import { afterEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "../types/manifest.js";
import { runManifest } from "./runner.js";
import type { RunProgressEvent } from "../types/run.js";
import * as adapters from "../adapters/index.js";

/** Pacing and retry aggregates land on the report with no OTEL collector configured. */

afterEach(() => vi.restoreAllMocks());

const ok = {
  success: true,
  latencyMs: 1,
  bytesIn: 1,
  bytesOut: 1,
  errorClass: "none",
  result: { content: [{ type: "text", text: "ok" }] },
};
const rateLimited = {
  success: false,
  latencyMs: 1,
  bytesIn: 1,
  bytesOut: 1,
  errorClass: "rate_limit",
  errorMessage: "Too Many Requests: slow down",
};

/** Stand in for the server: its first `rateLimitedCalls` tool calls report rate limiting. */
function fixtureServer(rateLimitedCalls: number): void {
  let calls = 0;
  vi.spyOn(adapters, "createSession").mockResolvedValue({
    id: "fixture",
    close: async () => {},
    getServerMeta: () => ({ capabilities: { tools: {} } }),
    serverInfo: () => ({}),
    callTool: async () => {
      calls += 1;
      return calls <= rateLimitedCalls ? rateLimited : ok;
    },
  } as unknown as adapters.McpSession);
}

function manifestFor(load: Record<string, unknown>, steps = 3) {
  return parseManifest({
    name: "pacing",
    target: { transport: "streamable-http", url: "https://fixture.example/mcp" },
    allowlist: ["fixture.example"],
    retry: { baseMs: 2, maxDelayMs: 4, maxRetries: 2 },
    load: { durationMs: 0, rampUpMs: 0, rampDownMs: 0, maxConcurrency: 1, jitterMs: 0, iterations: 1, ...load },
    scenarios: [{
      name: "steps",
      steps: Array.from({ length: steps }, () => ({ method: "tools/call" as const, tool: "echo" })),
    }],
  });
}

describe("run pacing", () => {
  it("records one jittered dwell per step gap, inside the configured bounds", async () => {
    fixtureServer(0);
    const report = await runManifest({ manifest: manifestFor({ dwellMs: 20, dwellJitterRatio: 0.5 }) });
    expect(report.verdict).toBe("pass");
    expect(report.pacing).toMatchObject({ dwellMs: 20, dwellJitterRatio: 0.5, passJitterMs: 0 });
    const step = report.pacing!.byKind.find((kind) => kind.kind === "step");
    expect(step).toMatchObject({ count: 2 });
    expect(step!.minMs).toBeGreaterThanOrEqual(10);
    expect(step!.meanMs).toBe(Math.round(step!.totalMs / step!.count));
  });

  it("reports no pacing when the suite has no dwell", async () => {
    fixtureServer(0);
    const report = await runManifest({ manifest: manifestFor({ dwellMs: 0 }) });
    expect(report.pacing).toBeUndefined();
  });

  it("measures the pass-level jitter of a load run", async () => {
    fixtureServer(0);
    // Pass jitter is uniform in 0..jitterMs, and a draw of 0 would be no pause at all.
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const report = await runManifest({
      manifest: manifestFor({ durationMs: 300, dwellMs: 0, jitterMs: 10, iterations: 2 }, 1),
      mode: "load",
    });
    expect(report.pacing?.byKind.map((kind) => kind.kind)).toEqual(["pass_jitter"]);
    expect(report.pacing).toMatchObject({ dwellMs: 0, passJitterMs: 10 });
    expect(report.pacing!.byKind[0]!.maxMs).toBeLessThan(100);
  });
});

describe("run retries", () => {
  it("splits retries by reason and source, and counts honoured Retry-After", async () => {
    fixtureServer(1);
    const events: RunProgressEvent[] = [];
    const report = await runManifest({
      manifest: manifestFor({ dwellMs: 0 }),
      onProgress: (event) => events.push(event),
    });
    expect(report.verdict).toBe("pass");
    expect(report.retries).toMatchObject({
      total: 1,
      reason: "rate_limit",
      byMethod: { "tools/call": 1 },
      sessionSetup: 0,
      byReason: { rate_limit: 1, unavailable: 0 },
      bySource: { http_429: 0, mcp_protocol: 1, unavailable: 0 },
      retryAfterHonoured: 0,
      exhausted: 0,
    });
    expect(report.retries!.totalBackoffMs).toBeGreaterThanOrEqual(0);
    const retryEvents = events.filter((event) => event.name === "mcp.retry");
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0]!.attributes).toMatchObject({
      reason: "rate_limit",
      source: "mcp_protocol",
      method: "tools/call",
      retryAfterHonoured: false,
    });
  });

  it("counts a retry loop that ran out of attempts", async () => {
    fixtureServer(Number.MAX_SAFE_INTEGER);
    const report = await runManifest({ manifest: manifestFor({ dwellMs: 0 }, 1) });
    expect(report.verdict).toBe("fail");
    expect(report.retries).toMatchObject({
      total: 2,
      exhausted: 1,
      exhaustedByCause: { max_retries: 1 },
      bySource: { http_429: 0, mcp_protocol: 2, unavailable: 0 },
    });
  });
});
