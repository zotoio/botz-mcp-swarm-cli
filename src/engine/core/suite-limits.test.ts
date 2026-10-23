import { describe, expect, it } from "vitest";
import { DEFAULT_SUITE_LIMITS, SUITE_LIMIT_CEILINGS, SuiteLimitsSchema, parseSuiteLimit, resolveSuiteLimits } from "./suite-limits.js";
import { QuotaExceededError, QuotaTracker } from "./quotas.js";
import { compileSuite, type SuiteNode } from "./suite-model.js";
import { SuiteInputSchema } from "../../cli/suite-schema.js";
import { suiteLimitFlags } from "../../cli/run-commands.js";
import { parseManifest } from "../types/manifest.js";

const nodes: SuiteNode[] = [{ id: "a", type: "sampler", enabled: true, method: "ping" }];
const target = { transport: "streamable-http" as const, url: "http://localhost:1/mcp" };

describe("suite limits parsing", () => {
  it("accepts positive integers within the ceiling", () => {
    expect(parseSuiteLimit("maxCallCount", "5")).toBe(5);
    expect(parseSuiteLimit("maxPayloadBytes", " 2048 ")).toBe(2048);
    expect(parseSuiteLimit("maxCallCount", undefined)).toBeUndefined();
    expect(parseSuiteLimit("maxCallCount", "")).toBeUndefined();
    expect(parseSuiteLimit("maxCallCount", String(SUITE_LIMIT_CEILINGS.maxCallCount))).toBe(SUITE_LIMIT_CEILINGS.maxCallCount);
  });
  it.each(["0", "-1", "1.5", "abc", "1e3", "9007199254740993"])("rejects %s", (value) => {
    expect(() => parseSuiteLimit("maxCallCount", value)).toThrow(/positive integer/);
  });
  it("rejects values above the ceiling", () => {
    expect(() => parseSuiteLimit("maxCallCount", String(SUITE_LIMIT_CEILINGS.maxCallCount + 1))).toThrow(/<=/);
    expect(() => parseSuiteLimit("maxPayloadBytes", String(SUITE_LIMIT_CEILINGS.maxPayloadBytes + 1))).toThrow(/<=/);
    expect(SuiteLimitsSchema.safeParse({ maxPayloadBytes: SUITE_LIMIT_CEILINGS.maxPayloadBytes + 1 }).success).toBe(false);
    expect(SuiteLimitsSchema.safeParse({ maxCallCount: 0 }).success).toBe(false);
    expect(SuiteLimitsSchema.safeParse({ maxCallCount: 2.5 }).success).toBe(false);
    expect(SuiteLimitsSchema.safeParse({ other: 1 }).success).toBe(false);
  });
  it("parses CLI flags", () => {
    expect(suiteLimitFlags({ maxCallCount: "10" })).toEqual({ maxCallCount: 10 });
    expect(() => suiteLimitFlags({ maxPayloadBytes: "0" })).toThrow(/max-payload-bytes/);
  });
});

describe("suite limits precedence", () => {
  const env = { SWARM_MAX_CALL_COUNT: "30", SWARM_MAX_PAYLOAD_BYTES: "300" };
  it("uses defaults when nothing is set", () => {
    expect(resolveSuiteLimits({ env: {} })).toEqual({ ...DEFAULT_SUITE_LIMITS, source: { maxCallCount: "default", maxPayloadBytes: "default" } });
  });
  it("flag > suite > env > default, per field", () => {
    expect(resolveSuiteLimits({ suite: { maxCallCount: 10, maxPayloadBytes: 100 }, flags: { maxCallCount: 20 }, env }))
      .toEqual({ maxCallCount: 20, maxPayloadBytes: 100, source: { maxCallCount: "flag", maxPayloadBytes: "suite" } });
    expect(resolveSuiteLimits({ suite: { maxCallCount: 10 }, env }))
      .toEqual({ maxCallCount: 10, maxPayloadBytes: 300, source: { maxCallCount: "suite", maxPayloadBytes: "env" } });
    expect(resolveSuiteLimits({ flags: { maxPayloadBytes: 200 }, env: {} }))
      .toEqual({ maxCallCount: 100_000, maxPayloadBytes: 200, source: { maxCallCount: "default", maxPayloadBytes: "flag" } });
  });
  it("validates env values", () => {
    expect(() => resolveSuiteLimits({ env: { SWARM_MAX_CALL_COUNT: "nope" } })).toThrow(/SWARM_MAX_CALL_COUNT/);
  });
});

describe("suite limits schema and compile", () => {
  it("suite files accept and validate limits", () => {
    const base = { kind: "botz-suite", name: "s", target, nodes, params: {}, surface: { capabilities: [], tools: [] } };
    expect(SuiteInputSchema.safeParse({ ...base, limits: { maxCallCount: 5 } }).success).toBe(true);
    expect(SuiteInputSchema.safeParse({ ...base, limits: { maxCallCount: -5 } }).success).toBe(false);
  });
  it("compileSuite keeps defaults and applies limits", () => {
    expect(compileSuite({ name: "s", target, allowlist: [], nodes, load: {} }).quotas)
      .toMatchObject({ maxCallCount: 100_000, maxPayloadBytes: 1_048_576 });
    expect(compileSuite({ name: "s", target, allowlist: [], nodes, load: {}, limits: { maxCallCount: 7, maxPayloadBytes: 9 } }).quotas)
      .toMatchObject({ maxCallCount: 7, maxPayloadBytes: 9 });
  });
  it("manifests keep their defaults and enforce the ceiling", () => {
    const m = { name: "m", target, allowlist: ["localhost"], scenarios: [{ name: "x", steps: [{ method: "ping" }] }] };
    expect(parseManifest(m).quotas).toMatchObject({ maxCallCount: 1000, maxPayloadBytes: 1_048_576 });
    expect(() => parseManifest({ ...m, quotas: { maxCallCount: SUITE_LIMIT_CEILINGS.maxCallCount + 1 } })).toThrow();
  });
});

describe("suite limits enforcement", () => {
  const quotas = { maxConcurrency: 1, maxDurationMs: 60_000, maxCallCount: 2, maxPayloadBytes: 10 };
  it("stops after maxCallCount calls", () => {
    const tracker = new QuotaTracker(quotas);
    tracker.recordCall(1);
    tracker.recordCall(1);
    expect(() => tracker.recordCall(1)).toThrow(QuotaExceededError);
  });
  it("rejects payloads above maxPayloadBytes", () => {
    const tracker = new QuotaTracker(quotas);
    tracker.recordCall(10);
    expect(() => tracker.recordCall(11)).toThrow(/exceeds limit of 10 bytes/);
  });
});

describe("runner records and enforces limits", () => {
  it("records effective limits in the report and fails past maxCallCount", async () => {
    const { vi } = await import("vitest");
    const adapters = await import("../adapters/index.js");
    const { runManifest } = await import("./runner.js");
    let calls = 0;
    const spy = vi.spyOn(adapters, "createSession").mockResolvedValue({
      id: "fixture", close: async () => {}, getServerMeta: () => ({ capabilities: { tools: {} } }), serverInfo: () => ({}),
      callTool: async () => { calls += 1; return { success: true, latencyMs: 1, bytesIn: 1, bytesOut: 1, errorClass: "none", result: { content: [] } }; },
    } as unknown as import("../adapters/index.js").McpSession);
    try {
      const manifest = parseManifest({
        name: "cap", target: { transport: "streamable-http", url: "https://fixture.example/mcp" }, allowlist: ["fixture.example"],
        quotas: { maxCallCount: 2, maxPayloadBytes: 4096 },
        scenarios: [{ name: "s", iterations: 1, steps: [1, 2, 3].map(() => ({ method: "tools/call", tool: "echo" })) }],
      });
      const report = await runManifest({ manifest });
      expect(report.limits).toEqual({ maxCallCount: 2, maxPayloadBytes: 4096 });
      expect(report.verdict).toBe("fail");
      expect(report.quotas.callCount).toBeLessThanOrEqual(3);
    } finally { spy.mockRestore(); }
  });
});
