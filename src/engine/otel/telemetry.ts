import type { Counter, Histogram, Meter } from "@opentelemetry/api";
import type { RunReport } from "../types/run.js";
import type { CallObservation } from "../core/metrics.js";
import type { ProcessSample } from "../core/process-gauges.js";
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
};

function getEndpoint(): string | undefined {
  // CLI-specific collector wins so the CLI never shares a collector with Swarm or botz-mcp by accident.
  const ep = process.env.SWARM_CLI_OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return ep ? ep.replace(/\/$/, "") : undefined;
}

export function isOtelEnabled(): boolean {
  return Boolean(getEndpoint());
}

function bindInstruments(m: Meter): void {
  instruments.sessionStart = m.createCounter("mcp.session.start");
  instruments.scenarioResult = m.createCounter("mcp.scenario.result");
  instruments.toolErrors = m.createCounter("mcp.tool.call.errors");
  instruments.rpcDuration = m.createHistogram("mcp.rpc.duration", { unit: "ms" });
  instruments.toolDuration = m.createHistogram("mcp.tool.call.duration", { unit: "ms" });
  instruments.payloadBytes = m.createHistogram("mcp.payload.bytes", { unit: "By" });
  instruments.rss = m.createHistogram("process.runtime.rss.bytes", { unit: "By" });
  instruments.cpu = m.createHistogram("process.runtime.cpu.ratio");
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
  const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
  const { metrics, trace } = await import("@opentelemetry/api");

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
    if (result.code === 0) delivered++; else failed = true;
    callback(result);
  });
  metricsProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 3000,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(metricsProvider);
  meter = metrics.getMeter("botz-mcp-swarm");
  bindInstruments(meter);

  const traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, timeoutMillis: 3000 });
  const exportTraces = traceExporter.export.bind(traceExporter);
  traceExporter.export = (data, callback) => exportTraces(data, (result) => {
    if (result.code === 0) delivered++; else failed = true;
    callback(result);
  });
  traceProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
  });
  traceProvider.register();
  tracer = trace.getTracer("botz-mcp-swarm");

  return { ...createActiveTelemetry(), exportStatus: () => failed ? "failed" : delivered > 0 ? "delivered" : "configured" };
}

function createActiveTelemetry(): TelemetryHandle {
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
      tracer
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
  await tel.flush();
  await tel.shutdown();
}
