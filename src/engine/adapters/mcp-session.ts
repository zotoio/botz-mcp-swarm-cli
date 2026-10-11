import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ElicitRequestSchema,
  LATEST_PROTOCOL_VERSION,
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
  version: "0.5.3",
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
}

export async function createMcpSession(
  transport: Transport,
  options?: McpSessionOptions,
): Promise<McpSession> {
  const id = randomUUID();
  const stderrLines = options?.stderrLines ?? [];
  let elicitReply: ElicitAutoReply | undefined = options?.elicitAutoReply ?? {
    action: "accept",
    content: {},
  };

  const client = new Client(CLIENT_INFO, {
    capabilities: {
      elicitation: {
        form: { applyDefaults: true },
        url: {},
      },
      tasks: {
        list: {},
        cancel: {},
      },
    },
  });

  // Auto-respond to elicitation/create so load scenarios stay non-interactive.
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    const reply = elicitReply ?? { action: "decline" as const };
    return scriptElicitResult(request.params, reply) as ElicitResult;
  });

  let connected = false;

  try {
    await client.connect(transport);
    connected = true;
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }

  async function wrapCall<T>(
    _method: string,
    bytesIn: number,
    fn: () => Promise<T>,
    isError?: (result: T) => boolean,
  ): Promise<McpCallResult> {
    const start = performance.now();
    try {
      const result = await fn();
      const latencyMs = performance.now() - start;
      const bytesOut = estimateBytes(result);
      const appError = isError?.(result) ?? false;
      return {
        success: !appError,
        latencyMs,
        errorClass: appError ? "application" : "none",
        ...(appError ? { errorMessage: ((result as { content?: Array<{ type?: string; text?: string }> }).content ?? [])
          .filter((item) => item.type === "text" && typeof item.text === "string")
          .map((item) => item.text).join(" ")
          .replace(/data:[^\s,]+;base64,[A-Za-z0-9+/=]+/g, "[inline code]")
          .slice(0, 1000) || "MCP tool returned isError=true" } : {}),
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
    transport,
    stderrLines,
    async close() {
      if (connected) {
        await client.close().catch(() => undefined);
        connected = false;
      }
      await transport.close().catch(() => undefined);
    },
    getServerMeta(): ServerMeta {
      const caps = client.getServerCapabilities() as
        | Record<string, unknown>
        | undefined;
      const version = client.getServerVersion();
      return {
        // SDK Client negotiates LATEST (2025-11-25 on sdk@1.30); expose via serverInfo when present.
        protocolVersion: LATEST_PROTOCOL_VERSION,
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
      return wrapCall(
        "tools/call",
        bytesIn,
        () =>
          client.callTool(
            { name, arguments: args },
            undefined,
            timeoutMs ? { timeout: timeoutMs } : undefined,
          ),
        (result) => Boolean((result as { isError?: boolean }).isError),
      );
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
