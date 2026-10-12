import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultLoadProfile, normalizeLoadProfile } from "./suite-model.js";
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
});
