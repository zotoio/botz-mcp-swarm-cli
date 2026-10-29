import { createHmac } from "node:crypto";
import type { SuiteLimitsInput } from "../engine/core/suite-limits.js";
import { compileProjectSuite, runCompiledSuite } from "../engine/core/project-run.js";
import { assertOrgTargetAllowlisted } from "../engine/core/org-target-policy.js";
import { normalizeLoadProfile, type LoadProfile, type SuiteNode } from "../engine/core/suite-model.js";
import type { CallSlo } from "../engine/core/call-slo.js";
import type { AllowlistEntry } from "../engine/service/mcp-allowlist.js";
import type { Target } from "../engine/types/manifest.js";
import { DEFAULT_SERVER } from "../engine/core/servers.js";
import type { RunProgressEvent, RunReport } from "../engine/types/run.js";
import { SWARM_TESTER_USER_AGENT } from "../engine/adapters/http-fetch.js";
import {
  defaultScrubContext,
  makeReportScrubber,
  scrubReport,
  stdioCommandPaths,
  targetSecretValues,
  type ScrubContext,
} from "./report-scrub.js";
import { resolveTargetSecrets } from "./suite-auth.js";
import {
  connectHttp2,
  connectSse,
  serverOrigin,
  WorkerAuthError,
  type CloseReason,
  type ConnectOptions,
  type ServerFrame,
  type TransportKind,
  type VuSliceAssignment,
  type WorkerFrame,
  type WorkerTransport,
} from "./worker-transport.js";

export const WORKER_TOKEN_ENV = "SWARM_WORKER_TOKEN";
export const WORKER_MAX_VUS_ENV = "SWARM_WORKER_MAX_VUS";
export const DEFAULT_WORKER_MAX_VUS = 50;

export type TransportChoice = "auto" | TransportKind;

/** Progress names the service accepts (every `RunProgressEvent` name except `run.finished`). */
const PROGRESS_NAMES = new Set<string>([
  "mcp.rpc.duration",
  "mcp.tool.call.duration",
  "mcp.tool.call.errors",
  "mcp.scenario.result",
  "mcp.session.start",
  "mcp.load.vus",
  "mcp.step",
  "process.runtime",
  "sut.stderr",
]);
/** Leaves room under the service's 8 MiB frame limit. */
const MAX_REPORT_BYTES = 7 * 1024 * 1024;
/** Stops sending this long before the service's execution deadline. */
const DEADLINE_MARGIN_MS = 5_000;
const MAX_QUEUED_PROGRESS = 500;

/** `--token` wins over `SWARM_WORKER_TOKEN` and `SWARM_TOKEN`. Empty values count as missing. */
export function resolveWorkerToken(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const token = flag?.trim() || env[WORKER_TOKEN_ENV]?.trim() || env.SWARM_TOKEN?.trim();
  if (!token) throw new Error(`worker token missing: pass --token or set ${WORKER_TOKEN_ENV}`);
  return token;
}

export function resolveWorkerMaxVus(flag: string | number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const raw = flag !== undefined ? String(flag).trim() : env[WORKER_MAX_VUS_ENV]?.trim();
  if (!raw) return DEFAULT_WORKER_MAX_VUS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new Error(`--max-vus must be an integer between 1 and 10000`);
  }
  return parsed;
}

export function parseTransportChoice(value: string | undefined): TransportChoice {
  const choice = (value ?? "auto").trim().toLowerCase();
  if (choice === "auto" || choice === "http2" || choice === "sse") return choice;
  throw new Error("--transport must be auto, http2, or sse");
}

/** Exponential backoff with up to 25% jitter. `attempt` starts at 0. */
export function backoffDelay(attempt: number, initialMs = 1_000, maxMs = 30_000, random: () => number = Math.random): number {
  const base = Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt));
  return Math.round(Math.min(maxMs, base + base * 0.25 * random()));
}

/** Suite payload from `GET /api/worker/executions/:executionId/suite`. */
export type WorkerSuite = {
  executionId: string;
  projectId: string;
  projectName: string;
  suiteId: string;
  suiteName: string;
  version: number;
  destructive: boolean;
  principal: string;
  /** Steps' `server` fields hold aliases from `targets`. */
  suite: { name: string; nodes: SuiteNode[]; load: LoadProfile; slo?: CallSlo; serverSlos?: Record<string, CallSlo>; limits?: SuiteLimitsInput };
  /** The default server. */
  target: Target;
  /** Other servers the steps call, by alias. */
  targets?: Record<string, Target>;
  /** Alias of `target`. Absent means `default`. */
  defaultServer?: string;
  allowlist: string[];
  catalog: Array<{ server?: string; name: string; schemaHash: string; writeLike: boolean }>;
  policy: { targetAllowlist: AllowlistEntry[]; gatewayAllowlist: AllowlistEntry[] };
  limits: {
    runnerConstrained: boolean;
    runner: { maxDurationMs: number; maxConcurrency: number; maxIterations: number; maxDwellMs: number };
    executionDeadlineMs: number;
  };
  /** `server` names the alias a variable is for, on multi-server assignments. */
  requiredEnv: Array<{ name: string; source: "header" | "env"; key: string; mapped: boolean; server?: string }>;
  /** Optional distributed VU slice assignment when the central Swarm server shards VUs across multiple workers. */
  vuSlice?: VuSliceAssignment;
};

/** Apply a distributed VU slice assignment (or worker maxVus ceiling) to a suite's load profile. */
export function applyWorkerVuSlice(
  suite: WorkerSuite,
  frameSlice?: VuSliceAssignment,
  maxVus?: number,
): WorkerSuite {
  const slice = frameSlice ?? suite.vuSlice;
  let nextConcurrency = suite.suite.load.maxConcurrency;
  if (slice && typeof slice.assignedVus === "number" && slice.assignedVus >= 1) {
    nextConcurrency = slice.assignedVus;
  }
  if (typeof maxVus === "number" && maxVus >= 1 && nextConcurrency > maxVus) {
    nextConcurrency = maxVus;
  }
  if (nextConcurrency === suite.suite.load.maxConcurrency && !slice) return suite;
  return {
    ...suite,
    ...(slice ? { vuSlice: slice } : {}),
    suite: {
      ...suite.suite,
      load: {
        ...suite.suite.load,
        maxConcurrency: nextConcurrency,
      },
    },
  };
}

export const WORKER_OTEL_EXPORT_ENV = "SWARM_WORKER_OTEL_EXPORT";

/**
 * Sending telemetry to Swarm is opt-in (`--otel-export` or SWARM_WORKER_OTEL_EXPORT=1) and
 * requires the worker token. Throws a clear error when enabled without a token.
 */
export const WORKER_TELEMETRY_HMAC_SECRET_ENVS = ["SWARM_CLI_TELEMETRY_HMAC_SECRET", "SWARM_TELEMETRY_HMAC_SECRET"] as const;

/** Shared HMAC secret for signing telemetry sent to Swarm (never logged). */
export function resolveWorkerTelemetryHmacSecret(env: NodeJS.ProcessEnv = process.env): string {
  for (const name of WORKER_TELEMETRY_HMAC_SECRET_ENVS) {
    const v = env[name]?.trim();
    if (v) return v;
  }
  return "";
}

/** `X-Swarm-Signature` value: `sha256=<hex HMAC-SHA256(secret, body)>`. */
export function signTelemetryBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function resolveWorkerOtelExport(flag: boolean | undefined, token: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[WORKER_OTEL_EXPORT_ENV]?.trim().toLowerCase();
  const enabled = flag ?? (raw === "1" || raw === "true" || raw === "yes");
  if (enabled && !token?.trim() && !resolveWorkerTelemetryHmacSecret(env)) {
    throw new Error(
      `Swarm telemetry export is enabled but no key is configured: set ${WORKER_TELEMETRY_HMAC_SECRET_ENVS.join(" or ")}, or pass --token / set ${WORKER_TOKEN_ENV}`,
    );
  }
  return enabled;
}

/** Export OpenTelemetry metrics and trace spans for an execution back to the central Swarm server's `/otlp/v1/*` collector. */
export async function exportWorkerOtelToServer(input: {
  server: string;
  token: string;
  executionId: string;
  report: RunReport;
  scrub: (text: string) => string;
  fetchFn?: typeof fetch;
  /** Shared HMAC secret; when set, bodies are signed (X-Swarm-Signature) instead of sending the token. */
  hmacSecret?: string;
}): Promise<{ metricsOk: boolean; tracesOk: boolean }> {
  const hmacSecret = input.hmacSecret?.trim() ?? "";
  if (!hmacSecret && !input.token?.trim()) {
    throw new Error("Swarm telemetry export requires a key (HMAC secret or worker token); refusing to send unauthenticated telemetry");
  }
  const origin = serverOrigin(input.server);
  const doFetch = input.fetchFn ?? fetch;
  const runAttr = { key: "run.id", value: { stringValue: input.executionId } };
  const svcAttr = { key: "service.name", value: { stringValue: "botz-mcp-swarm-worker" } };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(hmacSecret ? {} : { "x-swarm-token": input.token }),
    "x-swarm-run-id": input.executionId,
    "user-agent": SWARM_TESTER_USER_AGENT,
  };

  const metricsList: Array<Record<string, unknown>> = [];
  for (const ts of input.report.toolSeries ?? []) {
    const toolName = input.scrub(ts.toolName);
    metricsList.push({
      name: "mcp.tool.call.duration",
      unit: "ms",
      histogram: {
        dataPoints: [
          {
            count: ts.count,
            sum: Math.round((ts.latencyMs?.mean ?? ts.latencyMs?.p50 ?? 0) * ts.count),
            attributes: [
              runAttr,
              svcAttr,
              { key: "tool", value: { stringValue: toolName } },
              { key: "result", value: { stringValue: ts.errorRate > 0 ? "error" : "ok" } },
            ],
          },
        ],
      },
    });
  }
  if (input.report.processSummary?.worker) {
    metricsList.push({
      name: "process.runtime.rss.bytes",
      unit: "By",
      gauge: {
        dataPoints: [
          {
            asDouble: input.report.processSummary.worker.rssBytes.max,
            attributes: [runAttr, svcAttr, { key: "role", value: { stringValue: "worker" } }],
          },
        ],
      },
    });
    metricsList.push({
      name: "process.runtime.cpu.ratio",
      unit: "1",
      gauge: {
        dataPoints: [
          {
            asDouble: input.report.processSummary.worker.cpuRatio.max,
            attributes: [runAttr, svcAttr, { key: "role", value: { stringValue: "worker" } }],
          },
        ],
      },
    });
  }

  const startMs = Date.parse(input.report.startedAt) || Date.now();
  const startNs = BigInt(startMs) * 1_000_000n;
  const spansList: Array<Record<string, unknown>> = (input.report.toolSeries ?? []).map((ts, idx) => {
    const durNs = BigInt(Math.max(1, Math.round((ts.latencyMs?.p95 ?? 1) * 1_000_000)));
    return {
      name: `mcp.tool.${input.scrub(ts.toolName)}`,
      traceId: input.executionId.replace(/[^0-9a-f]/gi, "").padEnd(32, "0").slice(0, 32),
      spanId: String(idx + 1).padStart(16, "0"),
      startTimeUnixNano: String(startNs),
      endTimeUnixNano: String(startNs + durNs),
      attributes: [
        runAttr,
        svcAttr,
        { key: "tool", value: { stringValue: input.scrub(ts.toolName) } },
        { key: "calls", value: { intValue: ts.count } },
      ],
    };
  });

  const signed = (body: string): Record<string, string> =>
    hmacSecret ? { ...headers, "x-swarm-signature": signTelemetryBody(hmacSecret, body) } : headers;
  let metricsOk = false;
  let tracesOk = false;
  try {
    const body = JSON.stringify({
      resourceMetrics: [{ resource: { attributes: [runAttr, svcAttr] }, scopeMetrics: [{ metrics: metricsList }] }],
    });
    const mRes = await doFetch(new URL("/otlp/v1/metrics", origin), { method: "POST", headers: signed(body), body });
    metricsOk = mRes.ok;
  } catch {
    metricsOk = false;
  }
  try {
    const body = JSON.stringify({
      resourceSpans: [{ resource: { attributes: [runAttr, svcAttr] }, scopeSpans: [{ spans: spansList }] }],
    });
    const tRes = await doFetch(new URL("/otlp/v1/traces", origin), { method: "POST", headers: signed(body), body });
    tracesOk = tRes.ok;
  } catch {
    tracesOk = false;
  }
  return { metricsOk, tracesOk };
}

/** Every target of an assignment by alias, default first. */
export function workerTargets(suite: Pick<WorkerSuite, "target" | "targets" | "defaultServer">): Array<[string, Target]> {
  return [[suite.defaultServer ?? DEFAULT_SERVER, suite.target], ...Object.entries(suite.targets ?? {})];
}

export function parseWorkerSuite(value: unknown): WorkerSuite | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<WorkerSuite>;
  const suite = payload.suite;
  const target = payload.target as { transport?: unknown } | undefined;
  if (typeof payload.executionId !== "string" || !suite || !Array.isArray(suite.nodes) || typeof suite.name !== "string") return null;
  if (!target || typeof target.transport !== "string") return null;
  if (payload.targets !== undefined && (typeof payload.targets !== "object" || payload.targets === null
    || Object.values(payload.targets).some((item) => typeof (item as { transport?: unknown })?.transport !== "string"))) return null;
  if (!payload.limits || typeof payload.limits.executionDeadlineMs !== "number") return null;
  return {
    ...(payload as WorkerSuite),
    allowlist: Array.isArray(payload.allowlist) ? payload.allowlist : [],
    catalog: Array.isArray(payload.catalog) ? payload.catalog : [],
    policy: {
      targetAllowlist: Array.isArray(payload.policy?.targetAllowlist) ? payload.policy.targetAllowlist : [],
      gatewayAllowlist: Array.isArray(payload.policy?.gatewayAllowlist) ? payload.policy.gatewayAllowlist : [],
    },
    requiredEnv: Array.isArray(payload.requiredEnv) ? payload.requiredEnv : [],
  };
}

/** Names from `requiredEnv` that are unset or empty here. Values are never read into the result. */
export function missingRequiredEnv(suite: Pick<WorkerSuite, "requiredEnv">, env: NodeJS.ProcessEnv): string[] {
  const names = new Set<string>();
  for (const ref of suite.requiredEnv) {
    if (typeof ref?.name === "string" && !env[ref.name]) names.add(ref.name);
  }
  return [...names].sort();
}

/** Second check of the runner ceilings the service already applied when it offered the run. */
export function runnerLimitViolation(suite: Pick<WorkerSuite, "suite" | "limits">): string | null {
  if (!suite.limits.runnerConstrained) return null;
  const load = normalizeLoadProfile(suite.suite.load);
  const limit = suite.limits.runner;
  const window = load.durationMs + load.rampUpMs + load.rampDownMs + (load.rampDown?.drainTimeoutMs ?? 0);
  if (window > limit.maxDurationMs) return `duration ${window}ms exceeds ${limit.maxDurationMs}ms`;
  if (load.maxConcurrency > limit.maxConcurrency) return `concurrency ${load.maxConcurrency} exceeds ${limit.maxConcurrency}`;
  if (load.iterations > limit.maxIterations) return `iterations ${load.iterations} exceeds ${limit.maxIterations}`;
  if (load.dwellMs > limit.maxDwellMs) return `dwell ${load.dwellMs}ms exceeds ${limit.maxDwellMs}`;
  return null;
}

/**
 * Removes the bearer, resolved target secrets, user paths, and the username from text sent to the service.
 * Same rules as a standalone `run --suite` report.
 */
export function makeScrubber(secrets: string[], context: Omit<ScrubContext, "secrets"> = defaultScrubContext()): (text: string) => string {
  return makeReportScrubber({ ...context, secrets });
}

export type SuiteRunner = (input: {
  suite: WorkerSuite;
  target: Target;
  /** Other servers, resolved, by alias. */
  targets?: Record<string, Target>;
  baseDir: string;
  onProgress: (event: RunProgressEvent) => void;
  /** Aborted when the run is withdrawn, times out, or the worker disconnects or stops. */
  signal: AbortSignal;
}) => Promise<RunReport>;

/** Builds the manifest the way an in-process project run does, then runs it through the shared core runner. */
export const runWorkerSuite: SuiteRunner = async ({ suite, target, targets, baseDir, onProgress, signal }) => {
  const manifest = compileProjectSuite({
    projectName: suite.projectName,
    suiteName: suite.suite.name,
    version: suite.version,
    target,
    targets,
    defaultServer: suite.defaultServer,
    serverSlos: suite.suite.serverSlos,
    allowlist: suite.allowlist,
    nodes: suite.suite.nodes,
    load: suite.suite.load,
    slo: suite.suite.slo,
    limits: suite.suite.limits,
  });
  return runCompiledSuite({
    manifest,
    manifestDir: baseDir,
    runId: suite.executionId,
    nodes: suite.suite.nodes,
    catalog: suite.catalog,
    principal: suite.principal,
    orgTargetAllowlist: suite.policy.targetAllowlist,
    orgGatewayAllowlist: suite.policy.gatewayAllowlist,
    onProgress,
    signal,
  });
};

export const STDIO_NOT_ALLOWED = "stdio_not_allowed: start the worker with --allow-stdio to run local commands";

export interface WorkerOptions {
  server: string;
  token: string;
  transport?: TransportChoice;
  /** Run stdio targets, which start a local command chosen by the service. Off by default. */
  allowStdio?: boolean;
  /** Directory relative stdio commands resolve against. Defaults to cwd. */
  baseDir?: string;
  /** Maximum VUs this worker will accept/execute per slice. */
  maxVus?: number;
  /** Opt-in: stream OpenTelemetry traces/metrics to `/otlp/v1/*` on the central Swarm server (token required). Default off. */
  otelExport?: boolean;
  /** Optional worker label advertised to the central Swarm server. */
  label?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  signal?: AbortSignal;
  backoff?: { initialMs?: number; maxMs?: number };
  connectTimeoutMs?: number;
  /** Reconnect when nothing (frame, ping, or keepalive) arrives for this long. */
  idleTimeoutMs?: number;
  /** Test hooks. */
  connect?: (kind: TransportKind, options: ConnectOptions) => Promise<WorkerTransport>;
  runSuite?: SuiteRunner;
  fetchFn?: typeof fetch;
}

export type WorkerExit = { code: number; reason: string };

/** The one execution this worker holds. It stays set until the run settles, even after it is abandoned. */
type Active = { executionId: string; abort: AbortController };
type WorkerState = { active: Active | null; running: Set<Promise<void>> };

/** Long-running worker: connect, take assignments one at a time, reconnect with backoff, stop on revoke or abort. */
export async function runWorker(options: WorkerOptions): Promise<WorkerExit> {
  const log = options.log ?? ((line: string) => console.log(line));
  const env = options.env ?? process.env;
  const choice = options.transport ?? "auto";
  const connect = options.connect ?? ((kind, opts) => (kind === "http2" ? connectHttp2(opts) : connectSse(opts)));
  const capabilities = ["vu-slice", ...(options.otelExport === true ? ["otel-export"] : [])];
  const connectOptions: ConnectOptions = {
    server: options.server,
    token: options.token,
    timeoutMs: options.connectTimeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    ...(options.maxVus ? { maxVus: options.maxVus } : {}),
    capabilities,
    ...(options.label ? { label: options.label } : {}),
  };
  const baseScrub = makeScrubber([options.token]);
  const state: WorkerState = { active: null, running: new Set() };
  let attempt = 0;
  log(options.allowStdio ? "Stdio targets: allowed (--allow-stdio)" : "Stdio targets: refused (start with --allow-stdio to run local commands)");

  const stop = async (exit: WorkerExit): Promise<WorkerExit> => {
    state.active?.abort.abort();
    if (state.running.size > 0) {
      log("Waiting for the current run to stop");
      await Promise.allSettled([...state.running]);
    }
    log("Worker stopped");
    return exit;
  };

  while (!options.signal?.aborted) {
    let transport: WorkerTransport;
    try {
      transport = await open(choice, connect, connectOptions, log, baseScrub);
    } catch (error) {
      if (error instanceof WorkerAuthError) return stop({ code: 1, reason: error.message });
      const delay = backoffDelay(attempt++, options.backoff?.initialMs, options.backoff?.maxMs);
      log(`Worker disconnected: ${baseScrub(messageOf(error))}; retrying in ${delay}ms`);
      if (!(await sleep(delay, options.signal))) break;
      continue;
    }

    const reason = await serve(transport, options, env, log, baseScrub, state, () => (attempt = 0));
    if (reason.kind === "revoked") {
      return stop({ code: 1, reason: "worker token was revoked (token_revoked); not reconnecting with this token" });
    }
    if (reason.kind === "unauthorized") return stop({ code: 1, reason: "worker token was rejected (401 unauthorized)" });
    if (reason.kind === "stopped" || options.signal?.aborted) break;
    const delay = backoffDelay(attempt++, options.backoff?.initialMs, options.backoff?.maxMs);
    log(`Worker disconnected: ${baseScrub(reason.error)}; reconnecting in ${delay}ms`);
    if (!(await sleep(delay, options.signal))) break;
  }
  return stop({ code: 0, reason: "stopped" });
}

async function open(
  choice: TransportChoice,
  connect: NonNullable<WorkerOptions["connect"]>,
  options: ConnectOptions,
  log: (line: string) => void,
  scrub: (text: string) => string,
): Promise<WorkerTransport> {
  if (choice !== "auto") return connect(choice, options);
  try {
    return await connect("http2", options);
  } catch (error) {
    if (error instanceof WorkerAuthError) throw error;
    log(`HTTP/2 worker session unavailable (${scrub(messageOf(error))}); falling back to SSE`);
    return connect("sse", options);
  }
}

async function serve(
  transport: WorkerTransport,
  options: WorkerOptions,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  scrub: (text: string) => string,
  state: WorkerState,
  connected: () => void,
): Promise<CloseReason> {
  const onAbort = () => transport.close();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const frame of transport.frames()) {
      switch (frame.type) {
        case "ready":
          connected();
          log(`Worker connected via ${transport.kind === "http2" ? "HTTP/2" : "SSE"} as ${frame.label ?? "worker"}; waiting for assignments`);
          break;
        case "assign": {
          const task = handleAssign(frame, transport, options, env, log, scrub, state);
          state.running.add(task);
          void task.finally(() => state.running.delete(task));
          break;
        }
        case "withdraw":
          if (state.active?.executionId === frame.executionId) {
            log(`Execution ${frame.executionId} withdrawn (${frame.reason}); abandoning it`);
            state.active.abort.abort();
          } else {
            log(`Execution ${frame.executionId} withdrawn (${frame.reason})`);
          }
          break;
        case "error":
          log(`Server error: ${frame.error}`);
          break;
        default:
          break;
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    // The service fails an accepted run when its channel closes, so the local run is abandoned.
    state.active?.abort.abort();
  }
  transport.close();
  return transport.closeReason() ?? { kind: "disconnected", error: "stream ended" };
}

async function handleAssign(
  frame: Extract<ServerFrame, { type: "assign" }>,
  transport: WorkerTransport,
  options: WorkerOptions,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  scrub: (text: string) => string,
  state: WorkerState,
): Promise<void> {
  const executionId = typeof frame.executionId === "string" && frame.executionId.trim() ? frame.executionId : "";
  if (!executionId) {
    log("Rejected an assignment with no execution id");
    await transport.send({ type: "reject", executionId: "", reason: "assign_missing_execution_id" });
    return;
  }
  if (state.active) {
    await transport.send({ type: "reject", executionId, reason: "worker_busy" });
    log(`Declined execution ${executionId}: busy with ${state.active.executionId}`);
    return;
  }
  const abort = new AbortController();
  const active: Active = { executionId, abort };
  state.active = active;
  try {
    const acceptFrame: WorkerFrame = {
      type: "accept",
      executionId,
      ...(options.maxVus ? { maxVus: options.maxVus } : {}),
    };
    const accepted = await transport.send(acceptFrame);
    if (!accepted.ok) {
      log(`Execution ${executionId} not accepted: ${accepted.error}`);
      return;
    }
    log(`Accepted execution ${executionId}`);
    const reject = async (reason: string) => {
      const text = scrub(reason);
      log(`Rejected execution ${executionId}: ${text}`);
      await transport.send({ type: "reject", executionId, reason: text });
    };

    const fetched = await transport.fetchSuite(executionId);
    if (!fetched.ok) return reject(`suite_unavailable: ${fetched.status} ${fetched.error}`);
    const rawSuite = parseWorkerSuite(fetched.payload);
    if (!rawSuite || rawSuite.executionId !== executionId) return reject("suite_invalid");
    const suite = applyWorkerVuSlice(rawSuite, frame.vuSlice, options.maxVus);
    const assigned = workerTargets(suite);
    const multi = assigned.length > 1;
    const stdio = assigned.find(([, item]) => item.transport === "stdio");
    if (stdio && !options.allowStdio) return reject(multi ? `${STDIO_NOT_ALLOWED} (server ${stdio[0]})` : STDIO_NOT_ALLOWED);
    const missing = missingRequiredEnv(suite, env);
    if (missing.length > 0) return reject(`missing credential: ${missing.join(", ")}`);
    const overLimit = runnerLimitViolation(suite);
    if (overLimit) return reject(`runner_limit: ${overLimit}`);

    const baseDir = options.baseDir ?? process.cwd();
    const resolved: Array<[string, Target]> = [];
    for (const [alias, item] of assigned) {
      try {
        assertOrgTargetAllowlisted(item, suite.policy.targetAllowlist, baseDir, undefined, suite.policy.gatewayAllowlist);
        resolved.push([alias, resolveTargetSecrets(item, env)]);
      } catch (error) {
        return reject(multi ? `server ${alias}: ${messageOf(error)}` : messageOf(error));
      }
    }
    const target = resolved[0]![1];
    const targets = multi ? Object.fromEntries(resolved.slice(1)) : undefined;
    if (abort.signal.aborted) return;
    const runScrub = makeScrubber([options.token, ...resolved.flatMap(([, item]) => targetSecretValues(item))], {
      ...defaultScrubContext(baseDir),
      commands: resolved.flatMap(([, item]) => stdioCommandPaths(item, baseDir)),
    });
    const sliceNote = suite.vuSlice
      ? ` (VU slice ${suite.vuSlice.shardIndex + 1}/${suite.vuSlice.totalShards}: ${suite.suite.load.maxConcurrency} VUs)`
      : "";
    log(`Running ${runScrub(suite.projectName)} / ${runScrub(suite.suite.name)} v${suite.version}${sliceNote}`);

    const progress = progressSender(transport, executionId, runScrub, abort.signal);
    const deadlineMs = Math.max(1_000, suite.limits.executionDeadlineMs - DEADLINE_MARGIN_MS);
    const run = (options.runSuite ?? runWorkerSuite)({ suite, target, ...(targets ? { targets } : {}), baseDir, onProgress: progress.push, signal: abort.signal });
    const outcome = await raceRun(run, abort.signal, deadlineMs);
    if (outcome.kind === "aborted" || outcome.kind === "deadline") {
      abort.abort();
      if (outcome.kind === "deadline") await reject(`execution deadline of ${suite.limits.executionDeadlineMs}ms reached`);
      log(`Execution ${executionId} abandoned; waiting for it to stop before taking new work`);
      await run.then(() => undefined, () => undefined);
      log(`Execution ${executionId} stopped; its result was dropped`);
      return;
    }
    if (outcome.kind === "error") return reject(`run_failed: ${messageOf(outcome.error)}`);
    await progress.flush();
    const report = outcome.report;
    if (options.otelExport) {
      await exportWorkerOtelToServer({
        server: options.server,
        token: options.token,
        executionId,
        report,
        scrub: runScrub,
        fetchFn: options.fetchFn,
        hmacSecret: resolveWorkerTelemetryHmacSecret(env),
      });
    }
    const verdict = report.verdict === "pass" ? "pass" : "fail";
    const done = await transport.send({ type: "complete", executionId, verdict, report: reportForService(report, runScrub) });
    if (done.ok) log(`Execution ${executionId} finished: ${verdict.toUpperCase()}`);
    else log(`Execution ${executionId} finished: ${verdict.toUpperCase()} (complete not accepted: ${done.error})`);
  } finally {
    abort.abort();
    if (state.active === active) state.active = null;
  }
}

function reportForService(report: RunReport, scrub: (text: string) => string): RunReport | undefined {
  const clean = scrubReport(report, scrub);
  return Buffer.byteLength(JSON.stringify(clean)) <= MAX_REPORT_BYTES ? clean : undefined;
}

type RunOutcome = { kind: "done"; report: RunReport } | { kind: "error"; error: unknown } | { kind: "aborted" } | { kind: "deadline" };

function raceRun(run: Promise<RunReport>, signal: AbortSignal, deadlineMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "deadline" }), deadlineMs);
    const onAbort = () => resolve({ kind: "aborted" });
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    run.then(
      (report) => resolve({ kind: "done", report }),
      (error: unknown) => resolve({ kind: "error", error }),
    ).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/** Sends progress frames in order without blocking the runner. Drops events once too many are queued. */
function progressSender(transport: WorkerTransport, executionId: string, scrub: (text: string) => string, signal: AbortSignal) {
  let chain: Promise<unknown> = Promise.resolve();
  let queued = 0;
  return {
    push(event: RunProgressEvent) {
      if (signal.aborted || !PROGRESS_NAMES.has(event.name) || queued >= MAX_QUEUED_PROGRESS) return;
      const attributes: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(event.attributes ?? {})) {
        if (typeof value === "string") attributes[key] = scrub(value);
        else if (typeof value === "number" || typeof value === "boolean") attributes[key] = value;
      }
      const frame: WorkerFrame = { type: "progress", executionId, event: { name: event.name, attributes } };
      queued += 1;
      chain = chain.then(() => (signal.aborted ? undefined : transport.send(frame))).finally(() => (queued -= 1));
    },
    flush: () => chain.then(() => undefined, () => undefined),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
