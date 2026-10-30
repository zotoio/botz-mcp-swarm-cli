/**
 * Live-introspection freshness: when a server was last probed, which MCP protocol era and spec
 * version it spoke, a stable hash of what it advertised, and whether that is now stale.
 *
 * Also decides what a failed run should produce: a suite-fix recommendation when every finding is
 * a suite bug, or a server remediation prompt when the server itself is implicated.
 *
 * Pure functions only.
 */
import { createHash } from "node:crypto";
import { stableJson, type SurfaceSnapshot } from "./server-updates.js";
import type { SuiteNode } from "./suite-model.js";
import { MODERN_REMOVED_METHODS, isModernEra, protocolEraFor, type ProtocolEra } from "./protocol-era.js";

export { MODERN_PROTOCOL_REVISION, MODERN_REMOVED_METHODS, isModernEra, protocolEraFor, type ProtocolEra } from "./protocol-era.js";

export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Hash of everything the server advertised, ignoring when it was taken. Equal hashes mean nothing changed. */
export function snapshotHash(snapshot: Omit<SurfaceSnapshot, "takenAt"> & { takenAt?: string }): string {
  const { takenAt: _t, ...rest } = snapshot;
  return createHash("sha256").update(stableJson(rest)).digest("hex").slice(0, 16);
}

/**
 * Staleness threshold. Order: explicit override, `SWARM_INTROSPECTION_STALE_HOURS`, 24h.
 * Values ≤ 0 or unparsable fall back to the default.
 */
export function staleThresholdMs(env: NodeJS.ProcessEnv = process.env, overrideMs?: number | null): number {
  if (typeof overrideMs === "number" && Number.isFinite(overrideMs) && overrideMs > 0) return overrideMs;
  const hours = Number.parseFloat(env.SWARM_INTROSPECTION_STALE_HOURS ?? "");
  if (Number.isFinite(hours) && hours > 0) return Math.round(hours * 60 * 60 * 1000);
  return DEFAULT_STALE_AFTER_MS;
}

export interface IntrospectionFields {
  lastIntrospectedAt?: string;
  /** Older records: the time the catalog was last filled. Used when `lastIntrospectedAt` is missing. */
  catalogAt?: string;
  snapshotHash?: string;
  protocolVersion?: string;
  protocolEra?: string;
  introspectError?: string;
}

export interface IntrospectionStatus {
  lastIntrospectedAt: string | null;
  ageMs: number | null;
  stale: boolean;
  staleAfterMs: number;
  protocolVersion: string | null;
  protocolEra: ProtocolEra;
  snapshotHash: string | null;
  lastError: string | null;
}

export function introspectionStatus(server: IntrospectionFields, opts: { now?: Date; staleAfterMs?: number } = {}): IntrospectionStatus {
  const staleAfterMs = opts.staleAfterMs ?? staleThresholdMs();
  const at = server.lastIntrospectedAt ?? server.catalogAt ?? null;
  const t = at ? Date.parse(at) : Number.NaN;
  const ageMs = Number.isNaN(t) ? null : Math.max(0, (opts.now ?? new Date()).getTime() - t);
  return {
    lastIntrospectedAt: ageMs === null ? null : at,
    ageMs,
    // Never introspected counts as stale.
    stale: ageMs === null || ageMs > staleAfterMs,
    staleAfterMs,
    protocolVersion: server.protocolVersion ?? null,
    protocolEra: protocolEraFor(server.protocolVersion, server.protocolEra),
    snapshotHash: server.snapshotHash ?? null,
    lastError: server.introspectError ?? null,
  };
}

// ---- remediation classification ---------------------------------------------

export type FindingCategory = "suite_bug" | "server_bug" | "environment" | string;

export interface ClassifiableFinding {
  category: FindingCategory;
  nodeIds?: string[];
}

export interface ClassifiableNodeOutcome {
  nodeId: string;
  errorCount: number;
  errorMessage?: string;
}

export interface RemediationClassification {
  /** `suite_fix`: only the suite is wrong. `server`: the server is implicated. `none`: nothing failed. */
  kind: "suite_fix" | "server" | "none";
  serverFindings: number;
  suiteFindings: number;
  /** Failed steps the suite itself explains (removed-method steps on a modern server). */
  suiteExplainedNodeIds: string[];
  /** Failed steps nothing explains yet. These still count against the server. */
  unexplainedNodeIds: string[];
}

function walk(nodes: SuiteNode[], visit: (n: SuiteNode) => void): void {
  for (const n of nodes) {
    visit(n);
    if (n.children?.length) walk(n.children, visit);
  }
}

/**
 * Classify a failed run. Suite bugs (an LLM `suite_bug` finding, or a step that calls a method the
 * server's era removed) never yield a server remediation prompt on their own.
 */
export function classifyRemediation(input: {
  findings?: ClassifiableFinding[];
  failedNodes?: ClassifiableNodeOutcome[];
  failedEvals?: number;
  /** Recorded fail reasons (SLO breaches etc.). Without an analysis they implicate the server. */
  failReasons?: number;
  suiteNodes?: SuiteNode[];
  protocolVersion?: string | null;
  protocolEra?: string | null;
}): RemediationClassification {
  const findings = input.findings ?? [];
  const serverFindings = findings.filter((f) => f.category === "server_bug" || f.category === "environment").length;
  const suiteFindings = findings.filter((f) => f.category === "suite_bug").length;
  const modern = isModernEra(input.protocolVersion, input.protocolEra);
  const byId = new Map<string, SuiteNode>();
  walk(input.suiteNodes ?? [], (n) => byId.set(n.id, n));
  const suiteCovered = new Set(findings.filter((f) => f.category === "suite_bug").flatMap((f) => f.nodeIds ?? []));
  const failed = (input.failedNodes ?? []).filter((o) => o.errorCount > 0 || Boolean(o.errorMessage));
  const suiteExplained: string[] = [];
  const unexplained: string[] = [];
  for (const o of failed) {
    const node = byId.get(o.nodeId);
    const removedMethod = modern && node?.method && MODERN_REMOVED_METHODS.has(node.method);
    if (removedMethod || suiteCovered.has(o.nodeId)) suiteExplained.push(o.nodeId);
    else unexplained.push(o.nodeId);
  }
  const evals = input.failedEvals ?? 0;
  const reasons = input.failReasons ?? 0;
  // With an analysis, its categories decide (suite_bug-only never blames the server, bar failed evals).
  // Without one, anything the suite cannot explain (failed steps, SLO breaches, evals) implicates the server.
  const serverImplicated = findings.length > 0
    ? serverFindings > 0 || evals > 0
    : evals > 0 || unexplained.length > 0 || (reasons > 0 && suiteExplained.length === 0);
  const anything = findings.length > 0 || failed.length > 0 || evals > 0 || reasons > 0;
  return {
    kind: serverImplicated ? "server" : anything ? "suite_fix" : "none",
    serverFindings,
    suiteFindings,
    suiteExplainedNodeIds: suiteExplained,
    unexplainedNodeIds: unexplained,
  };
}

export interface PendingSuiteReview {
  serverId: string;
  serverName?: string;
  checkedAt: string;
  proposalCount: number;
  suiteIds: string[];
  summary: string;
}

/** Markdown note listing suite changes awaiting review. Empty string when there are none. */
export function pendingReviewNote(pending: PendingSuiteReview[]): string {
  if (!pending.length) return "";
  const lines = [
    "> **Suite changes pending review.** Live introspection found drift between the server and what the suites expect.",
    "> These are NOT applied automatically; review them under Server updates → Review (or `swarm_server_update_apply`).",
  ];
  for (const p of pending) {
    lines.push(`> - ${p.serverName ?? p.serverId}: ${p.proposalCount} proposed step change(s) across ${p.suiteIds.length} suite(s) (checked ${p.checkedAt}). ${p.summary.split("\n")[0] ?? ""}`.trimEnd());
  }
  return lines.join("\n");
}
