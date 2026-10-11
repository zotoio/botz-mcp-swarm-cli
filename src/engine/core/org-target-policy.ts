import type { Target } from "../types/manifest.js";
import type { AllowlistEntry, McpServerConfig } from "../service/mcp-allowlist.js";
import { isMcpServerConfig } from "../service/mcp-allowlist.js";
import {
  assertTargetAllowlisted,
  AllowlistError,
  isTargetAllowlisted,
} from "./allowlist.js";
import { resolveStdioTarget } from "./target-resolve.js";

export interface OrgTargetAllowlistResult {
  /** Run used admin-configured legacy `"stdio"` host wildcard (audited at call site). */
  usedLegacyStdioWildcard: boolean;
}

function resolvedTarget(target: Target, baseDir?: string): Target {
  return target.transport === "stdio" ? resolveStdioTarget(target, baseDir) : target;
}

function stdioArgsEqual(a?: string[], b?: string[]): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function stdioMatchesConfig(target: Target, entry: McpServerConfig, baseDir?: string): boolean {
  if (target.transport !== "stdio" || entry.transport !== "stdio") return false;
  const resolved = resolvedTarget(target, baseDir);
  if (resolved.transport !== "stdio") return false;
  const entryAsTarget: Target = {
    transport: "stdio",
    command: entry.command,
    args: entry.args,
    cwd: entry.cwd,
    env: entry.env,
  };
  const resolvedEntry = resolveStdioTarget(entryAsTarget, baseDir);
  if (resolvedEntry.transport !== "stdio") return false;
  return (
    resolved.command === resolvedEntry.command &&
    stdioArgsEqual(resolved.args, resolvedEntry.args)
  );
}

function httpMatchesConfig(target: Target, entry: McpServerConfig): boolean {
  if (target.transport === "stdio" || entry.transport === "stdio") return false;
  return target.transport === entry.transport && target.url === entry.url;
}

/** Host allowlist for HTTP targets — legacy `"stdio"` is not a transport wildcard here. */
export function orgHttpHostAllowlist(entries: AllowlistEntry[]): string[] {
  const hosts = new Set<string>();
  for (const entry of entries) {
    if (typeof entry === "string") {
      if (entry !== "stdio") hosts.add(entry.toLowerCase().trim());
      continue;
    }
    if (entry.transport !== "stdio") {
      try {
        hosts.add(new URL(entry.url).hostname.toLowerCase());
      } catch {
        /* skip invalid */
      }
    }
  }
  return [...hosts];
}

function assertOrgGatewayAllowlisted(
  gatewayId: string,
  entries: AllowlistEntry[],
): void {
  const gatewayAllowlist = entries.filter((e): e is string => typeof e === "string");
  if (
    !gatewayAllowlist.includes(gatewayId) &&
    !gatewayAllowlist.some((a) => a.startsWith("*"))
  ) {
    throw new AllowlistError(
      `Gateway id [${gatewayId}] not in org gateway allowlist: [${gatewayAllowlist.join(", ")}]`,
    );
  }
}

/**
 * Enforce tenant org targetAllowlist at execution time (fail closed).
 * Structured stdio entries require an exact command/args match; legacy `"stdio"` string is admin-only wildcard.
 */
export function assertOrgTargetAllowlisted(
  target: Target,
  entries: AllowlistEntry[],
  baseDir?: string,
  gatewayId?: string,
  orgGatewayAllowlist?: AllowlistEntry[],
): OrgTargetAllowlistResult {
  const resolved = resolvedTarget(target, baseDir);
  const structured = entries.filter(isMcpServerConfig);

  if (resolved.transport === "stdio") {
    const legacyWildcard = entries.some((e) => typeof e === "string" && e === "stdio");
    if (legacyWildcard) {
      return { usedLegacyStdioWildcard: true };
    }
    const stdioConfigs = structured.filter((e) => e.transport === "stdio");
    if (stdioConfigs.length === 0) {
      throw new AllowlistError("Stdio target requires explicit stdio allowlist entry");
    }
    if (!stdioConfigs.some((e) => stdioMatchesConfig(resolved, e, baseDir))) {
      throw new AllowlistError("Stdio command/args not in org target allowlist");
    }
    return { usedLegacyStdioWildcard: false };
  }

  const httpHosts = orgHttpHostAllowlist(entries);
  assertTargetAllowlisted(resolved, httpHosts);
  if (gatewayId) {
    assertOrgGatewayAllowlisted(gatewayId, orgGatewayAllowlist ?? []);
  }

  const httpConfigs = structured.filter((e) => e.transport !== "stdio");
  if (httpConfigs.length > 0) {
    const legacyHostEntries = entries.filter(
      (e): e is string => typeof e === "string" && e !== "stdio",
    );
    if (isTargetAllowlisted(resolved, legacyHostEntries)) {
      return { usedLegacyStdioWildcard: false };
    }
    if (!httpConfigs.some((e) => httpMatchesConfig(resolved, e))) {
      throw new AllowlistError("HTTP target URL not in org target allowlist");
    }
  }

  return { usedLegacyStdioWildcard: false };
}
