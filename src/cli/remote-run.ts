import { writeReports } from "../engine/core/report.js";
import type { LoadPresetId } from "../engine/core/load-presets.js";
import type { RunReport, ToolSeries } from "../engine/types/run.js";
import { SWARM_TESTER_USER_AGENT } from "../engine/adapters/http-fetch.js";
import { resolveSwarmServerUrl } from "./worker-transport.js";

export const SWARM_TOKEN_ENV_KEYS = ["SWARM_TOKEN", "SWARM_WORKER_TOKEN", "BOTZ_API_KEY"] as const;

export interface RemoteRunOptions {
  /** Central Swarm server base URL (`https://swarm.botz.ai` by default). */
  server?: string;
  /** Bearer token (`bzt_...` or OAuth token) for authenticating with the central Swarm server. */
  token?: string;
  /** Project ID or name on the central Swarm server. */
  projectId: string;
  /** Optional suite ID within the project. */
  suiteId?: string;
  /** Named load profile preset (`smoke`, `baseline`, `peak`, `spike`, `soak`). */
  preset?: LoadPresetId;
  /** Execution dispatch mode on the central server (`local` or `worker` for distributed VU execution). */
  dispatch?: "local" | "worker";
  /** Optional concurrency (VUs) override. */
  concurrency?: number;
  /** Optional hold duration (ms) override. */
  durationMs?: number;
  /** Send X-Swarm-Skip-Image-Gen: 1 during load/soak runs. */
  skipImageGen?: boolean;
  /** Send X-Swarm-Skip-Expensive-Llm: 1 during load/soak runs. */
  skipExpensiveLlm?: boolean;
  /** Poll interval in ms while waiting for central run completion. */
  pollIntervalMs?: number;
  /** AbortSignal for cancelling the remote run on SIGINT/SIGTERM. */
  signal?: AbortSignal;
  /** Optional progress callback invoked on each status poll. */
  onProgress?: (status: RemoteRunPollStatus) => void;
  /** Optional output directory to write JSON and Markdown reports locally. */
  outputDir?: string;
  /** Optional environment map for resolving token/server defaults. */
  env?: NodeJS.ProcessEnv;
  /** Optional fetch implementation for unit tests. */
  fetchFn?: typeof fetch;
}

export interface RemoteRunPollStatus {
  runId: string;
  projectId: string;
  suiteId?: string;
  status: "running" | "completed" | "failed";
  verdict?: "pass" | "fail";
  bufferedEventsCount?: number;
  progress?: Record<string, unknown>;
}

export function resolveRemoteSwarmToken(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (flag?.trim()) return flag.trim();
  for (const key of SWARM_TOKEN_ENV_KEYS) {
    const val = env[key]?.trim();
    if (val) return val;
  }
  throw new Error(
    `Swarm token missing for central server run: pass --token or set ${SWARM_TOKEN_ENV_KEYS.join(" / ")}`,
  );
}

async function callSwarmMcpTool(
  serverOriginUrl: string,
  token: string,
  toolName: string,
  args: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const endpoint = new URL("/mcp", serverOriginUrl).toString();
  const res = await fetchFn(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "user-agent": SWARM_TESTER_USER_AGENT,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    }),
    signal,
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(`Central Swarm server rejected authentication (${res.status}) at ${endpoint}`);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Central Swarm MCP call '${toolName}' failed (${res.status}): ${errText.slice(0, 200)}`);
  }

  const body = (await res.json()) as {
    error?: { message?: string };
    result?: {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content?: Array<{ type?: string; text?: string }>;
    };
  };
  if (body.error) {
    throw new Error(`Central Swarm MCP error on '${toolName}': ${body.error.message ?? "unknown error"}`);
  }
  const result = body.result;
  if (!result) {
    throw new Error(`Central Swarm MCP call '${toolName}' returned an empty result`);
  }
  if (result.isError) {
    const text = result.content?.[0]?.text ?? "tool execution failed";
    throw new Error(text);
  }
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const firstText = result.content?.find((c) => c.type === "text")?.text;
  if (firstText) {
    try {
      return JSON.parse(firstText) as Record<string, unknown>;
    } catch {
      return { rawText: firstText };
    }
  }
  return {};
}

function synthesizeReportFromStatus(
  statusPayload: Record<string, unknown>,
  serverOriginUrl: string,
  projectId: string,
  suiteId: string | undefined,
  runId: string,
): RunReport {
  if (statusPayload.report && typeof statusPayload.report === "object") {
    return statusPayload.report as RunReport;
  }
  const now = new Date().toISOString();
  const verdict = statusPayload.verdict === "pass" ? "pass" : "fail";
  const perTool = (statusPayload.per_tool ?? {}) as Record<
    string,
    { calls?: number; error_rate?: number; p50_ms?: number; p95_ms?: number; p99_ms?: number }
  >;
  const toolSeries: ToolSeries[] = Object.entries(perTool).map(([toolName, stats]) => {
    const count = Number(stats.calls ?? 0);
    const errorRate = Number(stats.error_rate ?? 0);
    const errCount = Math.round(count * errorRate);
    return {
      toolName,
      count,
      errorRate,
      errorClass: {
        none: Math.max(0, count - errCount),
        protocol: 0,
        application: errCount,
        timeout: 0,
        transport: 0,
        quota: 0,
        allowlist: 0,
        auth: 0,
        rate_limit: 0,
      },
      latencyMs: {
        mean: Number(stats.p50_ms ?? 0),
        p50: Number(stats.p50_ms ?? 0),
        p90: Number(stats.p95_ms ?? 0),
        p95: Number(stats.p95_ms ?? 0),
        p99: Number(stats.p99_ms ?? stats.p95_ms ?? 0),
      },
      bytesIn: 0,
      bytesOut: 0,
    };
  });
  const totalCalls = toolSeries.reduce((acc, item) => acc + item.count, 0);
  const failReasons = Array.isArray(statusPayload.failure_reasons)
    ? (statusPayload.failure_reasons as unknown[]).map(String)
    : verdict === "fail"
      ? ["central swarm run reported fail verdict"]
      : [];

  return {
    id: runId,
    projectId,
    ...(suiteId ? { suiteId } : {}),
    ...(typeof statusPayload.suite_version === "number" ? { suiteVersion: statusPayload.suite_version } : {}),
    manifestName: `${projectId}${suiteId ? `/${suiteId}` : ""}`,
    manifestHash: "remote-central-swarm",
    startedAt: typeof statusPayload.started_at === "string" ? statusPayload.started_at : now,
    finishedAt: typeof statusPayload.ended_at === "string" ? statusPayload.ended_at : now,
    durationMs: typeof statusPayload.duration_ms === "number" ? statusPayload.duration_ms : 0,
    verdict,
    failReasons,
    silentGreen: false,
    mode: "load",
    transport: "streamable-http",
    server: {
      name: projectId,
      version: String(statusPayload.suite_version ?? "1"),
      transport: "streamable-http",
      endpoint: `${serverOriginUrl}/mcp`,
    },
    sessionMetrics: {
      transport: "streamable-http",
      started: 1,
      active: 0,
      failed: verdict === "fail" ? 1 : 0,
    },
    toolSeries,
    rpcSeries: [],
    scenarioOutcomes: [
      {
        scenario: suiteId ?? projectId,
        outcome: verdict,
      },
    ],
    quotas: {
      concurrencyUsed: 1,
      callCount: totalCalls,
      maxPayloadBytesSeen: 0,
    },
  };
}

/**
 * Triggers a suite run on the central Swarm server (`https://swarm.botz.ai` by default),
 * streams progress updates until completion, and returns the final `RunReport` (plus written paths if `outputDir` is set).
 */
export async function runRemoteSuite(options: RemoteRunOptions): Promise<{
  report: RunReport;
  jsonPath?: string;
  markdownPath?: string;
  serverOrigin: string;
}> {
  const env = options.env ?? process.env;
  const origin = resolveSwarmServerUrl(options.server, env);
  const token = resolveRemoteSwarmToken(options.token, env);
  const fetchFn = options.fetchFn ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;

  // Apply load preset / concurrency / duration overrides if requested prior to starting the run
  if (options.preset || options.concurrency !== undefined || options.durationMs !== undefined) {
    const promptParts: string[] = [];
    if (options.concurrency !== undefined) promptParts.push(`${options.concurrency} VUs`);
    if (options.durationMs !== undefined) promptParts.push(`for ${Math.max(1, Math.round(options.durationMs / 1000))}s`);
    await callSwarmMcpTool(
      origin,
      token,
      "swarm_suite_describe",
      {
        project_id: options.projectId,
        ...(options.suiteId ? { suite_id: options.suiteId } : {}),
        ...(options.preset ? { preset: options.preset } : {}),
        ...(promptParts.length > 0 ? { prompt: promptParts.join(" ") } : {}),
        run_immediately: false,
      },
      fetchFn,
      options.signal,
    ).catch(() => undefined);
  }

  const startPayload = await callSwarmMcpTool(
    origin,
    token,
    "swarm_suite_run",
    {
      project_id: options.projectId,
      ...(options.suiteId ? { suite_id: options.suiteId } : {}),
      ...(options.preset ? { preset: options.preset } : {}),
      ...(options.dispatch ? { dispatch: options.dispatch } : {}),
      ...(options.skipImageGen ? { skip_image_gen: true } : {}),
      ...(options.skipExpensiveLlm ? { skip_expensive_llm: true } : {}),
      wait_for_completion: false,
    },
    fetchFn,
    options.signal,
  );

  const runId = String(startPayload.run_id ?? startPayload.runId ?? "");
  if (!runId) {
    throw new Error(`Central Swarm server did not return a run_id when starting '${options.projectId}'`);
  }
  const suiteId = typeof startPayload.suite_id === "string" ? startPayload.suite_id : options.suiteId;

  const onAbort = () => {
    void callSwarmMcpTool(origin, token, "swarm_run_stop", { run_id: runId }, fetchFn).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  let finalStatus: Record<string, unknown> = startPayload;
  try {
    if (!startPayload.completed) {
      while (!options.signal?.aborted) {
        const statusRes = await callSwarmMcpTool(
          origin,
          token,
          "swarm_run_status",
          {
            project_id: options.projectId,
            run_id: runId,
          },
          fetchFn,
          options.signal,
        );
        const state = String(statusRes.status ?? "completed");
        options.onProgress?.({
          runId,
          projectId: options.projectId,
          suiteId,
          status: state === "running" ? "running" : state === "failed" ? "failed" : "completed",
          verdict: statusRes.verdict === "pass" || statusRes.verdict === "fail" ? statusRes.verdict : undefined,
          bufferedEventsCount:
            typeof statusRes.buffered_events_count === "number" ? statusRes.buffered_events_count : undefined,
          progress:
            statusRes.progress && typeof statusRes.progress === "object"
              ? (statusRes.progress as Record<string, unknown>)
              : undefined,
        });
        if (state !== "running") {
          finalStatus = statusRes;
          break;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, pollIntervalMs);
          options.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }

  const report = synthesizeReportFromStatus(finalStatus, origin, options.projectId, suiteId, runId);
  if (options.outputDir) {
    const written = await writeReports(report, options.outputDir);
    return { report, jsonPath: written.jsonPath, markdownPath: written.markdownPath, serverOrigin: origin };
  }
  return { report, serverOrigin: origin };
}
