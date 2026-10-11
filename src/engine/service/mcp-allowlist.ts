import { z } from "zod";
import { HttpTargetSchema, StdioTargetSchema } from "../types/manifest.js";
import { validateAllowlistHost } from "./allowlist-host.js";

/** MCP server config per manifest target schema (stdio | sse | streamable-http). */
export const McpServerConfigSchema = z.union([StdioTargetSchema, HttpTargetSchema]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** Policy allowlist entry: legacy host string or full MCP server config. */
export type AllowlistEntry = string | McpServerConfig;

export function isMcpServerConfig(entry: AllowlistEntry): entry is McpServerConfig {
  return typeof entry === "object" && entry !== null && "transport" in entry;
}

export function validateMcpServerConfig(
  raw: unknown,
): { ok: true; config: McpServerConfig } | { ok: false; reason: string } {
  const parsed = McpServerConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: issue?.path.join(".") || "invalid_config" };
  }
  return { ok: true, config: parsed.data };
}

export function parseAllowlistEntryJson(
  json: string,
): { ok: true; entry: AllowlistEntry } | { ok: false; reason: string } {
  const trimmed = json.trim();
  if (!trimmed) return { ok: false, reason: "empty_config" };
  try {
    const raw = JSON.parse(trimmed) as unknown;
    if (typeof raw === "string") {
      const host = validateAllowlistHost(raw);
      return host.ok ? { ok: true, entry: host.host } : { ok: false, reason: host.reason };
    }
    const config = validateMcpServerConfig(raw);
    return config.ok ? { ok: true, entry: config.config } : { ok: false, reason: config.reason };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

/** Normalize persisted allowlist array; keeps legacy strings and validated configs. */
export function normalizeAllowlistEntries(
  raw: unknown,
  fallback: AllowlistEntry[],
): AllowlistEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) return [...fallback];
  const out: AllowlistEntry[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const valid = validateAllowlistHost(item);
      out.push(valid.ok ? valid.host : item.trim().toLowerCase());
      continue;
    }
    if (typeof item === "object" && item !== null) {
      const config = validateMcpServerConfig(item);
      if (config.ok) out.push(config.config);
    }
  }
  return out.length > 0 ? out : [...fallback];
}

/** Stable key for list rows, remove, and edit. */
export function allowlistEntryKey(entry: AllowlistEntry): string {
  if (typeof entry === "string") return entry;
  if (entry.transport === "stdio") {
    const args = entry.args?.join(" ") ?? "";
    return `stdio:${entry.command}${args ? ` ${args}` : ""}`;
  }
  return `${entry.transport}:${entry.url}`;
}

/** Human-readable summary for Admin UI tables. */
export function allowlistEntryLabel(entry: AllowlistEntry): string {
  if (typeof entry === "string") return entry;
  if (entry.transport === "stdio") {
    const args = entry.args?.length ? ` ${entry.args.join(" ")}` : "";
    return `stdio · ${entry.command}${args}`;
  }
  return `${entry.transport} · ${entry.url}`;
}

export function allowlistEntryTransport(entry: AllowlistEntry): string {
  if (typeof entry === "string") return "host";
  return entry.transport;
}

export function allowlistEntriesEqual(a: AllowlistEntry, b: AllowlistEntry): boolean {
  return allowlistEntryKey(a) === allowlistEntryKey(b);
}

export function allowlistIncludes(
  entries: AllowlistEntry[],
  candidate: AllowlistEntry,
): boolean {
  return entries.some((e) => allowlistEntriesEqual(e, candidate));
}

/** Entries whose keys are not in the disabled set. Missing keys stay enabled. */
export function enabledAllowlist(
  entries: AllowlistEntry[],
  disabledKeys: readonly string[] = [],
): AllowlistEntry[] {
  if (disabledKeys.length === 0) return entries;
  const disabled = new Set(disabledKeys);
  return entries.filter((entry) => !disabled.has(allowlistEntryKey(entry)));
}

export function toggleDisabledKey(
  keys: readonly string[],
  key: string,
): { keys: string[]; enabled: boolean } {
  if (keys.includes(key)) return { keys: keys.filter((item) => item !== key), enabled: true };
  return { keys: [...keys, key], enabled: false };
}

/** Keep a disabled flag when an edit changes the entry key. */
export function retargetDisabledKey(keys: readonly string[], from: string, to: string): string[] {
  if (!keys.includes(from) || from === to) return [...keys];
  return [...keys.filter((key) => key !== from && key !== to), to];
}

/** Flatten structured entries to host strings for runtime allowlist checks. */
export function allowlistHosts(entries: AllowlistEntry[]): string[] {
  const hosts = new Set<string>();
  for (const entry of entries) {
    if (typeof entry === "string") {
      hosts.add(entry);
      continue;
    }
    if (entry.transport === "stdio") {
      hosts.add("stdio");
      continue;
    }
    try {
      hosts.add(new URL(entry.url).hostname.toLowerCase());
    } catch {
      /* skip invalid url at runtime flatten */
    }
  }
  return [...hosts];
}
