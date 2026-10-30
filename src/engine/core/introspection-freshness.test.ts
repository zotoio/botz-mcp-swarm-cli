import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALE_AFTER_MS,
  classifyRemediation,
  introspectionStatus,
  pendingReviewNote,
  protocolEraFor,
  snapshotHash,
  staleThresholdMs,
} from "./introspection-freshness.js";
import { buildDefaultSuiteNodes, type SuiteNode } from "./suite-model.js";
import { consistentCallSlo, effectiveCallSlo, normalizeCallSlo } from "./call-slo.js";
import { applySuiteChanges, diffSnapshots, proposeSuiteChanges, snapshotFromSurface, suiteDriftProposals, valueFitsSchema } from "./server-updates.js";

const flat = (nodes: SuiteNode[]): SuiteNode[] => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);

describe("protocol era + freshness", () => {
  it("detects the era from the negotiated spec version", () => {
    expect(protocolEraFor("2026-07-28")).toBe("modern");
    expect(protocolEraFor("2025-11-25")).toBe("legacy");
    expect(protocolEraFor(undefined)).toBe("unknown");
    expect(protocolEraFor("2025-11-25", "modern")).toBe("modern");
  });

  it("uses a 24h default threshold, overridable by env or argument", () => {
    expect(staleThresholdMs({})).toBe(DEFAULT_STALE_AFTER_MS);
    expect(staleThresholdMs({ SWARM_INTROSPECTION_STALE_HOURS: "2" })).toBe(2 * 3_600_000);
    expect(staleThresholdMs({ SWARM_INTROSPECTION_STALE_HOURS: "nope" })).toBe(DEFAULT_STALE_AFTER_MS);
    expect(staleThresholdMs({}, 1000)).toBe(1000);
  });

  it("marks never-introspected and old servers stale, falling back to catalogAt", () => {
    const now = new Date("2026-10-30T00:00:00Z");
    expect(introspectionStatus({}, { now }).stale).toBe(true);
    expect(introspectionStatus({ catalogAt: "2026-10-29T12:00:00Z" }, { now, staleAfterMs: DEFAULT_STALE_AFTER_MS }).stale).toBe(false);
    const old = introspectionStatus({ lastIntrospectedAt: "2026-10-27T00:00:00Z", protocolVersion: "2026-07-28" }, { now, staleAfterMs: DEFAULT_STALE_AFTER_MS });
    expect(old).toMatchObject({ stale: true, protocolEra: "modern", ageMs: 3 * 86_400_000 });
  });

  it("hashes the advertised surface independent of when it was taken", () => {
    const a = snapshotFromSurface({ capabilities: ["tools"], tools: [], resources: [], resourceTemplates: [], prompts: [] }, "2026-01-01T00:00:00Z");
    const b = { ...a, takenAt: "2026-02-01T00:00:00Z" };
    expect(snapshotHash(a)).toBe(snapshotHash(b));
    expect(snapshotHash({ ...a, capabilities: ["tools", "prompts"] })).not.toBe(snapshotHash(a));
  });
});

describe("suite generator", () => {
  const surface = { capabilities: ["tools", "logging"], tools: [{ name: "t", schemaHash: "x", writeLike: false }], resources: [], resourceTemplates: [], prompts: [] };
  it("emits ping and logging on the legacy era", () => {
    const methods = flat(buildDefaultSuiteNodes({ ...surface, protocolVersion: "2025-11-25" })).map((n) => n.method);
    expect(methods).toContain("ping");
    expect(methods).toContain("logging/setLevel");
  });
  it("never emits ping or logging/setLevel on the modern era", () => {
    const methods = flat(buildDefaultSuiteNodes({ ...surface, protocolVersion: "2026-07-28" })).map((n) => n.method);
    expect(methods).not.toContain("ping");
    expect(methods).not.toContain("logging/setLevel");
    expect(methods).toContain("initialize");
  });
});

describe("SLO consistency", () => {
  it("never leaves p99 below p95", () => {
    expect(normalizeCallSlo({ maxP95Ms: 30795, maxP99Ms: 3500 })).toEqual({ maxP95Ms: 30795, maxP99Ms: 30795 });
    // A step p95 above the inherited suite p99 lifts p99 with it.
    expect(effectiveCallSlo({ maxP95Ms: 2000, maxP99Ms: 3500 }, { maxP95Ms: 30795 })).toMatchObject({ maxP95Ms: 30795, maxP99Ms: 30795 });
    expect(consistentCallSlo({ maxP95Ms: 100, maxP99Ms: 200 })).toEqual({ maxP95Ms: 100, maxP99Ms: 200 });
  });
});

describe("schema-change proposals (PR #28 P1/P2)", () => {
  const before = snapshotFromSurface({ capabilities: ["tools"], tools: [{ name: "find", schemaHash: "1", writeLike: false, inputSchema: { type: "object", properties: { q: { type: "string" }, limit: { type: "string" } }, required: ["q"] }, outputSchema: { type: "object", properties: { a: { type: "string" } } } }], resources: [], resourceTemplates: [], prompts: [] });
  const nextTool = { name: "find", schemaHash: "2", writeLike: false, inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query", "limit"] }, outputSchema: { type: "object", properties: { b: { type: "number" } } } };
  const after = snapshotFromSurface({ capabilities: ["tools"], tools: [nextTool], resources: [], resourceTemplates: [], prompts: [] });
  const node: SuiteNode = {
    id: "n1", type: "sampler", enabled: true, method: "tools/call", tool: "find", args: { q: "x", limit: "10" },
    expect: { resultShape: "tools/call", inputSchema: before.tools[0]!.inputSchema, outputSchema: before.tools[0]!.outputSchema },
  };
  const input = { suiteId: "s", nodes: [node], callsServer: () => true };

  it("moves expect.inputSchema/outputSchema with the accepted schema (P1)", () => {
    const [p] = proposeSuiteChanges(input, diffSnapshots(before, after), after);
    expect(p!.action).toBe("refresh-args");
    expect(p!.afterExpect).toEqual({ inputSchema: nextTool.inputSchema, outputSchema: nextTool.outputSchema });
    const { nodes } = applySuiteChanges([node], [p!]);
    expect((nodes[0]!.expect as Record<string, unknown>).inputSchema).toEqual(nextTool.inputSchema);
    expect((nodes[0]!.expect as Record<string, unknown>).outputSchema).toEqual(nextTool.outputSchema);
    expect(nodes[0]!.expect?.resultShape).toBe("tools/call");
  });

  it("replaces retained values that no longer fit the new type (P2)", () => {
    const [p] = proposeSuiteChanges(input, diffSnapshots(before, after), after);
    expect(typeof p!.afterArgs!.limit).toBe("number");
    expect(p!.afterArgs!.query).toBeDefined();
    expect(p!.afterArgs!.q).toBeUndefined();
    expect(valueFitsSchema("${limit}", { type: "integer" } as never)).toBe(true);
    expect(valueFitsSchema("a", { enum: ["b"] } as never)).toBe(false);
  });

  it("flags drift against the fresh probe even when the stored snapshot is unchanged", () => {
    const modern = { ...after, protocolVersion: "2026-07-28" };
    const ping: SuiteNode = { id: "p", type: "sampler", enabled: true, method: "ping" };
    const ghost: SuiteNode = { id: "g", type: "sampler", enabled: true, method: "tools/call", tool: "skill_install" };
    const drift = suiteDriftProposals({ suiteId: "s", nodes: [ping, ghost, node], callsServer: () => true }, modern, { modern: true, removedMethods: new Set(["ping"]) });
    const keys = drift.map((d) => `${d.action}:${d.primitive.kind}:${d.primitive.key}`);
    expect(keys).toEqual(["disable-step:method:ping", "disable-step:tool:skill_install", "refresh-args:tool:find"]);
    expect(drift.every((d) => d.source === "drift")).toBe(true);
  });
});

describe("remediation classification", () => {
  const pingNode: SuiteNode = { id: "n_ping", type: "sampler", enabled: true, method: "ping", label: "Ping" };
  it("a ping failure on a modern server is a suite fix, not a server finding", () => {
    const c = classifyRemediation({ failedNodes: [{ nodeId: "n_ping", errorCount: 1 }], failReasons: 1, suiteNodes: [pingNode], protocolVersion: "2026-07-28" });
    expect(c.kind).toBe("suite_fix");
  });
  it("suite_bug-only findings never implicate the server", () => {
    expect(classifyRemediation({ findings: [{ category: "suite_bug", nodeIds: ["x"] }], failedNodes: [{ nodeId: "x", errorCount: 1 }] }).kind).toBe("suite_fix");
    expect(classifyRemediation({ findings: [{ category: "server_bug" }] }).kind).toBe("server");
  });
  it("pendingReviewNote is empty with nothing pending", () => {
    expect(pendingReviewNote([])).toBe("");
  });
});
