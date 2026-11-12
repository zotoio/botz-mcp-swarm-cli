import type { Counter, Histogram, Meter, Tracer } from "@opentelemetry/api";
import type { RunReport } from "../types/run.js";
import type { CallObservation } from "../core/metrics.js";
import type { ProcessSample } from "../core/process-gauges.js";
import type { DwellKind } from "../core/dwell.js";
import type { RateLimitSource, RetryEvent, RetryGiveUpEvent } from "../core/rate-limit-retry.js";
import {
  buildTenantResourceAttributes,
  stripSecretAttributes,
  validateOtelExporterHeaders,
} from "./sanitize.js";

export interface TelemetryHandle {
  exportStatus?(): "disabled" | "configured" | "delivered" | "failed";
  recordCall(obs: CallObservation, transport: string): void;
  recordScenario(scenario: string, outcome: string): void;
  recordSessionStart(transport: string, result: string): void;
  recordProcessSample(sample: ProcessSample): void;
  /** One measured pause between calls. Optional: older handles predate pacing telemetry. */
  recordDwell?(durationMs: number, attrs: { kind: DwellKind; server?: string }): void;
  /** One retry that was slept through, with the backoff it waited. */
  recordRetry?(event: RetryEvent, method: string): void;
  /** One retry loop that gave up while still rate-limited. */
  recordRetryExhausted?(event: RetryGiveUpEvent, method: string): void;
  /** One observed rate-limit / unavailable signal, whether or not it was retried. */
  recordRateLimitSignal?(source: RateLimitSource, method: string): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

let metricsProvider: import("@opentelemetry/sdk-metrics").MeterProvider | null = null;
let traceProvider: import("@opentelemetry/sdk-trace-node").NodeTracerProvider | null = null;
let meter: Meter | null = null;
let tracer: ReturnType<import("@opentelemetry/api").TraceAPI["getTracer"]> | null = null;

const instruments = {
  sessionStart: null as Counter | null,
  scenarioResult: null as Counter | null,
  toolErrors: null as Counter | null,
  rpcDuration: null as Histogram | null,
  toolDuration: null as Histogram | null,
  payloadBytes: null as Histogram | null,
  rss: null as Histogram | null,
  cpu: null as Histogram | null,
  dwellDuration: null as Histogram | null,
  retryBackoff: null as Histogram | null,
  retryAttempts: null as Counter | null,
  retryExhausted: null as Counter | null,
  rateLimitSignals: null as Counter | null,
};

function getEndpoint(): string | undefined {
  // Package-specific collectors win so the CLI, Swarm service, and target servers do not share one exporter by accident.
  const ep =
    process.env.SWARM_CLI_OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
    process.env.SWARM_OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return ep ? ep.replace(/\/$/, "") : undefined;
}

export function isOtelEnabled(): boolean {
  return Boolean(getEndpoint());
}

/** Exported so a test can bind the instruments to a fake meter without an OTLP endpoint. */
export function bindInstruments(m: Meter): void {
  instruments.sessionStart = m.createCounter("mcp.session.start");
  instruments.scenarioResult = m.createCounter("mcp.scenario.result");
  instruments.toolErrors = m.createCounter("mcp.tool.call.errors");
  instruments.rpcDuration = m.createHistogram("mcp.rpc.duration", { unit: "ms" });
  instruments.toolDuration = m.createHistogram("mcp.tool.call.duration", { unit: "ms" });
  instruments.payloadBytes = m.createHistogram("mcp.payload.bytes", { unit: "By" });
  instruments.rss = m.createHistogram("process.runtime.rss.bytes", { unit: "By" });
  instruments.cpu = m.createHistogram("process.runtime.cpu.ratio");
  instruments.dwellDuration = m.createHistogram("mcp.client.dwell.duration", { unit: "ms" });
  instruments.retryBackoff = m.createHistogram("mcp.retry.backoff.duration", { unit: "ms" });
  instruments.retryAttempts = m.createCounter("mcp.retry.attempts");
  instruments.retryExhausted = m.createCounter("mcp.retry.exhausted");
  instruments.rateLimitSignals = m.createCounter("mcp.rate_limit.signals");
}

export interface TelemetryInitOptions {
  runId: string;
  githubOrg?: string;
  tenantId?: string;
}

export async function initTelemetry(
  runIdOrOpts: string | TelemetryInitOptions,
): Promise<TelemetryHandle> {
  const opts =
    typeof runIdOrOpts === "string"
      ? { runId: runIdOrOpts, githubOrg: process.env.SWARM_GITHUB_ORG ?? "zotoio" }
      : runIdOrOpts;
  const endpoint = getEndpoint();
  if (!endpoint) {
    return createNoopTelemetry();
  }

  const headerCheck = validateOtelExporterHeaders();
  if (!headerCheck.ok) {
    console.warn(`OTEL export disabled: ${headerCheck.reason}`);
    return createNoopTelemetry();
  }

  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const { OTLPMetricExporter } = await import(
    "@opentelemetry/exporter-metrics-otlp-http"
  );
  const { OTLPTraceExporter } = await import(
    "@opentelemetry/exporter-trace-otlp-http"
  );
  const { MeterProvider, PeriodicExportingMetricReader } = await import(
    "@opentelemetry/sdk-metrics"
  );
  const { NodeTracerProvider } = await import("@opentelemetry/sdk-trace-node");
  const { SimpleSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
  const { metrics } = await import("@opentelemetry/api");

  const resource = resourceFromAttributes(
    buildTenantResourceAttributes({
      githubOrg: opts.githubOrg ?? "zotoio",
      tenantId: opts.tenantId,
      runId: opts.runId,
    }),
  );

  let delivered = 0;
  let failed = false;
  const metricExporter = new OTLPMetricExporter({
    timeoutMillis: 3000,
    url: `${endpoint}/v1/metrics`,
  });
  const exportMetrics = metricExporter.export.bind(metricExporter);
  metricExporter.export = (data, callback) => exportMetrics(data, (result) => {
    if (!result.error) delivered++;
    else failed = true;
    callback(result);
  });
  metricsProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 2000,
      }),
    ],
  });
  try {
    metrics.disable();
    metrics.setGlobalMeterProvider(metricsProvider);
  } catch {
    // Global meter provider may already be locked after a prior init in the same process.
  }
  meter = metricsProvider.getMeter("botz-mcp-swarm");
  bindInstruments(meter);

  const traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, timeoutMillis: 3000 });
  const exportTraces = traceExporter.export.bind(traceExporter);
  traceExporter.export = (data, callback) => exportTraces(data, (result) => {
    if (!result.error) delivered++;
    else failed = true;
    callback(result);
  });
  traceProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(traceExporter)],
  });
  traceProvider.register();
  const localTracer = traceProvider.getTracer("botz-mcp-swarm");
  tracer = localTracer;

  return {
    ...createActiveTelemetry(meter, localTracer),
    exportStatus: () => (failed ? "failed" : delivered > 0 ? "delivered" : "configured"),
  };
}

/**
 * The exporting handle. Instruments live on the module (bound by `bindInstruments`), so a test can
 * bind a fake meter and pass a fake tracer here instead of standing up an OTLP endpoint.
 */
export function createActiveTelemetry(_activeMeter: Meter | null = meter, activeTracer: Tracer | null = tracer): TelemetryHandle {
  return {
    recordCall(obs, transport) {
      const result = obs.errorClass === "none" ? "ok" : obs.errorClass;
      const server = obs.server ? { "mcp.server.alias": obs.server } : {};
      instruments.rpcDuration?.record(obs.latencyMs, {
        method: obs.method,
        transport,
        result,
        ...server,
      });
      if (obs.method === "tools/call" && obs.toolName) {
        instruments.toolDuration?.record(obs.latencyMs, {
          tool: obs.toolName,
          transport,
          result,
          session_reuse: String(obs.sessionReuse),
          ...server,
        });
        if (obs.errorClass !== "none") {
          instruments.toolErrors?.add(1, {
            tool: obs.toolName,
            error_class: obs.errorClass,
          });
        }
      }
      instruments.payloadBytes?.record(obs.bytesIn + obs.bytesOut, {
        direction: "total",
        method: obs.method,
      });
      activeTracer
        ?.startSpan(`mcp.${obs.method}`, {
          attributes: stripSecretAttributes({
            "mcp.method": obs.method,
            "mcp.tool": obs.toolName ?? "",
            ...server,
            Authorization: "Bearer should-not-export",
          }),
        })
        .end();
    },
    recordScenario(scenario, outcome) {
      instruments.scenarioResult?.add(1, { scenario, outcome });
    },
    recordSessionStart(transport, result) {
      instruments.sessionStart?.add(1, { transport, result });
    },
    recordProcessSample(sample) {
      instruments.rss?.record(sample.rssBytes, {
        runtime: sample.runtime,
        role: sample.role,
      });
      instruments.cpu?.record(sample.cpuRatio, {
        runtime: sample.runtime,
        role: sample.role,
      });
    },
    recordDwell(durationMs, attrs) {
      const server = attrs.server ? { "mcp.server.alias": attrs.server } : {};
      instruments.dwellDuration?.record(durationMs, { kind: attrs.kind, ...server });
      // The span covers the wait itself, so it lines up with the calls either side of it.
      const endedAt = Date.now();
      activeTracer
        ?.startSpan("mcp.dwell", {
          startTime: endedAt - durationMs,
          attributes: stripSecretAttributes({ "mcp.dwell.kind": attrs.kind, "mcp.dwell.duration_ms": durationMs, ...server }),
        })
        .end(endedAt);
    },
    recordRetry(event, method) {
      const attrs = {
        reason: event.reason,
        source: event.source,
        method,
      };
      instruments.retryAttempts?.add(1, attrs);
      instruments.retryBackoff?.record(event.delayMs, {
        ...attrs,
        retry_after: String(event.retryAfterHonoured),
      });
      const endedAt = Date.now();
      activeTracer
        ?.startSpan("mcp.retry.backoff", {
          startTime: endedAt - event.delayMs,
          attributes: stripSecretAttributes({
            "mcp.method": method,
            "mcp.retry.reason": event.reason,
            "mcp.retry.source": event.source,
            "mcp.retry.attempt": event.attempt,
            "mcp.retry.delay_ms": event.delayMs,
            "mcp.retry.retry_after": event.retryAfterHonoured,
          }),
        })
        .end(endedAt);
    },
    recordRetryExhausted(event, method) {
      instruments.retryExhausted?.add(1, {
        reason: event.reason,
        source: event.source,
        method,
        cause: event.cause,
      });
    },
    recordRateLimitSignal(source, method) {
      instruments.rateLimitSignals?.add(1, { source, method });
    },
    async flush() {
      await metricsProvider?.forceFlush();
      await traceProvider?.forceFlush();
    },
    async shutdown() {
      const results = await Promise.allSettled([metricsProvider?.shutdown(), traceProvider?.shutdown()]);
      metricsProvider = null;
      traceProvider = null;
      meter = null;
      tracer = null;
      instruments.sessionStart = null;
      instruments.scenarioResult = null;
      instruments.toolErrors = null;
      instruments.rpcDuration = null;
      instruments.toolDuration = null;
      instruments.payloadBytes = null;
      instruments.rss = null;
      instruments.cpu = null;
      instruments.dwellDuration = null;
      instruments.retryBackoff = null;
      instruments.retryAttempts = null;
      instruments.retryExhausted = null;
      instruments.rateLimitSignals = null;
      if (results.some((result) => result.status === "rejected")) throw new Error("telemetry shutdown failed");
    },
  };
}

function createNoopTelemetry(): TelemetryHandle {
  return {
    exportStatus: () => "disabled",
    recordCall() {},
    recordScenario() {},
    recordSessionStart() {},
    recordProcessSample() {},
    recordDwell() {},
    recordRetry() {},
    recordRetryExhausted() {},
    recordRateLimitSignal() {},
    async flush() {},
    async shutdown() {},
  };
}

export async function exportRunToOtel(
  report: RunReport,
  opts?: { githubOrg?: string },
): Promise<void> {
  if (!isOtelEnabled()) return;
  const tel = await initTelemetry({
    runId: report.id,
    githubOrg: opts?.githubOrg ?? process.env.SWARM_GITHUB_ORG ?? "zotoio",
  });
  for (const tool of report.toolSeries) {
    tel.recordCall(
      {
        method: "tools/call",
        toolName: tool.toolName,
        latencyMs: tool.latencyMs.p95,
        errorClass: tool.errorRate > 0 ? "application" : "none",
        bytesIn: tool.bytesIn,
        bytesOut: tool.bytesOut,
        sessionReuse: false,
      },
      report.transport,
    );
  }
  for (const outcome of report.scenarioOutcomes) {
    tel.recordScenario(outcome.scenario, outcome.outcome);
  }
  for (const sample of report.processSeries ?? []) {
    tel.recordProcessSample(sample);
  }
  // Retries and pacing only survive in the report as aggregates, so they are replayed as counts on
  // the same series (no per-event attributes to reconstruct, and no spans for waits long past).
  const retries = report.retries;
  if (retries) {
    for (const [method, count] of Object.entries(retries.byMethod)) {
      if (count > 0) instruments.retryAttempts?.add(count, { method });
    }
    for (const [source, count] of Object.entries(retries.bySource ?? {})) {
      if (count > 0) instruments.rateLimitSignals?.add(count, { source });
    }
    for (const [cause, count] of Object.entries(retries.exhaustedByCause ?? {})) {
      if ((count ?? 0) > 0) instruments.retryExhausted?.add(count!, { cause });
    }
  }
  for (const kind of report.pacing?.byKind ?? []) {
    instruments.dwellDuration?.record(kind.meanMs, { kind: kind.kind });
  }
  await tel.flush();
  await tel.shutdown();
}
