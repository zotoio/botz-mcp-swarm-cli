import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerSurface } from "../core/suite-model.js";
import { createProject, getProject, loadSuiteVersion, saveSuiteVersion } from "./project-store.js";
import {
  acceptServerUpdate,
  checkServerUpdates,
  projectIntrospectionState,
  refreshServerIntrospection,
  remediationGate,
} from "./server-updates-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const legacy: ServerSurface = {
  protocolVersion: "2025-11-25",
  serverName: "botz",
  serverVersion: "1.0.0",
  capabilities: ["tools"],
  tools: [
    { name: "search", schemaHash: "a", writeLike: false, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
    { name: "skill_install", schemaHash: "b", writeLike: false, inputSchema: { type: "object", properties: {} } },
  ],
  resources: [],
  resourceTemplates: [],
  prompts: [],
};
/** Same tools, now on the modern era; `skill_install` no longer listed for this role. */
const modern: ServerSurface = {
  ...legacy,
  protocolVersion: "2026-07-28",
  tools: [legacy.tools[0]!],
};

async function setup(surface: ServerSurface = legacy) {
  const dataDir = await mkdtemp(join(tmpdir(), "swarm-introspect-"));
  dirs.push(dataDir);
  const project = await createProject({ name: "Botz", server: { transport: "streamable-http", url: "http://127.0.0.1:4444/mcp" } }, { dataDir, introspect: async () => surface });
  return { dataDir, project: (await getProject(project.id, { dataDir }))! };
}

function flatten(nodes: Array<{ method?: string; tool?: string; enabled: boolean; children?: unknown[] }>): Array<{ method?: string; tool?: string; enabled: boolean }> {
  return nodes.flatMap((n) => [n, ...flatten((n.children ?? []) as never)]);
}

describe("live introspection freshness", () => {
  it("stamps lastIntrospectedAt, snapshot hash, spec version and era when a server is added", async () => {
    const { dataDir, project } = await setup();
    const server = project.servers![0]!;
    expect(server.lastIntrospectedAt).toBeTruthy();
    expect(server.snapshotHash).toMatch(/^[0-9a-f]{16}$/);
    expect(server.protocolEra).toBe("legacy");
    const [state] = (await projectIntrospectionState(project.id, {}, { dataDir }))!;
    expect(state).toMatchObject({ lastIntrospectedAt: server.lastIntrospectedAt, protocolVersion: "2025-11-25", protocolEra: "legacy", stale: false, pendingReview: null });
  });

  it("reports stale past the threshold and fresh within it", async () => {
    const { dataDir, project } = await setup();
    const at = Date.parse(project.servers![0]!.lastIntrospectedAt!);
    const fresh = await projectIntrospectionState(project.id, { now: new Date(at + 60_000) }, { dataDir });
    expect(fresh?.[0]?.stale).toBe(false);
    const old = await projectIntrospectionState(project.id, { now: new Date(at + 25 * 3_600_000) }, { dataDir });
    expect(old?.[0]?.stale).toBe(true);
    const custom = await projectIntrospectionState(project.id, { now: new Date(at + 2 * 3_600_000), staleAfterMs: 3_600_000 }, { dataDir });
    expect(custom?.[0]?.stale).toBe(true);
  });

  it("refresh from server records the probe and flags drift (removed tool, ping on modern) for review without applying it", async () => {
    const { dataDir, project } = await setup();
    const suite = project.suites[0]!;
    const before = suite.currentVersion;
    const out = await refreshServerIntrospection(project.id, { suiteId: suite.id, probe: async () => modern }, { dataDir });
    const result = out!.results[0]!;
    expect(result.protocolEra).toBe("modern");
    const keys = result.proposals.map((p) => `${p.action}:${p.primitive.kind}:${p.primitive.key}`).sort();
    expect(keys).toContain("disable-step:method:ping");
    expect(keys).toContain("disable-step:tool:skill_install");
    const after = (await getProject(project.id, { dataDir }))!;
    const server = after.servers![0]!;
    expect(server.pendingUpdate?.proposals.length).toBe(result.proposals.length);
    expect(server.protocolEra).toBe("modern");
    expect(server.snapshotHash).toBe(result.snapshotHash);
    // Never auto-applied.
    expect(after.suites[0]!.currentVersion).toBe(before);
    expect(out!.state[0]!.pendingReview?.proposalCount).toBe(result.proposals.length);
  });

  it("gates remediation: blocks a stale server when auto-refresh is off, refreshes it otherwise", async () => {
    const { dataDir, project } = await setup();
    const later = new Date(Date.parse(project.servers![0]!.lastIntrospectedAt!) + 48 * 3_600_000);
    const blocked = await remediationGate(project.id, { autoRefresh: false, now: later }, { dataDir });
    expect(blocked?.ok).toBe(false);
    expect(blocked?.blocked?.reason).toBe("refresh_needed");
    expect(blocked?.blocked?.message).toMatch(/Refresh needed/);

    const refreshed = await remediationGate(project.id, { probe: async () => modern, now: later }, { dataDir });
    expect(refreshed?.refreshed).toBe(true);
    expect(refreshed?.ok).toBe(true);
    expect(refreshed?.pendingReviews[0]?.proposalCount).toBeGreaterThan(0);
  });

  it("does not clobber suite edits made after the check (P2): stale proposals are recomputed or skipped", async () => {
    const { dataDir, project } = await setup();
    const suite = project.suites[0]!;
    const [check] = (await checkServerUpdates(project.id, { probe: async () => modern }, { dataDir }))!;
    const pingProposal = check!.proposals.find((p) => p.primitive.key === "ping")!;
    expect(pingProposal.suiteVersion).toBe(suite.currentVersion);
    // User disables ping themselves and deletes the skill_install step before accepting.
    const doc = (await loadSuiteVersion(project.id, suite.id, suite.currentVersion, { dataDir }))!;
    const strip = (nodes: typeof doc.nodes): typeof doc.nodes => nodes
      .filter((n) => n.tool !== "skill_install")
      .map((n) => ({ ...n, ...(n.method === "ping" ? { enabled: false } : {}), ...(n.children ? { children: strip(n.children) } : {}) }));
    await saveSuiteVersion(project.id, suite.id, { name: doc.name, nodes: strip(doc.nodes), load: doc.load, basedOn: suite.currentVersion }, { dataDir });
    const result = await acceptServerUpdate(project.id, project.servers![0]!.id, {}, { dataDir });
    if ("error" in result) throw new Error(result.error);
    expect(result.staleChangeIds.length).toBeGreaterThanOrEqual(2);
    expect(result.suiteVersions).toEqual([]);
  });

  it("a server added on the modern era gets no ping step", async () => {
    const { dataDir, project } = await setup(modern);
    const suite = project.suites[0]!;
    const doc = (await loadSuiteVersion(project.id, suite.id, suite.currentVersion, { dataDir }))!;
    expect(flatten(doc.nodes as never).some((n) => n.method === "ping")).toBe(false);
    expect(project.servers![0]!.protocolEra).toBe("modern");
  });
});
