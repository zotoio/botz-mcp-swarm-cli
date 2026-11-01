import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerSurface } from "../core/suite-model.js";
import { addServerToProject, createProject, getProject, loadSuiteVersion } from "./project-store.js";
import {
  acceptServerUpdate,
  checkServerUpdates,
  listScenarios,
  setRunTags,
  setScenarioTags,
  setServerChangelogNotes,
  setServerMeta,
  setSuiteMeta,
  filterSuitesByTags,
} from "./server-updates-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const v1: ServerSurface = {
  protocolVersion: "2025-06-18",
  serverName: "demo",
  serverVersion: "1.0.0",
  capabilities: ["tools"],
  tools: [
    { name: "search", schemaHash: "a", writeLike: false, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
    { name: "legacy", schemaHash: "b", writeLike: false, inputSchema: { type: "object", properties: {} } },
  ],
  resources: [],
  resourceTemplates: [],
  prompts: [],
};
const v2: ServerSurface = {
  ...v1,
  protocolVersion: "2025-11-25",
  serverVersion: "2.0.0",
  tools: [
    { name: "search", schemaHash: "c", writeLike: false, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "brand_new", schemaHash: "d", writeLike: false },
  ],
};
const other: ServerSurface = { ...v1, serverName: "other", tools: [{ name: "ping_other", schemaHash: "e", writeLike: false }] };

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "swarm-updates-"));
  dirs.push(dataDir);
  const project = await createProject({ name: "Demo", server: { transport: "streamable-http", url: "http://127.0.0.1:4444/mcp" } }, { dataDir, introspect: async () => v1 });
  await addServerToProject(project.id, { transport: "streamable-http", url: "http://127.0.0.1:5555/mcp" }, { dataDir, introspect: async () => other, generateSuite: true } as never);
  const detail = (await getProject(project.id, { dataDir }))!;
  return { dataDir, project: detail };
}

describe("server update store", () => {
  it("records the negotiated protocol version from introspection", async () => {
    const { project } = await setup();
    expect(project.servers?.[0]?.protocolVersion).toBe("2025-06-18");
  });

  it("checks, reviews, and surgically applies accepted changes with a changelog annotation", async () => {
    const { dataDir, project } = await setup();
    const [primary, second] = project.servers!;
    const secondSuites = project.suites.filter((s) => s.serverId === second!.id);
    const before = Object.fromEntries(project.suites.map((s) => [s.id, s.currentVersion]));

    const clean = await checkServerUpdates(project.id, { probe: async (t) => (JSON.stringify(t).includes("5555") ? other : v1) }, { dataDir });
    expect(clean?.every((r) => !r.diff?.changed)).toBe(true);

    const checks = await checkServerUpdates(project.id, { serverId: primary!.id, probe: async () => v2 }, { dataDir });
    const check = checks![0]!;
    expect(check.diff?.changed).toBe(true);
    expect(check.current?.protocolVersion).toBe("2025-11-25");
    const actions = check.proposals.map((p) => p.action).sort();
    expect(actions).toEqual(["add-step", "disable-step", "refresh-args"]);
    expect(check.affectedSuiteIds.every((id) => !secondSuites.some((s) => s.id === id))).toBe(true);

    const refresh = check.proposals.find((p) => p.action === "refresh-args")!;
    const result = await acceptServerUpdate(project.id, primary!.id, { acceptChangeIds: [refresh.id], notes: "Renamed q→query", principal: "andrew" }, { dataDir });
    if ("error" in result) throw new Error(result.error);
    expect(result.annotation.summary).toContain("serverVersion: 1.0.0 → 2.0.0");
    expect(result.annotation.rejectedChangeIds).toHaveLength(2);

    const after = (await getProject(project.id, { dataDir }))!;
    const server = after.servers!.find((s) => s.id === primary!.id)!;
    expect(server.protocolVersion).toBe("2025-11-25");
    expect(server.pendingUpdate).toBeUndefined();
    expect(server.versionHistory?.[0]?.notes).toBe("Renamed q→query");
    for (const suite of after.suites) {
      const touched = result.suiteVersions.some((v) => v.suiteId === suite.id);
      expect(suite.currentVersion).toBe(before[suite.id]! + (touched ? 1 : 0));
    }
    const touched = result.suiteVersions[0]!;
    const doc = await loadSuiteVersion(project.id, touched.suiteId, touched.version, { dataDir });
    const flat = JSON.stringify(doc?.nodes);
    expect(flat).toContain("\"query\"");
    expect(flat).toContain("legacy");

    const edited = await setServerChangelogNotes(project.id, primary!.id, result.annotation.id, "edited", { dataDir });
    expect(edited?.notes).toBe("edited");
  });

  it("force-detects a selected set of servers, previews, then applies add/retire with a versioned changelog", async () => {
    const { dataDir, project } = await setup();
    const [primary, second] = project.servers!;
    const probe = async (t: unknown) => (JSON.stringify(t).includes("5555") ? other : v2);
    expect(await checkServerUpdates(project.id, { serverIds: [primary!.id, "nope"], probe }, { dataDir })).toBeNull();
    const checks = (await checkServerUpdates(project.id, { serverIds: [primary!.id, second!.id], probe }, { dataDir }))!;
    expect(checks.map((c) => c.serverId).sort()).toEqual([primary!.id, second!.id].sort());
    const check = checks.find((c) => c.serverId === primary!.id)!;
    expect(check.diff?.primitives.find((p) => p.key === "brand_new")?.change).toBe("added");

    const before = (await getProject(project.id, { dataDir }))!;
    const preview = await acceptServerUpdate(project.id, primary!.id, { dryRun: true }, { dataDir });
    if ("error" in preview) throw new Error(preview.error);
    expect(preview.dryRun).toBe(true);
    expect(preview.suiteVersions).toEqual([]);
    const p0 = preview.preview[0]!;
    expect(p0.added.map((a) => a.primitive)).toEqual(["tool:brand_new"]);
    expect(p0.retired.map((r) => r.primitive)).toEqual(["tool:legacy"]);
    expect(p0.toVersion).toBe(p0.fromVersion + 1);
    // Dry run writes nothing.
    const still = (await getProject(project.id, { dataDir }))!;
    expect(still.servers!.find((s) => s.id === primary!.id)!.pendingUpdate).toBeTruthy();
    expect(still.suites.map((s) => s.currentVersion)).toEqual(before.suites.map((s) => s.currentVersion));

    const result = await acceptServerUpdate(project.id, primary!.id, { principal: "andrew" }, { dataDir });
    if ("error" in result) throw new Error(result.error);
    const v = result.suiteVersions[0]!;
    const doc = (await loadSuiteVersion(project.id, v.suiteId, v.version, { dataDir }))!;
    const flat: Array<{ tool?: string; enabled: boolean; retired?: unknown }> = [];
    const walk = (list: any[]) => list.forEach((n) => { flat.push(n); if (n.children) walk(n.children); });
    walk(doc.nodes as any[]);
    expect(flat.find((n) => n.tool === "brand_new")).toBeTruthy();
    const legacy = flat.find((n) => n.tool === "legacy")!;
    expect(legacy.enabled).toBe(false);
    expect(legacy.retired).toBeTruthy();
    expect(doc.changelog).toContain("1 added");
    expect(doc.changelog).toContain("1 retired");
  });

  it("stores descriptions and tags and filters by them", async () => {
    const { dataDir, project } = await setup();
    const suite = project.suites[0]!;
    await setSuiteMeta(project.id, suite.id, { description: "Main contract suite", tags: ["Smoke", "nightly"] }, { dataDir });
    await setServerMeta(project.id, project.servers![0]!.id, { description: "Primary MCP" }, { dataDir });
    await setRunTags(project.id, "run_1", "regression", { dataDir });
    await setScenarioTags(project.id, suite.id, "sc-x", ["checkout"], { dataDir });
    const after = (await getProject(project.id, { dataDir }))!;
    expect(after.suites[0]?.description).toBe("Main contract suite");
    expect(after.servers?.[0]?.description).toBe("Primary MCP");
    expect(after.runTags).toEqual({ run_1: ["regression"] });
    expect(filterSuitesByTags(after.suites, ["smoke"]).map((s) => s.id)).toEqual([suite.id]);
    expect(filterSuitesByTags(after.suites, ["missing"])).toEqual([]);
    expect(await listScenarios(project.id, { tags: ["checkout"] }, { dataDir })).toEqual([]);
  });
});
