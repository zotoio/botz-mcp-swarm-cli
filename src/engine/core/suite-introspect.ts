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
    const resources = capabilities.includes("resources")
      ? await listAll("resources", timed((cursor) => session.listResources(cursor)))
      : { items: [] };
    const templates = capabilities.includes("resources")
      ? await listAll("resourceTemplates", timed((cursor) => session.listResourceTemplates(cursor)))
      : { items: [] };
    const prompts = capabilities.includes("prompts")
      ? await listAll("prompts", timed((cursor) => session.listPrompts(cursor)))
      : { items: [] };
    const protocolVersion = session.getServerMeta?.().protocolVersion;
    return {
      ...(protocolVersion ? { protocolVersion } : {}),
      serverName: info.name,
      serverVersion: info.version,
      latency: { connectMs: Math.ceil(connectMs), rpcMs: Math.ceil(rpcMs) },
      capabilities,
      tools: listedTools.items.map(toTool).filter((tool): tool is ToolCatalogEntry => tool !== null),
      resources: (resources?.items ?? []).map(toResource).filter((item): item is ResourceCatalogEntry => item !== null),
      resourceTemplates: (templates?.items ?? []).map(toTemplate).filter((item): item is ResourceTemplateEntry => item !== null),
      prompts: (prompts?.items ?? []).map(toPrompt).filter((item): item is PromptCatalogEntry => item !== null),
    };
  } finally {
    await session.close();
  }
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
  };
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
