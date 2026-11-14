import type { Meter, Tracer } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindInstruments, createActiveTelemetry, initTelemetry } from "./telemetry.js";

interface Recorded {
  instrument: string;
  value: number;
  attrs: Record<string, unknown>;
}
interface Span {
  name: string;
  startTime?: number;
  endTime?: number;
  attributes: Record<string, unknown>;
}

function fakes() {
  const recorded: Recorded[] = [];
  const spans: Span[] = [];
  const point = (instrument: string) => ({
    record: (value: number, attrs: Record<string, unknown> = {}) => recorded.push({ instrument, value, attrs }),
    add: (value: number, attrs: Record<string, unknown> = {}) => recorded.push({ instrument, value, attrs }),
  });
  const meter = {
    createHistogram: (name: string) => point(name),
    createCounter: (name: string) => point(name),
  } as unknown as Meter;
  const tracer = {
    startSpan: (name: string, options?: { startTime?: number; attributes?: Record<string, unknown> }) => {
      const span: Span = { name, startTime: options?.startTime, attributes: options?.attributes ?? {} };
      spans.push(span);
      return { end: (endTime?: number) => { span.endTime = endTime; } };
    },
  } as unknown as Tracer;
  bindInstruments(meter);
  return { recorded, spans, telemetry: createActiveTelemetry(meter, tracer) };
}

const of = (recorded: Recorded[], instrument: string) => recorded.filter((item) => item.instrument === instrument);

afterEach(() => vi.unstubAllEnvs());

describe("pacing and retry instruments", () => {
  it("records a dwell as a duration histogram and a span covering the wait", async () => {
    const { recorded, spans, telemetry } = fakes();
    telemetry.recordDwell?.(120, { kind: "step" });
    telemetry.recordDwell?.(40, { kind: "pass_jitter" });
    expect(of(recorded, "mcp.client.dwell.duration")).toEqual([
      { instrument: "mcp.client.dwell.duration", value: 120, attrs: { kind: "step" } },
      { instrument: "mcp.client.dwell.duration", value: 40, attrs: { kind: "pass_jitter" } },
    ]);
    expect(spans.map((span) => span.name)).toEqual(["mcp.dwell", "mcp.dwell"]);
    const [first] = spans;
    expect(first!.attributes).toMatchObject({ "mcp.dwell.kind": "step", "mcp.dwell.duration_ms": 120 });
    expect(first!.endTime! - first!.startTime!).toBe(120);
    await telemetry.shutdown();
  });

  it("records a retry's backoff, attempt count and signal source", async () => {
    const { recorded, spans, telemetry } = fakes();
    telemetry.recordRetry?.(
      { attempt: 2, delayMs: 2000, reason: "rate_limit", source: "http_429", retryAfterMs: 2000, retryAfterHonoured: true },
      "tools/call",
    );
    expect(of(recorded, "mcp.retry.attempts")).toEqual([
      { instrument: "mcp.retry.attempts", value: 1, attrs: { reason: "rate_limit", source: "http_429", method: "tools/call" } },
    ]);
    expect(of(recorded, "mcp.retry.backoff.duration")).toEqual([
      {
        instrument: "mcp.retry.backoff.duration",
        value: 2000,
        attrs: { reason: "rate_limit", source: "http_429", method: "tools/call", retry_after: "true" },
      },
    ]);
    expect(spans[0]).toMatchObject({
      name: "mcp.retry.backoff",
      attributes: { "mcp.method": "tools/call", "mcp.retry.source": "http_429", "mcp.retry.attempt": 2 },
    });
    await telemetry.shutdown();
  });

  it("counts exhausted retries by cause and raw rate-limit signals by source", async () => {
    const { recorded, telemetry } = fakes();
    telemetry.recordRetryExhausted?.(
      { reason: "unavailable", source: "unavailable", attempts: 4, cause: "budget" },
      "tools/call",
    );
    telemetry.recordRateLimitSignal?.("mcp_protocol", "initialize");
    expect(of(recorded, "mcp.retry.exhausted")).toEqual([
      {
        instrument: "mcp.retry.exhausted",
        value: 1,
        attrs: { reason: "unavailable", source: "unavailable", method: "tools/call", cause: "budget" },
      },
    ]);
    expect(of(recorded, "mcp.rate_limit.signals")).toEqual([
      { instrument: "mcp.rate_limit.signals", value: 1, attrs: { source: "mcp_protocol", method: "initialize" } },
    ]);
    await telemetry.shutdown();
  });

  it("strips secret attributes from the new spans", async () => {
    const { spans, telemetry } = fakes();
    telemetry.recordDwell?.(10, { kind: "wave" });
    for (const span of spans) {
      expect(Object.keys(span.attributes).some((key) => /authorization|token|secret/i.test(key))).toBe(false);
    }
    await telemetry.shutdown();
  });

  it("is safe on the noop handle used when no collector is configured", async () => {
    for (const name of ["SWARM_CLI_OTEL_EXPORTER_OTLP_ENDPOINT", "SWARM_OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT"]) {
      vi.stubEnv(name, "");
    }
    const telemetry = await initTelemetry("run-noop");
    expect(telemetry.exportStatus?.()).toBe("disabled");
    telemetry.recordDwell?.(10, { kind: "step" });
    telemetry.recordRetry?.({ attempt: 1, delayMs: 1, reason: "rate_limit", source: "mcp_protocol", retryAfterHonoured: false }, "ping");
    telemetry.recordRetryExhausted?.({ reason: "rate_limit", source: "mcp_protocol", attempts: 1, cause: "max_retries" }, "ping");
    telemetry.recordRateLimitSignal?.("http_429", "ping");
    await telemetry.flush();
    await telemetry.shutdown();
  });
});
