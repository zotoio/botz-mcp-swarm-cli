import { describe, expect, it } from "vitest";
import {
  applySuiteChanges,
  diffSnapshots,
  matchesTags,
  normalizeTags,
  proposeSuiteChanges,
  snapshotFromSurface,
  uriMatchesTemplate,
} from "./server-updates.js";
import type { ServerSurface, SuiteNode } from "./suite-model.js";

const base: ServerSurface & { protocolVersion?: string } = {
  protocolVersion: "2025-06-18",
  serverName: "demo",
  serverVersion: "1.0.0",
  capabilities: ["tools", "prompts"],
  tools: [
    { name: "search", schemaHash: "a", writeLike: false, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
    { name: "legacy", schemaHash: "b", writeLike: false },
  ],
  resources: [],
  resourceTemplates: [],
  prompts: [{ name: "plan", arguments: [{ name: "goal", required: true }] }],
};

const next: ServerSurface & { protocolVersion?: string } = {
  ...base,
  protocolVersion: "2025-11-25",
  serverVersion: "1.1.0",
  tools: [
    { name: "search", schemaHash: "c", writeLike: false, inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
    { name: "fresh", schemaHash: "d", writeLike: false },
  ],
};

const nodes: SuiteNode[] = [
  {
    id: "g1",
    type: "group",
    enabled: true,
    scenarioMeta: { id: "sc1", name: "Search flow", goal: "find", category: "read-flow", independent: true, dependsOnScenarioIds: [], consumedVariables: [], producedVariables: [] },
    children: [
      { id: "s1", type: "sampler", enabled: true, method: "tools/call", tool: "search", args: { q: "x" } },
      { id: "s2", type: "sampler", enabled: true, method: "tools/call", tool: "legacy", args: {} },
      { id: "s3", type: "sampler", enabled: true, method: "prompts/get", prompt: "plan", args: { goal: "g" } },
      { id: "s4", type: "sampler", enabled: true, method: "tools/call", tool: "legacy", server: "other" },
    ],
  },
] as SuiteNode[];

describe("server update diff", () => {
  it("diffs meta, protocol version, and primitives", () => {
    const diff = diffSnapshots(snapshotFromSurface(base), snapshotFromSurface(next));
    expect(diff.changed).toBe(true);
    expect(diff.meta.map((m) => m.field).sort()).toEqual(["protocolVersion", "serverVersion"]);
    expect(diff.primitives).toEqual([
      { kind: "tool", key: "fresh", change: "added" },
      { kind: "tool", key: "legacy", change: "removed" },
      { kind: "tool", key: "search", change: "changed", fields: ["inputSchema"] },
    ]);
    expect(diff.summary).toContain("protocolVersion: 2025-06-18 → 2025-11-25");
  });

  it("reports no change for an identical surface regardless of key order", () => {
    const reordered = { ...base, tools: [...base.tools].reverse(), capabilities: ["prompts", "tools"] };
    expect(diffSnapshots(snapshotFromSurface(base), snapshotFromSurface(reordered)).changed).toBe(false);
  });

  it("proposes surgical changes only for referencing steps on the updated server", () => {
    const diff = diffSnapshots(snapshotFromSurface(base), snapshotFromSurface(next));
    const proposals = proposeSuiteChanges({ suiteId: "su", nodes, callsServer: (alias) => alias === undefined }, diff, snapshotFromSurface(next));
    expect(proposals.map((p) => [p.nodeId, p.action])).toEqual([
      ["s1", "refresh-args"],
      ["s2", "disable-step"],
    ]);
    expect(proposals[0]?.afterArgs).toEqual({ query: "swarm-record-fixture" === "x" ? "x" : expect.anything() });
    expect(proposals[0]?.scenarioName).toBe("Search flow");
    const { nodes: updated, applied } = applySuiteChanges(nodes, [proposals[1]!]);
    expect(applied).toHaveLength(1);
    const kids = updated[0]!.children!;
    expect(kids.find((n) => n.id === "s2")?.enabled).toBe(false);
    expect(kids.find((n) => n.id === "s1")?.args).toEqual({ q: "x" });
    expect(kids.find((n) => n.id === "s4")?.enabled).toBe(true);
  });

  it("refreshes prompt arguments when a prompt's arguments change", () => {
    const changed = { ...base, prompts: [{ name: "plan", arguments: [{ name: "objective", required: true }] }] };
    const diff = diffSnapshots(snapshotFromSurface(base), snapshotFromSurface(changed));
    const proposals = proposeSuiteChanges({ suiteId: "su", nodes, callsServer: (a) => !a }, diff, snapshotFromSurface(changed));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.afterArgs).toEqual({ objective: "fixture" });
  });

  it("matches templated resource uris", () => {
    expect(uriMatchesTemplate("file:///a/b.txt", "file:///{path}")).toBe(true);
    expect(uriMatchesTemplate("mem://x", "file:///{path}")).toBe(false);
  });
});

describe("tags", () => {
  it("normalises and filters with AND semantics", () => {
    expect(normalizeTags(" Smoke, nightly ,smoke,Bad Tag!")).toEqual(["bad-tag", "nightly", "smoke"]);
    expect(matchesTags(["a", "b"], ["a"])).toBe(true);
    expect(matchesTags(["a"], ["a", "b"])).toBe(false);
    expect(matchesTags(undefined, [])).toBe(true);
  });
});
