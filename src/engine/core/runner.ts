import { LoadTimelineCollector } from "./load-timeline.js";
import { createHash, randomUUID } from "node:crypto";
import type { Manifest, Scenario, ScenarioStep, Target } from "../types/manifest.js";
import type { RunMode, RunProgressEvent, RunReport, RunServerSummary } from "../types/run.js";
import { contractFailure, validateAgainstSchema } from "./contract.js";
import { payloadErrorMessage } from "./payload-error.js";
import { redactValue } from "./redaction.js";
import { RunRecorder } from "./run-recorder.js";
import {
  drainDeadlineMs,
  mayStartPass,
  passEstimateMs,
  rampDownStrategy,
  vuRetireAtMs,
  readPath,
  substituteValue,
  UnresolvedParamError,
  vuStartOffsetMs,
  type VarContext,
} from "./suite-model.js";
import { assertTargetAllowlisted } from "./allowlist.js";
import { callSloFailures, serverSloFailures, toleratedStepIds } from "./call-slo.js";
import { exclusiveActiveNode } from "./node-log.js";
import { assertOrgTargetAllowlisted } from "./org-target-policy.js";
import type { AllowlistEntry } from "../service/mcp-allowlist.js";
import {
  detectSilentGreen,
  computeVerdict,
  MetricsCollector,
  summarizeLatencies,
} from "./metrics.js";
import {
  ProcessGaugeCollector,
  checkProcessAssertions,
} from "./process-gauges.js";
import { QuotaTracker } from "./quotas.js";
import { SessionPoolSet } from "./session-pool.js";
import { DEFAULT_SERVER } from "./servers.js";
import {
  resolveRetryPolicy,
  retryingSession,
  type RetryEvent,
  type RetryGiveUpEvent,
  type RetryPolicy,
} from "./rate-limit-retry.js";
import {
  jitteredDwellMs,
  pace,
  PacingCollector,
  passJitterMs,
  resolveDwellJitterRatio,
  type DwellKind,
} from "./dwell.js";
import { runServer } from "./run-server.js";
import { resolveStdioTarget } from "./target-resolve.js";
import {
  capabilityForMethod,
  type McpCallResult,
  type McpSession,
} from "../adapters/base.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

import {
  isGatewayMode,
  buildGatewayMetrics,
  observeGatewayHop,
  type HopObservation,
} from "./gateway.js";
import { initTelemetry, type TelemetryHandle } from "../otel/telemetry.js";
import { appendAudit } from "../store/audit-log.js";

export interface RunOptions {
  manifest: Manifest;
  /** Internal: keep per-node tools/call result digests (era compare mode). */
  collectEraDigests?: boolean;
  outputDir?: string;
  mode?: RunMode;
  manifestDir?: string;
  principal?: string;
  scheduleId?: string;
  /** Tenant org policy — enforced at execution in addition to manifest allowlist. */
  orgTargetAllowlist?: AllowlistEntry[];
  orgGatewayAllowlist?: AllowlistEntry[];
  /**
   * Standalone CLI run: the URL or command the operator typed is the only target consent, so no
   * allowlist is checked. Cannot be combined with an org allowlist.
   */
  standaloneTarget?: true;
  /** Stable id so a caller can subscribe before the first progress event. */
  runId?: string;
  onProgress?: (event: RunProgressEvent) => void;
  /** Values copied into each iteration before the first step. Built-ins still win. */
  vars?: Record<string, string>;
  /** Fail a step when ${name} is not a built-in and not in vars. */
  strictParams?: boolean;
  /** Stops new iterations and closes every session, including stdio children. The report fails with `run aborted`. */
  signal?: AbortSignal;
  /** Optional per-tool result validation after contracts and errorClass expectations. */
  toolResultValidator?: ToolResultValidator;
}

export type ToolResultValidator = (
  ctx: { tool?: string; method: string; result: McpCallResult },
) => string | null | Promise<string | null>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A scripted elicitation reply is session-wide, so that step runs by itself. */
function nextBatch(ready: number[], steps: Array<{ elicit?: unknown }>, width: number): number[] {
  const scripted = ready.filter((index) => steps[index]?.elicit);
  const plain = ready.filter((index) => !steps[index]?.elicit);
  if (scripted.length === 0) return ready.slice(0, width);
  if (plain.length === 0) return scripted.slice(0, 1);
  return plain.slice(0, width);
}

function assertRequiredCapabilities(
  session: McpSession,
  step: ScenarioStep,
): { ok: boolean; message?: string } | null {
  const required = new Set<string>(step.requireCapabilities ?? []);
  const inferred = capabilityForMethod(step.method);
  if (inferred) required.add(inferred);

  if (required.size === 0) return null;

  const caps = session.getServerMeta().capabilities ?? {};
  const missing = [...required].filter((key) => !(key in caps));
  if (missing.length === 0) return null;

  return {
    ok: false,
    message: `Capability mismatch (Fail, not skip): server missing [${missing.join(", ")}] required by ${step.method}`,
  };
}

async function applyResultChecks(
  step: ScenarioStep,
  raw: McpCallResult,
  method: string,
  toolName: string | undefined,
  toolResultValidator: ToolResultValidator | undefined,
): Promise<{ contracted: McpCallResult; expected: { ok: boolean; message?: string } }> {
  let contracted = applyContract(step, raw);
  let expected = applyExpectErrorClass(contracted, step);
  if (method === "tools/call" && contracted.success) {
    const payloadFail = payloadErrorMessage(contracted);
    if (payloadFail) {
      contracted = { ...contracted, success: false, errorClass: "application", errorMessage: payloadFail };
      expected = { ok: false, message: payloadFail };
    }
  }
  if (method === "tools/call" && toolResultValidator) {
    const message = await toolResultValidator({ tool: toolName, method, result: contracted });
    if (message) {
      contracted = { ...contracted, success: false, errorClass: "application", errorMessage: message };
      expected = { ok: false, message };
    }
  }
  return { contracted, expected };
}

function applyExpectErrorClass(
  result: McpCallResult,
  step: ScenarioStep,
): { ok: boolean; message?: string } {
  if (!step.expectErrorClass) {
    return { ok: result.success, message: result.errorMessage };
  }
  const matched = result.errorClass === step.expectErrorClass;
  return {
    ok: matched,
    message: matched
      ? undefined
      : `Expected errorClass=${step.expectErrorClass} got ${result.errorClass}${result.errorMessage ? `: ${result.errorMessage}` : ""}`,
  };
}

function assertJsonSchemaDialect(
  listResult: McpCallResult,
): { ok: boolean; message?: string } | null {
  if (!listResult.success) return null;
  const tools = (listResult.result as { tools?: { name: string; inputSchema?: Record<string, unknown> }[] })
    ?.tools ?? [];
  const bad = tools.filter((t) => {
    const schema = t.inputSchema?.$schema;
    return (
      typeof schema === "string" &&
      !schema.includes("2020-12") &&
      !schema.includes("draft/2020-12")
    );
  });
  // Only fail when a $schema is present and is the wrong dialect; absent $schema is tolerated.
  if (bad.length === 0) return null;
  return {
    ok: false,
    message: `JSON Schema dialect assertion failed for tools: ${bad.map((t) => t.name).join(", ")} (expected 2020-12)`,
  };
}

interface StepTrace {
  protocolEra?: "legacy" | "modern";
  requestedEra?: "legacy" | "auto" | "modern";
  eraFallbackReason?: string;
  resultDigests?: Map<string, string>;
  eraIgnoreKeys?: string[];
  nodeOutcomes: Map<string, NonNullable<RunReport["nodeOutcomes"]>[number]>;
  redactedArgs: Array<{ nodeId: string; tool?: string; args: unknown }>;
  seenArgs: Set<string>;
  /** Set on multi-server runs: node outcomes then carry the alias of the server each step calls. */
  defaultServer?: string;
  retryPolicy?: RetryPolicy;
  /** Epoch ms after which no retry may start (run max duration). */
  retryDeadline?: number;
  retries?: NonNullable<RunReport["retries"]>;
  /** Every pause this run slept through, aggregated per kind. */
  pacing?: PacingCollector;
  recorder?: RunRecorder;
  /** The manifest has extract steps: sample responses are not recorded, so extracted values never reach the report. */
  hasExtractors?: boolean;
  /** Work cut off by ramp-down; never counted as errors. */
  rampDown?: { cancelled: number; incomplete: number; skipped: number };
  rampDownSummary?: { strategy: "graceful" | "immediate"; drainDeadlineMs: number; passEstimateMs?: number };
  /** Setup/teardown hook failures. Teardown failures are reported here and never fail the verdict. */
  hookErrors?: NonNullable<RunReport["hookErrors"]>;
}

function noteHookError(trace: StepTrace, step: ScenarioStep, scope: "suite" | "scenario", message?: string): void {
  const list = (trace.hookErrors ??= []);
  if (list.length >= 50) return;
  const label = step.label ?? step.tool ?? step.method;
  const msg = (message ?? "failed").replace(/\s+/g, " ").slice(0, 300);
  if (list.some((item) => item.hook === step.hook && item.label === label && item.message === msg)) return;
  list.push({
    hook: step.hook ?? "setup",
    scope,
    label,
    ...(step.nodeId ? { nodeId: step.nodeId } : {}),
    ...(step.scenarioName ? { scenario: step.scenarioName } : {}),
    message: msg,
  });
}

function noteRampDown(trace: StepTrace, key: "cancelled" | "incomplete" | "skipped"): void {
  const counts = (trace.rampDown ??= { cancelled: 0, incomplete: 0, skipped: 0 });
  counts[key] += 1;
}

/** The run's retry section with every aggregate initialised, so the counters need no guards. */
function retryTotals(trace: StepTrace): Required<NonNullable<RunReport["retries"]>> {
  const retries = (trace.retries ??= { total: 0, reason: "rate_limit", byMethod: {}, sessionSetup: 0 });
  retries.byReason ??= { rate_limit: 0, unavailable: 0 };
  retries.bySource ??= { http_429: 0, mcp_protocol: 0, unavailable: 0 };
  retries.retryAfterHonoured ??= 0;
  retries.exhausted ??= 0;
  retries.exhaustedByCause ??= {};
  retries.totalBackoffMs ??= 0;
  return retries as Required<NonNullable<RunReport["retries"]>>;
}

function noteRetry(
  trace: StepTrace,
  emit: (name: RunProgressEvent["name"], attributes: Record<string, string | number | boolean>) => void,
  method: string,
  event: RetryEvent,
  extra: { nodeId?: string; label?: string; tool?: string; thread?: number; telemetry?: TelemetryHandle } = {},
): void {
  const retries = retryTotals(trace);
  retries.total += 1;
  retries.byMethod[method] = (retries.byMethod[method] ?? 0) + 1;
  retries.byReason[event.reason] += 1;
  retries.bySource[event.source] += 1;
  if (event.retryAfterHonoured) retries.retryAfterHonoured += 1;
  retries.totalBackoffMs += event.delayMs;
  if (method === "initialize") retries.sessionSetup += 1;
  extra.telemetry?.recordRetry?.(event, method);
  extra.telemetry?.recordRateLimitSignal?.(event.source, method);
  if (extra.nodeId) {
    const current = trace.nodeOutcomes.get(extra.nodeId) ?? {
      nodeId: extra.nodeId,
      label: extra.label ?? extra.tool ?? method,
      count: 0,
      errorCount: 0,
    };
    current.retries = (current.retries ?? 0) + 1;
    trace.nodeOutcomes.set(extra.nodeId, current);
  }
  emit("mcp.retry", {
    reason: event.reason,
    source: event.source,
    method,
    attempt: event.attempt,
    delayMs: event.delayMs,
    retryAfterHonoured: event.retryAfterHonoured,
    ...(event.retryAfterMs !== undefined ? { retryAfterMs: event.retryAfterMs } : {}),
    ...(extra.tool ? { tool: extra.tool } : {}),
    ...(extra.nodeId ? { node: extra.nodeId } : {}),
    ...(extra.thread !== undefined ? { thread: extra.thread } : {}),
    ...(event.message ? { message: event.message.slice(0, 300) } : {}),
  });
}

/**
 * A retry loop that stopped while the outcome was still rate-limited. Counted, never emitted as a
 * run event: the call's own failure is already reported through the step.
 */
function noteRetryGiveUp(
  trace: StepTrace,
  method: string,
  event: RetryGiveUpEvent,
  telemetry?: TelemetryHandle,
): void {
  const retries = retryTotals(trace);
  retries.exhausted += 1;
  retries.exhaustedByCause[event.cause] = (retries.exhaustedByCause[event.cause] ?? 0) + 1;
  telemetry?.recordRetryExhausted?.(event, method);
  telemetry?.recordRateLimitSignal?.(event.source, method);
}

/**
 * The one place a run pauses between calls. Jitter is applied by the caller (`jitteredDwellMs` /
 * `passJitterMs`); this clamps to the drain deadline, sleeps, then records what was actually slept.
 */
async function dwellFor(
  kind: DwellKind,
  plannedMs: number,
  trace: StepTrace,
  telemetry: TelemetryHandle,
  drainAt?: number,
): Promise<void> {
  await pace(kind, plannedMs, {
    ...(drainAt !== undefined ? { deadline: drainAt } : {}),
    sleep,
    onPaced: (pausedKind, actualMs) => {
      trace.pacing?.record(pausedKind, actualMs);
      telemetry.recordDwell?.(actualMs, { kind: pausedKind });
    },
  });
}

function minDeadline(...values: Array<number | undefined>): number | undefined {
  const set = values.filter((value): value is number => value !== undefined);
  return set.length > 0 ? Math.min(...set) : undefined;
}

function applyContract<T extends { success: boolean; errorClass: import("../types/run.js").ErrorClass; errorMessage?: string; result?: unknown }>(
  step: ScenarioStep,
  result: T,
): T {
  if (!step.expect || !result.success) return result;
  const message = contractFailure(step.expect, result.result);
  if (!message) return result;
  return { ...result, success: false, errorClass: "protocol", errorMessage: message };
}

function nodeOutcome(trace: StepTrace, step: ScenarioStep & { nodeId: string }): NonNullable<RunReport["nodeOutcomes"]>[number] {
  const callsServer = step.method !== "think" && step.method !== "extract";
  return trace.nodeOutcomes.get(step.nodeId) ?? {
    nodeId: step.nodeId,
    label: step.label ?? step.tool ?? step.method,
    ...(trace.defaultServer && callsServer ? { server: step.server ?? trace.defaultServer } : {}),
    count: 0,
    errorCount: 0,
  };
}

/** A step that did not run because a required variable upstream was missing. */
function noteSkip(trace: StepTrace, step: ScenarioStep): void {
  if (!step.nodeId) return;
  const current = nodeOutcome(trace, { ...step, nodeId: step.nodeId });
  current.skipped = (current.skipped ?? 0) + 1;
  trace.nodeOutcomes.set(step.nodeId, current);
}

function noteNode(trace: StepTrace, step: ScenarioStep, ok: boolean, message?: string): void {
  if (!step.nodeId) return;
  const current = nodeOutcome(trace, { ...step, nodeId: step.nodeId });
  current.count += 1;
  if (!ok) {
    current.errorCount += 1;
    if (message && !current.errorMessage) current.errorMessage = message.slice(0, 1000);
  }
  trace.nodeOutcomes.set(step.nodeId, current);
}

async function executeStep(
  session: McpSession | undefined,
  step: ScenarioStep,
  metrics: MetricsCollector,
  quota: QuotaTracker,
  reused: boolean,
  telemetry: TelemetryHandle,
  transport: string,
  hopObservations: HopObservation[],
  gatewayMode: boolean,
  ctx: VarContext,
  trace: StepTrace,
  emit: (name: RunProgressEvent["name"], attributes: Record<string, string | number | boolean>) => void,
  prior?: { value: unknown; server?: string },
  /** Alias of the step's server, on multi-server runs only. */
  server?: string,
  toolResultValidator?: ToolResultValidator,
): Promise<{ ok: boolean; message?: string; result?: unknown; cancelled?: boolean }> {
  if (step.method === "think") {
    await sleep(step.thinkMs ?? 0);
    noteNode(trace, step, true);
    return { ok: true };
  }
  if (step.method === "extract") {
    const variable = step.extract?.variable ?? "extracted";
    let last: unknown = prior?.value;
    if (!prior && ctx.vars.__last_json) {
      try {
        last = JSON.parse(ctx.vars.__last_json);
      } catch {
        last = undefined;
      }
    }
    const value = readPath(last, step.extract?.path ?? "");
    const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
    ctx.vars[variable] = text;
    (ctx.extracted ??= new Set()).add(variable);
    metrics.recordVariable({
      name: variable,
      setBy: step.nodeId ?? variable,
      ...(trace.defaultServer && prior?.server ? { server: prior.server } : {}),
      resolved: text !== "",
    });
    if (step.extract?.required && text === "") {
      const message = `extract_missing: ${variable} (${step.extract.path || "$"})`;
      noteNode(trace, step, false, message);
      return { ok: false, message };
    }
    noteNode(trace, step, true);
    return { ok: true };
  }
  if (step.method === "teardown") {
    noteNode(trace, step, true);
    return { ok: true };
  }
  if (!session) {
    noteNode(trace, step, false, "session_missing");
    return { ok: false, message: "session_missing" };
  }
  const serverAttr: Record<string, string> = server ? { server } : {};

  let args: Record<string, unknown>;
  try {
    args = (substituteValue(step.args ?? {}, ctx, randomUUID) ?? {}) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof UnresolvedParamError) {
      noteNode(trace, step, false);
      return { ok: false, message: error.message };
    }
    throw error;
  }
  quota.recordCall();
  if (step.expect?.inputSchema && step.method !== "initialize") {
    const inputError = validateAgainstSchema(step.expect.inputSchema, args);
    if (inputError) {
      noteNode(trace, step, false);
      return { ok: false, message: `arguments do not match inputSchema: ${inputError}` };
    }
  }
  // Extracted values come from another call's result and may be private, so they are shown as ${name}.
  const shown = ctx.extracted?.size
    ? (substituteValue(step.args ?? {}, {
      ...ctx,
      strict: false,
      vars: { ...ctx.vars, ...Object.fromEntries([...ctx.extracted].map((name) => [name, `\${${name}}`])) },
    }, randomUUID) ?? {}) as Record<string, unknown>
    : args;
  if (step.nodeId && !trace.seenArgs.has(step.nodeId)) {
    trace.seenArgs.add(step.nodeId);
    trace.redactedArgs.push({
      nodeId: step.nodeId,
      tool: step.tool,
      args: redactValue(shown),
    });
  }

  const record = async (
    method: string,
    raw: McpCallResult,
    toolName?: string,
  ) => {
    const { contracted, expected } = await applyResultChecks(step, raw, method, toolName, toolResultValidator);
    // Expected tool errors must not inflate error rate. The scenario outcome
    // already asserted the class; unexpected errors still Fail.
    const result =
      method === "tools/call" && step.expectErrorClass && expected.ok
        ? { ...contracted, success: true, errorClass: "none" as const }
        : contracted;
    if (!expected.ok && ctx.cancelAfter !== undefined && Date.now() >= ctx.cancelAfter) {
      // Cut off by the drain deadline: not a server error, so it stays out of error rate and SLOs.
      noteRampDown(trace, "cancelled");
      return { ok: false, cancelled: true, message: "cancelled by ramp-down" };
    }
    const obs = {
      ...serverAttr,
      method,
      toolName,
      nodeId: step.nodeId,
      latencyMs: result.latencyMs,
      errorClass: result.errorClass,
      bytesIn: result.bytesIn,
      bytesOut: result.bytesOut,
      sessionReuse: reused,
    };
    metrics.recordCall(obs);
    if (method === "tools/call" && step.nodeId && raw.success && trace.resultDigests && !trace.resultDigests.has(step.nodeId)) {
      trace.resultDigests.set(step.nodeId, eraResultDigest(raw.result, trace.eraIgnoreKeys));
    }
    telemetry.recordCall(obs, transport);
    if (gatewayMode) hopObservations.push(observeGatewayHop(result));
    emit("mcp.rpc.duration", {
      method,
      latencyMs: result.latencyMs,
      result: result.errorClass === "none" ? "ok" : result.errorClass,
      tool: toolName ?? "",
      ...serverAttr,
    });
    if (method === "tools/call" && toolName) {
      emit("mcp.tool.call.duration", {
        tool: toolName,
        latencyMs: result.latencyMs,
        result: result.errorClass === "none" ? "ok" : result.errorClass,
        ...serverAttr,
      });
      if (result.errorClass !== "none") {
        emit("mcp.tool.call.errors", { tool: toolName, error_class: result.errorClass, ...serverAttr });
      }
      trace.recorder?.recordToolCall({
        tool: toolName,
        ok: result.errorClass === "none" && expected.ok,
        latencyMs: result.latencyMs,
        args: shown,
        // Results that feed extractors would put the extracted values in the report; keep only their size.
        result: trace.hasExtractors ? undefined : contracted.result,
        errorClass: result.errorClass === "none" && !expected.ok ? "protocol" : result.errorClass,
        errorMessage: expected.message ?? contracted.errorMessage,
        nodeId: step.nodeId,
      });
    }
    if (contracted.result !== undefined) {
      try {
        ctx.vars["__last_json"] = JSON.stringify(contracted.result);
      } catch {
        delete ctx.vars["__last_json"];
      }
    }
    noteNode(trace, step, expected.ok, expected.message);
    return { ok: expected.ok, message: expected.message, result: contracted.result };
  };

  if (step.elicit) {
    session.setElicitAutoReply(step.elicit);
  }

  const capFail = assertRequiredCapabilities(session, step);
  if (capFail) {
    metrics.recordCall({
      ...serverAttr,
      method: step.method,
      toolName: step.tool,
      nodeId: step.nodeId,
      latencyMs: 0,
      errorClass: "protocol",
      bytesIn: 0,
      bytesOut: 0,
      sessionReuse: reused,
    });
    noteNode(trace, step, false);
    return capFail;
  }

  switch (step.method) {
    case "initialize": {
      const meta = session.getServerMeta();
      return await record("initialize", {
        success: true,
        latencyMs: 0,
        errorClass: "none",
        bytesIn: 0,
        bytesOut: 0,
        result: {
          ...meta,
          protocolVersion: meta.protocolVersion ?? LATEST_PROTOCOL_VERSION,
        },
      });
    }
    case "tools/list": {
      const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
      const result = await session.listTools(cursor);
      if (step.assertJsonSchema202012) {
        const dialect = assertJsonSchemaDialect(result);
        if (dialect && !dialect.ok) {
          return await record("tools/list", {
            ...result,
            success: false,
            errorClass: "protocol",
            errorMessage: dialect.message,
          });
        }
      }
      return await record("tools/list", result);
    }
    case "resources/list":
      return await record(
        "resources/list",
        await session.listResources(typeof args.cursor === "string" ? args.cursor : undefined),
      );
    case "resources/templates/list":
      return await record(
        "resources/templates/list",
        await session.listResourceTemplates(typeof args.cursor === "string" ? args.cursor : undefined),
      );
    case "resources/read": {
      const uri = step.resourceUri ?? step.uri;
      if (!uri) {
        noteNode(trace, step, false);
        return { ok: false, message: "resources/read requires a uri" };
      }
      return await record("resources/read", await session.readResource(uri));
    }
    case "prompts/list":
      return await record(
        "prompts/list",
        await session.listPrompts(typeof args.cursor === "string" ? args.cursor : undefined),
      );
    case "prompts/get": {
      const name = step.prompt ?? step.name;
      if (!name) {
        noteNode(trace, step, false);
        return { ok: false, message: "prompts/get requires a prompt name" };
      }
      const promptArgs: Record<string, string> = {};
      for (const [key, value] of Object.entries(args)) {
        promptArgs[key] = value == null ? "" : String(value);
      }
      return await record("prompts/get", await session.getPrompt(name, promptArgs));
    }
    case "logging/setLevel":
      return await record("logging/setLevel", await session.setLoggingLevel(String(args.level ?? "info")));
    case "completion/complete": {
      const ref = args.ref === "resource" ? "resource" : "prompt";
      const name = ref === "prompt" ? step.prompt ?? step.name : step.resourceUri ?? step.uri;
      if (!name || typeof args.argument !== "string") {
        noteNode(trace, step, false);
        return { ok: false, message: "completion/complete requires a ref and argument" };
      }
      return await record("completion/complete", await session.complete({
        ref,
        name,
        argument: args.argument,
        value: args.value == null ? "" : String(args.value),
      }));
    }
    case "tools/call": {
      if (!step.tool) {
        noteNode(trace, step, false);
        return { ok: false, message: "tools/call requires tool name" };
      }
      return await record("tools/call", await session.callTool(step.tool, args, step.timeoutMs), step.tool);
    }
    case "ping":
      return await record("ping", await session.ping());
    case "tasks/list":
      return await record(
        "tasks/list",
        await session.listTasks(typeof args.cursor === "string" ? args.cursor : undefined),
      );
    case "tasks/get": {
      if (!step.taskId) {
        noteNode(trace, step, false);
        return { ok: false, message: "tasks/get requires taskId" };
      }
      return await record("tasks/get", await session.getTask(step.taskId));
    }
    case "tasks/cancel": {
      if (!step.taskId) {
        noteNode(trace, step, false);
        return { ok: false, message: "tasks/cancel requires taskId" };
      }
      return await record("tasks/cancel", await session.cancelTask(step.taskId));
    }
    default:
      noteNode(trace, step, false);
      return { ok: false, message: `Unknown method: ${step.method}` };
  }
}

interface ScenarioRunContext {
  transport: string;
  /** Alias of the default server. */
  defaultServer: string;
  /** True when steps call more than one server; reports and events then carry aliases. */
  multiServer: boolean;
  /** Transport of each server, by alias. */
  transports: Map<string, string>;
  hopObservations: HopObservation[];
  gatewayMode: boolean;
  trace: StepTrace;
  emit: (name: RunProgressEvent["name"], attributes: Record<string, string | number | boolean>) => void;
  thread: number;
  iter: number;
  waitForSlot: boolean;
  drainAt?: number;
  dwellMs: number;
  /** Symmetric, mean-preserving jitter on each dwell (0..1); 0 keeps the exact `dwellMs`. */
  dwellJitterRatio: number;
  /** How many ready steps in one pass may run at once. */
  stepParallelism: number;
  /** Steps inside executeStep. Server stderr is stamped only when this has one id. */
  activeNodes: Set<string>;
  seedVars?: Record<string, string>;
  strictParams?: boolean;
  toolResultValidator?: ToolResultValidator;
  /** Set when this pass runs suite-level setup or teardown steps: no scenario outcome or pass is recorded. */
  suiteHook?: "setup" | "teardown";
}

async function runScenario(
  scenario: Scenario,
  pools: SessionPoolSet,
  metrics: MetricsCollector,
  quota: QuotaTracker,
  telemetry: TelemetryHandle,
  run: ScenarioRunContext,
): Promise<void> {
  await Promise.all(
    Array.from({ length: scenario.iterations }, (_, i) => runScenarioPass(scenario, pools, metrics, quota, telemetry, run, i)),
  );
}

interface HeldSession {
  session: McpSession;
  reused: boolean;
}

async function runScenarioPass(
  scenario: Scenario,
  pools: SessionPoolSet,
  metrics: MetricsCollector,
  quota: QuotaTracker,
  telemetry: TelemetryHandle,
  run: ScenarioRunContext,
  i: number,
): Promise<PassResult> {
  await quota.acquireConcurrency({ wait: true });
    const passBegan = Date.now();
    let cancelled = false;
    // Sessions this pass holds, one per server, checked out when a step first needs that server.
    const held = new Map<string, Promise<HeldSession>>();
    const opened = new Map<string, HeldSession>();
    const unreachable = new Map<string, string>();
    let scenarioOk = true;
    let lastMessage: string | undefined;
    let skippedAny = false;
    let passStarted: number | undefined;
    const ctx: VarContext = {
      thread: run.thread,
      iter: run.iter + i,
      loop: 0,
      vars: { ...(run.seedVars ?? {}) },
      strict: run.strictParams === true,
      ...(run.drainAt !== undefined ? { cancelAfter: run.drainAt } : {}),
    };
    const pastDrain = () => run.drainAt !== undefined && Date.now() >= run.drainAt;
    const aliasOf = (step: ScenarioStep) => step.server ?? run.defaultServer;
    const serverAttr = (alias: string): Record<string, string> => (run.multiServer ? { server: alias } : {});
    const checkout = (alias: string): Promise<HeldSession> => {
      let pending = held.get(alias);
      if (!pending) {
        pending = pools.acquire(alias).then((acquired) => {
          opened.set(alias, acquired);
          if (!run.trace.protocolEra) {
            const sm = acquired.session.getServerMeta();
            run.trace.protocolEra = sm.protocolEra ?? acquired.session.protocolEra ?? "legacy";
            run.trace.requestedEra = sm.requestedEra ?? acquired.session.requestedEra;
            const fb = sm.eraFallbackReason ?? acquired.session.eraFallbackReason;
            if (fb) run.trace.eraFallbackReason = fb;
          }
          const transport = run.transports.get(alias) ?? run.transport;
          metrics.recordSessionStart(alias);
          telemetry.recordSessionStart(transport, "started");
          run.emit("mcp.session.start", { transport, result: "started", thread: run.thread, ...serverAttr(alias) });
          return acquired;
        });
        held.set(alias, pending);
      }
      return pending;
    };
    const releaseAll = async (keepWarm: boolean, ok: boolean) => {
      for (const [alias, item] of opened) {
        metrics.recordSessionEnd(ok, alias);
        telemetry.recordSessionStart(run.transports.get(alias) ?? run.transport, ok ? "ok" : "fail");
        await pools.release(alias, item.session, keepWarm);
      }
      opened.clear();
    };

    try {
      // A single-server pass opens its session first, as it always has; a failure makes the whole pass an error.
      if (!run.multiServer) {
        const first = await checkout(run.defaultServer);
        if (!first.session) throw new Error("session_missing");
      }

      const results = new Map<number, { value: unknown; server?: string }>();
      // Steps that did not run, or a required extractor that found nothing. Steps waiting on them are skipped.
      const blocked = new Set<number>();
      const runOne = async (index: number): Promise<{ ok: boolean; message?: string; cancelled?: boolean }> => {
        const step = scenario.steps[index]!;
        ctx.loop = step.loopIndex ?? 0;
        const stepStarted = Date.now();
        passStarted ??= stepStarted;
        const nodeId = step.nodeId ?? "";
        const alias = aliasOf(step);
        const callsServer = step.method !== "think" && step.method !== "extract";
        const label = step.label ?? step.tool ?? step.method;
        const producer = step.waitFor?.at(-1);
        if (step.hook !== "teardown" && (step.waitFor ?? []).some((pred) => blocked.has(pred))) {
          blocked.add(index);
          skippedAny = true;
          noteSkip(run.trace, step);
          run.emit("mcp.step", {
            node: nodeId, label, method: step.method, phase: "done", result: "skip", latencyMs: 0,
            iter: ctx.iter, thread: run.thread, loop: ctx.loop, ...(callsServer ? serverAttr(alias) : {}),
          });
          return { ok: true };
        }
        if (nodeId) run.activeNodes.add(nodeId);
        let bound: McpSession | undefined;
        try {
          run.emit("mcp.step", {
            node: nodeId,
            label,
            method: step.method,
            phase: "start",
            result: "run",
            latencyMs: 0,
            iter: ctx.iter,
            thread: run.thread,
            loop: ctx.loop,
            ...(callsServer ? serverAttr(alias) : {}),
          });
          let reused = false;
          let result: { ok: boolean; message?: string; result?: unknown; cancelled?: boolean } | undefined;
          const down = callsServer ? unreachable.get(alias) : undefined;
          if (down) {
            result = recordUnreachable(step, alias, down, metrics, run);
          } else {
            if (callsServer) {
              try {
                const acquired = await checkout(alias);
                bound = acquired.session;
                reused = acquired.reused;
              } catch (error) {
                // Past the drain deadline a server that will not open is ramp-down, not an outage.
                if (pastDrain()) {
                  noteRampDown(run.trace, "cancelled");
                  return { ok: false, cancelled: true, message: "cancelled by ramp-down" };
                }
                const message = unreachable.get(alias) ?? `session failed on ${alias}: ${describeSessionFailure(error, pools.target(alias))}`;
                // Steps in one wave share the failed checkout; count the failed session once.
                if (!unreachable.has(alias)) metrics.recordSessionEnd(false, alias);
                unreachable.set(alias, message);
                result = recordUnreachable(step, alias, message, metrics, run);
                bound = undefined;
              }
            }
            const stepSession = bound && run.trace.retryPolicy
              ? retryingSession(bound, run.trace.retryPolicy, {
                  deadline: () => minDeadline(run.drainAt, run.trace.retryDeadline),
                  onRetry: (method, event) =>
                    noteRetry(run.trace, run.emit, method === "callTool" ? "tools/call" : step.method, event, {
                      nodeId: step.nodeId,
                      label: step.label,
                      tool: step.tool,
                      thread: run.thread,
                      telemetry,
                    }),
                  onGiveUp: (method, event) =>
                    noteRetryGiveUp(run.trace, method === "callTool" ? "tools/call" : step.method, event, telemetry),
                })
              : bound;
            result ??= await executeStep(
              stepSession,
              step,
              metrics,
              quota,
              reused,
              telemetry,
              run.transports.get(alias) ?? run.transport,
              run.hopObservations,
              run.gatewayMode,
              ctx,
              run.trace,
              run.emit,
              producer === undefined ? undefined : results.get(producer) ?? { value: undefined },
              run.multiServer ? alias : undefined,
              run.toolResultValidator,
            );
          }
          results.set(index, { value: result.result, ...(callsServer ? { server: alias } : {}) });
          if (!result.ok && step.method === "extract" && step.extract?.required) blocked.add(index);
          // A failed setup step skips everything that waits on it; the reason is recorded once.
          if (!result.ok && !result.cancelled && step.hook) {
            if (step.hook === "setup") blocked.add(index);
            noteHookError(run.trace, step, run.suiteHook ? "suite" : "scenario", result.message);
          }
          run.emit("mcp.step", {
            node: nodeId,
            label,
            method: step.method,
            phase: "done",
            result: result.ok ? "ok" : "fail",
            latencyMs: Date.now() - stepStarted,
            iter: ctx.iter,
            thread: run.thread,
            loop: ctx.loop,
            ...(callsServer ? serverAttr(alias) : {}),
          });
          return result;
        } finally {
          if (step.elicit && bound) {
            bound.setElicitAutoReply({ action: "accept", content: {} });
          }
          if (nodeId) run.activeNodes.delete(nodeId);
        }
      };
      const note = (result: { ok: boolean; message?: string; cancelled?: boolean }, index?: number) => {
        const hook = index === undefined ? undefined : scenario.steps[index]?.hook;
        if (result.cancelled) cancelled = true;
        else if (!result.ok && hook === "teardown") {
          // Teardown errors are reported (trace.hookErrors) but never fail the scenario.
        } else if (!result.ok) {
          scenarioOk = false;
          lastMessage = result.message;
        }
      };
      const drained = (): boolean => {
        if (cancelled) return true;
        if (run.drainAt === undefined || Date.now() <= run.drainAt) return false;
        cancelled = true;
        return true;
      };
      const skipChained = (index: number): { ok: boolean } => {
        if (scenario.steps[index]?.hook === "teardown") return { ok: true };
        const step = scenario.steps[index]!;
        blocked.add(index);
        skippedAny = true;
        noteSkip(run.trace, step);
        run.emit("mcp.step", {
          node: step.nodeId ?? "", label: step.label ?? step.tool ?? step.method, method: step.method, phase: "done",
          result: "skip", latencyMs: 0, iter: ctx.iter, thread: run.thread, loop: step.loopIndex ?? 0,
          ...(step.method !== "think" && step.method !== "extract" ? serverAttr(aliasOf(step)) : {}),
        });
        return { ok: true };
      };
      const dag = scenario.steps.some((step) => step.waitFor !== undefined);
      if (!dag) {
        for (let index = 0; index < scenario.steps.length; index++) {
          if (drained()) break;
          // Without a graph every step follows the one before it, so a missing required value stops the rest.
          const result = blocked.size > 0 && scenario.steps[index]?.hook !== "teardown" ? skipChained(index) : await runOne(index);
          note(result, index);
          if (index < scenario.steps.length - 1 && run.dwellMs > 0 && blocked.size === 0) {
            await dwellFor("step", jitteredDwellMs(run.dwellMs, run.dwellJitterRatio), run.trace, telemetry, run.drainAt);
          }
        }
      } else {
        const pending = new Set(scenario.steps.map((_step, index) => index));
        const done = new Set<number>();
        const dwelled = new Set<string>();
        while (pending.size > 0) {
          if (drained()) break;
          const ready = [...pending].filter((index) =>
            (scenario.steps[index]?.waitFor ?? []).every((pred) => done.has(pred)),
          );
          if (ready.length === 0) {
            scenarioOk = false;
            lastMessage = "execution graph has a cycle";
            break;
          }
          const waveKey = ready
            .map((index) => (scenario.steps[index]?.waitFor ?? []).join("."))
            .sort()
            .join("|");
          const allSkipped = ready.every((index) => (scenario.steps[index]?.waitFor ?? []).some((pred) => blocked.has(pred)));
          if (!allSkipped && waveKey && !dwelled.has(waveKey) && done.size > 0 && run.dwellMs > 0) {
            await dwellFor("wave", jitteredDwellMs(run.dwellMs, run.dwellJitterRatio), run.trace, telemetry, run.drainAt);
          }
          dwelled.add(waveKey);
          const batch = nextBatch(ready, scenario.steps, run.stepParallelism);
          const finished = await Promise.all(batch.map(async (index) => ({ index, result: await runOne(index) })));
          for (const item of finished) {
            pending.delete(item.index);
            done.add(item.index);
            note(item.result, item.index);
          }
        }
        // Teardown always runs, even when the pass was stopped or drained early.
        for (const index of [...pending].sort((a, b) => a - b)) {
          if (scenario.steps[index]?.hook !== "teardown") continue;
          pending.delete(index);
          note(await runOne(index), index);
        }
      }
      if (run.suiteHook) {
        await releaseAll(true, scenarioOk);
        const failedSetup = run.suiteHook === "setup" && (blocked.size > 0 || !scenarioOk);
        return {
          durationMs: Date.now() - passBegan,
          completed: !cancelled && !failedSetup,
          ...(failedSetup ? { message: lastMessage ?? "suite setup failed" } : {}),
        };
      }

      if (cancelled && scenarioOk) {
        // Stopped by the drain deadline with no real failure: incomplete, not failed. Not counted as a flow pass.
        noteRampDown(run.trace, "incomplete");
        run.emit("mcp.scenario.result", { scenario: scenario.name, outcome: "cancelled", thread: run.thread });
        await releaseAll(true, true);
        return { durationMs: Date.now() - passBegan, completed: false };
      }
      const outcome = scenarioOk ? "pass" : "fail";
      metrics.recordScenarioOutcome({
        scenario: scenario.name,
        outcome,
        message: lastMessage,
      });
      metrics.recordPass({ durationMs: passStarted === undefined ? 0 : Date.now() - passStarted, outcome, skipped: skippedAny });
      telemetry.recordScenario(scenario.name, outcome);
      run.emit("mcp.scenario.result", { scenario: scenario.name, outcome, thread: run.thread });
      await releaseAll(true, scenarioOk);
      return { durationMs: Date.now() - passBegan, completed: !cancelled };
    } catch (error) {
      if (run.suiteHook) {
        const message = error instanceof Error ? error.message : String(error);
        const first = scenario.steps[0];
        if (first) noteHookError(run.trace, { ...first, hook: run.suiteHook }, "suite", message);
        for (const [alias, item] of opened) await pools.release(alias, item.session, false);
        opened.clear();
        return { durationMs: Date.now() - passBegan, completed: false, message };
      }
      if (pastDrain()) {
        noteRampDown(run.trace, "incomplete");
        for (const [alias, item] of opened) await pools.release(alias, item.session, false);
        opened.clear();
        return { durationMs: Date.now() - passBegan, completed: false };
      }
      metrics.recordScenarioOutcome({
        scenario: scenario.name,
        outcome: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      metrics.recordPass({ durationMs: passStarted === undefined ? 0 : Date.now() - passStarted, outcome: "error", skipped: skippedAny });
      run.emit("mcp.scenario.result", {
        scenario: scenario.name,
        outcome: "error",
        thread: run.thread,
      });
      if (opened.size === 0) metrics.recordSessionEnd(false, run.defaultServer);
      await releaseAll(false, false);
      return { durationMs: Date.now() - passBegan, completed: false };
    } finally {
      quota.releaseConcurrency();
    }
}

interface PassResult {
  durationMs: number;
  /** Suite hook passes: why setup failed. */
  message?: string;
  /** False when the pass errored or was cut off before its last step. */
  completed: boolean;
}

/** A step whose server could not be reached: a transport failure counted against that server. */
function recordUnreachable(
  step: ScenarioStep,
  alias: string,
  message: string,
  metrics: MetricsCollector,
  run: ScenarioRunContext,
): { ok: false; message: string } {
  metrics.recordCall({
    ...(run.multiServer ? { server: alias } : {}),
    method: step.method,
    toolName: step.tool,
    nodeId: step.nodeId,
    latencyMs: 0,
    errorClass: "transport",
    bytesIn: 0,
    bytesOut: 0,
    sessionReuse: false,
  });
  noteNode(run.trace, step, false, message);
  return { ok: false, message };
}

/** Dwell between steps: the load profile's, or 1s for a functional run that sets no load. */
function resolvedDwellMs(manifest: Manifest): number {
  return Math.max(0, manifest.load?.dwellMs ?? 1000);
}

function scenarioContext(
  manifest: Manifest,
  hopObservations: HopObservation[],
  trace: StepTrace,
  emit: ScenarioRunContext["emit"],
  extra?: Partial<ScenarioRunContext>,
): ScenarioRunContext {
  const defaultServer = manifest.defaultTarget ?? DEFAULT_SERVER;
  const others = Object.entries(manifest.targets ?? {});
  return {
    transport: manifest.target.transport,
    defaultServer,
    multiServer: others.length > 0,
    transports: new Map([[defaultServer, manifest.target.transport], ...others.map(([alias, item]) => [alias, item.transport] as [string, string])]),
    hopObservations,
    gatewayMode: isGatewayMode(manifest),
    trace,
    emit,
    thread: 1,
    iter: 0,
    waitForSlot: false,
    dwellMs: resolvedDwellMs(manifest),
    dwellJitterRatio: resolveDwellJitterRatio(manifest.load?.dwellJitterRatio),
    stepParallelism: Math.max(1, manifest.load?.lanes ?? 4),
    activeNodes: new Set(),
    ...extra,
  };
}

async function runAllScenarios(
  manifest: Manifest,
  pool: SessionPoolSet,
  metrics: MetricsCollector,
  quota: QuotaTracker,
  telemetry: TelemetryHandle,
  hopObservations: HopObservation[],
  trace: StepTrace,
  emit: ScenarioRunContext["emit"],
  activeNodes: Set<string>,
  seed?: Pick<ScenarioRunContext, "seedVars" | "strictParams">,
): Promise<void> {
  await Promise.all(
    manifest.scenarios.map((scenario) =>
      runScenario(
        scenario,
        pool,
        metrics,
        quota,
        telemetry,
        scenarioContext(manifest, hopObservations, trace, emit, { activeNodes, ...seed }),
      ),
    ),
  );
}

async function runLoadProfile(
  manifest: Manifest,
  pool: SessionPoolSet,
  metrics: MetricsCollector,
  quota: QuotaTracker,
  telemetry: TelemetryHandle,
  hopObservations: HopObservation[],
  trace: StepTrace,
  emit: ScenarioRunContext["emit"],
  activeNodes: Set<string>,
  seed?: Pick<ScenarioRunContext, "seedVars" | "strictParams">,
  signal?: AbortSignal,
): Promise<void> {
  const load = manifest.load;
  if (!load) return;
  const origin = Date.now();
  const vuCount = load.maxConcurrency;
  const minPasses = Math.max(1, load.iterations ?? 1);
  const strategy = rampDownStrategy(load);
  const drainAt = drainDeadlineMs(origin, load);
  const durations: number[] = [];
  const estimate = () => passEstimateMs(durations, load.rampDown?.passEstimateMs);
  let active = 0;
  const publishVus = () => emit("mcp.load.vus", { active, max: vuCount });
  trace.rampDown ??= { cancelled: 0, incomplete: 0, skipped: 0 };

  await Promise.all(
    Array.from({ length: vuCount }, async (_unused, index) => {
      const delay = vuStartOffsetMs(index, vuCount, load.rampUpMs);
      if (delay > 0) await sleep(delay);
      const retireAt = vuRetireAtMs(index, vuCount, origin, load);
      active += 1;
      publishVus();
      let passes = 0;
      try {
        while (!signal?.aborted) {
          const required = passes < minPasses;
          if (!required && !mayStartPass(Date.now(), retireAt, drainAt, estimate(), strategy)) {
            // Still inside the window but the pass would not plausibly finish: skip, don't start.
            if (Date.now() < retireAt) noteRampDown(trace, "skipped");
            break;
          }
          const scenario = manifest.scenarios[index % manifest.scenarios.length] ?? manifest.scenarios[0];
          if (!scenario) break;
          const result = await runScenarioPass({ ...scenario, iterations: 1 }, pool, metrics, quota, telemetry, scenarioContext(manifest, hopObservations, trace, emit, {
            thread: index + 1,
            iter: passes,
            waitForSlot: true,
            drainAt: required ? undefined : drainAt,
            activeNodes,
            ...seed,
          }), 0);
          if (result.completed) durations.push(result.durationMs);
          passes += 1;
          if (passes >= minPasses && Date.now() >= retireAt) break;
          // Pass-level jitter is unchanged (uniform 0..jitterMs); it is now measured like any dwell.
          if (load.jitterMs > 0) {
            await dwellFor("pass_jitter", passJitterMs(load.jitterMs), trace, telemetry, drainAt);
          }
        }
      } finally {
        active -= 1;
        publishVus();
      }
    }),
  );
  trace.rampDownSummary = {
    strategy,
    drainDeadlineMs: drainAt - origin,
    ...(estimate() !== undefined ? { passEstimateMs: estimate() } : {}),
  };
}

function resolveTarget(target: Target, baseDir?: string): Target {
  if (target.transport === "stdio") {
    return resolveStdioTarget(target, baseDir);
  }
  return target;
}

/** Every server of a manifest by alias, default first, with stdio paths resolved. */
function resolveTargets(manifest: Manifest, baseDir?: string): Map<string, Target> {
  const defaultServer = manifest.defaultTarget ?? DEFAULT_SERVER;
  return new Map([
    [defaultServer, resolveTarget(manifest.target, baseDir)],
    ...Object.entries(manifest.targets ?? {}).map(([alias, item]) => [alias, resolveTarget(item, baseDir)] as [string, Target]),
  ]);
}

/** Aliases that an enabled step calls, so warm-up opens no session a run never uses. */
function calledServers(manifest: Manifest, defaultServer: string): string[] {
  const used = new Set<string>();
  for (const scenario of manifest.scenarios) {
    for (const step of scenario.steps) {
      if (step.method === "think" || step.method === "extract") continue;
      used.add(step.server ?? defaultServer);
    }
  }
  return used.size > 0 ? [...used] : [defaultServer];
}

/** True when every failed call in the scenario came from a step whose `maxFailedCalls` allowance absorbed it. */
function onlyToleratedFailures(
  manifest: Manifest,
  scenarioName: string,
  samples: ReturnType<MetricsCollector["getObservations"]>,
  tolerated: Set<string>,
): boolean {
  const scenario = manifest.scenarios.find((sc) => sc.name === scenarioName);
  if (!scenario) return false;
  const ids = new Set(scenario.steps.map((s) => s.nodeId).filter((id): id is string => Boolean(id)));
  const failed = samples.filter((s) => s.errorClass !== "none" && s.nodeId && ids.has(s.nodeId));
  return failed.length > 0 && failed.every((s) => tolerated.has(s.nodeId!));
}

function buildFailReasons(
  manifest: Manifest,
  samples: ReturnType<MetricsCollector["getObservations"]>,
  scenarioOutcomes: ReturnType<MetricsCollector["getScenarioOutcomes"]>,
  silentGreen: boolean,
  processFailures: string[],
): string[] {
  const failReasons: string[] = [...processFailures];

  if (silentGreen) {
    failReasons.push(
      "Silent green: traffic intended but no pass/fail scenario outcomes recorded",
    );
  }

  const steps = manifest.scenarios.flatMap((scenario) => scenario.steps);
  const sloInput = {
    suite: {
      maxP95Ms: manifest.assertions.maxP95LatencyMs,
      maxP99Ms: manifest.assertions.maxP99LatencyMs,
      maxErrorRate: manifest.assertions.maxErrorRate,
    },
    steps: steps
      .filter((step) => step.method === "tools/call")
      .map((step) => ({
        nodeId: step.nodeId,
        label: step.label,
        tool: step.tool,
        slo: step.slo,
      })),
    samples: samples
      .filter((sample) => sample.method === "tools/call")
      .map((sample) => ({
        nodeId: sample.nodeId,
        toolName: sample.toolName,
        latencyMs: sample.latencyMs,
        failed: sample.errorClass !== "none",
      })),
  };
  failReasons.push(...callSloFailures(sloInput));
  const tolerated = toleratedStepIds(sloInput);

  for (const outcome of scenarioOutcomes) {
    if (outcome.outcome === "fail" && tolerated.size > 0 && onlyToleratedFailures(manifest, outcome.scenario, samples, tolerated)) continue;
    if (outcome.outcome === "fail" || outcome.outcome === "error") {
      failReasons.push(
        `Scenario ${outcome.scenario} ${outcome.outcome}${outcome.message ? `: ${outcome.message}` : ""}`,
      );
    }
  }

  return failReasons;
}

/** Calls, error rate, latency, and sessions for one server. A single-server run counts every call. */
function serverSummary(
  alias: string,
  target: Target,
  info: { name?: string; version?: string } | undefined,
  metrics: MetricsCollector,
  multiServer: boolean,
): RunServerSummary {
  const calls = metrics.getObservations().filter((obs) => !multiServer || obs.server === alias);
  const errors = calls.filter((obs) => obs.errorClass !== "none").length;
  return {
    alias,
    ...runServer(target, info),
    calls: calls.length,
    errorRate: calls.length > 0 ? errors / calls.length : 0,
    latencyMs: summarizeLatencies(calls.map((obs) => obs.latencyMs)),
    sessionMetrics: { transport: target.transport, ...metrics.getServerSessions(alias) },
  };
}

/** Per-server objectives, judged over every tool call on that server. */
function serverSloReasons(manifest: Manifest, samples: ReturnType<MetricsCollector["getObservations"]>, defaultServer: string): string[] {
  const reasons: string[] = [];
  for (const [alias, slo] of Object.entries(manifest.assertions.servers ?? {})) {
    reasons.push(...serverSloFailures(alias, samples
      .filter((sample) => sample.method === "tools/call" && (sample.server ?? defaultServer) === alias)
      .map((sample) => ({ toolName: sample.toolName, latencyMs: sample.latencyMs, failed: sample.errorClass !== "none" })), slo));
  }
  return reasons;
}

/** Names the URL or command inside a session-open failure, plus the OS error when fetch only says "fetch failed". */
export function describeSessionFailure(error: unknown, target: Target): string {
  const message = error instanceof Error ? error.message : String(error);
  let hint = "";
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const err = current as { message?: unknown; code?: unknown; cause?: unknown };
    if (typeof err.code === "string" && err.code) hint = err.code;
    else if (!hint && typeof err.message === "string" && err.message && err.message !== message) hint = err.message;
    current = err.cause;
  }
  const where = target.transport === "stdio" ? target.command : target.url;
  const detail = hint && !message.includes(hint) ? `${message} (${hint})` : message;
  return `${detail} · ${where}`;
}

export async function runManifest(options: RunOptions): Promise<RunReport> {
  const { manifest, manifestDir } = options;
  const mode: RunMode =
    options.mode ??
    (manifest.load && manifest.load.durationMs > 0
      ? "load"
      : manifest.soak
        ? "soak"
        : "smoke");
  const startedAt = new Date();
  const runId = options.runId ?? randomUUID();
  const manifestHash = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex")
    .slice(0, 16);

  const defaultServer = manifest.defaultTarget ?? DEFAULT_SERVER;
  if (manifest.protocolEra === "both") {
    return runManifestBothEras(options);
  }
  const targets = resolveTargets(manifest, manifestDir);
  if (manifest.protocolEra) {
    for (const [alias, item] of targets) targets.set(alias, { ...item, protocolEra: manifest.protocolEra } as Target);
  }
  const multiServer = targets.size > 1;
  const target = targets.get(defaultServer)!;
  // Every server must pass the same checks; the refusal names the server when there is more than one.
  const forServer = <T>(alias: string, check: () => T): T => {
    try {
      return check();
    } catch (error) {
      if (!multiServer || !(error instanceof Error)) throw error;
      throw Object.assign(new Error(`server ${alias}: ${error.message}`, { cause: error }), { name: error.name });
    }
  };
  if (options.standaloneTarget) {
    if (options.orgTargetAllowlist || options.orgGatewayAllowlist) {
      throw new Error("a standalone run takes no org allowlist");
    }
  } else {
    for (const [alias, item] of targets) {
      forServer(alias, () => assertTargetAllowlisted(item, manifest.allowlist, manifest.gateway?.gatewayId));
    }
  }
  if (options.orgTargetAllowlist) {
    for (const [alias, item] of targets) {
      const orgCheck = forServer(alias, () => assertOrgTargetAllowlisted(
        item,
        options.orgTargetAllowlist!,
        manifestDir,
        manifest.gateway?.gatewayId,
        options.orgGatewayAllowlist,
      ));
      if (orgCheck.usedLegacyStdioWildcard) {
        await appendAudit({
          kind: "legacy_stdio_allowlist_run",
          principal: options.principal,
          detail: `manifest=${manifest.name}${multiServer ? ` server=${alias}` : ""}`,
        });
      }
    }
  }

  const metrics = new MetricsCollector(multiServer);
  const quota = new QuotaTracker(manifest.quotas);
  const failReasons: string[] = [];
  const hopObservations: HopObservation[] = [];
  const retryPolicy = resolveRetryPolicy({ ...(manifest.retry ?? {}), ...(manifest.load?.retry ?? {}) });
  const trace: StepTrace = {
    nodeOutcomes: new Map(),
    redactedArgs: [],
    seenArgs: new Set(),
    ...(multiServer ? { defaultServer } : {}),
    retryPolicy,
    retryDeadline: Date.now() + manifest.quotas.maxDurationMs,
    resultDigests: new Map(),
    eraIgnoreKeys: manifest.eraCompare?.ignoreKeys ?? [],
    pacing: new PacingCollector(),
    recorder: new RunRecorder(Date.now()),
    hasExtractors: manifest.scenarios.some((scenario) => scenario.steps.some((step) => step.method === "extract")),
  };
  const timeline = new LoadTimelineCollector();
  const emit = (
    name: RunProgressEvent["name"],
    attributes: Record<string, string | number | boolean>,
  ) => {
    if (name === "mcp.load.vus" && typeof attributes.active === "number") trace.recorder?.setVus(attributes.active);
    if (name === "mcp.load.vus") timeline.setVus(Number(attributes.active) || 0);
    else if (name === "mcp.tool.call.duration") {
      timeline.recordToolCall(String(attributes.tool), Number(attributes.latencyMs) || 0, attributes.result === "ok");
    }
    options.onProgress?.({ ts: new Date().toISOString(), runId, name, attributes });
  };
  const telemetry = await initTelemetry(runId);

  const processCollector = new ProcessGaugeCollector(process.pid);
  const sampleIntervalMs =
    manifest.soak?.sampleIntervalMs ?? 1000;
  processCollector.start(sampleIntervalMs);

  const activeNodes = new Set<string>();
  const pool = new SessionPoolSet(defaultServer, targets, {
    size:
      mode === "load"
        ? Math.max(manifest.sessionPool.size, manifest.load?.maxConcurrency ?? 1)
        : manifest.sessionPool.size,
    reuse: manifest.sessionPool.reuse,
    headers: { "X-Swarm-Run-Id": runId },
    baseDir: manifestDir,
    retry: {
      policy: retryPolicy,
      deadline: () => trace.retryDeadline,
      onRetry: (event) => noteRetry(trace, emit, "initialize", event, { telemetry }),
      onGiveUp: (event) => noteRetryGiveUp(trace, "initialize", event, telemetry),
    },
    onSutPid: (pid, alias) => processCollector.trackSutPid(pid, alias),
    onStderr: (line, alias) => {
      const node = exclusiveActiveNode(activeNodes);
      emit("sut.stderr", { line, ...(node ? { node } : {}), ...(multiServer ? { server: alias } : {}) });
    },
  });

  const signal = options.signal;
  const onAbort = () => void pool.abort().catch(() => undefined);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  let sessionReady = true;
  if (manifest.sessionPool.reuse === "warm") {
    try {
      await pool.warmUp(calledServers(manifest, defaultServer));
    } catch (error) {
      sessionReady = false;
      const alias = (error as { serverAlias?: string }).serverAlias ?? defaultServer;
      const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
      failReasons.push(`Session warm-up failed${multiServer ? ` on ${alias}` : ""}: ${describeSessionFailure(cause, pool.target(alias))}`);
      await pool.drain();
    }
  }

  let soakIterations = 0;
  const soakStart = Date.now();
  const soakDurationMs = manifest.soak?.durationMs;
  const soakMaxIterations = manifest.soak?.maxIterations;
  const soakIntervalMs = manifest.soak?.intervalMs ?? 500;

  // `${__runId}` resolves to this run's id (the same id sent as X-Swarm-Run-Id and in swarm_run_completed).
  const seed = {
    seedVars: { ...(options.vars ?? {}), __runId: runId },
    strictParams: options.strictParams,
    toolResultValidator: options.toolResultValidator,
  };
  const runSuiteHook = async (hook: "setup" | "teardown", steps: ScenarioStep[] | undefined): Promise<PassResult | undefined> => {
    if (!steps || steps.length === 0 || !sessionReady) return undefined;
    const scenario: Scenario = { name: hook === "setup" ? "Suite setup" : "Suite teardown", iterations: 1, steps: steps.map((step) => ({ ...step, hook })) };
    const res = await runScenarioPass(
      scenario, pool, metrics, quota, telemetry,
      // Teardown ignores the stop signal: it always runs.
      scenarioContext(manifest, hopObservations, trace, emit, { activeNodes, ...seed, suiteHook: hook, ...(hook === "setup" ? { signal } : {}) }),
      0,
    );
    emit("mcp.scenario.result", { scenario: scenario.name, outcome: res.completed || hook === "teardown" ? "pass" : "fail", thread: 1 });
    return res;
  };
  let suiteSetupFailed: string | undefined;
  const setupRes = await runSuiteHook("setup", manifest.setup);
  if (setupRes && !setupRes.completed) {
    suiteSetupFailed = setupRes.message ?? "suite setup failed";
    failReasons.push(`Suite setup failed: ${suiteSetupFailed}; every scenario was skipped`);
  }
  try {
  if (!sessionReady || suiteSetupFailed) {
    // No session, or suite setup failed: there are no steps to run.
  } else if (mode === "soak") {
    while (!signal?.aborted) {
      quota.assertWithinDuration();
      if (soakDurationMs !== undefined && Date.now() - soakStart >= soakDurationMs) {
        break;
      }
      if (
        soakMaxIterations !== undefined &&
        soakIterations >= soakMaxIterations
      ) {
        break;
      }
      if (soakDurationMs === undefined && soakMaxIterations === undefined) {
        failReasons.push("Soak mode requires durationMs or maxIterations in manifest.soak");
        break;
      }

      await runAllScenarios(manifest, pool, metrics, quota, telemetry, hopObservations, trace, emit, activeNodes, seed);
      soakIterations++;
      if (soakDurationMs !== undefined && Date.now() - soakStart >= soakDurationMs) {
        break;
      }
      if (
        soakMaxIterations !== undefined &&
        soakIterations >= soakMaxIterations
      ) {
        break;
      }
      await sleep(soakIntervalMs);
    }
  } else if (mode === "load") {
    await runLoadProfile(manifest, pool, metrics, quota, telemetry, hopObservations, trace, emit, activeNodes, seed, signal);
  } else {
    await runAllScenarios(manifest, pool, metrics, quota, telemetry, hopObservations, trace, emit, activeNodes, seed);
  }
  } finally {
    // Suite teardown always runs, after success, failure or stop. Its errors never fail the verdict.
    await runSuiteHook("teardown", manifest.teardown);
  }

  signal?.removeEventListener("abort", onAbort);
  if (signal?.aborted) {
    failReasons.push("run aborted");
    await pool.abort();
  }
  await pool.drain();
  const processSeries = await processCollector.stop();
  for (const sample of processSeries) {
    telemetry.recordProcessSample(sample);
    emit("process.runtime", {
      role: sample.role,
      rssBytes: sample.rssBytes,
      cpuRatio: sample.cpuRatio,
    });
  }
  const processSummaryRaw = processCollector.summarize(multiServer ? defaultServer : undefined);
  const serverProcesses = [processSummaryRaw.sut, ...Object.values(processSummaryRaw.suts ?? {})];
  const otelSpikeFlag =
    processSummaryRaw.worker.cpuRatio.max > 0.8 ||
    serverProcesses.some((sut) => (sut?.cpuRatio.max ?? 0) > 0.8) ||
    processSummaryRaw.worker.rssBytes.max > 512 * 1024 * 1024 ||
    serverProcesses.some((sut) => (sut?.rssBytes.max ?? 0) > 512 * 1024 * 1024);

  const processSummary = {
    ...processSummaryRaw,
    otelSpikeFlag,
  };

  const processFailures = manifest.processAssertions
    ? checkProcessAssertions(processSummaryRaw, manifest.processAssertions)
    : [];

  const finishedAt = new Date();
  const toolSeries = metrics.buildToolSeries();
  const rpcSeries = metrics.buildRpcSeries();
  const scenarioOutcomes = metrics.getScenarioOutcomes();

  const silentGreen = detectSilentGreen(
    manifest.scenarios.length * (mode === "soak" ? Math.max(soakIterations, 1) : 1),
    scenarioOutcomes,
    sessionReady,
  );

  // Teardown calls are reported in hookErrors, never judged against step or server objectives.
  const teardownNodes = new Set(
    [...(manifest.teardown ?? []), ...manifest.scenarios.flatMap((sc) => sc.steps).filter((step) => step.hook === "teardown")]
      .map((step) => step.nodeId)
      .filter((id): id is string => Boolean(id)),
  );
  const judged = () => metrics.getObservations().filter((o) => !o.nodeId || !teardownNodes.has(o.nodeId));
  failReasons.push(
    ...buildFailReasons(
      manifest,
      judged(),
      scenarioOutcomes,
      silentGreen,
      processFailures,
    ),
  );

  for (const node of trace.nodeOutcomes.values()) {
    if (!node.errorMessage) continue;
    const index = failReasons.findIndex((reason) => reason.startsWith(`Step ${node.label} error_rate `));
    if (index >= 0) failReasons[index] += `: ${node.errorMessage}`;
  }

  const requiredPv =
    manifest.assertions.requireProtocolVersion ?? manifest.protocolVersion;
  if (requiredPv && requiredPv !== LATEST_PROTOCOL_VERSION) {
    failReasons.push(
      `Protocol version label ${requiredPv} does not match SDK negotiated ${LATEST_PROTOCOL_VERSION}`,
    );
  }

  const requiredEra = manifest.assertions.requireProtocolEra;
  if (requiredEra && trace.protocolEra && requiredEra !== trace.protocolEra) {
    failReasons.push(
      `Protocol era ${requiredEra} required but the run spoke ${trace.protocolEra}` +
        (trace.eraFallbackReason ? ` (Auto fell back: ${trace.eraFallbackReason})` : ""),
    );
  }

  failReasons.push(...serverSloReasons(manifest, judged(), defaultServer));

  const verdict = computeVerdict(failReasons, silentGreen);
  const gatewayMetrics = buildGatewayMetrics(manifest, hopObservations);

  const pacing = trace.pacing?.summary({
    dwellMs: resolvedDwellMs(manifest),
    dwellJitterRatio: resolveDwellJitterRatio(manifest.load?.dwellJitterRatio),
    ...(manifest.load ? { passJitterMs: manifest.load.jitterMs } : {}),
  });

  let telemetryFailed = false;
  try { await telemetry.flush(); } catch { telemetryFailed = true; }
  try { await telemetry.shutdown(); } catch { telemetryFailed = true; }
  const otelStatus = telemetryFailed ? "failed" : telemetry.exportStatus?.() ?? "disabled";

  return {
    id: runId,
    manifestName: manifest.name,
    manifestHash,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    verdict,
    failReasons,
    silentGreen,
    mode,
    transport: manifest.target.transport,
    server: runServer(target, pool.serverInfo()),
    servers: [...targets].map(([alias, item]) => serverSummary(alias, item, pool.serverInfo(alias), metrics, multiServer)),
    flow: metrics.buildFlow(),
    ...(metrics.buildVariables().length > 0 ? { variables: metrics.buildVariables() } : {}),
    soak: mode === "soak"
      ? {
          iterations: soakIterations,
          durationMs: finishedAt.getTime() - soakStart,
          intervalMs: soakIntervalMs,
        }
      : undefined,
    sessionMetrics: metrics.getSessionMetrics(manifest.target.transport),
    processSeries,
    loadTimeline: timeline.finish(),
    ...(trace.protocolEra ? { protocolEra: trace.protocolEra } : {}),
    ...(trace.requestedEra ? { protocolEraRequested: trace.requestedEra } : {}),
    ...(trace.eraFallbackReason ? { protocolEraFallback: trace.eraFallbackReason } : {}),
    ...(options.collectEraDigests && trace.resultDigests?.size
      ? { eraResultDigests: Object.fromEntries(trace.resultDigests) }
      : {}),
    processSummary,
    toolSeries,
    ...(trace.hookErrors?.length ? { hookErrors: trace.hookErrors } : {}),
    rpcSeries,
    scenarioOutcomes,
    quotas: {
      concurrencyUsed: quota.concurrencyUsed,
      callCount: quota.calls,
      maxPayloadBytesSeen: quota.largestPayload,
    },
    limits: { maxCallCount: manifest.quotas.maxCallCount, maxPayloadBytes: manifest.quotas.maxPayloadBytes },
    principal: options.principal,
    scheduleId: options.scheduleId,
    ...(options.vars ? { params: options.vars } : {}),
    gatewayMetrics,
    otelExported: otelStatus === "delivered",
    otelStatus,
    loadProfile: mode === "load" ? manifest.load : undefined,
    nodeOutcomes: [...trace.nodeOutcomes.values()],
    redactedArgs: trace.redactedArgs,
    ...(trace.recorder
      ? { sampleResults: trace.recorder.sampleResults(), timeSeries: trace.recorder.timeSeries() }
      : {}),
    ...(trace.retries ? { retries: trace.retries } : {}),
    ...(pacing ? { pacing } : {}),
    ...(mode === "load" && trace.rampDownSummary
      ? {
          rampDown: {
            ...trace.rampDownSummary,
            cancelledByRampDown: trace.rampDown?.cancelled ?? 0,
            incompletePasses: trace.rampDown?.incomplete ?? 0,
            skippedPasses: trace.rampDown?.skipped ?? 0,
          },
        }
      : {}),
  };
}


/** Keys whose values legitimately differ between two runs (time, ids, tracing). */
const VOLATILE_KEY = /(^|_|-)(ts|time|timestamp|at|date|id|uuid|trace|traceid|traceparent|span|spanid|request_?id|run_?id|session_?id|duration|duration_ms|latency|latency_ms|elapsed|elapsed_ms|took|took_ms|nonce|etag|expires|expires_at|created|created_at|updated|updated_at)$/i;

function normaliseForEra(value: unknown, depth = 0, ignore: ReadonlySet<string> = new Set()): unknown {
  if (depth > 12) return "…";
  // Tool text content is often JSON-encoded: normalise inside it so volatile keys are dropped there too.
  if (typeof value === "string" && /^\s*[[{]/.test(value)) {
    try {
      return normaliseForEra(JSON.parse(value), depth + 1, ignore);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((v) => normaliseForEra(v, depth + 1, ignore));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key === "_meta" || key === "resultType" || VOLATILE_KEY.test(key) || ignore.has(key)) continue;
      out[key] = normaliseForEra((value as Record<string, unknown>)[key], depth + 1, ignore);
    }
    return out;
  }
  return value;
}

/** Max serialized size of one recorded response payload. */
export const RESPONSE_SAMPLE_MAX_BYTES = 8192;

/** Redact, then cap a payload so reports stay small; oversize payloads become a truncated preview. */
export function capPayload(value: unknown, max = RESPONSE_SAMPLE_MAX_BYTES): { value: unknown; truncated: boolean; bytes: number } {
  const red = redactValue(value);
  let text: string;
  try {
    text = JSON.stringify(red) ?? "null";
  } catch {
    text = String(red);
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= max) return { value: red, truncated: false, bytes };
  return { value: { preview: text.slice(0, max), note: `truncated: ${bytes} bytes > ${max}` }, truncated: true, bytes };
}

/** Era-neutral digest of a tools/call result: structuredContent (else content), volatile keys removed. */
export function eraResultDigest(result: unknown, ignoreKeys: readonly string[] = []): string {
  const r = (result ?? {}) as { structuredContent?: unknown; content?: unknown; isError?: boolean };
  const body = r.structuredContent !== undefined ? r.structuredContent : r.content;
  return createHash("sha256").update(JSON.stringify({ isError: Boolean(r.isError), body: normaliseForEra(body, 0, new Set(ignoreKeys)) })).digest("hex").slice(0, 16);
}

/**
 * Compare mode (`protocolEra: both`): run the suite pinned to legacy, then
 * pinned to modern, and diff verdicts, per-node outcomes and tool-result digests.
 * The returned report is the modern run, annotated with `eraComparison`; any
 * divergence (or modern unavailable) fails the run.
 */
export async function runManifestBothEras(options: RunOptions): Promise<RunReport> {
  const pin = (era: "legacy" | "modern"): RunOptions => ({
    ...options,
    collectEraDigests: true,
    runId: options.runId ? `${options.runId}-${era}` : undefined,
    manifest: { ...options.manifest, protocolEra: era },
  });
  const legacy = await runManifest(pin("legacy"));
  const modern = await runManifest({ ...pin("modern"), runId: options.runId });
  const diffs: string[] = [];
  if (legacy.verdict !== modern.verdict) diffs.push(`verdict: legacy=${legacy.verdict} modern=${modern.verdict}`);
  const lNodes = new Map((legacy.nodeOutcomes ?? []).map((n) => [n.nodeId, n]));
  for (const n of modern.nodeOutcomes ?? []) {
    const l = lNodes.get(n.nodeId);
    if (!l) { diffs.push(`node ${n.label}: only ran on modern`); continue; }
    if ((l.errorCount > 0) !== (n.errorCount > 0)) {
      diffs.push(`node ${n.label}: legacy errors=${l.errorCount} modern errors=${n.errorCount}${n.errorMessage ? ` (${n.errorMessage.slice(0, 160)})` : ""}`);
    }
  }
  const ld = legacy.eraResultDigests ?? {};
  const md = modern.eraResultDigests ?? {};
  let compared = 0;
  for (const [node, digest] of Object.entries(ld)) {
    if (md[node] === undefined) continue;
    compared += 1;
    if (md[node] !== digest) {
      const label = (modern.nodeOutcomes ?? []).find((n) => n.nodeId === node)?.label ?? node;
      diffs.push(`node ${label}: tool result differs across eras`);
    }
  }
  const eraComparison = {
    legacy: { runId: legacy.id, verdict: legacy.verdict, protocolEra: legacy.protocolEra },
    modern: { runId: modern.id, verdict: modern.verdict, protocolEra: modern.protocolEra },
    comparedToolResults: compared,
    equivalent: diffs.length === 0 && modern.protocolEra === "modern" && legacy.protocolEra === "legacy",
    diffs,
  };
  const failReasons = [...modern.failReasons];
  if (modern.protocolEra !== "modern") failReasons.push(`Compare mode: modern run did not speak modern (${modern.protocolEraFallback ?? modern.failReasons[0] ?? "unknown"})`);
  for (const d of diffs) failReasons.push(`Era divergence: ${d}`);
  for (const r of legacy.failReasons) failReasons.push(`[legacy] ${r}`);
  const verdict: RunReport["verdict"] = eraComparison.equivalent && legacy.verdict === "pass" ? modern.verdict : "fail";
  return { ...modern, verdict, failReasons, eraComparison };
}
