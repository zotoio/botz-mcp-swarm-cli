import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ErrorClass } from "../types/run.js";
import type { Target } from "../types/manifest.js";

export interface McpCallResult {
  success: boolean;
  latencyMs: number;
  errorClass: ErrorClass;
  errorMessage?: string;
  bytesIn: number;
  bytesOut: number;
  result?: unknown;
  /** Lowercased response headers from the last HTTP transport round-trip, when available. */
  responseHeaders?: Record<string, string>;
}

export interface ServerMeta {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string; icons?: unknown[] };
  instructions?: string;
}

export interface ElicitAutoReply {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export interface McpSession {
  id: string;
  transport: Transport;
  /** Stdio SUT child PID when available. */
  childPid?: number | null;
  /** Captured stderr lines from stdio transport (log surface). */
  stderrLines?: string[];
  close(): Promise<void>;
  getServerMeta(): ServerMeta;
  serverInfo(): { name?: string; version?: string; capabilities?: Record<string, unknown> };
  setElicitAutoReply(reply: ElicitAutoReply | undefined): void;
  listTools(cursor?: string): Promise<McpCallResult>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpCallResult>;
  ping(): Promise<McpCallResult>;
  listResources(cursor?: string): Promise<McpCallResult>;
  listResourceTemplates(cursor?: string): Promise<McpCallResult>;
  readResource(uri: string): Promise<McpCallResult>;
  listPrompts(cursor?: string): Promise<McpCallResult>;
  getPrompt(name: string, args?: Record<string, string>): Promise<McpCallResult>;
  setLoggingLevel(level: string): Promise<McpCallResult>;
  complete(params: {
    ref: "prompt" | "resource";
    name: string;
    argument: string;
    value: string;
  }): Promise<McpCallResult>;
  /** @experimental */
  listTasks(cursor?: string): Promise<McpCallResult>;
  /** @experimental */
  getTask(taskId: string): Promise<McpCallResult>;
  /** @experimental */
  cancelTask(taskId: string): Promise<McpCallResult>;
}

export interface AdapterFactory {
  createSession(target: Target, headers?: Record<string, string>): Promise<McpSession>;
}

export function estimateBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? {}), "utf8");
  } catch {
    return 0;
  }
}

export function classifyError(error: unknown): ErrorClass {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("timeout")) return "timeout";
    if (msg.includes("auth") || msg.includes("unauthorized") || msg.includes("401")) {
      return "auth";
    }
    if (msg.includes("transport") || msg.includes("connect")) return "transport";
    if (msg.includes("quota")) return "quota";
    if (msg.includes("allowlist")) return "allowlist";
    if (
      msg.includes("protocol") ||
      msg.includes("json-rpc") ||
      msg.includes("method not found") ||
      msg.includes("capability") ||
      msg.includes("-32601") ||
      msg.includes("-32602") ||
      msg.includes("-32600")
    ) {
      return "protocol";
    }
  }
  return "application";
}

/** Map scenario method → required server capability key. */
export function capabilityForMethod(method: string): string | undefined {
  switch (method) {
    case "resources/list":
    case "resources/read":
    case "resources/templates/list":
      return "resources";
    case "prompts/list":
    case "prompts/get":
      return "prompts";
    case "completion/complete":
      return "completions";
    case "logging/setLevel":
      return "logging";
    case "tasks/list":
    case "tasks/get":
    case "tasks/cancel":
      return "tasks";
    case "tools/list":
    case "tools/call":
      return "tools";
    default:
      return undefined;
  }
}
