import type { ProjectDetail, ProjectServer, ProjectStoreOptions } from "../engine/store/project-store.js";
import {
  acceptServerUpdate,
  checkServerUpdates,
  discardServerUpdate,
  filterSuitesByTags,
  listRunsWithTags,
  listScenarios,
  setRunTags,
  setScenarioTags,
  setServerChangelogNotes,
  setServerMeta,
  setSuiteMeta,
  storedSnapshot,
  projectIntrospectionState,
  refreshServerIntrospection,
  type ProbeFn,
  type ServerIntrospectionState,
  type ServerUpdateCheck,
} from "../engine/store/server-updates-store.js";
import { normalizeTags } from "../engine/core/server-updates.js";
import { resolveProject, resolveSuite } from "./project-ops.js";

export function resolveServer(project: ProjectDetail, ref?: string): ProjectServer {
  const servers = project.servers ?? [];
  const server = ref ? servers.find((s) => s.id === ref || s.name === ref) : servers[0];
  if (!server) throw new Error(`server_not_found: ${ref ?? "(first)"}`);
  return server;
}

export async function projectServerUpdates(ref: string, serverRef?: string, options?: ProjectStoreOptions & { probe?: ProbeFn }) {
  const project = await resolveProject(ref, options);
  const serverId = serverRef ? resolveServer(project, serverRef).id : undefined;
  const results = await checkServerUpdates(project.id, { serverId, probe: options?.probe }, options);
  if (!results) throw new Error("project_not_found");
  return { projectId: project.id, results };
}

/**
 * `project server refresh`: live-introspect one server (or the suite's server, or all) now. Records
 * lastIntrospectedAt + snapshot hash + era, and flags drift as a pending review. Never edits suites.
 */
export async function projectRefreshServer(
  ref: string,
  target: { server?: string; suite?: string },
  options?: ProjectStoreOptions & { probe?: ProbeFn; staleAfterMs?: number },
) {
  const project = await resolveProject(ref, options);
  const serverId = target.server ? resolveServer(project, target.server).id : undefined;
  const suiteId = !serverId && target.suite ? resolveSuite(project, target.suite).id : undefined;
  const out = await refreshServerIntrospection(project.id, { serverId, suiteId, probe: options?.probe, staleAfterMs: options?.staleAfterMs }, options);
  if (!out) throw new Error("project_not_found");
  return { projectId: project.id, ...out };
}

/** `project server status`: last live introspection per server, era/spec, stale flag, pending review. */
export async function projectIntrospectionStatus(
  ref: string,
  target: { server?: string; suite?: string; staleAfterMs?: number },
  options?: ProjectStoreOptions,
) {
  const project = await resolveProject(ref, options);
  const serverId = target.server ? resolveServer(project, target.server).id : undefined;
  const suiteId = !serverId && target.suite ? resolveSuite(project, target.suite).id : undefined;
  return (await projectIntrospectionState(project.id, { serverId, suiteId, staleAfterMs: target.staleAfterMs }, options)) ?? [];
}

function relative(ms: number | null): string {
  if (ms === null) return "never";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function formatIntrospectionStatus(rows: ServerIntrospectionState[]): string {
  return rows.map((r) => {
    const parts = [
      `${r.stale ? "⚠" : "✓"} ${r.serverName} (${r.serverId})`,
      `Last introspected: ${relative(r.ageMs)}${r.lastIntrospectedAt ? ` (${r.lastIntrospectedAt})` : ""}`,
      `${r.protocolEra} era · MCP ${r.protocolVersion ?? "unknown"}`,
      ...(r.snapshotHash ? [`surface ${r.snapshotHash}`] : []),
      ...(r.stale ? [`STALE (> ${Math.round(r.staleAfterMs / 3_600_000)}h) — run \`project server refresh\``] : []),
      ...(r.lastError ? [`last refresh failed: ${r.lastError}`] : []),
    ];
    const pending = r.pendingReview
      ? `\n    Suite changes pending review: ${r.pendingReview.proposalCount} across ${r.pendingReview.suiteIds.length} suite(s) — \`project server changelog\` / \`accept-update --change <id>\``
      : "";
    return parts.join(" · ") + pending;
  }).join("\n");
}

export async function projectAcceptServerUpdate(
  ref: string,
  serverRef: string | undefined,
  input: { changeIds?: string[]; notes?: string },
  options?: ProjectStoreOptions,
) {
  const project = await resolveProject(ref, options);
  const server = resolveServer(project, serverRef);
  const result = await acceptServerUpdate(project.id, server.id, { acceptChangeIds: input.changeIds, notes: input.notes, principal: "cli" }, options);
  if ("error" in result) throw new Error(result.error);
  return result;
}

export async function projectDiscardServerUpdate(ref: string, serverRef: string | undefined, options?: ProjectStoreOptions) {
  const project = await resolveProject(ref, options);
  return discardServerUpdate(project.id, resolveServer(project, serverRef).id, options);
}

export async function projectServerChangelog(ref: string, serverRef?: string, options?: ProjectStoreOptions) {
  const project = await resolveProject(ref, options);
  const servers = serverRef ? [resolveServer(project, serverRef)] : project.servers ?? [];
  return servers.map((s) => ({
    serverId: s.id,
    name: s.name,
    description: s.description ?? "",
    protocolVersion: s.protocolVersion ?? null,
    serverVersion: s.surface?.serverVersion ?? null,
    snapshotAt: storedSnapshot(s).takenAt,
    pending: s.pendingUpdate ? { checkedAt: s.pendingUpdate.checkedAt, summary: s.pendingUpdate.diff.summary, proposals: s.pendingUpdate.proposals.length } : null,
    versionHistory: s.versionHistory ?? [],
  }));
}

export async function projectEditChangelogNotes(ref: string, serverRef: string | undefined, entryId: string, notes: string, options?: ProjectStoreOptions) {
  const project = await resolveProject(ref, options);
  const entry = await setServerChangelogNotes(project.id, resolveServer(project, serverRef).id, entryId, notes, options);
  if (!entry) throw new Error(`changelog_not_found: ${entryId}`);
  return entry;
}

export async function projectDescribe(ref: string, entity: "server" | "suite", target: string | undefined, description: string, options?: ProjectStoreOptions) {
  const project = await resolveProject(ref, options);
  if (entity === "server") return setServerMeta(project.id, resolveServer(project, target).id, { description }, options);
  return setSuiteMeta(project.id, resolveSuite(project, target).id, { description }, options);
}

export async function projectTag(
  ref: string,
  entity: "suite" | "scenario" | "run",
  input: { id: string; suite?: string; tags: string[] },
  options?: ProjectStoreOptions,
): Promise<string[]> {
  const project = await resolveProject(ref, options);
  if (entity === "suite") return (await setSuiteMeta(project.id, resolveSuite(project, input.id).id, { tags: input.tags }, options))?.tags ?? [];
  if (entity === "scenario") {
    const tags = await setScenarioTags(project.id, resolveSuite(project, input.suite).id, input.id, input.tags, options);
    if (!tags) throw new Error("suite_not_found");
    return tags;
  }
  return (await setRunTags(project.id, input.id, input.tags, options)) ?? [];
}

export async function projectSuiteRows(ref: string, tags?: string[], options?: ProjectStoreOptions) {
  const project = await resolveProject(ref, options);
  return filterSuitesByTags(project.suites, normalizeTags(tags ?? []));
}

export async function projectScenarioRows(ref: string, filter: { suite?: string; tags?: string[] }, options?: ProjectStoreOptions) {
  const project = await resolveProject(ref, options);
  return (await listScenarios(project.id, { suiteId: filter.suite ? resolveSuite(project, filter.suite).id : undefined, tags: normalizeTags(filter.tags ?? []) }, options)) ?? [];
}

export async function projectTaggedRunRows(ref: string, tags?: string[], options?: ProjectStoreOptions) {
  const project = await resolveProject(ref, options);
  return listRunsWithTags(project.id, { tags: normalizeTags(tags ?? []) }, options);
}

export function formatUpdateCheck(results: ServerUpdateCheck[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const pv = r.current?.protocolVersion ?? r.protocolVersion ?? "unknown";
    if (r.error) {
      lines.push(`✗ ${r.serverName} (${r.serverId}): ${r.error}`);
      continue;
    }
    const era = r.protocolEra ? ` (${r.protocolEra} era)` : "";
    if (!r.diff?.changed && r.proposals.length === 0) {
      lines.push(`✓ ${r.serverName} (${r.serverId}) · MCP ${pv}${era} · serverVersion ${r.current?.serverVersion ?? "?"} · no changes · introspected ${r.checkedAt}`);
      continue;
    }
    lines.push(`△ ${r.serverName} (${r.serverId}) · MCP ${pv}${era} · ${r.proposals.length} proposal(s) across ${r.affectedSuiteIds.length} suite(s) · pending review, nothing applied`);
    if (r.diff?.changed) lines.push(...r.diff.summary.split("\n").map((l) => `    ${l}`));
    else lines.push("    Suite drift: the suites expect things this server no longer offers.");
    for (const p of r.proposals) {
      lines.push(`    [${p.id}] ${p.action} ${p.suiteName ?? p.suiteId} › ${p.scenarioName ? `${p.scenarioName} › ` : ""}${p.nodeLabel ?? p.nodeId} — ${p.reason}`);
    }
  }
  return lines.join("\n");
}

export function parseTagList(raw?: string | string[]): string[] {
  if (!raw) return [];
  return normalizeTags(Array.isArray(raw) ? raw.flatMap((r) => r.split(",")) : raw.split(","));
}
