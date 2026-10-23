import { createHash, randomUUID } from "node:crypto";
import type { Manifest, Scenario, ScenarioStep, Target } from "../types/manifest.js";
import type { RunMode, RunProgressEvent, RunReport } from "../types/run.js";
import { contractFailure, validateAgainstSchema } from "./contract.js";
import { redactValue } from "./redaction.js";
import { RunRecorder } from "./run-recorder.js";
import {
  drainDeadlineMs,
  mayStartIteration,
  readPath,
  substituteValue,
  UnresolvedParamError,
  vuStartOffsetMs,
  type VarContext,
} from "./suite-model.js";
import { assertTargetAllowlisted } from "./allowlist.js";
import { callSloFailures } from "./call-slo.js";
import { exclusiveActiveNode } from "./node-log.js";
import { assertOrgTargetAllowlisted } from "./org-target-policy.js";
import type { AllowlistEntry } from "../service/mcp-allowlist.js";
import {
  detectSilentGreen,
  computeVerdict,
  MetricsCollector,
} from "./metrics.js";
import {
  ProcessGaugeCollector,
  checkProcessAssertions,
} from "./process-gauges.js";
import { QuotaTracker } from "./quotas.js";
import { resolveRetryPolicy, retryingSession, type RetryEvent, type RetryPolicy } from "./rate-limit-retry.js";
import { SessionPool } from "./session-pool.js";
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
}

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
  nodeOutcomes: Map<string, NonNullable<RunReport["nodeOutcomes"]>[number]>;
  redactedArgs: Array<{ nodeId: string; tool?: string; args: unknown }>;
  seenArgs: Set<string>;
  retryPolicy?: RetryPolicy;
  /** Epoch ms after which no retry may start (run max duration). */
  retryDeadline?: number;
  retries?: NonNullable<RunReport["retries"]>;
  recorder?: RunRecorder;
}

function noteRetry(
  trace: StepTrace,
  emit: (name: RunProgressEvent["name"], attributes: Record<string, string | number | boolean>) => void,
  method: string,
  event: RetryEvent,
  extra: { nodeId?: string; label?: string; tool?: string; thread?: number } = {},
): void {
  const retries = (trace.retries ??= { total: 0, reason: "rate_limit", byMethod: {}, sessionSetup: 0 });
  retries.total += 1;
  retries.byMethod[method] = (retries.byMethod[method] ?? 0) + 1;
  if (method === "initialize") retries.sessionSetup += 1;
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
    method,
    attempt: event.attempt,
    delayMs: event.delayMs,
    ...(event.retryAfterMs !== undefined ? { retryAfterMs: event.retryAfterMs } : {}),
    ...(extra.tool ? { tool: extra.tool } : {}),
    ...(extra.nodeId ? { node: extra.nodeId } : {}),
    ...(extra.thread !== undefined ? { thread: extra.thread } : {}),
    ...(event.message ? { message: event.message.slice(0, 300) } : {}),
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

function noteNode(trace: StepTrace, step: ScenarioStep, ok: boolean, message?: string): void {
  if (!step.nodeId) return;
  const current: NonNullable<RunReport["nodeOutcomes"]>[number] = trace.nodeOutcomes.get(step.nodeId) ?? {
    nodeId: step.nodeId,
    label: step.label ?? step.tool ?? step.method,
    count: 0,
    errorCount: 0,
  };
  current.count += 1;
  if (!ok) {
    current.errorCount += 1;
    if (message && !current.errorMessage) current.errorMessage = message.slice(0, 1000);
  }
  trace.nodeOutcomes.set(step.nodeId, current);
}

async function executeStep(
  session: McpSession,
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
  prior?: { value: unknown },
): Promise<{ ok: boolean; message?: string; result?: unknown }> {
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
    ctx.vars[variable] = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
    noteNode(trace, step, true);
    return { ok: true };
  }
  if (step.method === "teardown") {
    noteNode(trace, step, true);
    return { ok: true };
  }

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
  if (step.nodeId && !trace.seenArgs.has(step.nodeId)) {
    trace.seenArgs.add(step.nodeId);
    trace.redactedArgs.push({
      nodeId: step.nodeId,
      tool: step.tool,
      args: redactValue(args),
    });
  }

  const record = (
    method: string,
    raw: McpCallResult,
    toolName?: string,
  ) => {
    const contracted = applyContract(step, raw);
    const expected = applyExpectErrorClass(contracted, step);
    // Expected tool errors must not inflate error rate. The scenario outcome
    // already asserted the class; unexpected errors still Fail.
    const result =
      method === "tools/call" && step.expectErrorClass && expected.ok
        ? { ...contracted, success: true, errorClass: "none" as const }
        : contracted;
    const obs = {
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
    telemetry.recordCall(obs, transport);
    if (gatewayMode) hopObservations.push(observeGatewayHop(result));
    emit("mcp.rpc.duration", {
      method,
      latencyMs: result.latencyMs,
      result: result.errorClass === "none" ? "ok" : result.errorClass,
      tool: toolName ?? "",
    });
    if (method === "tools/call" && toolName) {
      emit("mcp.tool.call.duration", {
        tool: toolName,
        latencyMs: result.latencyMs,
        result: result.errorClass === "none" ? "ok" : result.errorClass,
      });
      if (result.errorClass !== "none") {
        emit("mcp.tool.call.errors", { tool: toolName, error_class: result.errorClass });
      }
      trace.recorder?.recordToolCall({
        tool: toolName,
        ok: result.errorClass === "none" && expected.ok,
        latencyMs: result.latencyMs,
        args,
        result: contracted.result,
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
      return record("initialize", {
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
          return record("tools/list", {
            ...result,
            success: false,
            errorClass: "protocol",
            errorMessage: dialect.message,
          });
        }
      }
      return record("tools/list", result);
    }
    case "resources/list":
      return record(
        "resources/list",
        await session.listResources(typeof args.cursor === "string" ? args.cursor : undefined),
      );
    case "resources/templates/list":
      return record(
        "resources/templates/list",
        await session.listResourceTemplates(typeof args.cursor === "string" ? args.cursor : undefined),
      );
    case "resources/read": {
      const uri = step.resourceUri ?? step.uri;
      if (!uri) {
        noteNode(trace, step, false);
        return { ok: false, message: "resources/read requires a uri" };
      }
      return record("resources/read", await session.readResource(uri));
    }
    case "prompts/list":
      return record(
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
      return record("prompts/get", await session.getPrompt(name, promptArgs));
    }
    case "logging/setLevel":
      return record("logging/setLevel", await session.setLoggingLevel(String(args.level ?? "info")));
    case "completion/complete": {
      const ref = args.ref === "resource" ? "resource" : "prompt";
      const name = ref === "prompt" ? step.prompt ?? step.name : step.resourceUri ?? step.uri;
      if (!name || typeof args.argument !== "string") {
        noteNode(trace, step, false);
        return { ok: false, message: "completion/complete requires a ref and argument" };
      }
      return record("completion/complete", await session.complete({
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
      return record("tools/call", await session.callTool(step.tool, args, step.timeoutMs), step.tool);
    }
    case "ping":
      return record("ping", await session.ping());
    case "tasks/list":
      return record(
        "tasks/list",
        await session.listTasks(typeof args.cursor === "string" ? args.cursor : undefined),
      );
    case "tasks/get": {
      if (!step.taskId) {
        noteNode(trace, step, false);
        return { ok: false, message: "tasks/get requires taskId" };
      }
      return record("tasks/get", await session.getTask(step.taskId));
    }
    case "tasks/cancel": {
      if (!step.taskId) {
        noteNode(trace, step, false);
        return { ok: false, message: "tasks/cancel requires taskId" };
      }
      return record("tasks/cancel", await session.cancelTask(step.taskId));
    }
    default:
      noteNode(trace, step, false);
      return { ok: false, message: `Unknown method: ${step.method}` };
  }
}

interface ScenarioRunContext {
  transport: string;
  hopObservations: HopObservation[];
  gatewayMode: boolean;
  trace: StepTrace;
  emit: (name: RunProgressEvent["name"], attributes: Record<string, string | number | boolean>) => void;
  thread: number;
  iter: number;
  waitForSlot: boolean;
  drainAt?: number;
  dwellMs: number;
  /** How many ready steps in one pass may run at once. */
  stepParallelism: number;
  /** Steps inside executeStep. Server stderr is stamped only when this has one id. */
  activeNodes: Set<string>;
  seedVars?: Record<string, string>;
  strictParams?: boolean;
}

async function runScenario(
  scenario: Scenario,
  pool: SessionPool,
  metrics: MetricsCollector,
  quota: QuotaTracker,
  telemetry: TelemetryHandle,
  run: ScenarioRunContext,
): Promise<void> {
  await Promise.all(
    Array.from({ length: scenario.iterations }, (_, i) => runScenarioPass(scenario, pool, metrics, quota, telemetry, run, i)),
  );
}

async function runScenarioPass(
  scenario: Scenario,
  pool: SessionPool,
  metrics: MetricsCollector,
  quota: QuotaTracker,
  telemetry: TelemetryHandle,
  run: ScenarioRunContext,
  i: number,
): Promise<void> {
  await quota.acquireConcurrency({ wait: true });
    let session: McpSession | undefined;
    let reused = false;
    let scenarioOk = true;
    let lastMessage: string | undefined;
    const ctx: VarContext = {
      thread: run.thread,
      iter: run.iter + i,
      loop: 0,
      vars: { ...(run.seedVars ?? {}) },
      strict: run.strictParams === true,
    };

    try {
      const acquired = await pool.acquire();
      session = acquired.session;
      if (!session) throw new Error("session_missing");
      const boundSession = session;
      reused = acquired.reused;
      metrics.recordSessionStart();
      telemetry.recordSessionStart(run.transport, "started");
      run.emit("mcp.session.start", { transport: run.transport, result: "started", thread: run.thread });

      const results = new Map<number, unknown>();
      const runOne = async (index: number): Promise<{ ok: boolean; message?: string }> => {
        const step = scenario.steps[index]!;
        ctx.loop = step.loopIndex ?? 0;
        const stepStarted = Date.now();
        const nodeId = step.nodeId ?? "";
        if (nodeId) run.activeNodes.add(nodeId);
        const producer = step.waitFor?.at(-1);
        try {
          run.emit("mcp.step", {
            node: nodeId,
            label: step.label ?? step.tool ?? step.method,
            method: step.method,
            phase: "start",
            result: "run",
            latencyMs: 0,
            iter: ctx.iter,
            thread: run.thread,
            loop: ctx.loop,
          });
          const stepSession = run.trace.retryPolicy
            ? retryingSession(boundSession, run.trace.retryPolicy, {
                deadline: () => minDeadline(run.drainAt, run.trace.retryDeadline),
                onRetry: (method, event) =>
                  noteRetry(run.trace, run.emit, method === "callTool" ? "tools/call" : step.method, event, {
                    nodeId: step.nodeId,
                    label: step.label,
                    tool: step.tool,
                    thread: run.thread,
                  }),
              })
            : boundSession;
          const result = await executeStep(
            stepSession,
            step,
            metrics,
            quota,
            reused,
            telemetry,
            run.transport,
            run.hopObservations,
            run.gatewayMode,
            ctx,
            run.trace,
            run.emit,
            producer === undefined ? undefined : { value: results.get(producer) },
          );
          results.set(index, result.result);
          run.emit("mcp.step", {
            node: nodeId,
            label: step.label ?? step.tool ?? step.method,
            method: step.method,
            phase: "done",
            result: result.ok ? "ok" : "fail",
            latencyMs: Date.now() - stepStarted,
            iter: ctx.iter,
            thread: run.thread,
            loop: ctx.loop,
          });
          return result;
        } finally {
          if (step.elicit) {
            boundSession.setElicitAutoReply({ action: "accept", content: {} });
          }
          if (nodeId) run.activeNodes.delete(nodeId);
        }
      };
      const note = (result: { ok: boolean; message?: string }) => {
        if (!result.ok) {
          scenarioOk = false;
          lastMessage = result.message;
        }
      };
      const drained = (): boolean => {
        if (run.drainAt === undefined || Date.now() <= run.drainAt) return false;
        scenarioOk = false;
        lastMessage = "ramp-down deadline";
        return true;
      };
      const dag = scenario.steps.some((step) => step.waitFor !== undefined);
      if (!dag) {
        for (let index = 0; index < scenario.steps.length; index++) {
          if (drained()) break;
          note(await runOne(index));
          if (index < scenario.steps.length - 1 && run.dwellMs > 0) await sleep(run.dwellMs);
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
          if (waveKey && !dwelled.has(waveKey) && done.size > 0 && run.dwellMs > 0) {
            await sleep(run.dwellMs);
          }
          dwelled.add(waveKey);
          const batch = nextBatch(ready, scenario.steps, run.stepParallelism);
          const finished = await Promise.all(batch.map(async (index) => ({ index, result: await runOne(index) })));
          for (const item of finished) {
            pending.delete(item.index);
            done.add(item.index);
            note(item.result);
          }
        }
      }

      const outcome = scenarioOk ? "pass" : "fail";
      metrics.recordScenarioOutcome({
        scenario: scenario.name,
        outcome,
        message: lastMessage,
      });
      telemetry.recordScenario(scenario.name, outcome);
      run.emit("mcp.scenario.result", { scenario: scenario.name, outcome, thread: run.thread });
      metrics.recordSessionEnd(scenarioOk);
      telemetry.recordSessionStart(run.transport, scenarioOk ? "ok" : "fail");
      await pool.release(session, true);
    } catch (error) {
      metrics.recordSessionEnd(false);
      metrics.recordScenarioOutcome({
        scenario: scenario.name,
        outcome: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      run.emit("mcp.scenario.result", {
        scenario: scenario.name,
        outcome: "error",
        thread: run.thread,
      });
      if (session) await pool.release(session, false);
    } finally {
      quota.releaseConcurrency();
    }
}

function scenarioContext(
  manifest: Manifest,
  hopObservations: HopObservation[],
  trace: StepTrace,
  emit: ScenarioRunContext["emit"],
  extra?: Partial<ScenarioRunContext>,
): ScenarioRunContext {
  return {
    transport: manifest.target.transport,
    hopObservations,
    gatewayMode: isGatewayMode(manifest),
    trace,
    emit,
    thread: 1,
    iter: 0,
    waitForSlot: false,
    dwellMs: Math.max(0, manifest.load?.dwellMs ?? 1000),
    stepParallelism: Math.max(1, manifest.load?.lanes ?? 4),
    activeNodes: new Set(),
    ...extra,
  };
}

async function runAllScenarios(
  manifest: Manifest,
  pool: SessionPool,
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
  pool: SessionPool,
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
  let active = 0;
  const publishVus = () => emit("mcp.load.vus", { active, max: vuCount });

  await Promise.all(
    Array.from({ length: vuCount }, async (_unused, index) => {
      const delay = vuStartOffsetMs(index, vuCount, load.rampUpMs);
      if (delay > 0) await sleep(delay);
      active += 1;
      publishVus();
      let passes = 0;
      try {
        while (!signal?.aborted && (passes < minPasses || mayStartIteration(Date.now(), origin, load))) {
          const scenario = manifest.scenarios[index % manifest.scenarios.length] ?? manifest.scenarios[0];
          if (!scenario) break;
          const required = passes < minPasses;
          await runScenario({ ...scenario, iterations: 1 }, pool, metrics, quota, telemetry, scenarioContext(manifest, hopObservations, trace, emit, {
            thread: index + 1,
            iter: passes,
            waitForSlot: true,
            drainAt: required ? undefined : drainDeadlineMs(origin, load),
            activeNodes,
            ...seed,
          }));
          passes += 1;
          if (passes >= minPasses && !mayStartIteration(Date.now(), origin, load)) break;
          if (load.jitterMs > 0) await sleep(Math.floor(Math.random() * (load.jitterMs + 1)));
        }
      } finally {
        active -= 1;
        publishVus();
      }
    }),
  );
}

function resolveTarget(manifest: Manifest, baseDir?: string) {
  if (manifest.target.transport === "stdio") {
    return resolveStdioTarget(manifest.target, baseDir);
  }
  return manifest.target;
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
  failReasons.push(
    ...callSloFailures({
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
    }),
  );

  for (const outcome of scenarioOutcomes) {
    if (outcome.outcome === "fail" || outcome.outcome === "error") {
      failReasons.push(
        `Scenario ${outcome.scenario} ${outcome.outcome}${outcome.message ? `: ${outcome.message}` : ""}`,
      );
    }
  }

  return failReasons;
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

  const target = resolveTarget(manifest, manifestDir);
  if (options.standaloneTarget) {
    if (options.orgTargetAllowlist || options.orgGatewayAllowlist) {
      throw new Error("a standalone run takes no org allowlist");
    }
  } else {
    assertTargetAllowlisted(target, manifest.allowlist, manifest.gateway?.gatewayId);
  }
  if (options.orgTargetAllowlist) {
    const orgCheck = assertOrgTargetAllowlisted(
      target,
      options.orgTargetAllowlist,
      manifestDir,
      manifest.gateway?.gatewayId,
      options.orgGatewayAllowlist,
    );
    if (orgCheck.usedLegacyStdioWildcard) {
      await appendAudit({
        kind: "legacy_stdio_allowlist_run",
        principal: options.principal,
        detail: `manifest=${manifest.name}`,
      });
    }
  }

  const metrics = new MetricsCollector();
  const quota = new QuotaTracker(manifest.quotas);
  const failReasons: string[] = [];
  const hopObservations: HopObservation[] = [];
  const retryPolicy = resolveRetryPolicy({ ...(manifest.retry ?? {}), ...(manifest.load?.retry ?? {}) });
  const trace: StepTrace = {
    nodeOutcomes: new Map(),
    redactedArgs: [],
    seenArgs: new Set(),
    retryPolicy,
    retryDeadline: Date.now() + manifest.quotas.maxDurationMs,
    recorder: new RunRecorder(Date.now()),
  };
  const emit = (
    name: RunProgressEvent["name"],
    attributes: Record<string, string | number | boolean>,
  ) => {
    if (name === "mcp.load.vus" && typeof attributes.active === "number") trace.recorder?.setVus(attributes.active);
    options.onProgress?.({ ts: new Date().toISOString(), runId, name, attributes });
  };
  const telemetry = await initTelemetry(runId);

  const processCollector = new ProcessGaugeCollector(process.pid);
  const sampleIntervalMs =
    manifest.soak?.sampleIntervalMs ?? 1000;
  processCollector.start(sampleIntervalMs);

  const activeNodes = new Set<string>();
  const pool = new SessionPool({
    size:
      mode === "load"
        ? Math.max(manifest.sessionPool.size, manifest.load?.maxConcurrency ?? 1)
        : manifest.sessionPool.size,
    reuse: manifest.sessionPool.reuse,
    target,
    baseDir: manifestDir,
    retry: {
      policy: retryPolicy,
      deadline: () => trace.retryDeadline,
      onRetry: (event) => noteRetry(trace, emit, "initialize", event),
    },
    onSutPid: (pid) => processCollector.trackSutPid(pid),
    onStderr: (line) => {
      const node = exclusiveActiveNode(activeNodes);
      emit("sut.stderr", node ? { line, node } : { line });
    },
  });

  const signal = options.signal;
  const onAbort = () => void pool.abort().catch(() => undefined);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  let sessionReady = true;
  if (manifest.sessionPool.reuse === "warm") {
    try {
      await pool.warmUp();
    } catch (error) {
      sessionReady = false;
      failReasons.push(`Session warm-up failed: ${describeSessionFailure(error, target)}`);
    }
  }

  let soakIterations = 0;
  const soakStart = Date.now();
  const soakDurationMs = manifest.soak?.durationMs;
  const soakMaxIterations = manifest.soak?.maxIterations;
  const soakIntervalMs = manifest.soak?.intervalMs ?? 500;

  const seed = { seedVars: options.vars, strictParams: options.strictParams };
  if (!sessionReady) {
    // The suite never opened a session, so there are no steps to run.
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
  const processSummaryRaw = processCollector.summarize();
  const otelSpikeFlag =
    processSummaryRaw.worker.cpuRatio.max > 0.8 ||
    (processSummaryRaw.sut?.cpuRatio.max ?? 0) > 0.8 ||
    processSummaryRaw.worker.rssBytes.max > 512 * 1024 * 1024 ||
    (processSummaryRaw.sut?.rssBytes.max ?? 0) > 512 * 1024 * 1024;

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

  failReasons.push(
    ...buildFailReasons(
      manifest,
      metrics.getObservations(),
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

  const verdict = computeVerdict(failReasons, silentGreen);
  const gatewayMetrics = buildGatewayMetrics(manifest, hopObservations);

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
    soak: mode === "soak"
      ? {
          iterations: soakIterations,
          durationMs: finishedAt.getTime() - soakStart,
          intervalMs: soakIntervalMs,
        }
      : undefined,
    sessionMetrics: metrics.getSessionMetrics(manifest.target.transport),
    processSeries,
    processSummary,
    toolSeries,
    rpcSeries,
    scenarioOutcomes,
    quotas: {
      concurrencyUsed: quota.concurrencyUsed,
      callCount: quota.calls,
      maxPayloadBytesSeen: quota.largestPayload,
    },
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
  };
}
