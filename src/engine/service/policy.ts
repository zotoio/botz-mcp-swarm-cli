import type { AllowlistEntry, McpServerConfig } from "./mcp-allowlist.js";
import { normalizeAllowlistEntries } from "./mcp-allowlist.js";

/** Bundled mock MCP server (examples/mock-stdio.json). */
export const BUNDLED_MOCK_STDIO_ALLOWLIST_ENTRY: McpServerConfig = {
  transport: "stdio",
  command: "mock-server/run.sh",
};

const DEFAULT_TARGET_ALLOWLIST: AllowlistEntry[] = [
  BUNDLED_MOCK_STDIO_ALLOWLIST_ENTRY,
  "localhost",
  "127.0.0.1",
];

/** Editor or runner grant. Empty projectIds means every project. */
export interface RoleBinding {
  role: "editor" | "runner";
  teamSlugs: string[];
  projectIds: string[];
  /** Runners with this flag may run a suite that enables a destructive tool. */
  destructive?: boolean;
}

/** Tenant control-plane policy (single-tenant per deploy). */
export interface OrgPolicy {
  githubOrg: string;
  /** SSO team allowlist; empty = any org member. */
  teamSlugs: string[];
  /** Operator teams. Empty = GitHub org owners only. Owners are always operators. */
  adminTeamSlugs: string[];
  /** Extra editor and runner grants. Org members who can sign in are viewers. */
  roleBindings: RoleBinding[];
  /** Legacy host strings or full MCP server configs. */
  targetAllowlist: AllowlistEntry[];
  gatewayAllowlist: AllowlistEntry[];
  /** Server and gateway keys that stay in the list but are not called. */
  disabledTargetKeys: string[];
  disabledGatewayKeys: string[];
  /** Hosts permitted for admin-configured egress (webhook, otel). */
  egressAllowlist: string[];
  failWebhookUrl?: string;
  /** OTLP HTTP endpoint when process env unset. */
  otelEndpoint?: string;
  sessionTtlHours?: number;
  /** How long a saved execution and its OTEL exports are kept. */
  executionTtlHours?: number;
  /** Locked ON — cannot be disabled via UI or API. */
  redactionMode: "on";
}

export const DEFAULT_POLICY: OrgPolicy = {
  githubOrg: "zotoio",
  teamSlugs: [],
  adminTeamSlugs: [],
  roleBindings: [],
  targetAllowlist: DEFAULT_TARGET_ALLOWLIST,
  gatewayAllowlist: [],
  disabledTargetKeys: [],
  disabledGatewayKeys: [],
  egressAllowlist: [],
  sessionTtlHours: 8,
  executionTtlHours: 168,
  redactionMode: "on",
};

export function clampSessionTtlHours(hours: number): number {
  return Math.min(72, Math.max(1, Math.round(hours)));
}

export function sessionTtlMs(policy: OrgPolicy): number {
  return clampSessionTtlHours(policy.sessionTtlHours ?? 8) * 60 * 60 * 1000;
}

/** 1 hour through 90 days. Default is 7 days. */
export function clampExecutionTtlHours(hours: number): number {
  if (!Number.isFinite(hours)) return DEFAULT_POLICY.executionTtlHours!;
  return Math.min(2160, Math.max(1, Math.round(hours)));
}

export function executionTtlMs(policy: OrgPolicy): number {
  return clampExecutionTtlHours(policy.executionTtlHours ?? DEFAULT_POLICY.executionTtlHours!) * 60 * 60 * 1000;
}

/** Backward-compatible normalization for persisted policy.json. */
export function normalizePolicy(raw: Partial<OrgPolicy>): OrgPolicy {
  const redaction = raw.redactionMode === "on" ? "on" : "on";
  return {
    githubOrg:
      typeof raw.githubOrg === "string" && raw.githubOrg
        ? raw.githubOrg
        : process.env.GITHUB_ALLOWED_ORG?.trim() || DEFAULT_POLICY.githubOrg,
    teamSlugs: Array.isArray(raw.teamSlugs)
      ? raw.teamSlugs.map(String)
      : parseCommaList(process.env.GITHUB_TEAM_SLUGS),
    adminTeamSlugs: Array.isArray(raw.adminTeamSlugs) ? raw.adminTeamSlugs.map(String) : [],
    roleBindings: normalizeRoleBindings(raw.roleBindings),
    targetAllowlist: normalizeAllowlistEntries(raw.targetAllowlist, DEFAULT_POLICY.targetAllowlist),
    gatewayAllowlist: normalizeAllowlistEntries(raw.gatewayAllowlist, DEFAULT_POLICY.gatewayAllowlist),
    disabledTargetKeys: normalizeKeyList(raw.disabledTargetKeys),
    disabledGatewayKeys: normalizeKeyList(raw.disabledGatewayKeys),
    egressAllowlist: Array.isArray(raw.egressAllowlist) ? raw.egressAllowlist.map(String) : [],
    failWebhookUrl:
      typeof raw.failWebhookUrl === "string" && raw.failWebhookUrl.trim()
        ? raw.failWebhookUrl.trim()
        : undefined,
    otelEndpoint:
      typeof raw.otelEndpoint === "string" && raw.otelEndpoint.trim()
        ? raw.otelEndpoint.trim()
        : undefined,
    sessionTtlHours: clampSessionTtlHours(
      typeof raw.sessionTtlHours === "number" ? raw.sessionTtlHours : DEFAULT_POLICY.sessionTtlHours!,
    ),
    executionTtlHours: clampExecutionTtlHours(
      typeof raw.executionTtlHours === "number" ? raw.executionTtlHours : DEFAULT_POLICY.executionTtlHours!,
    ),
    redactionMode: redaction,
  };
}

function normalizeKeyList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(String).filter(Boolean))];
}

function normalizeRoleBindings(raw: unknown): RoleBinding[] {
  if (!Array.isArray(raw)) return [];
  const bindings: RoleBinding[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const role = (entry as { role?: unknown }).role;
    if (role !== "editor" && role !== "runner") continue;
    const teamSlugs = Array.isArray((entry as { teamSlugs?: unknown }).teamSlugs)
      ? (entry as { teamSlugs: unknown[] }).teamSlugs.map(String).filter(Boolean)
      : [];
    if (teamSlugs.length === 0) continue;
    const projectIds = Array.isArray((entry as { projectIds?: unknown }).projectIds)
      ? (entry as { projectIds: unknown[] }).projectIds.map(String).filter(Boolean)
      : [];
    bindings.push({
      role,
      teamSlugs,
      projectIds,
      destructive: (entry as { destructive?: unknown }).destructive === true,
    });
  }
  return bindings;
}

/**
 * Apply an access-policy edit.
 * Org owners may change who can sign in and which teams are admins.
 * Any admin may change editor and runner grants. Those grant edits do not count as a sign-in change.
 */
export function applyIdentityChange(
  current: OrgPolicy,
  input: {
    isOwner: boolean;
    githubOrg?: string | null;
    teamSlugs?: string[] | null;
    adminTeamSlugs?: string[] | null;
    roleBindings: RoleBinding[];
  },
): { policy: OrgPolicy; signInChanged: boolean } {
  const policy = normalizePolicy({
    ...current,
    githubOrg: input.isOwner && input.githubOrg?.trim() ? input.githubOrg.trim() : current.githubOrg,
    teamSlugs: input.isOwner && input.teamSlugs ? input.teamSlugs : current.teamSlugs,
    adminTeamSlugs: input.isOwner && input.adminTeamSlugs ? input.adminTeamSlugs : current.adminTeamSlugs,
    roleBindings: input.roleBindings,
    redactionMode: "on",
  });
  const signInChanged =
    policy.githubOrg !== current.githubOrg ||
    JSON.stringify(policy.teamSlugs) !== JSON.stringify(current.teamSlugs) ||
    JSON.stringify(policy.adminTeamSlugs) !== JSON.stringify(current.adminTeamSlugs);
  return { policy, signInChanged };
}

export function parseCommaList(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/** In-process collector on the dashboard. Used when env and policy are both unset. */
export function defaultLocalOtelEndpoint(port = Number.parseInt(process.env.PORT ?? "4310", 10)): string {
  return `http://127.0.0.1:${port}/otlp`;
}

export function effectiveOtelEndpoint(policy: OrgPolicy, port?: number): string {
  const fromEnv = process.env.SWARM_CLI_OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (policy.otelEndpoint?.trim()) return policy.otelEndpoint.trim().replace(/\/$/, "");
  return defaultLocalOtelEndpoint(port);
}
