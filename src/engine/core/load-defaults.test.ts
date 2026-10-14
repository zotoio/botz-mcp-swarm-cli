import { afterEach, describe, expect, it, vi } from "vitest";
import { blankSuiteNode, defaultLoadProfile, estimatePassMs, generatedLoadProfile, normalizeLoadProfile, type SuiteNode } from "./suite-model.js";
import { parseManifest } from "../types/manifest.js";
import { runManifest } from "./runner.js";
import * as adapters from "../adapters/index.js";

afterEach(() => vi.restoreAllMocks());
describe("run defaults", () => {
  it("uses one user, lane, and required pass with a bounded drain grace period", () => {
    expect(defaultLoadProfile()).toEqual({ durationMs: 30000, rampUpMs: 5000, maxConcurrency: 1, jitterMs: 100, rampDownMs: 60000, dwellMs: 100, iterations: 1, lanes: 1 });
    expect(normalizeLoadProfile({ durationMs: 0, rampUpMs: 0, rampDownMs: 0, dwellMs: 0, jitterMs: 0, iterations: 3, lanes: 2 })).toMatchObject({ durationMs: 0, rampUpMs: 0, rampDownMs: 0, dwellMs: 0, jitterMs: 0, iterations: 3, lanes: 2 });
  });
  it.each([undefined, 0])("finishes a 25-second in-flight pass with default grace, respecting explicit drain %s", async (rampDownMs) => {
    let now = 100000;
    let calls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(adapters, "createSession").mockResolvedValue({
      id: "fixture", close: async () => {}, getServerMeta: () => ({ capabilities: { tools: {} } }), serverInfo: () => ({}),
      callTool: async () => {
        calls += 1;
        now += calls === 3 ? 25000 : 10;
        return { success: true, latencyMs: 10, bytesIn: 1, bytesOut: 1, errorClass: "none", result: { content: [{ type: "text", text: "ok" }] } };
      },
    } as unknown as adapters.McpSession);
    const manifest = parseManifest({
      name: "drain-default", target: { transport: "streamable-http", url: "https://fixture.example/mcp" }, allowlist: ["fixture.example"],
      load: { durationMs: 100, rampUpMs: 0, maxConcurrency: 1, dwellMs: 0, jitterMs: 0, ...(rampDownMs === undefined ? {} : { rampDownMs }) },
      scenarios: [{ name: "two steps", steps: [{ method: "tools/call", tool: "echo" }, { method: "tools/call", tool: "echo" }] }],
    });
    const report = await runManifest({ manifest });
    expect(calls).toBe(rampDownMs === 0 ? 3 : 4);
    expect(report.failReasons.join(" ").includes("ramp-down deadline")).toBe(rampDownMs === 0);
    expect(report.verdict).toBe(rampDownMs === 0 ? "fail" : "pass");
  });
  it("sizes a generated suite's ramp-down from introspection latency", () => {
    const sampler = (method: SuiteNode["method"]): SuiteNode => ({ ...blankSuiteNode("sampler"), method });
    const loop: SuiteNode = { ...blankSuiteNode("loop"), iterations: 3, children: [sampler("tools/call")] };
    const off: SuiteNode = { ...sampler("tools/call"), enabled: false };
    const nodes = [sampler("initialize"), sampler("tools/list"), loop, { ...blankSuiteNode("think"), thinkMs: 50 }, off];
    expect(estimatePassMs(nodes, { connectMs: 1000, rpcMs: 100 }, 10)).toBe(1000 + 100 + 300 + 50 + 6 * 10);
    expect(generatedLoadProfile(nodes)).toEqual(defaultLoadProfile());
    expect(generatedLoadProfile(nodes, { connectMs: 20, rpcMs: 2 }).rampDownMs).toBe(60_000);
    expect(generatedLoadProfile(nodes, { connectMs: 15_000, rpcMs: 4_000 }).rampDownMs).toBe(317_000);
    expect(generatedLoadProfile(nodes, { connectMs: 600_000, rpcMs: 600_000 }).rampDownMs).toBe(30 * 60_000);
  });
});
