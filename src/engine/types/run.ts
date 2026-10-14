import type { TransportType } from "./manifest.js";

export type ErrorClass =
  | "none"
  | "protocol"
  | "application"
  | "timeout"
  | "transport"
  | "quota"
  | "allowlist"
  | "auth";

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
  toolName: string;
  count: number;
  errorRate: number;
  errorClass: Record<ErrorClass, number>;
  latencyMs: LatencyPercentiles;
  bytesIn: number;
  bytesOut: number;
}

export interface RpcSeries {
  method: string;
  count: number;
  errorRate: number;
  latencyMs: LatencyPercentiles;
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
  sut: ProcessRoleSummary | null;
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
  server?: RunServer;
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
  };
  catalog?: Array<{ name: string; schemaHash: string; writeLike?: boolean }>;
  nodeOutcomes?: Array<{
    nodeId: string;
    label: string;
    count: number;
    errorCount: number;
    errorMessage?: string;
  }>;
  /** First substituted args sample per node, with secrets redacted. */
  redactedArgs?: Array<{ nodeId: string; tool?: string; args: unknown }>;
  /** One result per eval prompt attached to a tool step. */
  toolEvals?: ToolEvalCaseResult[];
  /** Tail of the run log, newest lines last. */
  log?: string[];
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
    | "process.runtime"
    | "sut.stderr"
    | "run.finished";
  attributes: Record<string, string | number | boolean>;
}

export interface CompareDelta {
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
  /** Base and head ran against different servers or endpoints, so deltas may not measure one server. */
  warnings: string[];
  deltas: CompareDelta[];
  regressions: string[];
}
