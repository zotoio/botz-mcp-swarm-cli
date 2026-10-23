import { afterEach, describe, expect, it, vi } from "vitest";
import { mayStartPass, passEstimateMs, vuRetireAtMs } from "./suite-model.js";
import { parseManifest } from "../types/manifest.js";
import { runManifest } from "./runner.js";
import type { RunProgressEvent } from "../types/run.js";
import * as adapters from "../adapters/index.js";

afterEach(() => vi.restoreAllMocks());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type CallResult = { ok: boolean; latencyMs: number };

function fakeSession(call: (startedAt: number) => Promise<CallResult>) {
  vi.spyOn(adapters, "createSession").mockImplementation(async () => ({
    id: "fixture", close: async () => {}, getServerMeta: () => ({ capabilities: { tools: {} } }), serverInfo: () => ({}),
    callTool: async () => {
      const { ok, latencyMs } = await call(Date.now());
      return ok
        ? { success: true, latencyMs, bytesIn: 1, bytesOut: 1, errorClass: "none", result: { content: [{ type: "text", text: "ok" }] } }
        : { success: false, latencyMs, bytesIn: 1, bytesOut: 0, errorClass: "timeout", errorMessage: "timed out" };
    },
  }) as unknown as adapters.McpSession);
}

function manifest(load: Record<string, unknown>, steps = 4) {
  return parseManifest({
    name: "ramp-down", target: { transport: "streamable-http", url: "https://fixture.example/mcp" }, allowlist: ["fixture.example"],
    load: { rampUpMs: 0, dwellMs: 0, jitterMs: 0, iterations: 1, ...load },
    scenarios: [{ name: "suite", steps: Array.from({ length: steps }, () => ({ method: "tools/call", tool: "search_files" })) }],
  });
}

describe("ramp-down helpers", () => {
  it("retires VUs linearly across the window, last-started first; immediate retires all at hold end", () => {
    const load = { rampUpMs: 100, durationMs: 900, rampDownMs: 400 };
    expect([0, 1, 2, 3].map((i) => vuRetireAtMs(i, 4, 0, load))).toEqual([1400, 1300, 1200, 1100]);
    expect(vuRetireAtMs(0, 4, 0, { ...load, rampDown: { strategy: "immediate" } })).toBe(1000);
    expect(vuRetireAtMs(0, 4, 0, { ...load, rampDownMs: 0 })).toBe(1000);
    expect(vuRetireAtMs(0, 4, 0, { ...load, durationMs: 0 })).toBe(100);
  });
  it("uses the p90 of completed passes, falling back to the configured estimate", () => {
    expect(passEstimateMs([], 500)).toBe(500);
    expect(passEstimateMs([])).toBeUndefined();
    expect(passEstimateMs([10, 20, 30, 40, 50, 60, 70, 80, 90, 1000])).toBe(90);
  });
  it("does not start a pass that would not finish before the drain deadline", () => {
    expect(mayStartPass(900, 1000, 1200, 200, "graceful")).toBe(true);
    expect(mayStartPass(900, 1000, 1200, 301, "graceful")).toBe(false);
    expect(mayStartPass(900, 1000, 1200, 301, "immediate")).toBe(true);
    expect(mayStartPass(1000, 1000, 5000, 1, "graceful")).toBe(false);
    expect(mayStartPass(900, 1000, 1200, undefined, "graceful")).toBe(true);
  });
});

describe("ramp-down runs", () => {
  it("soak in miniature: second passes cut by the drain deadline do not fail the suite", async () => {
    // Pass ≈ 4 × 100ms. Every VU starts a second pass during the 500ms hold; the drain deadline
    // (≈650ms) cuts it mid-suite, like the 500-VU soak where 458 second passes were stopped.
    fakeSession(async () => {
      await sleep(100);
      return { ok: true, latencyMs: 100 };
    });
    const report = await runManifest({ manifest: manifest({ maxConcurrency: 10, durationMs: 500, rampDownMs: 150, rampDown: { strategy: "immediate" } }) });
    expect(report.failReasons).toEqual([]);
    expect(report.verdict).toBe("pass");
    expect(report.scenarioOutcomes.filter((o) => o.outcome === "pass")).toHaveLength(10);
    expect(report.rampDown).toMatchObject({ strategy: "immediate", incompletePasses: 10, cancelledByRampDown: 0 });
    expect(report.toolSeries.find((t) => t.toolName === "search_files")?.errorRate ?? 0).toBe(0);
  });

  it("calls failing after the drain deadline are cancelled, not errors", async () => {
    // Pass ≈ 4 × 100ms; the second pass's third call starts ≈600ms and ends ≈700ms, after the
    // ≈650ms deadline, and fails as a server would when the client hangs up.
    const t0 = Date.now();
    fakeSession(async (startedAt) => {
      await sleep(100);
      return { ok: startedAt < t0 + 550, latencyMs: 100 };
    });
    const report = await runManifest({ manifest: manifest({ maxConcurrency: 4, durationMs: 500, rampDownMs: 150, rampDown: { strategy: "immediate" } }) });
    expect(report.failReasons).toEqual([]);
    expect(report.verdict).toBe("pass");
    expect(report.rampDown).toMatchObject({ incompletePasses: 4, cancelledByRampDown: 4 });
    expect(report.toolSeries.every((t) => t.errorRate === 0)).toBe(true);
  });

  it("graceful: passes that fit keep running and none is cut off", async () => {
    let calls = 0;
    fakeSession(async () => {
      calls += 1;
      await sleep(5);
      return { ok: true, latencyMs: 5 };
    });
    const report = await runManifest({ manifest: manifest({ maxConcurrency: 3, durationMs: 60, rampDownMs: 30, rampDown: { passEstimateMs: 60_000 } }) });
    // The configured 60s estimate only applies before a pass completes; the p90 (~20ms) then
    // takes over, so passes run while they fit and none is ever cut off.
    expect(report.verdict).toBe("pass");
    expect(report.rampDown).toMatchObject({ strategy: "graceful", incompletePasses: 0, cancelledByRampDown: 0 });
    expect(calls % 4).toBe(0);
  });

  it("graceful: no new pass starts near the end when the rolling estimate cannot finish it", async () => {
    let calls = 0;
    // Pass ≈ 4 × 50ms = 200ms; after the first pass only ~10ms of hold is left and no ramp-down window.
    fakeSession(async () => {
      calls += 1;
      await sleep(50);
      return { ok: true, latencyMs: 50 };
    });
    const report = await runManifest({ manifest: manifest({ maxConcurrency: 3, durationMs: 210, rampDownMs: 0 }) });
    expect(report.verdict).toBe("pass");
    expect(report.rampDown).toMatchObject({ incompletePasses: 0, skippedPasses: 3 });
    expect(calls).toBe(3 * 4);
  });

  it("graceful: VUs retire gradually across the ramp-down window and the VU series steps down", async () => {
    fakeSession(async () => {
      await sleep(10);
      return { ok: true, latencyMs: 10 };
    });
    const events: RunProgressEvent[] = [];
    const t0 = Date.now();
    const report = await runManifest({
      manifest: manifest({ maxConcurrency: 4, durationMs: 50, rampDownMs: 3000 }, 1),
      onProgress: (event) => events.push(event),
    });
    const drops = events
      .filter((e) => e.name === "mcp.load.vus")
      .map((e) => ({ t: Date.parse(e.ts) - t0, active: Number(e.attributes.active) }))
      .filter((e, i, all) => i > 0 && e.active < all[i - 1]!.active);
    expect(drops.map((d) => d.active)).toEqual([3, 2, 1, 0]);
    // Retirements are spread across the window (~750ms apart), not all at hold end.
    expect(drops[3]!.t - drops[0]!.t).toBeGreaterThan(1500);
    expect(report.verdict).toBe("pass");
    expect(report.rampDown).toMatchObject({ incompletePasses: 0, cancelledByRampDown: 0 });
    // The 1s-bucket timeline steps down instead of dropping from 4 to 0 in one bucket.
    const vus = report.loadTimeline!.points.map((p) => p.vus);
    expect(vus[0]).toBe(4);
    expect(vus.some((v) => v > 0 && v < 4)).toBe(true);
    expect(vus.length).toBeGreaterThanOrEqual(3);
  });

  it("real errors before ramp-down still fail the suite", async () => {
    let calls = 0;
    fakeSession(async () => {
      calls += 1;
      await sleep(5);
      return { ok: calls !== 2, latencyMs: 5 };
    });
    const report = await runManifest({ manifest: manifest({ maxConcurrency: 1, durationMs: 10, rampDownMs: 1000 }) });
    expect(report.verdict).toBe("fail");
    expect(report.failReasons.join(" ")).toMatch(/error_rate|Scenario suite fail/);
    expect(report.rampDown!.cancelledByRampDown).toBe(0);
  });
});
