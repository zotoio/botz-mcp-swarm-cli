/**
 * Modern-era (MCP 2026-07-28) sessionless client over Streamable HTTP.
 *
 * The bundled @modelcontextprotocol/sdk 1.x client only speaks the legacy
 * initialize/session era, so this is a small, server-agnostic JSON-RPC client
 * behind the same `McpSession` interface: every request carries
 * `_meta.io.modelcontextprotocol/{protocolVersion,clientInfo,clientCapabilities}`
 * plus the mirrored `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers.
 * No Mcp-Session-Id, no initialize, no GET stream.
 *
 * Gaps (docs/protocol-eras.md): no `subscriptions/listen`, no MRTR
 * (`input_required` results are returned as-is), no `Mcp-Param-*` headers.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { randomUUID } from "node:crypto";
import {
  classifyError,
  estimateBytes,
  type ElicitAutoReply,
  type McpCallResult,
  type McpSession,
  type ServerMeta,
} from "./base.js";
function parseW3CTraceparent(raw: string | undefined): { traceId: string; spanId: string } | null {
  const m = raw?.trim().match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i);
  return m ? { traceId: m[1]!.toLowerCase(), spanId: m[2]!.toLowerCase() } : null;
}

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const CLIENT_INFO = { name: "botz-mcp-swarm", version: "0.6.0" };

export class McpRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly status: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpRpcError";
  }
}

export interface DiscoverResult {
  supportedVersions?: string[];
  capabilities?: Record<string, unknown>;
  instructions?: string;
  _meta?: Record<string, unknown>;
  [k: string]: unknown;
}

export function modernMeta(protocolVersion = MODERN_PROTOCOL_VERSION): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": protocolVersion,
    "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function headerSafe(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?base64?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

async function readRpcBody(res: Response, id: string | number): Promise<{ result?: unknown; error?: { code?: number; message?: string; data?: unknown } } | undefined> {
  const ctype = res.headers.get("content-type") ?? "";
  const text = await res.text();
  const msgs: Array<Record<string, unknown>> = [];
  if (ctype.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data.trim()) continue;
      try { msgs.push(JSON.parse(data)); } catch { /* ignore */ }
    }
  } else if (text.trim()) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) msgs.push(...parsed); else msgs.push(parsed);
    } catch { return undefined; }
  }
  return msgs.find((m) => m && m.id === id && ("result" in m || "error" in m)) as never
    ?? (msgs.find((m) => m && "error" in m) as never);
}

export interface ModernRpcClient {
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  lastResponseHeaders(): Record<string, string>;
  lastSentHeaders(): Record<string, string>;
}

export function createModernRpc(
  url: URL,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  capture?: { lastHeaders: Record<string, string>; lastSentHeaders: Record<string, string> },
  protocolVersion = MODERN_PROTOCOL_VERSION,
): ModernRpcClient {
  let seq = 0;
  return {
    async request(method, params = {}, timeoutMs) {
      const id = `swarm-${++seq}`;
      const body = {
        jsonrpc: "2.0",
        id,
        method,
        params: { ...params, _meta: { ...((params._meta as object) ?? {}), ...modernMeta(protocolVersion) } },
      };
      const h: Record<string, string> = {
        ...headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": protocolVersion,
        "mcp-method": method,
      };
      const name = (params.name ?? params.uri) as string | undefined;
      if (typeof name === "string" && ["tools/call", "resources/read", "prompts/get"].includes(method)) {
        h["mcp-name"] = headerSafe(name);
      }
      const ctl = new AbortController();
      const timer = timeoutMs ? setTimeout(() => ctl.abort(), timeoutMs) : undefined;
      try {
        const res = await fetchFn(url, { method: "POST", headers: h, body: JSON.stringify(body), signal: ctl.signal });
        const msg = await readRpcBody(res, id);
        if (msg?.error) {
          throw new McpRpcError(
            `MCP error ${msg.error.code ?? ""}: ${msg.error.message ?? "error"} (HTTP ${res.status})`,
            msg.error.code,
            res.status,
            msg.error.data,
          );
        }
        if (!res.ok || !msg) {
          throw new McpRpcError(`HTTP ${res.status} without a JSON-RPC result`, undefined, res.status);
        }
        return msg.result;
      } catch (e) {
        if ((e as Error).name === "AbortError") throw new Error(`Request timeout after ${timeoutMs}ms`);
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    lastResponseHeaders: () => capture?.lastHeaders ?? {},
    lastSentHeaders: () => capture?.lastSentHeaders ?? {},
  };
}

export type EraProbe =
  | { era: "modern"; discover: DiscoverResult; protocolVersion: string }
  | { era: "legacy"; reason: string };

/**
 * Spec-conformant era detection on HTTP: attempt a modern `server/discover`.
 * A DiscoverResult or a recognised modern error (-32022) means modern; anything
 * else (4xx/5xx without a modern error body, legacy -32600 "missing session", ...) means legacy.
 */
export async function probeProtocolEra(rpc: ModernRpcClient, timeoutMs = 15_000): Promise<EraProbe> {
  try {
    const result = (await rpc.request("server/discover", {}, timeoutMs)) as DiscoverResult;
    if (result && typeof result === "object" && (Array.isArray(result.supportedVersions) || result.capabilities)) {
      return { era: "modern", discover: result, protocolVersion: MODERN_PROTOCOL_VERSION };
    }
    return { era: "legacy", reason: "server/discover returned a non-DiscoverResult body" };
  } catch (e) {
    if (e instanceof McpRpcError && e.code === UNSUPPORTED_PROTOCOL_VERSION) {
      const supported = ((e.data as { supported?: string[] })?.supported ?? []).filter((v) => v >= MODERN_PROTOCOL_VERSION);
      if (supported.length > 0) {
        return { era: "modern", discover: { supportedVersions: supported }, protocolVersion: supported[0]! };
      }
      return { era: "legacy", reason: "server supports no modern protocol version" };
    }
    return { era: "legacy", reason: `server/discover probe failed: ${(e as Error).message}`.slice(0, 300) };
  }
}

export function createModernSession(
  rpc: ModernRpcClient,
  discover: DiscoverResult,
  protocolVersion: string,
  extras?: { requestedEra?: "auto" | "modern" | "legacy" },
): McpSession {
  const id = randomUUID();
  const serverInfo = (discover._meta?.["io.modelcontextprotocol/serverInfo"] ?? {}) as { name?: string; version?: string };
  const transport = {
    async start() {},
    async send() {},
    async close() {},
  } as unknown as Transport;

  async function wrap(method: string, params: Record<string, unknown>, timeoutMs?: number, isTool = false): Promise<McpCallResult> {
    const bytesIn = estimateBytes({ method, ...params });
    const start = performance.now();
    try {
      const result = await rpc.request(method, params, timeoutMs);
      const latencyMs = performance.now() - start;
      const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
      const appError = isTool && Boolean(r?.isError);
      const respH = rpc.lastResponseHeaders();
      const tp = respH.traceparent || rpc.lastSentHeaders().traceparent;
      const parsed = parseW3CTraceparent(tp);
      return {
        success: !appError,
        latencyMs,
        errorClass: appError ? "application" : "none",
        ...(appError
          ? { errorMessage: (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ").slice(0, 1000) || "MCP tool returned isError=true" }
          : {}),
        bytesIn,
        bytesOut: estimateBytes(result),
        result,
        responseHeaders: respH,
        ...(tp ? { traceparent: tp } : {}),
        ...(parsed ? { traceId: parsed.traceId, spanId: parsed.spanId } : {}),
      };
    } catch (error) {
      return {
        success: false,
        latencyMs: performance.now() - start,
        errorClass: classifyError(error),
        errorMessage: error instanceof Error ? error.message : String(error),
        bytesIn,
        bytesOut: 0,
        responseHeaders: rpc.lastResponseHeaders(),
      };
    }
  }

  const removed = (method: string): Promise<McpCallResult> =>
    Promise.resolve({
      success: false,
      latencyMs: 0,
      errorClass: "protocol",
      errorMessage: `${method} was removed in MCP ${MODERN_PROTOCOL_VERSION} (method not found on the modern era)`,
      bytesIn: 0,
      bytesOut: 0,
    });

  return {
    id,
    transport,
    protocolEra: "modern",
    ...(extras?.requestedEra ? { requestedEra: extras.requestedEra } : {}),
    async close() {},
    getServerMeta(): ServerMeta {
      return {
        protocolVersion,
        protocolEra: "modern",
        capabilities: discover.capabilities,
        serverInfo: serverInfo.name || serverInfo.version ? serverInfo : undefined,
        instructions: discover.instructions,
        ...(extras?.requestedEra ? { requestedEra: extras.requestedEra } : {}),
      };
    },
    serverInfo() {
      return { name: serverInfo.name, version: serverInfo.version, capabilities: discover.capabilities };
    },
    setElicitAutoReply(_reply: ElicitAutoReply | undefined) {
      // Modern servers cannot call the client (MRTR replaces elicitation/create); nothing to set.
    },
    listTools: (cursor) => wrap("tools/list", cursor ? { cursor } : {}),
    callTool: (name, args, timeoutMs) => wrap("tools/call", { name, arguments: args }, timeoutMs, true),
    ping: () => removed("ping"),
    listResources: (cursor) => wrap("resources/list", cursor ? { cursor } : {}),
    listResourceTemplates: (cursor) => wrap("resources/templates/list", cursor ? { cursor } : {}),
    readResource: (uri) => wrap("resources/read", { uri }),
    listPrompts: (cursor) => wrap("prompts/list", cursor ? { cursor } : {}),
    getPrompt: (name, args) => wrap("prompts/get", { name, ...(args ? { arguments: args } : {}) }),
    setLoggingLevel: () => removed("logging/setLevel"),
    complete: (p) =>
      wrap("completion/complete", {
        ref: p.ref === "prompt" ? { type: "ref/prompt", name: p.name } : { type: "ref/resource", uri: p.name },
        argument: { name: p.argument, value: p.value },
      }),
    listTasks: (cursor) => wrap("tasks/list", cursor ? { cursor } : {}),
    getTask: (taskId) => wrap("tasks/get", { taskId }),
    cancelTask: (taskId) => wrap("tasks/cancel", { taskId }),
  };
}
