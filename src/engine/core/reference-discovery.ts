import { createSession } from "../adapters/index.js";
import type { Target } from "../types/manifest.js";
import { isPlaceholderValue, referenceParams, sampleArgsForTool, type JsonSchema, type ReferenceValues } from "./tool-args.js";

/** Minimal tool shape (snapshot / tools/list entry). */
export interface DiscoveryTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  writeLike?: boolean;
}

/** The one call the resolver needs; `createSession(...).callTool` satisfies it. */
export type CallToolFn = (name: string, args: Record<string, unknown>) => Promise<{ success: boolean; result?: unknown; errorMessage?: string }>;

const QUERY_KEYS = ["query", "q", "request", "search", "text", "need", "prompt"];

function props(tool: DiscoveryTool): Record<string, JsonSchema> {
  return ((tool.inputSchema as JsonSchema | undefined)?.properties ?? {}) as Record<string, JsonSchema>;
}

/** Read-only tools that list/search/suggest entities of `domain`, best first (intent from names and schemas only). */
export function discoveryToolsFor(domain: string, tools: DiscoveryTool[]): DiscoveryTool[] {
  const d = domain.toLowerCase();
  const scored: Array<{ tool: DiscoveryTool; score: number }> = [];
  for (const tool of tools) {
    if (tool.annotations?.destructiveHint || tool.writeLike) continue;
    const n = tool.name.toLowerCase();
    let score = 0;
    if (new RegExp(`^(?:${d}s?_(?:list|search|find)|(?:list|search|find)_${d}s?)$`).test(n)) score = 3;
    else if (/(?:^|_)(?:list|search|suggest|find)(?:$|_)/.test(n)) {
      const kind = props(tool).kind ?? props(tool).type;
      const kindText = kind ? `${JSON.stringify(kind.enum ?? [])} ${kind.description ?? ""}` : "";
      if (new RegExp(`\\b${d}\\b`, "i").test(kindText)) score = 2;
    }
    if (score) scored.push({ tool, score: score + (tool.annotations?.readOnlyHint ? 0.5 : 0) });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.tool);
}

function discoveryArgs(tool: DiscoveryTool, domain: string, request: string): Record<string, unknown> {
  const args = sampleArgsForTool({ name: tool.name, inputSchema: tool.inputSchema as JsonSchema });
  const p = props(tool);
  for (const key of QUERY_KEYS) if (key in p) args[key] = request;
  for (const key of ["kind", "type"]) {
    const enumVals = p[key]?.enum;
    if (key in p && (!enumVals || enumVals.includes(domain))) args[key] = domain;
  }
  for (const key of ["limit", "top_k", "k", "max_results"]) if (key in p) args[key] = 5;
  return args;
}

/** Parsed JSON payload of a tools/call result (structuredContent, else text content that is JSON). */
function payload(result: unknown): unknown {
  const r = result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> } | undefined;
  if (r?.structuredContent !== undefined) return r.structuredContent;
  for (const c of r?.content ?? []) {
    if (c?.type === "text" && typeof c.text === "string") {
      try { return JSON.parse(c.text); } catch { /* not JSON */ }
    }
  }
  return result;
}

/** Identifier-like strings found in a discovery payload, in document order. */
export function identifierCandidates(value: unknown, domain: string): string[] {
  const keys = [`${domain}_name`, `${domain}_id`, `${domain}_slug`, "slug", "name", "id"];
  const out: string[] = [];
  const visit = (v: unknown, depth: number) => {
    if (depth > 6 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const item of v) visit(item, depth + 1); return; }
    const obj = v as Record<string, unknown>;
    const kind = typeof obj.kind === "string" ? obj.kind.toLowerCase() : undefined;
    if (!kind || kind === domain) {
      for (const k of keys) {
        const s = obj[k];
        if (typeof s === "string" && /^[\w.@:/-]{1,200}$/.test(s) && !isPlaceholderValue(s) && !out.includes(s)) { out.push(s); break; }
      }
    }
    for (const child of Object.values(obj)) visit(child, depth + 1);
  };
  visit(value, 0);
  return out;
}

/** Suggestions a server puts in an error ("did you mean 'x'"), a last-resort discovery channel. */
export function errorSuggestions(message: string | undefined): string[] {
  if (!message) return [];
  const m = /did you mean\s+(.+?)\?/i.exec(message);
  if (!m?.[1]) return [];
  return [...m[1].matchAll(/['"`]([\w.@:/-]+)['"`]/g)].map((x) => x[1]!).filter((s) => !isPlaceholderValue(s));
}

/**
 * Resolve one real identifier per reference domain the server's tools take (e.g. `agent`), so generated steps
 * never pass a placeholder or an entity of the wrong kind. Order: discovery tools (list/search/suggest with a
 * kind filter), then the server's own error hint for a placeholder call. Each candidate is verified with a
 * read-only consumer tool when one exists.
 */
export async function resolveReferenceValues(tools: DiscoveryTool[], call: CallToolFn, opts: { domains?: string[] } = {}): Promise<ReferenceValues> {
  const consumers = new Map<string, Array<{ tool: DiscoveryTool; param: string }>>();
  for (const tool of tools) {
    for (const ref of referenceParams({ name: tool.name, inputSchema: tool.inputSchema as JsonSchema })) {
      if (opts.domains && !opts.domains.includes(ref.domain)) continue;
      consumers.set(ref.domain, [...(consumers.get(ref.domain) ?? []), { tool, param: ref.param }]);
    }
  }
  const out: ReferenceValues = {};
  for (const [domain, users] of consumers) {
    const verifier = users.find((u) => u.tool.annotations?.readOnlyHint && !u.tool.annotations?.destructiveHint && !u.tool.writeLike);
    const verify = async (candidate: string): Promise<boolean> => {
      if (!verifier) return true;
      const args = { ...sampleArgsForTool({ name: verifier.tool.name, inputSchema: verifier.tool.inputSchema as JsonSchema }), [verifier.param]: candidate };
      try { return (await call(verifier.tool.name, args)).success; } catch { return false; }
    };
    const request = (users[0]?.tool.description ?? domain).replace(/\s+/g, " ").slice(0, 200);
    const tried = new Set<string>();
    const attempt = async (candidates: string[]): Promise<boolean> => {
      for (const c of candidates.slice(0, 5)) {
        if (tried.has(c)) continue;
        tried.add(c);
        if (await verify(c)) { out[domain] = c; return true; }
      }
      return false;
    };
    let found = false;
    for (const tool of discoveryToolsFor(domain, tools)) {
      try {
        const res = await call(tool.name, discoveryArgs(tool, domain, request));
        if (res.success && (await attempt(identifierCandidates(payload(res.result), domain)))) { found = true; break; }
      } catch { /* try the next discovery tool */ }
    }
    if (!found && verifier) {
      try {
        const probe = { ...sampleArgsForTool({ name: verifier.tool.name, inputSchema: verifier.tool.inputSchema as JsonSchema }), [verifier.param]: "fixture" };
        const res = await call(verifier.tool.name, probe);
        if (!res.success) await attempt(errorSuggestions(res.errorMessage));
      } catch { /* no hint */ }
    }
  }
  return out;
}

/** Live variant: open a session to `target` and resolve against its tools. */
export async function discoverReferenceValues(target: Target, tools: DiscoveryTool[], baseDir?: string): Promise<ReferenceValues> {
  if (!tools.some((t) => referenceParams({ name: t.name, inputSchema: t.inputSchema as JsonSchema }).length)) return {};
  const session = await createSession(target, undefined, baseDir);
  try {
    return await resolveReferenceValues(tools, (name, args) => session.callTool(name, args, 20_000));
  } finally {
    await session.close();
  }
}
