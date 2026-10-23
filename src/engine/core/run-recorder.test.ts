import { describe, expect, it } from "vitest";
import { RunRecorder, truncatePayload } from "./run-recorder.js";

describe("RunRecorder", () => {
  it("keeps the first success and first error per tool with redacted args", () => {
    const rec = new RunRecorder(1_000);
    rec.recordToolCall({ tool: "echo", ok: true, latencyMs: 5, args: { message: "hi", api_key: "k" }, result: { content: [{ text: "hi" }] }, at: 1_100 });
    rec.recordToolCall({ tool: "echo", ok: true, latencyMs: 6, args: { message: "second" }, result: "second", at: 1_200 });
    rec.recordToolCall({ tool: "echo", ok: false, latencyMs: 7, args: {}, errorClass: "tool", errorMessage: "boom Bearer abc.def", at: 2_500 });
    const [sample] = rec.sampleResults();
    expect(sample.tool).toBe("echo");
    expect(sample.success?.args).toEqual({ message: "hi", api_key: "[REDACTED]" });
    expect(sample.success?.response).toEqual({ content: [{ text: "hi" }] });
    expect(sample.success?.atMs).toBe(100);
    expect(sample.error?.errorClass).toBe("tool");
    expect(sample.error?.errorMessage).toBe("boom [REDACTED]");
  });

  it("truncates large payloads to the byte limit", () => {
    const big = { text: "x".repeat(10_000) };
    const out = truncatePayload(big, 4096);
    expect(out.truncated).toBe(true);
    expect(typeof out.value).toBe("string");
    expect(Buffer.byteLength(out.value as string)).toBeLessThanOrEqual(4096);
    expect(out.bytes).toBeGreaterThan(10_000);
    const rec = new RunRecorder(0);
    rec.recordToolCall({ tool: "big", ok: true, latencyMs: 1, result: big, at: 0 });
    expect(rec.sampleResults()[0].success?.truncated).toBe(true);
  });

  it("builds dense per-second buckets with per-tool counts, latency, and vus", () => {
    const rec = new RunRecorder(0);
    rec.recordToolCall({ tool: "a", ok: true, latencyMs: 10, at: 100 });
    rec.recordToolCall({ tool: "a", ok: false, latencyMs: 30, at: 200 });
    rec.recordToolCall({ tool: "b", ok: true, latencyMs: 20, at: 900 });
    rec.recordToolCall({ tool: "a", ok: true, latencyMs: 40, at: 2_100 });
    const series = rec.timeSeries(3_500);
    expect(series.map((b) => b.t)).toEqual([0, 1, 2, 3]);
    expect(series[0]).toMatchObject({ calls: 3, errors: 1, byTool: { a: { calls: 2, errors: 1 }, b: { calls: 1, errors: 0 } } });
    expect(series[0].latency).toEqual({ p50: 20, p95: 30 });
    expect(series[0].byToolLatency.a).toEqual({ p50: 10, p95: 30 });
    expect(series[1]).toMatchObject({ calls: 0, errors: 0, byTool: {}, latency: { p50: 0, p95: 0 } });
    expect(series[2].calls).toBe(1);
  });

  it("is not limited by a line cap", () => {
    const rec = new RunRecorder(0);
    for (let i = 0; i < 5_000; i++) rec.recordToolCall({ tool: "t", ok: true, latencyMs: 1, at: i * 10 });
    const total = rec.timeSeries(50_000).reduce((n, b) => n + b.calls, 0);
    expect(total).toBe(5_000);
  });
});

describe("RunRecorder long spans", () => {
  it("falls back to sparse buckets past the dense cap", () => {
    const rec = new RunRecorder(0);
    rec.recordToolCall({ tool: "t", ok: true, latencyMs: 1, at: 5_000 });
    const series = rec.timeSeries(1e12);
    expect(series.map((b) => b.t)).toEqual([5]);
  });
});
