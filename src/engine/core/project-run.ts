import { resolveSuiteLimits, type SuiteLimitsInput } from "./suite-limits.js";
import { createHash, randomUUID } from "node:crypto";
import type { AllowlistEntry } from "../service/mcp-allowlist.js";
import type { Manifest, Target } from "../types/manifest.js";
import type { RunProgressEvent, RunReport } from "../types/run.js";
import type { CallSlo } from "./call-slo.js";
import { compileSuite, type LoadProfile, type SuiteNode } from "./suite-model.js";
import { DEFAULT_SERVER, nodesForServer } from "./servers.js";
import { applyToolEvalVerdict, evaluateSuiteTools } from "./tool-evals.js";
import { runManifest } from "./runner.js";
import { tailRunLog } from "./run-log.js";
import { bufferedRunEvents, finishSuiteRun, publishRunEvent, subscribeRunEvents, tryBeginSuiteRun } from "./run-events.js";
import {
  getProject,
  loadProjectRun,
  loadSuiteVersion,
  saveProjectRun,
  projectSuiteServers,
  type ProjectSuiteServers,
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
  /** False skips model evals for tool eval prompts. Defaults to true. */
  evals?: boolean;
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
  const dispatch: SuiteDispatch = input.dispatch ?? pointer.dispatch ?? "local";
  if (dispatch === "worker" && !input.workerDispatch) return { ok: false, error: "worker_dispatch_unavailable" };

  let manifest: Manifest;
  let servers: ProjectSuiteServers;
  try {
    servers = projectSuiteServers(project, pointer, version);
    manifest = compileProjectSuite({
      projectName: project.name,
      suiteName: version.name,
      version: version.version,
      target: servers.target,
      targets: servers.targets,
      defaultServer: servers.defaultAlias,
      serverSlos: servers.serverSlos,
      allowlist: servers.allowlist,
      nodes: servers.nodes,
      load: version.load,
      slo: version.slo,
      limits: version.limits,
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
      destructive: servers.destructive,
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
    nodes: servers.nodes,
    catalog: servers.catalog,
    principal: input.principal,
    orgTargetAllowlist: input.orgTargetAllowlist,
    orgGatewayAllowlist: input.orgGatewayAllowlist,
    dataDir: input.dataDir,
    evals: input.evals,
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
  evals?: boolean;
}): Promise<void> {
  const startedAt = new Date();
  const store = input.dataDir ? { dataDir: input.dataDir } : undefined;
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
      evals: input.evals,
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
    await saveProjectRun(input.projectId, withEvals, store);
    publishRunEvent(finished);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const finished = {
      ts: new Date().toISOString(),
      runId: input.runId,
      name: "run.finished" as const,
      attributes: { verdict: "fail", ok: false, message },
    };
    // Keep a failed report so the run and its reason are listed even when the run never started.
    const report = failedSuiteRunReport({ ...input, startedAt, message });
    report.log = tailRunLog([...bufferedRunEvents(input.runId), finished]);
    await saveProjectRun(input.projectId, report, store).catch(() => undefined);
    publishRunEvent(finished);
  } finally {
    finishSuiteRun(input.suiteId, input.runId);
  }
}

/** Report for a run that failed before the runner produced one. */
export function failedSuiteRunReport(input: {
  runId: string;
  manifest: Manifest;
  projectId: string;
  suiteId: string;
  suiteVersion: number;
  catalog: NonNullable<RunReport["catalog"]>;
  principal: string;
  startedAt: Date;
  message: string;
}): RunReport {
  const finishedAt = new Date();
  const transport = input.manifest.target.transport;
  return {
    id: input.runId,
    manifestName: input.manifest.name,
    manifestHash: createHash("sha256").update(JSON.stringify(input.manifest)).digest("hex").slice(0, 16),
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - input.startedAt.getTime(),
    verdict: "fail",
    failReasons: [input.message],
    silentGreen: false,
    mode: input.manifest.load && input.manifest.load.durationMs > 0 ? "load" : "smoke",
    transport,
    sessionMetrics: { transport, started: 0, active: 0, failed: 0 },
    toolSeries: [],
    rpcSeries: [],
    scenarioOutcomes: [],
    quotas: { concurrencyUsed: 0, callCount: 0, maxPayloadBytesSeen: 0 },
    principal: input.principal,
    projectId: input.projectId,
    suiteId: input.suiteId,
    suiteVersion: input.suiteVersion,
    catalog: input.catalog,
  };
}

/** Compile a stored project suite version. Shared by in-process runs and remote workers. */
export function compileProjectSuite(input: {
  projectName: string;
  suiteName: string;
  version: number;
  target: Target;
  /** Other servers the steps call, by alias. Step `server` fields hold these aliases. */
  targets?: Record<string, Target>;
  defaultServer?: string;
  serverSlos?: Record<string, CallSlo>;
  allowlist: string[];
  nodes: SuiteNode[];
  load: Partial<LoadProfile>;
  slo?: CallSlo;
  limits?: SuiteLimitsInput;
}): Manifest {
  return compileSuite({
    name: input.suiteName,
    description: `Project ${input.projectName} suite ${input.suiteName} v${input.version}`,
    target: input.target,
    targets: input.targets,
    defaultServer: input.defaultServer,
    serverSlos: input.serverSlos,
    allowlist: input.allowlist,
    nodes: input.nodes,
    load: input.load,
    slo: input.slo,
    limits: resolveSuiteLimits({ suite: input.limits }),
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
  /** False skips model evals for tool eval prompts. Defaults to true. */
  evals?: boolean;
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
  if (input.signal?.aborted || input.evals === false) return report;
  return attachSuiteEvals(report, input.nodes, input.manifest);
}

/** Each tool's evals run against its own server. `nodes` carry aliases, as compiled. */
async function attachSuiteEvals(
  report: RunReport,
  nodes: SuiteNode[],
  manifest: Manifest,
): Promise<RunReport> {
  try {
    const defaultServer = manifest.defaultTarget ?? DEFAULT_SERVER;
    const targets: Array<[string, Target]> = [[defaultServer, manifest.target], ...Object.entries(manifest.targets ?? {})];
    const runs = [];
    for (const [alias, target] of targets) {
      const scoped = targets.length > 1 ? nodesForServer(nodes, alias, defaultServer) : nodes;
      const result = await evaluateSuiteTools({ nodes: scoped, target });
      if (result) runs.push(result);
    }
    const evalReport = runs.length > 0
      ? { cases: runs.flatMap((run) => run.cases), failReasons: runs.flatMap((run) => run.failReasons) }
      : null;
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
