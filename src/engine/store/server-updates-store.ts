/**
 * Persistence for server update checks, descriptions and tags.
 * Everything is stored as optional fields on the existing project.json record, so older records load unchanged.
 */
import { introspectServer } from "../core/suite-introspect.js";
import {
  applySuiteChanges,
  diffSnapshots,
  matchesTags,
  normalizeDescription,
  normalizeTags,
  proposeSuiteChanges,
  snapshotFromSurface,
  type PendingServerUpdate,
  type ServerVersionAnnotation,
  type SuiteChangeProposal,
  type SurfaceDiff,
  type SurfaceSnapshot,
} from "../core/server-updates.js";
import type { ServerSurface, SuiteNode, ToolCatalogEntry } from "../core/suite-model.js";
import {
  getProject,
  loadSuiteVersion,
  listProjectRuns,
  mutateProjectRecord,
  projectServerAliases,
  saveSuiteVersion,
  type ProjectRecord,
  type ProjectServer,
  type ProjectStoreOptions,
  type RunSummary,
  type SuitePointer,
} from "./project-store.js";

export type ProbeFn = (target: ProjectServer["target"]) => Promise<ServerSurface | ToolCatalogEntry[]>;

export interface ServerUpdateCheck {
  serverId: string;
  serverName: string;
  checkedAt: string;
  error?: string;
  protocolVersion?: string;
  previous?: SurfaceSnapshot;
  current?: SurfaceSnapshot;
  diff?: SurfaceDiff;
  proposals: SuiteChangeProposal[];
  /** Suites with at least one proposal; every other suite stays exactly as it is. */
  affectedSuiteIds: string[];
}

/** The stored baseline: an explicit snapshot, else the catalog and surface suites were last built from. */
export function storedSnapshot(server: ProjectServer): SurfaceSnapshot {
  if (server.snapshot) return server.snapshot;
  return snapshotFromSurface({
    ...(server.surface ?? { capabilities: [], resources: [], resourceTemplates: [], prompts: [] }),
    capabilities: server.surface?.capabilities ?? (server.catalog.length ? ["tools"] : []),
    resources: server.surface?.resources ?? [],
    resourceTemplates: server.surface?.resourceTemplates ?? [],
    prompts: server.surface?.prompts ?? [],
    tools: server.catalog,
    protocolVersion: server.protocolVersion ?? server.surface?.protocolVersion,
  }, server.catalogAt ?? new Date(0).toISOString());
}

function asSurface(found: ServerSurface | ToolCatalogEntry[]): ServerSurface & { protocolVersion?: string } {
  if (Array.isArray(found)) return { capabilities: ["tools"], tools: found, resources: [], resourceTemplates: [], prompts: [] };
  return found;
}

function suiteCallsServer(project: ProjectRecord, suite: SuitePointer, serverId: string): (alias: string | undefined) => boolean {
  const aliases = projectServerAliases(project);
  const home = suite.serverId ?? project.servers?.[0]?.id;
  return (alias) => {
    if (!alias) return home === serverId;
    return alias === serverId || aliases.get(alias) === serverId;
  };
}

async function proposalsFor(
  project: ProjectRecord,
  serverId: string,
  diff: SurfaceDiff,
  next: SurfaceSnapshot,
  options?: ProjectStoreOptions,
): Promise<SuiteChangeProposal[]> {
  const out: SuiteChangeProposal[] = [];
  for (const suite of project.suites) {
    const doc = await loadSuiteVersion(project.id, suite.id, suite.currentVersion, options);
    if (!doc) continue;
    out.push(...proposeSuiteChanges({ suiteId: suite.id, suiteName: suite.name, nodes: doc.nodes as SuiteNode[], callsServer: suiteCallsServer(project, suite, serverId) }, diff, next));
  }
  return out;
}

/**
 * Re-probe each server (or one), diff against its stored snapshot, and propose surgical suite edits.
 * A changed server keeps the probe as a pending update for review. An unchanged server just records its protocol version.
 */
export async function checkServerUpdates(
  projectId: string,
  input: { serverId?: string; probe?: ProbeFn } = {},
  options?: ProjectStoreOptions,
): Promise<ServerUpdateCheck[] | null> {
  const project = await getProject(projectId, options);
  if (!project || project.archived) return null;
  const servers = (project.servers ?? []).filter((s) => !input.serverId || s.id === input.serverId);
  if (input.serverId && servers.length === 0) return null;
  const probe: ProbeFn = input.probe ?? (options?.introspect as ProbeFn | undefined) ?? ((target) => introspectServer(target));
  const results: ServerUpdateCheck[] = [];
  const pending = new Map<string, PendingServerUpdate | null>();
  const protocols = new Map<string, string>();
  for (const server of servers) {
    const checkedAt = new Date().toISOString();
    let previous = storedSnapshot(server);
    try {
      const current = snapshotFromSurface(asSurface(await probe(server.target)), checkedAt);
      // Records saved before protocol detection have no version: the first sighting is a fact, not a change.
      if (!previous.protocolVersion && current.protocolVersion) previous = { ...previous, protocolVersion: current.protocolVersion };
      const diff = diffSnapshots(previous, current);
      const proposals = diff.changed ? await proposalsFor(project, server.id, diff, current, options) : [];
      if (current.protocolVersion) protocols.set(server.id, current.protocolVersion);
      pending.set(server.id, diff.changed ? { checkedAt, snapshot: current, diff, proposals } : null);
      results.push({
        serverId: server.id,
        serverName: server.name,
        checkedAt,
        protocolVersion: current.protocolVersion,
        previous,
        current,
        diff,
        proposals,
        affectedSuiteIds: [...new Set(proposals.map((p) => p.suiteId))],
      });
    } catch (error) {
      results.push({ serverId: server.id, serverName: server.name, checkedAt, error: error instanceof Error ? error.message : String(error), proposals: [], affectedSuiteIds: [] });
    }
  }
  await mutateProjectRecord(projectId, (record) => {
    for (const server of record.servers ?? []) {
      if (!pending.has(server.id)) continue;
      const next = pending.get(server.id);
      if (next) server.pendingUpdate = next;
      else {
        delete server.pendingUpdate;
        // Unchanged: adopt the probe as the explicit baseline and record the negotiated protocol.
        server.snapshot ??= storedSnapshot(server);
        const pv = protocols.get(server.id);
        if (pv) {
          server.protocolVersion = pv;
          server.snapshot.protocolVersion = pv;
        }
      }
      // First sighting of a protocol version is a fact about the server, not a change to review.
      if (!server.protocolVersion && protocols.get(server.id) && !server.snapshot?.protocolVersion) server.protocolVersion = protocols.get(server.id);
    }
  }, options);
  return results;
}

export interface AcceptServerUpdateResult {
  annotation: ServerVersionAnnotation;
  suiteVersions: Array<{ suiteId: string; version: number }>;
  untouchedSuiteIds: string[];
}

/**
 * Accept a reviewed pending update: adopt the new snapshot, apply only accepted proposals
 * (one new version per affected suite), and record a changelog annotation on the server.
 */
export async function acceptServerUpdate(
  projectId: string,
  serverId: string,
  input: { acceptChangeIds?: string[]; notes?: string; principal?: string } = {},
  options?: ProjectStoreOptions,
): Promise<AcceptServerUpdateResult | { error: "project_not_found" | "server_not_found" | "no_pending_update" }> {
  const project = await getProject(projectId, options);
  if (!project || project.archived) return { error: "project_not_found" };
  const server = project.servers?.find((s) => s.id === serverId);
  if (!server) return { error: "server_not_found" };
  const pending = server.pendingUpdate;
  if (!pending) return { error: "no_pending_update" };
  const wanted = input.acceptChangeIds ? new Set(input.acceptChangeIds) : null;
  const accepted = pending.proposals.filter((p) => !wanted || wanted.has(p.id));
  const rejected = pending.proposals.filter((p) => wanted && !wanted.has(p.id));
  const previous = storedSnapshot(server);
  const annotation: ServerVersionAnnotation = {
    id: `chg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    recordedAt: new Date().toISOString(),
    ...(pending.snapshot.serverVersion ? { serverVersion: pending.snapshot.serverVersion } : {}),
    ...(pending.snapshot.protocolVersion ? { protocolVersion: pending.snapshot.protocolVersion } : {}),
    ...(previous.serverVersion ? { previousServerVersion: previous.serverVersion } : {}),
    ...(previous.protocolVersion ? { previousProtocolVersion: previous.protocolVersion } : {}),
    summary: pending.diff.summary,
    ...(normalizeDescription(input.notes) ? { notes: normalizeDescription(input.notes) } : {}),
    ...(input.principal ? { principal: input.principal } : {}),
    acceptedChangeIds: accepted.map((p) => p.id),
    rejectedChangeIds: rejected.map((p) => p.id),
    suiteVersions: [],
  };
  // Adopt the catalog first so new suite versions fingerprint against it.
  await mutateProjectRecord(projectId, (record) => {
    const target = record.servers?.find((s) => s.id === serverId);
    if (!target) return;
    const snap = pending.snapshot;
    target.catalog = snap.tools;
    target.surface = {
      ...(snap.serverName ? { serverName: snap.serverName } : {}),
      ...(snap.serverVersion ? { serverVersion: snap.serverVersion } : {}),
      ...(snap.protocolVersion ? { protocolVersion: snap.protocolVersion } : {}),
      ...(target.surface?.latency ? { latency: target.surface.latency } : {}),
      capabilities: snap.capabilities,
      resources: snap.resources,
      resourceTemplates: snap.resourceTemplates,
      prompts: snap.prompts,
    };
    target.catalogAt = snap.takenAt;
    target.snapshot = snap;
    if (snap.protocolVersion) target.protocolVersion = snap.protocolVersion;
    target.introspectError = undefined;
    delete target.pendingUpdate;
  }, options);
  const bySuite = new Map<string, SuiteChangeProposal[]>();
  for (const p of accepted) bySuite.set(p.suiteId, [...(bySuite.get(p.suiteId) ?? []), p]);
  const suiteVersions: Array<{ suiteId: string; version: number }> = [];
  for (const [suiteId, proposals] of bySuite) {
    const pointer = project.suites.find((s) => s.id === suiteId);
    if (!pointer) continue;
    const doc = await loadSuiteVersion(projectId, suiteId, pointer.currentVersion, options);
    if (!doc) continue;
    const { nodes } = applySuiteChanges(doc.nodes as SuiteNode[], proposals);
    const saved = await saveSuiteVersion(projectId, suiteId, { name: doc.name, nodes: nodes as typeof doc.nodes, load: doc.load, basedOn: pointer.currentVersion }, options);
    if (saved) suiteVersions.push({ suiteId, version: saved.version });
  }
  annotation.suiteVersions = suiteVersions;
  await mutateProjectRecord(projectId, (record) => {
    const target = record.servers?.find((s) => s.id === serverId);
    if (!target) return;
    target.versionHistory = [annotation, ...(target.versionHistory ?? [])].slice(0, 100);
  }, options);
  return {
    annotation,
    suiteVersions,
    untouchedSuiteIds: project.suites.map((s) => s.id).filter((id) => !bySuite.has(id)),
  };
}

export async function discardServerUpdate(projectId: string, serverId: string, options?: ProjectStoreOptions): Promise<boolean> {
  let found = false;
  await mutateProjectRecord(projectId, (record) => {
    const target = record.servers?.find((s) => s.id === serverId);
    if (target?.pendingUpdate) {
      delete target.pendingUpdate;
      found = true;
    }
  }, options);
  return found;
}

export async function setServerChangelogNotes(
  projectId: string,
  serverId: string,
  entryId: string,
  notes: string,
  options?: ProjectStoreOptions,
): Promise<ServerVersionAnnotation | null> {
  let updated: ServerVersionAnnotation | null = null;
  await mutateProjectRecord(projectId, (record) => {
    const entry = record.servers?.find((s) => s.id === serverId)?.versionHistory?.find((e) => e.id === entryId);
    if (!entry) return;
    const next = normalizeDescription(notes);
    if (next) entry.notes = next;
    else delete entry.notes;
    updated = entry;
  }, options);
  return updated;
}

// ---- descriptions & tags --------------------------------------------------

export async function setServerMeta(
  projectId: string,
  serverId: string,
  input: { description?: string | null; tags?: unknown },
  options?: ProjectStoreOptions,
): Promise<ProjectServer | null> {
  let out: ProjectServer | null = null;
  await mutateProjectRecord(projectId, (record) => {
    const server = record.servers?.find((s) => s.id === serverId);
    if (!server) return;
    if (input.description !== undefined) {
      const d = normalizeDescription(input.description);
      if (d) server.description = d;
      else delete server.description;
    }
    out = server;
  }, options);
  return out;
}

export async function setSuiteMeta(
  projectId: string,
  suiteId: string,
  input: { description?: string | null; tags?: unknown },
  options?: ProjectStoreOptions,
): Promise<SuitePointer | null> {
  let out: SuitePointer | null = null;
  await mutateProjectRecord(projectId, (record) => {
    const suite = record.suites.find((s) => s.id === suiteId);
    if (!suite) return;
    if (input.description !== undefined) {
      const d = normalizeDescription(input.description);
      if (d) suite.description = d;
      else delete suite.description;
    }
    if (input.tags !== undefined) {
      const tags = normalizeTags(input.tags);
      if (tags.length) suite.tags = tags;
      else delete suite.tags;
    }
    out = suite;
  }, options);
  return out;
}

export async function setScenarioTags(
  projectId: string,
  suiteId: string,
  scenarioId: string,
  tags: unknown,
  options?: ProjectStoreOptions,
): Promise<string[] | null> {
  let out: string[] | null = null;
  await mutateProjectRecord(projectId, (record) => {
    const suite = record.suites.find((s) => s.id === suiteId);
    if (!suite) return;
    const next = normalizeTags(tags);
    const map = { ...(suite.scenarioTags ?? {}) };
    if (next.length) map[scenarioId] = next;
    else delete map[scenarioId];
    if (Object.keys(map).length) suite.scenarioTags = map;
    else delete suite.scenarioTags;
    out = next;
  }, options);
  return out;
}

export async function setRunTags(projectId: string, runId: string, tags: unknown, options?: ProjectStoreOptions): Promise<string[] | null> {
  let out: string[] | null = null;
  await mutateProjectRecord(projectId, (record) => {
    const next = normalizeTags(tags);
    const map = { ...(record.runTags ?? {}) };
    if (next.length) map[runId] = next;
    else delete map[runId];
    if (Object.keys(map).length) record.runTags = map;
    else delete record.runTags;
    out = next;
  }, options);
  return out;
}

export function filterSuitesByTags<T extends { tags?: string[] }>(suites: T[], tags?: string[]): T[] {
  const filter = normalizeTags(tags ?? []);
  return suites.filter((s) => matchesTags(s.tags, filter));
}

export interface ScenarioRow {
  suiteId: string;
  suiteName: string;
  scenarioId: string;
  name: string;
  goal?: string;
  category?: string;
  tags: string[];
}

/** Scenario frames (groups carrying scenarioMeta) across the current version of each suite. */
export async function listScenarios(
  projectId: string,
  filter: { suiteId?: string; tags?: string[] } = {},
  options?: ProjectStoreOptions,
): Promise<ScenarioRow[] | null> {
  const project = await getProject(projectId, options);
  if (!project) return null;
  const tags = normalizeTags(filter.tags ?? []);
  const rows: ScenarioRow[] = [];
  for (const suite of project.suites) {
    if (filter.suiteId && suite.id !== filter.suiteId) continue;
    const doc = await loadSuiteVersion(projectId, suite.id, suite.currentVersion, options);
    const walk = (list: SuiteNode[]) => {
      for (const node of list) {
        const meta = node.scenarioMeta;
        if (meta) {
          const own = suite.scenarioTags?.[meta.id] ?? [];
          if (matchesTags(own, tags)) rows.push({ suiteId: suite.id, suiteName: suite.name, scenarioId: meta.id, name: meta.name, goal: meta.goal, category: meta.category, tags: own });
        }
        if (node.children?.length) walk(node.children);
      }
    };
    walk((doc?.nodes ?? []) as SuiteNode[]);
  }
  return rows;
}

export async function listRunsWithTags(
  projectId: string,
  filter: { tags?: string[] } = {},
  options?: ProjectStoreOptions,
): Promise<Array<RunSummary & { tags: string[] }>> {
  const project = await getProject(projectId, options);
  const runs = await listProjectRuns(projectId, options);
  const tags = normalizeTags(filter.tags ?? []);
  return runs
    .map((run) => ({ ...run, tags: project?.runTags?.[run.id] ?? [] }))
    .filter((run) => matchesTags(run.tags, tags));
}
