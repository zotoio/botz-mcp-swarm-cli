import type { McpCallResult } from "../adapters/base.js";

function toolTextPayload(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((item): item is { type?: string; text?: string } => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text!);
  if (parts.length === 0) return undefined;
  return parts.join("\n").trim();
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const value = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function messageFromObject(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.error === "string" && obj.error.trim()) return obj.error.trim().slice(0, 500);
  if (obj.error && typeof obj.error === "object" && !Array.isArray(obj.error)) {
    const nested = obj.error as { message?: unknown };
    if (typeof nested.message === "string" && nested.message.trim()) return nested.message.trim().slice(0, 500);
  }
  if (typeof obj.message === "string" && obj.message.trim()) return obj.message.trim().slice(0, 500);
  return undefined;
}

/** MCP reported success but the payload looks like an application error (JSON tool body). */
export function payloadErrorMessage(result: McpCallResult): string | null {
  if (!result.success || result.errorClass !== "none") return null;
  const text = toolTextPayload(result.result);
  if (!text) return null;
  const obj = parseJsonObject(text);
  if (!obj) return null;
  const status = typeof obj.status === "string" ? obj.status.trim().toLowerCase() : "";
  const hasTopLevelError = "error" in obj && obj.error !== undefined && obj.error !== null;
  if (status !== "error" && !hasTopLevelError) return null;
  const detail = messageFromObject(obj);
  if (detail) return `tool result reports application error: ${detail}`;
  return "tool result reports application error in JSON payload";
}
