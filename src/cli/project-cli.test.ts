import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { selectRunMode } from "./run-mode.js";
import {
  addStructuredProject,
  addSuiteNode,
  cloneSuiteNode,
  compareProjectRuns,
  currentVersion,
  exportSuiteManifest,
  formatSuiteTree,
  removeStructuredProject,
  resolveProject,
  resolveSuite,
  saveLoadProfile,
  setSuiteNode,
} from "./project-ops.js";
import { parseManifest } from "../engine/types/manifest.js";
import { saveProjectRun } from "../engine/store/project-store.js";
import type { McpServerConfig } from "../engine/service/mcp-allowlist.js";
import type { RunReport } from "../engine/types/run.js";
import type { ToolCatalogEntry } from "../engine/core/suite-model.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const httpServer: McpServerConfig = {
  transport: "streamable-http",
  url: "http://127.0.0.1:9/mcp",
};

const catalog: ToolCatalogEntry[] = [
  { name: "echo", schemaHash: "abc", writeLike: false },
  { name: "skill_delete", schemaHash: "def", writeLike: true },
];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swarm-cli-"));
  dirs.push(dir);
  return dir;
}

function report(id: string, tool: string, p95: number): RunReport {
  return {
    id,
    manifestName: "Smoke",
    manifestHash: "abc",
    startedAt: "2026-10-06T00:00:00.000Z",
    finishedAt: "2026-10-06T00:00:01.000Z",
    durationMs: 1000,
    verdict: "pass",
    failReasons: [],
    silentGreen: false,
    mode: "load",
    transport: "streamable-http",
    sessionMetrics: { transport: "streamable-http", started: 1, active: 0, failed: 0 },
    toolSeries: [
      {
        toolName: tool,
        count: 1,
        errorRate: 0,
        errorClass: {
          none: 1,
          protocol: 0,
          application: 0,
          timeout: 0,
          transport: 0,
          quota: 0,
          allowlist: 0,
          auth: 0,
        },
        latencyMs: { p50: p95, p95, p99: p95 },
        bytesIn: 1,
        bytesOut: 1,
      },
    ],
    rpcSeries: [],
    scenarioOutcomes: [{ scenario: "Smoke", outcome: "pass" }],
    quotas: { concurrencyUsed: 1, callCount: 1, maxPayloadBytesSeen: 1 },
    catalog: catalog.map((entry) => ({ name: entry.name, schemaHash: entry.schemaHash, writeLike: entry.writeLike })),
  };
}

describe("project cli", () => {
  it("selects load mode for a suite manifest and soak when soak is requested", () => {
    expect(selectRunMode({ load: { durationMs: 800, rampUpMs: 0, maxConcurrency: 1, jitterMs: 0, rampDownMs: 0 } }, false)).toBe("load");
    expect(selectRunMode({ soak: { durationMs: 1000 } }, false)).toBe("soak");
    expect(selectRunMode({}, false)).toBe("smoke");
  });

  it("sizes the generated suite's ramp-down from the server's introspection latency", async () => {
    const surface = (connectMs: number, rpcMs: number) => async () => ({
      capabilities: ["tools"], tools: catalog, resources: [], resourceTemplates: [], prompts: [], latency: { connectMs, rpcMs },
    });
    const fast = await addStructuredProject(JSON.stringify(httpServer), { dataDir: await tempDir(), introspect: surface(20, 2) });
    const slow = await addStructuredProject(JSON.stringify(httpServer), { dataDir: await tempDir(), introspect: surface(20_000, 5_000) });
    const rampDown = async (projectId: string, dataDir: string) => {
      const detail = await resolveProject(projectId, { dataDir });
      return currentVersion(detail, resolveSuite(detail)).load.rampDownMs;
    };
    expect(await rampDown(fast.project.id, dirs.at(-2)!)).toBe(60_000);
    expect(await rampDown(slow.project.id, dirs.at(-1)!)).toBeGreaterThan(60_000);
    expect(slow.project.surface?.latency).toEqual({ connectMs: 20_000, rpcMs: 5_000 });
  });

  it("creates a read-safe suite and edits it with the same versioned operations as the studio", async () => {
    const dataDir = await tempDir();
    const options = { dataDir, introspect: async () => catalog };
    const { project } = await addStructuredProject(JSON.stringify(httpServer), options);
    const detail = await resolveProject(project.id, options);
    const suite = resolveSuite(detail);
    const version = currentVersion(detail, suite);
    const calls = version.nodes[0]?.children?.filter((node) => node.method === "tools/call") ?? [];
    expect(calls.find((node) => node.tool === "echo")?.enabled).toBe(true);
    expect(calls.find((node) => node.tool === "skill_delete")?.enabled).toBe(false);

    const echo = calls.find((node) => node.tool === "echo");
    const cloned = await cloneSuiteNode(project.id, echo!.id, suite.id, options);
    expect(formatSuiteTree(cloned.nodes)).toContain("echo copy");

    const disabled = await setSuiteNode(project.id, echo!.id, { enabled: false }, suite.id, options);
    const echoAfter = disabled.nodes[0]?.children?.find((node) => node.id === echo!.id);
    expect(echoAfter?.enabled).toBe(false);

    await addSuiteNode(project.id, { suite: suite.id, type: "think", thinkMs: 25, parent: version.nodes[0]?.id }, options);
    const loaded = await saveLoadProfile(project.id, { durationMs: 800, maxConcurrency: 1, jitterMs: 0 }, suite.id, options);
    expect(loaded.load.durationMs).toBe(800);
    expect(loaded.version).toBeGreaterThan(1);

    const manifestPath = join(dataDir, "suite.json");
    await exportSuiteManifest(project.id, manifestPath, suite.id, options);
    const manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    expect(selectRunMode(manifest, false)).toBe("load");
    expect(manifest.scenarios[0]?.steps.some((step) => step.method === "think")).toBe(true);

    await saveProjectRun(project.id, report("run-base", "echo", 10), options);
    await saveProjectRun(project.id, report("run-head", "echo", 12), options);
    const compare = await compareProjectRuns(project.id, "run-base", "run-head", options);
    expect(compare.deltas.find((delta) => delta.toolName === "echo")?.catalogStatus).toBe("unchanged");
    expect(compare.deltas.find((delta) => delta.toolName === "echo")?.scored).toBe(true);
    expect(compare.deltas.find((delta) => delta.toolName === "skill_delete")?.scored).toBe(false);

    await removeStructuredProject(project.id, options);
    const archived = await resolveProject(project.id, options);
    expect(archived.archived).toBe(true);
  });

  it("refuses host-only allowlist strings", async () => {
    const dataDir = await tempDir();
    await expect(addStructuredProject("\"localhost\"", { dataDir })).rejects.toThrow(/host_strings_do_not_create_projects/);
  });
});