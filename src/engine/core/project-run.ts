import { randomUUID } from "node:crypto";
import type { AllowlistEntry } from "../service/mcp-allowlist.js";
import type { Manifest, Target } from "../types/manifest.js";
import type { RunProgressEvent, RunReport } from "../types/run.js";
import type { CallSlo } from "./call-slo.js";
import { compileSuite, type LoadProfile, type SuiteNode } from "./suite-model.js";
import { suiteEnablesDestructive } from "./suite-compatibility.js";
import { applyToolEvalVerdict, evaluateSuiteTools } from "./tool-evals.js";
import { runManifest } from "./runner.js";
import { tailRunLog } from "./run-log.js";
import { bufferedRunEvents, finishSuiteRun, publishRunEvent, subscribeRunEvents, tryBeginSuiteRun } from "./run-events.js";
import {
  getProject,
  loadProjectRun,
  loadSuiteVersion,
  projectAllowlistHosts,
  saveProjectRun,
  serverForSuite,
  type SuiteDispatch,
} from "../store/project-store.js";

/** An execution handed to a remote worker. The run is open until the worker hub finishes it. */
export interface WorkerDispatchJob {
  executionId: string;
  projectId: string;
  suiteId: string;
  version: number;
  /** True when an enabled step calls a tool that is not called by default. */
  destructive: boolean;
  load: LoadProfile;
  principal: string;
  dataDir?: string;
}

export async function startSuiteRun(input: {
  projectId: string;
  suiteId: string;
  /** Stored version to run. Omitted means the latest version. */
  version?: number;
  principal: string;
  orgTargetAllowlist: AllowlistEntry[];
  orgGatewayAllowlist: AllowlistEntry[];
  /** Isolated store for tests. Omitted uses the service data directory. */
  dataDir?: string;
  /** Omitted uses the suite's field, and `local` when the suite has none. */
  dispatch?: SuiteDispatch;
  /** Receives `worker` runs. Without it a `worker` run is refused, never run in this process. */
  workerDispatch?: (job: WorkerDispatchJob) => void;
}): Promise<{ ok: true; runId: string; dispatch: SuiteDispatch } | { ok: false; error: string }> {
  const store = input.dataDir ? { dataDir: input.dataDir } : undefined;
  const project = await getProject(input.projectId, store);
  if (!project || project.archived) return { ok: false, error: "project_not_found" };
  const pointer = project.suites.find((suite) => suite.id === input.suiteId);
  const version = input.version
    ? await loadSuiteVersion(project.id, input.suiteId, input.version, store)
    : project.versions[input.suiteId];
  if (!pointer) return { ok: false, error: "suite_not_found" };
  if (!version) return { ok: false, error: input.version ? "suite_version_not_found" : "suite_not_found" };
  if (pointer.enabled === false) return { ok: false, error: "suite_disabled" };
  const server = serverForSuite(project, pointer);
  const dispatch: SuiteDispatch = input.dispatch ?? pointer.dispatch ?? "local";
  if (dispatch === "worker" && !input.workerDispatch) return { ok: false, error: "worker_dispatch_unavailable" };

  let manifest: Manifest;
  try {
    manifest = compileProjectSuite({
      projectName: project.name,
      suiteName: version.name,
      version: version.version,
      target: server.target,
      allowlist: projectAllowlistHosts(server.target),
      nodes: version.nodes,
      load: version.load,
      slo: version.slo,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "suite_compile_failed" };
  }

  const runId = randomUUID();
  if (!tryBeginSuiteRun(input.suiteId, runId, {
    projectId: project.id,
    projectName: project.name,
    suiteName: version.name,
  })) {
    return { ok: false, error: "suite_already_running" };
  }

  if (dispatch === "worker" && input.workerDispatch) {
    input.workerDispatch({
      executionId: runId,
      projectId: project.id,
      suiteId: input.suiteId,
      version: version.version,
      destructive: suiteEnablesDestructive(version.nodes, server.catalog),
      load: version.load,
      principal: input.principal,
      dataDir: input.dataDir,
    });
    return { ok: true, runId, dispatch };
  }

  void executeSuiteRun({
    runId,
    manifest,
    projectId: project.id,
    suiteId: input.suiteId,
    suiteVersion: version.version,
    nodes: version.nodes,
    catalog: server.catalog.map((tool) => ({
      name: tool.name,
      schemaHash: tool.schemaHash,
      writeLike: tool.writeLike,
    })),
    principal: input.principal,
    orgTargetAllowlist: input.orgTargetAllowlist,
    orgGatewayAllowlist: input.orgGatewayAllowlist,
    dataDir: input.dataDir,
  });

  return { ok: true, runId, dispatch };
}

async function executeSuiteRun(input: {
  runId: string;
  manifest: Manifest;
  projectId: string;
  suiteId: string;
  suiteVersion: number;
  nodes: SuiteNode[];
  catalog: NonNullable<RunReport["catalog"]>;
  principal: string;
  orgTargetAllowlist: AllowlistEntry[];
  orgGatewayAllowlist: AllowlistEntry[];
  dataDir?: string;
}): Promise<void> {
  try {
    const withEvals = await runCompiledSuite({
      manifest: input.manifest,
      manifestDir: process.cwd(),
      runId: input.runId,
      nodes: input.nodes,
      catalog: input.catalog,
      principal: input.principal,
      orgTargetAllowlist: input.orgTargetAllowlist,
      orgGatewayAllowlist: input.orgGatewayAllowlist,
      onProgress: publishRunEvent,
    });
    withEvals.projectId = input.projectId;
    withEvals.suiteId = input.suiteId;
    withEvals.suiteVersion = input.suiteVersion;
    const finished = {
      ts: new Date().toISOString(),
      runId: input.runId,
      name: "run.finished" as const,
      attributes: { verdict: withEvals.verdict, ok: true },
    };
    withEvals.log = tailRunLog([...bufferedRunEvents(input.runId), finished]);
    await saveProjectRun(input.projectId, withEvals, input.dataDir ? { dataDir: input.dataDir } : undefined);
    publishRunEvent(finished);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    publishRunEvent({
      ts: new Date().toISOString(),
      runId: input.runId,
      name: "run.finished",
      attributes: { verdict: "fail", ok: false, message },
    });
  } finally {
    finishSuiteRun(input.suiteId, input.runId);
  }
}

/** Compile a stored project suite version. Shared by in-process runs and remote workers. */
export function compileProjectSuite(input: {
  projectName: string;
  suiteName: string;
  version: number;
  target: Target;
  allowlist: string[];
  nodes: SuiteNode[];
  load: Partial<LoadProfile>;
  slo?: CallSlo;
}): Manifest {
  return compileSuite({
    name: input.suiteName,
    description: `Project ${input.projectName} suite ${input.suiteName} v${input.version}`,
    target: input.target,
    allowlist: input.allowlist,
    nodes: input.nodes,
    load: input.load,
    slo: input.slo,
  }) as unknown as Manifest;
}

/** Run a compiled project suite, set its catalog, and apply tool evals. Shared by in-process runs and remote workers. */
export async function runCompiledSuite(input: {
  manifest: Manifest;
  manifestDir: string;
  runId: string;
  nodes: SuiteNode[];
  catalog: NonNullable<RunReport["catalog"]>;
  principal: string;
  orgTargetAllowlist: AllowlistEntry[];
  orgGatewayAllowlist: AllowlistEntry[];
  onProgress?: (event: RunProgressEvent) => void;
  /** Aborts the run (see `runManifest`); tool evals are skipped once aborted. */
  signal?: AbortSignal;
}): Promise<RunReport> {
  const report = await runManifest({
    manifest: input.manifest,
    manifestDir: input.manifestDir,
    runId: input.runId,
    principal: input.principal,
    orgTargetAllowlist: input.orgTargetAllowlist,
    orgGatewayAllowlist: input.orgGatewayAllowlist,
    onProgress: input.onProgress,
    signal: input.signal,
  });
  report.catalog = input.catalog;
  if (input.signal?.aborted) return report;
  return attachSuiteEvals(report, input.nodes, input.manifest.target);
}

async function attachSuiteEvals(
  report: RunReport,
  nodes: SuiteNode[],
  target: Target,
): Promise<RunReport> {
  try {
    const evalReport = await evaluateSuiteTools({ nodes, target });
    return evalReport ? applyToolEvalVerdict(report, evalReport) : report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return applyToolEvalVerdict(report, {
      cases: [],
      failReasons: [`tool eval: ${message}`],
    });
  }
}

export function followSuiteRun(
  runId: string,
  onEvent: (event: RunProgressEvent) => void,
): Promise<RunProgressEvent> {
  return new Promise((resolve) => {
    const seen = new Set<string>();
    const handle = (event: RunProgressEvent) => {
      const key = `${event.ts}\0${event.name}\0${JSON.stringify(event.attributes)}`;
      if (seen.has(key)) return;
      seen.add(key);
      onEvent(event);
      if (event.name === "run.finished") {
        unsubscribe();
        resolve(event);
      }
    };
    const unsubscribe = subscribeRunEvents(runId, handle);
    for (const event of bufferedRunEvents(runId)) handle(event);
  });
}

export async function readSuiteRun(projectId: string, runId: string): Promise<RunReport | null> {
  return loadProjectRun(projectId, runId);
}
