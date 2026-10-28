import { isRateLimitMessage } from "../core/rate-limit-retry.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  LATEST_PROTOCOL_VERSION,
  ListRootsRequestSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import {
  classifyError,
  estimateBytes,
  type ElicitAutoReply,
  type McpCallResult,
  type McpSession,
  type ServerMeta,
} from "./base.js";
import { scriptElicitResult } from "./elicit-reply.js";

const CLIENT_INFO = {
  name: "botz-mcp-swarm",
  version: "0.6.0",
  icons: [
    {
      src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
      mimeType: "image/svg+xml",
      sizes: ["any"],
    },
  ],
};

export interface McpSessionOptions {
  getResponseHeaders?: () => Record<string, string>;
  /** Default auto-reply for elicitation/create (SEP-1036 form + URL modes). */
  elicitAutoReply?: ElicitAutoReply;
  /** Collect stderr lines (stdio only — caller attaches stream). */
  stderrLines?: string[];
  /** Optional factory to recreate the transport if a Streamable HTTP session is dropped mid-run. */
  recreateTransport?: () => Transport;
}

export function isSessionLostError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (/session\s+not\s+found|session\s+expired|unknown\s+session|invalid\s+session\s+id|missing\s+session/i.test(msg)) {
    return true;
  }
  if (/\b404\b/.test(msg) && /session/i.test(msg)) {
    return true;
  }
  return false;
}

export async function createMcpSession(
  initialTransport: Transport,
  options?: McpSessionOptions,
): Promise<McpSession> {
  const id = randomUUID();
  const stderrLines = options?.stderrLines ?? [];
  let elicitReply: ElicitAutoReply | undefined = options?.elicitAutoReply ?? {
    action: "accept",
    content: {},
  };

  let currentTransport: Transport = initialTransport;
  let negotiatedProtocolVersion: string | undefined;
  let connected = false;
  let reconnectPromise: Promise<void> | null = null;

  function buildClient(): Client {
    const c = new Client(CLIENT_INFO, {
      capabilities: {
        elicitation: {
          form: { applyDefaults: true },
          url: {},
        },
        tasks: {
          list: {},
          cancel: {},
        },
        sampling: {},
        roots: {
          listChanged: true,
        },
      },
    });
    // Auto-respond to elicitation/create so load scenarios stay non-interactive.
    c.setRequestHandler(ElicitRequestSchema, async (request) => {
      const reply = elicitReply ?? { action: "decline" as const };
      return scriptElicitResult(request.params, reply) as ElicitResult;
    });
    // Stage 6: Deterministic mock handler for sampling/createMessage (zero external LLM cost).
    c.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      const firstMsg = request.params?.messages?.[0];
      const promptPreview =
        firstMsg && typeof firstMsg.content === "object" && firstMsg.content && "text" in firstMsg.content
          ? String((firstMsg.content as { text?: unknown }).text ?? "").slice(0, 120)
          : "sampling request";
      return {
        model: "swarm-deterministic-sampler-v1",
        role: "assistant" as const,
        stopReason: "endTurn",
        content: {
          type: "text" as const,
          text: `[Swarm Deterministic Sampling] Synthesized response for: ${promptPreview}`,
        },
      };
    });
    // Stage 6: Deterministic workspace roots handler for roots/list.
    c.setRequestHandler(ListRootsRequestSchema, async () => {
      return {
        roots: [
          {
            uri: "file:///workspace/swarm-sandbox",
            name: "swarm-sandbox",
          },
        ],
      };
    });
    return c;
  }

  function hookProtocolVersion(t: Transport): void {
    const origSet = t.setProtocolVersion?.bind(t);
    t.setProtocolVersion = (version: string) => {
      negotiatedProtocolVersion = version;
      origSet?.(version);
    };
  }

  let client = buildClient();
  hookProtocolVersion(currentTransport);

  try {
    await client.connect(currentTransport);
    connected = true;
  } catch (error) {
    await currentTransport.close().catch(() => undefined);
    throw error;
  }

  async function reconnectSession(): Promise<void> {
    if (!options?.recreateTransport) {
      throw new Error("recreateTransport not configured");
    }
    if (reconnectPromise) {
      return reconnectPromise;
    }
    reconnectPromise = (async () => {
      const oldClient = client;
      const oldTransport = currentTransport;
      connected = false;
      await oldClient.close().catch(() => undefined);
      await oldTransport.close().catch(() => undefined);

      const nextTransport = options.recreateTransport!();
      hookProtocolVersion(nextTransport);
      const nextClient = buildClient();
      await nextClient.connect(nextTransport);
      currentTransport = nextTransport;
      client = nextClient;
      connected = true;
    })().finally(() => {
      reconnectPromise = null;
    });
    return reconnectPromise;
  }

  async function wrapCall<T>(
    _method: string,
    bytesIn: number,
    fn: () => Promise<T>,
    isError?: (result: T) => boolean,
  ): Promise<McpCallResult> {
    const start = performance.now();
    try {
      let result: T;
      try {
        result = await fn();
      } catch (firstErr) {
        if (options?.recreateTransport && isSessionLostError(firstErr)) {
          await reconnectSession();
          result = await fn();
        } else {
          throw firstErr;
        }
      }
      const latencyMs = performance.now() - start;
      const bytesOut = estimateBytes(result);
      const appError = isError?.(result) ?? false;
      const appMessage = appError
        ? ((result as { content?: Array<{ type?: string; text?: string }> }).content ?? [])
            .filter((item) => item.type === "text" && typeof item.text === "string")
            .map((item) => item.text).join(" ")
            .replace(/data:[^\s,]+;base64,[A-Za-z0-9+/=]+/g, "[inline code]")
            .slice(0, 1000) || "MCP tool returned isError=true"
        : undefined;
      return {
        success: !appError,
        latencyMs,
        errorClass: appError ? (isRateLimitMessage(appMessage) ? "rate_limit" : "application") : "none",
        ...(appError ? { errorMessage: appMessage } : {}),
        bytesIn,
        bytesOut,
        result,
        responseHeaders: options?.getResponseHeaders?.(),
      };
    } catch (error) {
      const latencyMs = performance.now() - start;
      return {
        success: false,
        latencyMs,
        errorClass: classifyError(error),
        errorMessage: error instanceof Error ? error.message : String(error),
        bytesIn,
        bytesOut: 0,
        responseHeaders: options?.getResponseHeaders?.(),
      };
    }
  }

  return {
    id,
    get transport() {
      return currentTransport;
    },
    stderrLines,
    async close() {
      if (connected) {
        // Streamable HTTP: end the server-side session (HTTP DELETE with Mcp-Session-Id) before closing.
        const http = currentTransport as Transport & { terminateSession?: () => Promise<void>; sessionId?: string };
        if (typeof http.terminateSession === "function" && http.sessionId) {
          await http.terminateSession().catch(() => undefined);
        }
        await client.close().catch(() => undefined);
        connected = false;
      }
      await currentTransport.close().catch(() => undefined);
    },
    getServerMeta(): ServerMeta {
      const caps = client.getServerCapabilities() as
        | Record<string, unknown>
        | undefined;
      const version = client.getServerVersion();
      return {
        protocolVersion: negotiatedProtocolVersion ?? LATEST_PROTOCOL_VERSION,
        capabilities: caps,
        serverInfo: version
          ? {
              name: version.name,
              version: version.version,
              icons: (version as { icons?: unknown[] }).icons,
            }
          : undefined,
        instructions: client.getInstructions(),
      };
    },
    serverInfo() {
      const version = client.getServerVersion();
      return {
        name: version?.name,
        version: version?.version,
        capabilities: client.getServerCapabilities() as Record<string, unknown> | undefined,
      };
    },
    setElicitAutoReply(reply) {
      elicitReply = reply;
    },
    async listTools(cursor?: string) {
      const bytesIn = estimateBytes({ method: "tools/list", cursor });
      return wrapCall("tools/list", bytesIn, () => client.listTools(cursor ? { cursor } : undefined));
    },
    async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number) {
      const bytesIn = estimateBytes({ method: "tools/call", name, arguments: args });
      const callStart = performance.now();
      let progressCount = 0;
      let lastProgressMessage: string | undefined;
      let ttfpMs: number | undefined;
      const callRes = await wrapCall(
        "tools/call",
        bytesIn,
        () =>
          client.callTool(
            { name, arguments: args },
            undefined,
            {
              ...(timeoutMs ? { timeout: timeoutMs } : {}),
              resetTimeoutOnProgress: true,
              onprogress: (progress) => {
                progressCount += 1;
                if (ttfpMs === undefined) {
                  ttfpMs = Math.round(performance.now() - callStart);
                }
                if (typeof progress.message === "string" && progress.message.length > 0) {
                  lastProgressMessage = progress.message;
                }
              },
            },
          ),
        (result) => Boolean((result as { isError?: boolean }).isError),
      );
      if (progressCount > 0) {
        callRes.progressEventsCount = progressCount;
        callRes.lastProgressMessage = lastProgressMessage;
        callRes.ttfpMs = ttfpMs;
      }
      return callRes;
    },
    async ping() {
      const bytesIn = estimateBytes({ method: "ping" });
      return wrapCall("ping", bytesIn, () => client.ping());
    },
    async listResources(cursor?: string) {
      const bytesIn = estimateBytes({ method: "resources/list", cursor });
      return wrapCall("resources/list", bytesIn, () => client.listResources(cursor ? { cursor } : undefined));
    },
    async listResourceTemplates(cursor?: string) {
      const bytesIn = estimateBytes({ method: "resources/templates/list", cursor });
      return wrapCall("resources/templates/list", bytesIn, () =>
        client.listResourceTemplates(cursor ? { cursor } : undefined),
      );
    },
    async readResource(uri: string) {
      const bytesIn = estimateBytes({ method: "resources/read", uri });
      return wrapCall("resources/read", bytesIn, () => client.readResource({ uri }));
    },
    async listPrompts(cursor?: string) {
      const bytesIn = estimateBytes({ method: "prompts/list", cursor });
      return wrapCall("prompts/list", bytesIn, () => client.listPrompts(cursor ? { cursor } : undefined));
    },
    async getPrompt(name: string, args?: Record<string, string>) {
      const bytesIn = estimateBytes({ method: "prompts/get", name, arguments: args });
      return wrapCall("prompts/get", bytesIn, () => client.getPrompt({ name, arguments: args }));
    },
    async setLoggingLevel(level: string) {
      const bytesIn = estimateBytes({ method: "logging/setLevel", level });
      return wrapCall("logging/setLevel", bytesIn, () =>
        client.setLoggingLevel(level as "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency"),
      );
    },
    async complete(params: { ref: "prompt" | "resource"; name: string; argument: string; value: string }) {
      const bytesIn = estimateBytes({ method: "completion/complete", ...params });
      const ref = params.ref === "prompt"
        ? { type: "ref/prompt" as const, name: params.name }
        : { type: "ref/resource" as const, uri: params.name };
      return wrapCall("completion/complete", bytesIn, () =>
        client.complete({ ref, argument: { name: params.argument, value: params.value } }),
      );
    },
    async listTasks(cursor?: string) {
      const bytesIn = estimateBytes({ method: "tasks/list", cursor });
      return wrapCall("tasks/list", bytesIn, () =>
        client.experimental.tasks.listTasks(cursor),
      );
    },
    async getTask(taskId: string) {
      const bytesIn = estimateBytes({ method: "tasks/get", taskId });
      return wrapCall("tasks/get", bytesIn, () =>
        client.experimental.tasks.getTask(taskId),
      );
    },
    async cancelTask(taskId: string) {
      const bytesIn = estimateBytes({ method: "tasks/cancel", taskId });
      return wrapCall("tasks/cancel", bytesIn, () =>
        client.experimental.tasks.cancelTask(taskId),
      );
    },
  };
}
