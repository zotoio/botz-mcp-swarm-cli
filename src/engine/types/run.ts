import type { TransportType } from "./manifest.js";

export type ErrorClass =
  | "none"
  | "protocol"
  | "application"
  | "timeout"
  | "transport"
  | "quota"
  | "allowlist"
  | "auth"
  | "rate_limit";

export type RunVerdict = "pass" | "fail";

export interface LatencyPercentiles {
  /** Arithmetic mean of the samples. */
  mean?: number;
  /** Sample standard deviation. Zero when fewer than two samples exist. */
  std?: number;
  p50: number;
  p90?: number;
  p95: number;
  p99: number;
}

export interface ToolSeries {
  /** Alias of the server, on multi-server runs only. */
  server?: string;
  toolName: string;
  count: number;
  errorRate: number;
  errorClass: Record<ErrorClass, number>;
  latencyMs: LatencyPercentiles;
  bytesIn: number;
  bytesOut: number;
}

export interface RpcSeries {
  /** Alias of the server, on multi-server runs only. */
  server?: string;
  method: string;
  count: number;
  errorRate: number;
  latencyMs: LatencyPercentiles;
}

export interface RampDownSummary {
  strategy: "graceful" | "immediate";
  /** Calls that failed after the drain deadline (cut off, not counted as errors). */
  cancelledByRampDown: number;
  /** Passes stopped before their last step by the drain deadline. */
  incompletePasses: number;
  /** Optional passes not started because the estimate would not finish before the drain deadline. */
  skippedPasses: number;
  /** Rolling pass estimate (p90) at the end of the run, if any pass completed. */
  passEstimateMs?: number;
  /** Epoch-relative ms from run start to the final drain deadline. */
  drainDeadlineMs: number;
}

export interface ScenarioOutcome {
  scenario: string;
  outcome: "pass" | "fail" | "error";
  message?: string;
}

export interface SessionMetrics {
  transport: TransportType;
  started: number;
  active: number;
  failed: number;
}

export interface ProcessSample {
  ts: string;
  pid: number;
  runtime: "node" | "python";
  role: "worker" | "sut";
  rssBytes: number;
  cpuRatio: number;
}

export interface ProcessRoleSummary {
  pid: number;
  runtime: "node" | "python";
  role: "worker" | "sut";
  samples: number;
  rssBytes: { min: number; max: number; last: number };
  cpuRatio: { min: number; max: number; avg: number; last: number };
}

export interface ProcessSummary {
  worker: ProcessRoleSummary;
  /** The default server's process, or all server processes on a single-server run. */
  sut: ProcessRoleSummary | null;
  /** Stdio server processes by alias, on multi-server runs. */
  suts?: Record<string, ProcessRoleSummary>;
  otelSpikeFlag: boolean;
}

export type RunMode = "smoke" | "soak" | "load";

export type HopFailureClass =
  | "gateway_timeout"
  | "gateway_auth"
  | "gateway_routing"
  | "upstream_unreachable"
  | "upstream_error";

export interface HopFailure {
  index: number;
  class: HopFailureClass;
  edgeToEdgeMs: number;
  hopMs?: number;
}

export type GatewayHopSource = "header" | "edge-only" | "mixed";

export interface GatewayMetrics {
  mode: "gateway";
  gatewayId?: string;
  edgeToEdgeMs: LatencyPercentiles;
  hopMs?: LatencyPercentiles;
  /** Whether hopMs came from gateway headers, edge-only timing, or a mix. */
  hopSource: GatewayHopSource;
  hopFailures: HopFailure[];
}

/** One server of a run, with its calls and sessions. */
export interface RunServerSummary extends RunServer {
  alias: string;
  calls: number;
  errorRate: number;
  latencyMs: LatencyPercentiles;
  sessionMetrics: SessionMetrics;
}

/** Whole passes: one virtual user from a scenario's first step to its last. */
export interface FlowMetrics {
  passes: number;
  /** Passes whose scenario outcome was fail or error. */
  passesFailed: number;
  /** Passes where a missing required variable stopped later steps. */
  passesSkipped: number;
  latencyMs: LatencyPercentiles;
}

/** How often an extractor found a value. Values are never recorded. */
export interface VariableSummary {
  name: string;
  /** Node id of the extractor. */
  setBy: string;
  /** Alias of the server whose result it read, on multi-server runs. */
  server?: string;
  resolved: number;
  missing: number;
  resolvedRate: number;
}

/** The MCP server a run exercised. */
export interface RunServer {
  /** From the run's live `initialize` result; a saved-suite run falls back to the suite's recorded surface. */
  name?: string;
  version?: string;
  transport: TransportType;
  /** HTTP URL without userinfo, query, or fragment, or the stdio command basename and its arguments. */
  endpoint: string;
}

export interface RunReport {
  id: string;
  manifestName: string;
  manifestHash: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  verdict: RunVerdict;
  failReasons: string[];
  silentGreen: boolean;
  mode: RunMode;
  transport: TransportType;
  /** The default server. */
  server?: RunServer;
  /** Every server the run used, default first. */
  servers?: RunServerSummary[];
  /** Whole-pass timing and outcomes. */
  flow?: FlowMetrics;
  /** Extractor results, without values. */
  variables?: VariableSummary[];
  soak?: {
    iterations: number;
    durationMs: number;
    intervalMs: number;
  };
  sessionMetrics: SessionMetrics;
  processSeries?: ProcessSample[];
  processSummary?: ProcessSummary;
  toolSeries: ToolSeries[];
  rpcSeries: RpcSeries[];
  scenarioOutcomes: ScenarioOutcome[];
  quotas: {
    concurrencyUsed: number;
    callCount: number;
    maxPayloadBytesSeen: number;
  };
  /** Effective call-count and payload limits enforced on this run. */
  limits?: { maxCallCount: number; maxPayloadBytes: number };
  principal?: string;
  scheduleId?: string;
  /** Values substituted for ${name} on this run. */
  params?: Record<string, string>;
  gatewayMetrics?: GatewayMetrics;
  otelExported?: boolean;
  otelStatus?: "disabled" | "configured" | "delivered" | "failed";
  projectId?: string;
  suiteId?: string;
  suiteVersion?: number;
  loadProfile?: {
    durationMs: number;
    rampUpMs: number;
    maxConcurrency: number;
    jitterMs: number;
    rampDownMs: number;
    dwellMs?: number;
    iterations?: number;
    lanes?: number;
    rampDown?: { strategy?: "graceful" | "immediate"; drainTimeoutMs?: number; passEstimateMs?: number };
  };
  /** Work cut off by ramp-down or the drain deadline. Excluded from error rate, thresholds and pass/fail. */
  rampDown?: RampDownSummary;
  /** Tools by server. Entries without `server` belong to the default server. */
  catalog?: Array<{ server?: string; name: string; schemaHash: string; writeLike?: boolean }>;
  nodeOutcomes?: Array<{
    nodeId: string;
    label: string;
    /** Alias of the server, on multi-server runs only. */
    server?: string;
    count: number;
    errorCount: number;
    /** Passes where this step did not run because a required variable upstream was missing. */
    skipped?: number;
    errorMessage?: string;
    /** Rate-limited attempts that were retried (not counted in errorCount). */
    retries?: number;
  }>;
  /** Rate-limit retries. Only final outcomes count toward error rates. */
  retries?: {
    total: number;
    reason: "rate_limit";
    byMethod: Record<string, number>;
    sessionSetup: number;
  };
  /** First substituted args sample per node, with secrets redacted. */
  redactedArgs?: Array<{ nodeId: string; tool?: string; args: unknown }>;
  /** One result per eval prompt attached to a tool step. */
  toolEvals?: ToolEvalCaseResult[];
  /** Active VUs and TPS over time, overall and per tool, with peak/avg summary. */
  loadTimeline?: import("../core/load-timeline.js").LoadTimeline;
  /** Per tool: first successful and first failed call, args redacted, payloads truncated to 4KB. */
  sampleResults?: RunSample[];
  /** Per-second buckets covering the whole run (not limited by the log tail). */
  timeSeries?: RunTimeBucket[];
  /** Tail of the run log, newest lines last. */
  log?: string[];
}

export interface RunSampleEntry {
  /** Ms since run start when the call completed. */
  atMs: number;
  latencyMs: number;
  nodeId?: string;
  /** Redacted call arguments (a truncated JSON string when over the limit). */
  args: unknown;
  /** Redacted tool result (a truncated JSON string when over the limit). */
  response?: unknown;
  responseBytes?: number;
  errorClass?: ErrorClass;
  errorMessage?: string;
  truncated?: boolean;
}

export interface RunSample {
  tool: string;
  success?: RunSampleEntry;
  error?: RunSampleEntry;
}

export interface RunTimeBucket {
  /** Seconds since run start. */
  t: number;
  calls: number;
  errors: number;
  byTool: Record<string, { calls: number; errors: number }>;
  /** Active virtual users at the end of the second (load mode; 0 otherwise unless set). */
  vus: number;
  latency: { p50: number; p95: number };
  byToolLatency: Record<string, { p50: number; p95: number }>;
}

export interface ToolEvalAssertionResult {
  id: string;
  text: string;
  pass: boolean;
  reason: string;
  /** Jev noul probability when that judge answered. */
  score?: number;
}

export interface ToolEvalCaseResult {
  id: string;
  nodeId: string;
  tool: string;
  polarity: "positive" | "negative";
  prompt: string;
  pass: boolean;
  judge: "jev" | "llm" | "none";
  toolCalls: Array<{ name: string; arguments: Record<string, unknown>; result?: unknown }>;
  polarityPass: boolean;
  assertions: ToolEvalAssertionResult[];
  reason?: string;
}

export type CatalogCompareStatus = "unchanged" | "added" | "removed" | "schema-changed";

export interface RunProgressEvent {
  ts: string;
  runId: string;
  name:
    | "mcp.rpc.duration"
    | "mcp.tool.call.duration"
    | "mcp.tool.call.errors"
    | "mcp.scenario.result"
    | "mcp.session.start"
    | "mcp.load.vus"
    | "mcp.step"
    | "mcp.retry"
    | "process.runtime"
    | "sut.stderr"
    | "run.finished";
  attributes: Record<string, string | number | boolean>;
}

export interface CompareDelta {
  /** Alias of the server, when either report is multi-server. */
  server?: string;
  toolName: string;
  catalogStatus: CatalogCompareStatus;
  /** Latency and error rate are scored only when the tool exists on both sides with the same schema. */
  scored: boolean;
  baseP95: number | null;
  headP95: number | null;
  p95Delta: number;
  p95DeltaPct: number;
  baseErrorRate: number | null;
  headErrorRate: number | null;
  errorRateDelta: number;
}

export interface CompareReport {
  baseRunId: string;
  headRunId: string;
  generatedAt: string;
  baseServer?: RunServer;
  headServer?: RunServer;
  /** Flow p95 in each report, when both have one. */
  flow?: { baseP95: number; headP95: number; p95Delta: number; p95DeltaPct: number };
  /** Base and head ran against different servers or endpoints, so deltas may not measure one server. */
  warnings: string[];
  deltas: CompareDelta[];
  regressions: string[];
}
