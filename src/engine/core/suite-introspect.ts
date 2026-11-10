import { createHash } from "node:crypto";
import { createSession } from "../adapters/index.js";
import type { McpCallResult } from "../adapters/base.js";
import type { Target } from "../types/manifest.js";
import {
  toolIsCalledByDefault,
  type PromptCatalogEntry,
  type ResourceCatalogEntry,
  type ResourceTemplateEntry,
  type ServerSurface,
  type ToolCatalogEntry,
} from "./suite-model.js";
import type { JsonSchema } from "./tool-args.js";

const PAGE_CAP = 20;

export function schemaHash(schema: unknown): string {
  return createHash("sha256").update(JSON.stringify(schema ?? null)).digest("hex").slice(0, 16);
}

export async function introspectCatalog(
  target: Target,
  baseDir?: string,
): Promise<ToolCatalogEntry[]> {
  const surface = await introspectServer(target, baseDir);
  return surface.tools;
}

/** Connects to the server and reads every advertised primitive. */
export async function introspectServer(
  target: Target,
  baseDir?: string,
): Promise<ServerSurface> {
  const connectStarted = performance.now();
  const session = await createSession(target, undefined, baseDir);
  const connectMs = performance.now() - connectStarted;
  try {
    const info = session.serverInfo();
    const capabilities = Object.keys(info.capabilities ?? {});
    let rpcMs = 0;
    const timed = (fetchPage: (cursor?: string) => Promise<McpCallResult>) => async (cursor?: string) => {
      const started = performance.now();
      try {
        return await fetchPage(cursor);
      } finally {
        rpcMs = Math.max(rpcMs, performance.now() - started);
      }
    };
    const listedTools = capabilities.includes("tools")
      ? await listAll("tools", timed((cursor) => session.listTools(cursor)))
      : { items: [] };
    // Only methods the initialize capabilities advertise are called. Resources, templates and prompts are
    // optional: a server that advertises a capability but answers -32601 for one of its list methods is
    // recorded as "not supported" for that list instead of failing the whole introspection (which would
    // otherwise discard a perfectly good tools/list and leave the server at 0 tools).
    const unsupported: string[] = [];
    const optional = async (key: string, fetchPage: (cursor?: string) => Promise<McpCallResult>) => {
      try {
        return await listAll(key, fetchPage);
      } catch (error) {
        if (!isMethodNotFound(error)) throw error;
        unsupported.push(key);
        return { items: [] };
      }
    };
    const resources = capabilities.includes("resources")
      ? await optional("resources", timed((cursor) => session.listResources(cursor)))
      : { items: [] };
    const templates = capabilities.includes("resources")
      ? await optional("resourceTemplates", timed((cursor) => session.listResourceTemplates(cursor)))
      : { items: [] };
    const prompts = capabilities.includes("prompts")
      ? await optional("prompts", timed((cursor) => session.listPrompts(cursor)))
      : { items: [] };
    const protocolVersion = session.getServerMeta?.().protocolVersion;
    return {
      ...(protocolVersion ? { protocolVersion } : {}),
      serverName: info.name,
      serverVersion: info.version,
      latency: { connectMs: Math.ceil(connectMs), rpcMs: Math.ceil(rpcMs) },
      capabilities,
      ...(unsupported.length ? { unsupportedMethods: unsupported } : {}),
      tools: listedTools.items.map(toTool).filter((tool): tool is ToolCatalogEntry => tool !== null),
      resources: (resources?.items ?? []).map(toResource).filter((item): item is ResourceCatalogEntry => item !== null),
      resourceTemplates: (templates?.items ?? []).map(toTemplate).filter((item): item is ResourceTemplateEntry => item !== null),
      prompts: (prompts?.items ?? []).map(toPrompt).filter((item): item is PromptCatalogEntry => item !== null),
    };
  } finally {
    await session.close();
  }
}

/** JSON-RPC -32601 (Method not found), as surfaced by the adapters in an error message. */
export function isMethodNotFound(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /-32601|method not found/i.test(text);
}

async function listAll(
  key: string,
  fetchPage: (cursor?: string) => Promise<McpCallResult>,
): Promise<{ items: unknown[] }> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < PAGE_CAP; page++) {
    const result = await fetchPage(cursor);
    if (!result.success) {
      throw new Error(`${key}_list_failed: ${result.errorMessage ?? "incomplete discovery"}`);
    }
    const body = isRecord(result.result) ? result.result : {};
    const chunk = body[key];
    if (!Array.isArray(chunk)) throw new Error(`${key}_list_invalid`);
    items.push(...chunk);
    const next = typeof body.nextCursor === "string" && body.nextCursor.length > 0 ? body.nextCursor : undefined;
    if (!next) return { items };
    if (seen.has(next)) throw new Error(`${key}_pagination_cycle`);
    seen.add(next);
    cursor = next;
  }
  throw new Error(`${key}_pagination_limit: discovery exceeded ${PAGE_CAP} pages`);
}

function toTool(value: unknown): ToolCatalogEntry | null {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) return null;
  const inputSchema = isRecord(value.inputSchema) ? (value.inputSchema as JsonSchema) : undefined;
  const outputSchema = isRecord(value.outputSchema) ? (value.outputSchema as JsonSchema) : undefined;
  const annotations = isRecord(value.annotations)
    ? {
        ...(typeof value.annotations.title === "string" ? { title: value.annotations.title } : {}),
        readOnlyHint: value.annotations.readOnlyHint === true ? true : undefined,
        destructiveHint: value.annotations.destructiveHint === true ? true : undefined,
        ...(typeof value.annotations.idempotentHint === "boolean" ? { idempotentHint: value.annotations.idempotentHint } : {}),
        ...(typeof value.annotations.openWorldHint === "boolean" ? { openWorldHint: value.annotations.openWorldHint } : {}),
      }
    : undefined;
  return {
    name: value.name,
    description: typeof value.description === "string" ? value.description : undefined,
    schemaHash: schemaHash({ input: inputSchema ?? null, output: outputSchema ?? null }),
    writeLike: !toolIsCalledByDefault({ name: value.name, annotations }),
    inputSchema,
    outputSchema,
    annotations,
    ...(hintMeta(value._meta) ? { meta: hintMeta(value._meta) } : {}),
  };
}

const HINT_KEYS = /^(cost|costUsd|cost_usd|costTier|latencyMs|latency_ms|expectedLatencyMs|longRunning|long_running)$/;

/** Keep only small, server-declared cost/latency hints from tools/list `_meta` (flat or one namespace deep). */
function hintMeta(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, unknown> = {};
  const take = (obj: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(obj)) {
      if (HINT_KEYS.test(k) && (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 32))) out[k] = v;
    }
  };
  take(raw);
  for (const v of Object.values(raw)) if (isRecord(v)) take(v);
  return Object.keys(out).length ? out : undefined;
}

function toResource(value: unknown): ResourceCatalogEntry | null {
  if (!isRecord(value) || typeof value.uri !== "string" || typeof value.name !== "string") return null;
  return {
    uri: value.uri,
    name: value.name,
    mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
  };
}

function toTemplate(value: unknown): ResourceTemplateEntry | null {
  if (!isRecord(value) || typeof value.uriTemplate !== "string" || typeof value.name !== "string") return null;
  return { uriTemplate: value.uriTemplate, name: value.name };
}

function toPrompt(value: unknown): PromptCatalogEntry | null {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) return null;
  const rawArgs = Array.isArray(value.arguments) ? value.arguments : [];
  const args = rawArgs.flatMap((argument) => {
    if (!isRecord(argument) || typeof argument.name !== "string") return [];
    return [{ name: argument.name, required: argument.required === true }];
  });
  return {
    name: value.name,
    description: typeof value.description === "string" ? value.description : undefined,
    arguments: args,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
