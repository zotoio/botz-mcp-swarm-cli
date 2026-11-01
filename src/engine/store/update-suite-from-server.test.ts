import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerSurface, SuiteNode } from "../core/suite-model.js";
import { createProject, getProject, loadSuiteVersion, saveSuiteVersion } from "./project-store.js";
import { checkServerUpdates, updateSuiteFromServer } from "./server-updates-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const outSchema = { type: "object", properties: { ok: { type: "boolean" } } };
const v1: ServerSurface = {
  protocolVersion: "2025-06-18",
  serverName: "demo",
  serverVersion: "1.0.0",
  capabilities: ["tools", "prompts"],
  tools: [
    { name: "search", schemaHash: "a", writeLike: false, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
    { name: "stats", schemaHash: "b", writeLike: false, inputSchema: { type: "object", properties: {} } },
  ],
  resources: [],
  resourceTemplates: [],
  prompts: [{ name: "summarise", arguments: [{ name: "text", required: true }] }],
};

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "swarm-update-always-"));
  dirs.push(dataDir);
  const project = await createProject({ name: "Demo", server: { transport: "streamable-http", url: "http://127.0.0.1:4444/mcp" } }, { dataDir, introspect: async () => v1 });
  const detail = (await getProject(project.id, { dataDir }))!;
  return { dataDir, project: detail, suite: detail.suites[0]! };
}

const samplerNodes = (nodes: SuiteNode[]): SuiteNode[] => nodes.flatMap((n) => [...(n.type === "sampler" ? [n] : []), ...samplerNodes(n.children ?? [])]);

describe("update suite from server (always available)", () => {
  it("previews 'no changes' with a per-item coverage list when the suite already covers everything", async () => {
    const { dataDir, project, suite } = await setup();
    // Force detect agrees: no diff, nothing to review.
    const check = await checkServerUpdates(project.id, { probe: async () => v1 }, { dataDir });
    expect(check![0]!.diff?.changed).toBe(false);
    const res = await updateSuiteFromServer(project.id, suite.id, { dryRun: true, probe: async () => v1 }, { dataDir });
    if ("error" in res) throw new Error(res.error);
    expect(res.servers[0]!.coverage.map((c) => `${c.kind}:${c.key}`).sort()).toEqual(["prompt:summarise", "tool:search", "tool:stats"]);
    expect(res.servers[0]!.coverage.filter((c) => c.status === "missing")).toEqual([]);
    expect(res.noChanges).toBe(true);
    expect(res.preview.changelog).toMatch(/^No changes/);
    // Apply with no changes writes nothing.
    const applied = await updateSuiteFromServer(project.id, suite.id, { probe: async () => v1 }, { dataDir });
    if ("error" in applied) throw new Error(applied.error);
    expect(applied.version).toBeUndefined();
  });

  it("adds a step for a tool missing from THIS suite even when the snapshot already lists it, and force detect sees it too", async () => {
    const { dataDir, project, suite } = await setup();
    const doc = (await loadSuiteVersion(project.id, suite.id, suite.currentVersion, { dataDir }))!;
    // Someone deleted the 'stats' step: the snapshot still lists it, the suite no longer covers it.
    const drop = (list: SuiteNode[]): SuiteNode[] => list.filter((n) => !(n.type === "sampler" && n.tool === "stats")).map((n) => ({ ...n, ...(n.children ? { children: drop(n.children) } : {}) }));
    await saveSuiteVersion(project.id, suite.id, { name: doc.name, nodes: drop(doc.nodes as SuiteNode[]) as typeof doc.nodes, load: doc.load, basedOn: suite.currentVersion, changelog: "drop stats" }, { dataDir });

    const check = await checkServerUpdates(project.id, { probe: async () => v1 }, { dataDir });
    expect(check![0]!.diff?.changed).toBe(false);
    expect(check![0]!.proposals.map((p) => `${p.action}:${p.primitive.key}:${p.source}`)).toContain("add-step:stats:coverage");

    const res = await updateSuiteFromServer(project.id, suite.id, { probe: async () => v1, principal: "editor@x" }, { dataDir });
    if ("error" in res) throw new Error(res.error);
    expect(res.servers[0]!.coverage.find((c) => c.key === "stats")?.status).toBe("missing");
    expect(res.preview.added.map((a) => a.primitive)).toEqual(["tool:stats"]);
    expect(res.version).toBe(suite.currentVersion + 2);
    const after = (await loadSuiteVersion(project.id, suite.id, res.version!, { dataDir }))!;
    expect(samplerNodes(after.nodes as SuiteNode[]).some((n) => n.tool === "stats")).toBe(true);
    expect(after.changelog).toMatch(/Update suite from server/);
    const proj = (await getProject(project.id, { dataDir }))!;
    expect(proj.servers![0]!.versionHistory?.[0]?.principal).toBe("editor@x");
  });

  it("re-syncs args and adds an outputSchema contract check for a tool that now declares one", async () => {
    const { dataDir, project, suite } = await setup();
    const v2: ServerSurface = { ...v1, tools: [{ ...v1.tools[0]!, outputSchema: outSchema } as never, v1.tools[1]!] };
    const res = await updateSuiteFromServer(project.id, suite.id, { dryRun: true, probe: async () => v2 }, { dataDir });
    if ("error" in res) throw new Error(res.error);
    const upd = res.preview.updated.find((u) => u.primitive === "tool:search");
    expect(upd?.afterExpect).toEqual({ outputSchema: outSchema });
    expect(res.noChanges).toBe(false);
  });

  it("regenerate all refreshes every step's args and pins both contracts", async () => {
    const { dataDir, project, suite } = await setup();
    const res = await updateSuiteFromServer(project.id, suite.id, { dryRun: true, regenerateAll: true, probe: async () => v1 }, { dataDir });
    if ("error" in res) throw new Error(res.error);
    expect(res.regenerateAll).toBe(true);
    expect(res.proposals.every((p) => p.action !== "add-step")).toBe(true);
    expect(res.preview.changelog).toMatch(/regenerate all|No changes/);
  });

  it("errors on unknown suite or server", async () => {
    const { dataDir, project } = await setup();
    expect(await updateSuiteFromServer(project.id, "nope", { probe: async () => v1 }, { dataDir })).toEqual({ error: "suite_not_found" });
  });
});
