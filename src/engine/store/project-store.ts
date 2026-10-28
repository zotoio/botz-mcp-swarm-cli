import { SuiteLimitsSchema, type SuiteLimitsInput } from "../core/suite-limits.js";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { allowlistEntryKey, allowlistEntryLabel, allowlistHosts, type McpServerConfig } from "../service/mcp-allowlist.js";
import { introspectServer } from "../core/suite-introspect.js";
import { fillGeneratedToolEvals } from "../core/tool-evals.js";
import {
  asServerSurface,
  adoptSuiteNodes,
  buildDefaultSuiteNodes,
  catalogFingerprint,
  reconcileSuiteNodes,
  cloneNode,
  generatedLoadProfile,
  normalizeLoadProfile,
  type LoadProfile,
  type PromptCatalogEntry,
  type ResourceCatalogEntry,
  type ResourceTemplateEntry,
  type ServerSurface,
  type SuiteNode,
  type ToolCatalogEntry,
  type SurfaceLatency,
} from "../core/suite-model.js";
import { normalizeCallSlo, type CallSlo } from "../core/call-slo.js";
import { tidyPositions } from "../core/suite-graph.js";
import { forgetRunExports } from "../otel/local-collector.js";
import type { RunReport } from "../types/run.js";
import { swarmDataDir } from "../core/data-dirs.js";
import { aliasFromName, DEFAULT_SERVER, nodesForServer, usedServers } from "../core/servers.js";
import { suiteEnablesDestructive } from "../core/suite-compatibility.js";

export interface ProjectIndexRow {
  id: string;
  name: string;
  transport: string;
  allowlistKey: string;
  archived: boolean;
  lastVerdict?: "pass" | "fail";
  lastRunAt?: string;
  lastSuiteName?: string;
  suiteCount: number;
  toolCount: number;
  serverCount?: number;
}

export interface SuitePointer {
  id: string;
  name: string;
  currentVersion: number;
  createdAt: string;
  /** Server this suite exercises. Missing on projects saved before multi-server. */
  serverId?: string;
  /** Missing means enabled. A disabled suite stays in the project and is not run. */
  enabled?: boolean;
  /** Child version number to the version it was saved from. Version 1 has no parent. */
  basedOn?: Record<string, number>;
  /** Missing means local. `worker` hands runs to a connected worker instead of this process. */
  dispatch?: SuiteDispatch;
  /** Version numbers explicitly disabled from being executed again. */
  disabledVersions?: number[];
}

export type SuiteDispatch = "local" | "worker";

export interface SuiteVersionDocument {
  version: number;
  createdAt: string;
  name: string;
  nodes: SuiteNode[];
  load: LoadProfile;
  /** Suite objectives. A tool call can replace any field it sets. */
  slo?: CallSlo;
  /** Objectives over every tool call on one project server, by server id. */
  serverSlo?: Record<string, CallSlo>;
  /** Per-suite call-count and payload limits. Absent fields use the defaults. */
  limits?: SuiteLimitsInput;
  catalogFingerprint: string;
  /** Version this snapshot was saved from. Absent on version 1. */
  basedOn?: number;
  disabled?: boolean;
  changelog?: string;
  changelogStatus?: "pending" | "ready" | "fallback";
  changelogUpdatedAt?: string;
}

export interface SuiteVersionSummary {
  version: number;
  name: string;
  createdAt: string;
  basedOn?: number;
  disabled: boolean;
  changelog: string;
  changelogStatus: "pending" | "ready" | "fallback";
  stepCount: number;
  enabledStepCount: number;
  toolEvalCount: number;
  load: LoadProfile;
}

export interface ProjectServer {
  id: string;
  name: string;
  target: McpServerConfig;
  catalog: ToolCatalogEntry[];
  surface?: ProjectSurface;
  catalogAt?: string;
  introspectError?: string;
}

export interface ProjectSurface {
  serverName?: string;
  serverVersion?: string;
  /** Measured at the last introspection; sizes the load profile of suites generated from it. */
  latency?: SurfaceLatency;
  capabilities: string[];
  resources: ResourceCatalogEntry[];
  resourceTemplates: ResourceTemplateEntry[];
  prompts: PromptCatalogEntry[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  /** First server, kept so older readers still see a target. */
  allowlistKey: string;
  target: McpServerConfig;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  catalog: ToolCatalogEntry[];
  /** Primitives discovered with the first server's catalog. Tools stay on catalog. */
  surface?: ProjectSurface;
  catalogAt?: string;
  introspectError?: string;
  lastVerdict?: "pass" | "fail";
  lastRunAt?: string;
  /** Suite name of the newest run by start time. */
  lastSuiteName?: string;
  /** Every MCP server in this project. The first one is the server the project was created from. */
  servers?: ProjectServer[];
  suites: SuitePointer[];
}

export interface ProjectDetail extends ProjectRecord {
  versions: Record<string, SuiteVersionDocument>;
}

export interface RunSummary {
  id: string;
  startedAt: string;
  finishedAt: string;
  verdict: "pass" | "fail";
  durationMs: number;
  suiteId?: string;
  suiteVersion?: number;
  manifestName: string;
  mode?: RunReport["mode"];
}

const DEFAULT_DATA_DIR = swarmDataDir();

export interface ProjectStoreOptions {
  dataDir?: string;
  introspect?: (target: McpServerConfig) => Promise<ToolCatalogEntry[] | ServerSurface>;
  /** Write the project immediately and leave catalog empty until a later introspect. */
  skipIntrospect?: boolean;
}

function dir(options?: ProjectStoreOptions): string {
  return options?.dataDir ?? DEFAULT_DATA_DIR;
}

function projectsRoot(options?: ProjectStoreOptions): string {
  return join(dir(options), "projects");
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

function indexPath(options?: ProjectStoreOptions): string {
  return join(projectsRoot(options), "index.json");
}

async function loadIndex(options?: ProjectStoreOptions): Promise<ProjectIndexRow[]> {
  return (await readJson<ProjectIndexRow[]>(indexPath(options))) ?? [];
}

async function saveIndex(rows: ProjectIndexRow[], options?: ProjectStoreOptions): Promise<void> {
  await writeJson(indexPath(options), rows);
}

function projectPath(id: string, options?: ProjectStoreOptions): string {
  return join(projectsRoot(options), id, "project.json");
}

function versionPath(projectId: string, suiteId: string, version: number, options?: ProjectStoreOptions): string {
  return join(projectsRoot(options), projectId, "suites", suiteId, "versions", `${version}.json`);
}

function runsDir(projectId: string, options?: ProjectStoreOptions): string {
  return join(projectsRoot(options), projectId, "runs");
}

function toIndexRow(project: ProjectRecord): ProjectIndexRow {
  const servers = project.servers ?? [];
  const first = servers[0];
  return {
    id: project.id,
    name: project.name,
    transport: first?.target.transport ?? project.target.transport,
    allowlistKey: project.allowlistKey,
    archived: project.archived,
    lastVerdict: project.lastVerdict,
    lastRunAt: project.lastRunAt,
    lastSuiteName: project.lastSuiteName,
    suiteCount: project.suites.length,
    toolCount: servers.reduce((count, server) => count + server.catalog.length, 0) || project.catalog.length,
    serverCount: Math.max(1, servers.length),
  };
}

function mirrorPrimary(project: ProjectRecord): void {
  const first = project.servers?.[0];
  if (!first) return;
  project.target = first.target;
  project.catalog = first.catalog;
  project.surface = first.surface;
  project.catalogAt = first.catalogAt;
  project.introspectError = first.introspectError;
  project.allowlistKey = allowlistEntryKey(first.target);
}

/** Older projects stored one server on the project itself. Lift that into servers[]. */
export function normalizeProject(project: ProjectRecord): ProjectRecord {
  if (!project.servers?.length) {
    project.servers = [{
      id: "sv_primary",
      name: project.name,
      target: project.target,
      catalog: project.catalog ?? [],
      surface: project.surface,
      catalogAt: project.catalogAt,
      introspectError: project.introspectError,
    }];
  }
  const firstId = project.servers[0]!.id;
  for (const suite of project.suites) {
    if (!suite.serverId || !project.servers.some((server) => server.id === suite.serverId)) {
      suite.serverId = firstId;
    }
  }
  mirrorPrimary(project);
  return project;
}

export function serverForSuite(project: ProjectRecord, suite: { serverId?: string }): ProjectServer {
  const servers = normalizeProject(project).servers ?? [];
  return servers.find((server) => server.id === suite.serverId) ?? servers[0]!;
}

/** Readable aliases for a project's servers, from their names, stable in project order: `GitHub Prod` is `github-prod`. */
export function projectServerAliases(project: ProjectRecord): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const server of normalizeProject(project).servers ?? []) aliases.set(server.id, aliasFromName(server.name, aliases.values()));
  return aliases;
}

/** Project server ids on a suite's steps, so a step may also name a server by its name or alias. */
export function projectServerId(project: ProjectRecord, ref: string): string | null {
  const servers = normalizeProject(project).servers ?? [];
  const aliases = projectServerAliases(project);
  return servers.find((server) => server.id === ref || server.name === ref || aliases.get(server.id) === ref)?.id ?? null;
}

export interface ProjectSuiteServers {
  /** Alias of the suite's own server. `default` when the suite calls only that server. */
  defaultAlias: string;
  target: McpServerConfig;
  /** Other servers the suite's enabled steps call, by alias. */
  targets: Record<string, McpServerConfig>;
  /** Steps with project server ids replaced by aliases, ready to compile. */
  nodes: SuiteNode[];
  serverSlos: Record<string, CallSlo>;
  /** Host allowlist entries for every server the suite calls. */
  allowlist: string[];
  /** Tools of every server the suite calls; tagged with an alias when there is more than one. */
  catalog: Array<{ server?: string; name: string; schemaHash: string; writeLike: boolean }>;
  /** True when an enabled step calls a tool that is not called by default, on any server. */
  destructive: boolean;
  /** Project server ids by alias, for the servers the suite calls. */
  serverIds: Record<string, string>;
}

/**
 * The servers a project suite calls. Steps store project server ids; a run sees readable aliases. A suite
 * whose steps call only its own server compiles exactly as a single-server suite did.
 */
export function projectSuiteServers(
  project: ProjectRecord,
  pointer: { serverId?: string },
  version: { nodes: SuiteNode[]; serverSlo?: Record<string, CallSlo> },
): ProjectSuiteServers {
  const servers = normalizeProject(project).servers ?? [];
  const main = serverForSuite(project, pointer);
  const byId = new Map(servers.map((server) => [server.id, server]));
  const walk = (list: SuiteNode[]) => {
    for (const node of list) {
      if (node.server !== undefined && !byId.has(node.server)) throw new Error(`server_not_found: ${node.server}`);
      if (node.children) walk(node.children);
    }
  };
  walk(version.nodes);
  const used = usedServers(version.nodes, main.id);
  const multi = [...used].some((id) => id !== main.id);
  const aliases = multi ? projectServerAliases(project) : new Map([[main.id, DEFAULT_SERVER]]);
  const aliasOf = (id: string) => aliases.get(id) ?? id;
  const translate = (list: SuiteNode[]): SuiteNode[] => list.map((node) => {
    const { server, ...rest } = node;
    const next = server === undefined ? rest : server === main.id ? rest : { ...rest, server: aliasOf(server) };
    return node.children ? { ...next, children: translate(node.children) } : next;
  });
  const calls = [main.id, ...[...used].filter((id) => id !== main.id)];
  const defaultAlias = aliasOf(main.id);
  const targets = Object.fromEntries(calls.filter((id) => id !== main.id).map((id) => [aliasOf(id), byId.get(id)!.target]));
  const serverSlos = Object.fromEntries(Object.entries(version.serverSlo ?? {})
    .filter(([id]) => calls.includes(id))
    .map(([id, slo]) => [aliasOf(id), slo]));
  return {
    defaultAlias,
    target: main.target,
    targets,
    nodes: translate(version.nodes),
    serverSlos,
    allowlist: [...new Set(calls.flatMap((id) => projectAllowlistHosts(byId.get(id)!.target)))],
    catalog: calls.flatMap((id) => byId.get(id)!.catalog.map((tool) => ({
      ...(multi ? { server: aliasOf(id) } : {}),
      name: tool.name,
      schemaHash: tool.schemaHash,
      writeLike: tool.writeLike,
    }))),
    destructive: calls.some((id) => suiteEnablesDestructive(nodesForServer(version.nodes, id, main.id), byId.get(id)!.catalog)),
    serverIds: Object.fromEntries(calls.map((id) => [aliasOf(id), id])),
  };
}

async function upsertIndex(project: ProjectRecord, options?: ProjectStoreOptions): Promise<void> {
  const rows = await loadIndex(options);
  const next = rows.filter((row) => row.id !== project.id);
  next.push(toIndexRow(project));
  next.sort((a, b) => a.name.localeCompare(b.name));
  await saveIndex(next, options);
}

async function defaultIntrospect(target: McpServerConfig): Promise<ServerSurface> {
  return introspectServer(target);
}

function storedSurface(surface: ServerSurface): ProjectSurface {
  return {
    serverName: surface.serverName,
    serverVersion: surface.serverVersion,
    latency: surface.latency,
    capabilities: surface.capabilities,
    resources: surface.resources,
    resourceTemplates: surface.resourceTemplates,
    prompts: surface.prompts,
  };
}

function suiteSurface(catalog: ToolCatalogEntry[], surface?: ProjectRecord["surface"]): ServerSurface {
  return {
    serverName: surface?.serverName,
    serverVersion: surface?.serverVersion,
    capabilities: surface?.capabilities ?? (catalog.length > 0 ? ["tools"] : []),
    tools: catalog,
    resources: surface?.resources ?? [],
    resourceTemplates: surface?.resourceTemplates ?? [],
    prompts: surface?.prompts ?? [],
  };
}

async function writeSuiteVersion(
  project: ProjectRecord,
  suite: SuitePointer,
  doc: SuiteVersionDocument,
  options?: ProjectStoreOptions,
): Promise<void> {
  await writeJson(versionPath(project.id, suite.id, doc.version, options), doc);
  suite.currentVersion = doc.version;
  suite.name = doc.name;
}

export async function listProjects(options?: ProjectStoreOptions): Promise<ProjectIndexRow[]> {
  const rows = (await loadIndex(options)).filter((row) => !row.archived);
  await Promise.all(rows.map(async (row) => {
    if (row.lastSuiteName || !row.lastRunAt) return;
    const newest = (await listProjectRuns(row.id, options))[0];
    if (newest?.manifestName) row.lastSuiteName = newest.manifestName;
  }));
  return rows;
}

export async function listProjectsIncludingArchived(
  options?: ProjectStoreOptions,
): Promise<ProjectIndexRow[]> {
  return loadIndex(options);
}

async function loadRecord(id: string, options?: ProjectStoreOptions): Promise<ProjectRecord | null> {
  const project = await readJson<ProjectRecord>(projectPath(id, options));
  if (!project) return null;
  return normalizeProject(project);
}

export async function getProject(
  id: string,
  options?: ProjectStoreOptions,
): Promise<ProjectDetail | null> {
  const project = await loadRecord(id, options);
  if (!project) return null;
  const versions: Record<string, SuiteVersionDocument> = {};
  for (const suite of project.suites) {
    const doc = await readJson<SuiteVersionDocument>(
      versionPath(project.id, suite.id, suite.currentVersion, options),
    );
    if (doc) versions[suite.id] = withStoredSuite(doc);
  }
  return { ...project, versions };
}

async function fillCatalog(
  target: McpServerConfig,
  options?: ProjectStoreOptions,
): Promise<{ catalog: ToolCatalogEntry[]; surface?: ProjectRecord["surface"]; introspectError?: string }> {
  try {
    const introspect = options?.introspect ?? defaultIntrospect;
    const discovered = await introspect(target);
    const surface = Array.isArray(discovered) ? asServerSurface(discovered) : discovered;
    return { catalog: surface.tools, surface: storedSurface(surface) };
  } catch (error) {
    return {
      catalog: [],
      introspectError: error instanceof Error ? error.message : String(error),
    };
  }
}


function flattenSuiteNodes(nodes: SuiteNode[]): SuiteNode[] {
  const out: SuiteNode[] = [];
  const walk = (list: SuiteNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function summarizeNodesCounts(nodes: SuiteNode[]): { stepCount: number; enabledStepCount: number; toolCallCount: number; toolEvalCount: number } {
  const flat = flattenSuiteNodes(nodes);
  const samplers = flat.filter((n) => n.type !== "group" && n.type !== "loop");
  const enabledSamplers = samplers.filter((n) => n.enabled);
  const toolCalls = samplers.filter((n) => n.method === "tools/call");
  const toolEvalCount = flat.reduce((acc, n) => acc + (n.evals?.length ?? 0), 0);
  return {
    stepCount: samplers.length,
    enabledStepCount: enabledSamplers.length,
    toolCallCount: toolCalls.length,
    toolEvalCount,
  };
}

export function computeDeterministicSuiteChangelog(
  doc: SuiteVersionDocument,
  parent: SuiteVersionDocument | null | undefined,
): string {
  const counts = summarizeNodesCounts(doc.nodes);
  if (!parent || doc.version <= 1) {
    return `Initial suite v${doc.version} with ${counts.stepCount} steps (${counts.enabledStepCount} enabled, ${counts.toolCallCount} tool calls, ${counts.toolEvalCount} eval cases).`;
  }
  const parts: string[] = [];
  const prevFlat = flattenSuiteNodes(parent.nodes).filter((n) => n.type !== "group" && n.type !== "loop");
  const nextFlat = flattenSuiteNodes(doc.nodes).filter((n) => n.type !== "group" && n.type !== "loop");
  const prevById = new Map(prevFlat.map((n) => [n.id, n]));
  const nextById = new Map(nextFlat.map((n) => [n.id, n]));
  const added = nextFlat.filter((n) => !prevById.has(n.id)).map((n) => n.label || n.tool || n.method || n.id);
  const removed = prevFlat.filter((n) => !nextById.has(n.id)).map((n) => n.label || n.tool || n.method || n.id);
  if (added.length > 0) parts.push(`added ${added.length} step${added.length === 1 ? "" : "s"} (${added.slice(0, 4).join(", ")})`);
  if (removed.length > 0) parts.push(`removed ${removed.length} step${removed.length === 1 ? "" : "s"} (${removed.slice(0, 4).join(", ")})`);
  for (const nextNode of nextFlat) {
    const prevNode = prevById.get(nextNode.id);
    if (!prevNode) continue;
    const label = nextNode.label || nextNode.tool || nextNode.method || nextNode.id;
    if (prevNode.enabled !== nextNode.enabled) parts.push(`${nextNode.enabled ? "enabled" : "disabled"} ${label}`);
    if (JSON.stringify(prevNode.args ?? {}) !== JSON.stringify(nextNode.args ?? {})) parts.push(`updated args on ${label}`);
    if (JSON.stringify(prevNode.evals ?? []) !== JSON.stringify(nextNode.evals ?? [])) parts.push(`updated evals on ${label}`);
  }
  if (parts.length === 0) {
    return `Saved v${doc.version} from v${doc.basedOn ?? doc.version - 1} (${counts.enabledStepCount}/${counts.stepCount} steps enabled, ${counts.toolEvalCount} evals).`;
  }
  const s = parts.slice(0, 5).join("; ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

async function freshSuite(
  catalog: ToolCatalogEntry[],
  surface: ProjectSurface | undefined,
  serverId: string,
  name = "Smoke",
  nodes?: SuiteNode[],
): Promise<{ pointer: SuitePointer; version: SuiteVersionDocument }> {
  const now = new Date().toISOString();
  const pointer: SuitePointer = {
    id: `s_${randomUUID()}`,
    name,
    serverId,
    currentVersion: 1,
    createdAt: now,
  };
  const built = nodes ?? buildDefaultSuiteNodes(suiteSurface(catalog, surface));
  const finalNodes = nodes ? await fillGeneratedToolEvals(built, catalog) : tidyPositions(await fillGeneratedToolEvals(built, catalog));
  const version: SuiteVersionDocument = {
    version: 1,
    createdAt: now,
    name,
    nodes: finalNodes,
    load: generatedLoadProfile(built, surface?.latency),
    catalogFingerprint: catalogFingerprint(catalog),
  };
  version.changelog = computeDeterministicSuiteChangelog(version, null);
  version.changelogStatus = "ready";
  version.changelogUpdatedAt = now;
  return { pointer, version };
}

function makeServer(
  entry: McpServerConfig,
  filled: { catalog: ToolCatalogEntry[]; surface?: ProjectSurface; introspectError?: string },
  now: string,
): ProjectServer {
  return {
    id: `sv_${randomUUID()}`,
    name: allowlistEntryLabel(entry),
    target: entry,
    catalog: filled.catalog,
    surface: filled.surface,
    catalogAt: filled.introspectError ? undefined : now,
    introspectError: filled.introspectError,
  };
}

async function discover(
  entry: McpServerConfig,
  options?: ProjectStoreOptions,
): Promise<{ catalog: ToolCatalogEntry[]; surface?: ProjectSurface; introspectError?: string }> {
  if (options?.skipIntrospect) return { catalog: [] };
  return fillCatalog(entry, options);
}

/** Copy a verified master suite when one exists. Otherwise live-query the allowlisted server. */
export function seedFromKnownServer(
  name: string | undefined,
  entry: McpServerConfig,
  master: {
    target: McpServerConfig;
    nodes: SuiteNode[];
    catalog: ToolCatalogEntry[];
    surface?: ProjectSurface;
    introspectError?: string;
  } | null,
): {
  name?: string;
  server: McpServerConfig;
  suiteNodes?: SuiteNode[];
  catalog?: ToolCatalogEntry[];
  surface?: ProjectSurface;
} {
  if (master && !master.introspectError) {
    return {
      name,
      server: master.target,
      suiteNodes: master.nodes,
      catalog: master.catalog,
      surface: master.surface,
    };
  }
  return { name, server: entry };
}

export async function createProject(
  input: {
    name?: string;
    server: McpServerConfig;
    /** Master suite nodes from Servers. Copied into the project so later edits stay project-owned. */
    suiteNodes?: SuiteNode[];
    catalog?: ToolCatalogEntry[];
    surface?: ProjectSurface;
  },
  options?: ProjectStoreOptions,
): Promise<ProjectRecord> {
  const now = new Date().toISOString();
  const filled = input.catalog
    ? { catalog: input.catalog, surface: input.surface }
    : await discover(input.server, options);
  const server = makeServer(input.server, filled, now);
  const suite = await freshSuite(
    server.catalog,
    server.surface,
    server.id,
    "Smoke",
    input.suiteNodes ? adoptSuiteNodes(input.suiteNodes) : undefined,
  );
  const project: ProjectRecord = {
    id: `p_${randomUUID()}`,
    name: input.name?.trim() || allowlistEntryLabel(input.server),
    allowlistKey: allowlistEntryKey(input.server),
    target: input.server,
    archived: false,
    createdAt: now,
    updatedAt: now,
    catalog: server.catalog,
    surface: server.surface,
    catalogAt: server.catalogAt,
    introspectError: server.introspectError,
    servers: [server],
    suites: [suite.pointer],
  };
  await writeJson(projectPath(project.id, options), project);
  await writeSuiteVersion(project, suite.pointer, suite.version, options);
  await writeJson(projectPath(project.id, options), project);
  await upsertIndex(project, options);
  return project;
}

export async function createProjectForServer(
  entry: McpServerConfig,
  options?: ProjectStoreOptions,
): Promise<ProjectRecord> {
  return createProject({ server: entry }, options);
}

export async function addServerToProject(
  projectId: string,
  entry: McpServerConfig,
  options?: ProjectStoreOptions & { generateSuite?: boolean },
): Promise<ProjectRecord | null> {
  const project = await loadRecord(projectId, options);
  if (!project || project.archived) return null;
  const key = allowlistEntryKey(entry);
  if ((project.servers ?? []).some((server) => allowlistEntryKey(server.target) === key)) {
    throw new Error("duplicate_server");
  }
  const now = new Date().toISOString();
  const generateSuite = options?.generateSuite !== false;
  const filled = generateSuite ? await discover(entry, options) : { catalog: [] as ToolCatalogEntry[] };
  const server = makeServer(entry, filled, now);
  project.servers = [...(project.servers ?? []), server];
  if (generateSuite) {
    const suite = await freshSuite(server.catalog, server.surface, server.id, `Smoke · ${server.name}`);
    project.suites = [...project.suites, suite.pointer];
    await writeSuiteVersion(project, suite.pointer, suite.version, options);
  }
  project.updatedAt = now;
  mirrorPrimary(project);
  await writeJson(projectPath(project.id, options), project);
  await upsertIndex(project, options);
  return project;
}

export async function archiveProject(id: string, options?: ProjectStoreOptions): Promise<void> {
  const project = await loadRecord(id, options);
  if (!project || project.archived) return;
  project.archived = true;
  project.updatedAt = new Date().toISOString();
  await writeJson(projectPath(project.id, options), project);
  await upsertIndex(project, options);
}

/** Remove the project directory (suites, versions, stored runs) and its index row. */
export async function deleteProject(id: string, options?: ProjectStoreOptions): Promise<boolean> {
  if (!/^p_[0-9a-f-]{36}$/i.test(id)) return false;
  const root = resolve(projectsRoot(options));
  const dir = resolve(root, id);
  if (dir !== `${root}/${id}`) return false;
  const project = await loadRecord(id, options);
  if (!project) return false;
  const runs = await listProjectRuns(id, options);
  await rm(dir, { recursive: true, force: true });
  await Promise.all(runs.map((run) => forgetRunExports(run.id)));
  const rows = (await loadIndex(options)).filter((row) => row.id !== id);
  await saveIndex(rows, options);
  return true;
}

export async function reintrospectProject(
  id: string,
  options?: ProjectStoreOptions & { serverId?: string },
): Promise<ProjectRecord | null> {
  const project = await loadRecord(id, options);
  if (!project || project.archived) return null;
  const server = options?.serverId
    ? project.servers?.find((item) => item.id === options.serverId)
    : project.servers?.[0];
  if (!server) return null;
  const filled = await fillCatalog(server.target, options);
  project.updatedAt = new Date().toISOString();
  if (filled.introspectError) {
    server.introspectError = filled.introspectError;
  } else {
    server.catalog = filled.catalog;
    server.surface = filled.surface;
    server.catalogAt = project.updatedAt;
    server.introspectError = undefined;
    await replaceUntouchedStubSuite(project, server, options);
  }
  mirrorPrimary(project);
  await writeJson(projectPath(project.id, options), project);
  await upsertIndex(project, options);
  return project;
}

async function replaceUntouchedStubSuite(
  project: ProjectRecord,
  server: ProjectServer,
  options?: ProjectStoreOptions,
): Promise<void> {
  const surface = suiteSurface(server.catalog, server.surface);
  if (surface.tools.length === 0 && surface.resources.length === 0 && surface.prompts.length === 0) return;
  const emptyFingerprint = catalogFingerprint([]);
  for (const suite of project.suites) {
    if (suite.serverId !== server.id || suite.currentVersion !== 1) continue;
    const doc = await readJson<SuiteVersionDocument>(versionPath(project.id, suite.id, 1, options));
    if (!doc || doc.catalogFingerprint !== emptyFingerprint) continue;
    doc.nodes = tidyPositions(await fillGeneratedToolEvals(buildDefaultSuiteNodes(surface), server.catalog));
    doc.load = generatedLoadProfile(doc.nodes, server.surface?.latency);
    doc.catalogFingerprint = catalogFingerprint(server.catalog);
    await writeSuiteVersion(project, suite, doc, options);
  }
}

export async function renameProject(
  projectId: string,
  name: string,
  options?: ProjectStoreOptions,
): Promise<ProjectRecord | null> {
  const project = await loadRecord(projectId, options);
  if (!project || project.archived) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  project.name = trimmed;
  project.updatedAt = new Date().toISOString();
  await writeJson(projectPath(project.id, options), project);
  await upsertIndex(project, options);
  return project;
}

function sameServerTarget(left: McpServerConfig, right: McpServerConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Write the next version of every suite that runs against this server. */
async function applyServerCatalogToSuites(
  project: ProjectRecord,
  server: ProjectServer,
  options?: ProjectStoreOptions,
): Promise<void> {
  const surface = suiteSurface(server.catalog, server.surface);
  const fingerprint = catalogFingerprint(server.catalog);
  for (const suite of project.suites) {
    if (suite.serverId !== server.id) continue;
    const doc = await readJson<SuiteVersionDocument>(versionPath(project.id, suite.id, suite.currentVersion, options));
    if (!doc || doc.catalogFingerprint === fingerprint) continue;
    const version = suite.currentVersion + 1;
    suite.basedOn = { ...suite.basedOn, [String(version)]: suite.currentVersion };
    await writeSuiteVersion(project, suite, {
      version,
      createdAt: project.updatedAt,
      name: doc.name,
      nodes: tidyPositions(await fillGeneratedToolEvals(reconcileSuiteNodes(doc.nodes, surface), server.catalog)),
      load: normalizeLoadProfile(doc.load),
      slo: normalizeCallSlo(doc.slo),
      catalogFingerprint: fingerprint,
      basedOn: suite.currentVersion,
    }, options);
  }
}

export async function updateProjectServer(
  projectId: string,
  serverId: string,
  input: { name?: string; target?: McpServerConfig },
  options?: ProjectStoreOptions,
): Promise<ProjectRecord | null> {
  const project = await loadRecord(projectId, options);
  if (!project || project.archived) return null;
  const server = project.servers?.find((item) => item.id === serverId);
  if (!server) return null;
  const trimmed = input.name?.trim();
  if (trimmed) server.name = trimmed;
  const targetChanged = Boolean(input.target && !sameServerTarget(server.target, input.target));
  if (input.target && targetChanged) server.target = input.target;
  project.updatedAt = new Date().toISOString();
  if (targetChanged) {
    const filled = await fillCatalog(server.target, options);
    if (filled.introspectError) {
      server.introspectError = filled.introspectError;
    } else {
      server.catalog = filled.catalog;
      server.surface = filled.surface;
      server.catalogAt = project.updatedAt;
      server.introspectError = undefined;
      await applyServerCatalogToSuites(project, server, options);
    }
  }
  mirrorPrimary(project);
  await writeJson(projectPath(project.id, options), project);
  await upsertIndex(project, options);
  return project;
}

function uniqueSuiteName(project: ProjectRecord, base: string): string {
  const names = new Set(project.suites.map((suite) => suite.name));
  const trimmed = base.trim() || "Suite";
  if (!names.has(trimmed)) return trimmed;
  let n = 2;
  while (names.has(`${trimmed} ${n}`)) n += 1;
  return `${trimmed} ${n}`;
}

export async function addSuiteToProject(
  projectId: string,
  input: { serverId?: string; name?: string } = {},
  options?: ProjectStoreOptions,
): Promise<SuitePointer | null> {
  const project = await loadRecord(projectId, options);
  if (!project || project.archived || !project.servers?.length) return null;
  const server = input.serverId
    ? project.servers.find((item) => item.id === input.serverId)
    : project.servers[0];
  if (!server) return null;
  const suite = await freshSuite(
    server.catalog,
    server.surface,
    server.id,
    uniqueSuiteName(project, input.name?.trim() || "Suite"),
  );
  project.suites.push(suite.pointer);
  project.updatedAt = suite.pointer.createdAt;
  await writeSuiteVersion(project, suite.pointer, suite.version, options);
  await writeJson(projectPath(project.id, options), project);
  await upsertIndex(project, options);
  return suite.pointer;
}

export async function loadSuiteVersion(
  projectId: string,
  suiteId: string,
  version: number,
  options?: ProjectStoreOptions,
): Promise<SuiteVersionDocument | null> {
  const project = await loadRecord(projectId, options);
  if (!project || project.archived) return null;
  const suite = project.suites.find((item) => item.id === suiteId);
  if (!suite || version < 1 || version > suite.currentVersion) return null;
  const doc = await readJson<SuiteVersionDocument>(versionPath(projectId, suiteId, version, options));
  if (!doc) return null;
  if (suite.disabledVersions?.includes(version)) doc.disabled = true;
  if (!doc.changelog) {
    const parentVer = doc.basedOn ?? (version > 1 ? version - 1 : undefined);
    const parentDoc = parentVer ? await readJson<SuiteVersionDocument>(versionPath(projectId, suiteId, parentVer, options)) : null;
    doc.changelog = computeDeterministicSuiteChangelog(doc, parentDoc);
    doc.changelogStatus = "fallback";
  }
  return withStoredSuite(doc);
}

function withStoredSuite(doc: SuiteVersionDocument): SuiteVersionDocument {
  return { ...doc, load: normalizeLoadProfile(doc.load), slo: normalizeCallSlo(doc.slo) };
}

export async function saveSuiteVersion(
  projectId: string,
  suiteId: string,
  input: { name?: string; nodes: SuiteNode[]; load: LoadProfile; basedOn?: number; slo?: CallSlo | null; serverSlo?: Record<string, CallSlo> | null; limits?: SuiteLimitsInput | null },
  options?: ProjectStoreOptions,
): Promise<SuiteVersionDocument | null> {
  const project = await loadRecord(projectId, options);
  if (!project || project.archived) return null;
  const suite = project.suites.find((item) => item.id === suiteId);
  if (!suite) return null;
  const server = serverForSuite(project, suite);
  const version = suite.currentVersion + 1;
  const requestedParent = input.basedOn;
  const basedOn = Number.isInteger(requestedParent) && requestedParent! >= 1 && requestedParent! <= suite.currentVersion
    ? requestedParent!
    : suite.currentVersion;
  suite.basedOn = { ...suite.basedOn, [String(version)]: basedOn };
  const parent = await loadSuiteVersion(projectId, suiteId, basedOn, options);
  const slo = input.slo === undefined ? parent?.slo : normalizeCallSlo(input.slo);
  const serverSlo = input.serverSlo === undefined ? parent?.serverSlo : Object.fromEntries(Object.entries(input.serverSlo ?? {})
    .map(([id, value]) => [id, normalizeCallSlo(value)] as const)
    .filter((entry): entry is readonly [string, CallSlo] => entry[1] !== undefined));
  const limits = input.limits === undefined ? parent?.limits : input.limits === null ? undefined : SuiteLimitsSchema.parse(input.limits);
  const hasLimits = limits && Object.keys(limits).length > 0;
  const doc: SuiteVersionDocument = {
    version,
    createdAt: new Date().toISOString(),
    name: input.name?.trim() || suite.name,
    nodes: input.nodes,
    load: input.load,
    ...(slo ? { slo } : {}),
    ...(serverSlo && Object.keys(serverSlo).length > 0 ? { serverSlo } : {}),
    ...(hasLimits ? { limits } : {}),
    catalogFingerprint: catalogFingerprint(server.catalog),
    basedOn,
  };
  doc.changelog = computeDeterministicSuiteChangelog(doc, parent);
  doc.changelogStatus = "fallback";
  doc.changelogUpdatedAt = doc.createdAt;
  await writeSuiteVersion(project, suite, doc, options);
  project.updatedAt = doc.createdAt;
  await writeJson(projectPath(project.id, options), project);
  await upsertIndex(project, options);
  return doc;
}


export async function listSuiteVersions(
  projectId: string,
  suiteId: string,
  options?: ProjectStoreOptions,
): Promise<SuiteVersionSummary[]> {
  const project = await loadRecord(projectId, options);
  if (!project || project.archived) return [];
  const suite = project.suites.find((item) => item.id === suiteId);
  if (!suite) return [];
  const disabledSet = new Set(suite.disabledVersions ?? []);
  const rawDocs = await Promise.all(
    Array.from({ length: suite.currentVersion }, (_, idx) =>
      readJson<SuiteVersionDocument>(versionPath(projectId, suiteId, idx + 1, options)),
    ),
  );
  const byVersion = new Map<number, SuiteVersionDocument>();
  for (const d of rawDocs) {
    if (d) byVersion.set(d.version, d);
  }
  const summaries: SuiteVersionSummary[] = [];
  for (let v = suite.currentVersion; v >= 1; v--) {
    const doc = byVersion.get(v);
    if (!doc) continue;
    const parentVer = doc.basedOn ?? suite.basedOn?.[String(v)] ?? (v > 1 ? v - 1 : undefined);
    const parentDoc = parentVer ? byVersion.get(parentVer) ?? null : null;
    const changelog = doc.changelog || computeDeterministicSuiteChangelog(doc, parentDoc);
    const counts = summarizeNodesCounts(doc.nodes ?? []);
    summaries.push({
      version: doc.version,
      name: doc.name || suite.name,
      createdAt: doc.createdAt,
      ...(parentVer ? { basedOn: parentVer } : {}),
      disabled: Boolean(doc.disabled || disabledSet.has(doc.version)),
      changelog,
      changelogStatus: doc.changelogStatus ?? "fallback",
      stepCount: counts.stepCount,
      enabledStepCount: counts.enabledStepCount,
      toolEvalCount: counts.toolEvalCount,
      load: normalizeLoadProfile(doc.load),
    });
  }
  return summaries;
}

export async function setSuiteVersionDisabled(
  projectId: string,
  suiteId: string,
  version: number,
  disabled: boolean,
  options?: ProjectStoreOptions,
): Promise<SuiteVersionDocument | null> {
  const project = await loadRecord(projectId, options);
  if (!project || project.archived) return null;
  const suite = project.suites.find((item) => item.id === suiteId);
  if (!suite || version < 1 || version > suite.currentVersion) return null;
  const vPath = versionPath(projectId, suiteId, version, options);
  const doc = await readJson<SuiteVersionDocument>(vPath);
  if (!doc) return null;
  if (disabled) {
    doc.disabled = true;
    const set = new Set(suite.disabledVersions ?? []);
    set.add(version);
    suite.disabledVersions = [...set].sort((a, b) => a - b);
  } else {
    delete doc.disabled;
    const next = (suite.disabledVersions ?? []).filter((v) => v !== version);
    if (next.length > 0) suite.disabledVersions = next;
    else delete suite.disabledVersions;
  }
  project.updatedAt = new Date().toISOString();
  await writeJson(vPath, doc);
  await writeJson(projectPath(project.id, options), project);
  await upsertIndex(project, options);
  return withStoredSuite(doc);
}

export function suiteIsEnabled(suite: { enabled?: boolean }): boolean {
  return suite.enabled !== false;
}

export async function setSuiteEnabled(
  projectId: string,
  suiteId: string,
  enabled: boolean,
  options?: ProjectStoreOptions,
): Promise<SuitePointer | null> {
  const project = await loadRecord(projectId, options);
  if (!project || project.archived) return null;
  const suite = project.suites.find((item) => item.id === suiteId);
  if (!suite) return null;
  suite.enabled = enabled;
  project.updatedAt = new Date().toISOString();
  await writeJson(projectPath(project.id, options), project);
  await upsertIndex(project, options);
  return suite;
}

export async function setSuiteDispatch(
  projectId: string,
  suiteId: string,
  dispatch: SuiteDispatch,
  options?: ProjectStoreOptions,
): Promise<SuitePointer | null> {
  const project = await loadRecord(projectId, options);
  if (!project || project.archived) return null;
  const suite = project.suites.find((item) => item.id === suiteId);
  if (!suite) return null;
  if (dispatch === "worker") suite.dispatch = "worker";
  else delete suite.dispatch;
  project.updatedAt = new Date().toISOString();
  await writeJson(projectPath(project.id, options), project);
  await upsertIndex(project, options);
  return suite;
}

export async function removeSuite(
  projectId: string,
  suiteId: string,
  options?: ProjectStoreOptions,
): Promise<"ok" | "not_found" | "last_suite"> {
  const project = await loadRecord(projectId, options);
  if (!project || project.archived) return "not_found";
  if (!project.suites.some((item) => item.id === suiteId)) return "not_found";
  if (project.suites.length <= 1) return "last_suite";
  project.suites = project.suites.filter((item) => item.id !== suiteId);
  project.updatedAt = new Date().toISOString();
  await writeJson(projectPath(project.id, options), project);
  await upsertIndex(project, options);
  return "ok";
}

export async function cloneSuite(
  projectId: string,
  suiteId: string,
  options?: ProjectStoreOptions,
): Promise<SuitePointer | null> {
  const detail = await getProject(projectId, options);
  if (!detail || detail.archived) return null;
  const source = detail.versions[suiteId];
  const sourcePointer = detail.suites.find((item) => item.id === suiteId);
  if (!source || !sourcePointer) return null;
  const now = new Date().toISOString();
  const server = serverForSuite(detail, sourcePointer);
  const pointer: SuitePointer = {
    id: `s_${randomUUID()}`,
    name: `${sourcePointer.name} copy`,
    serverId: server.id,
    currentVersion: 1,
    createdAt: now,
  };
  const doc: SuiteVersionDocument = {
    version: 1,
    createdAt: now,
    name: pointer.name,
    nodes: source.nodes.map((node) => cloneNode(node)),
    load: { ...source.load },
    catalogFingerprint: catalogFingerprint(server.catalog),
  };
  const { versions: _versions, ...rest } = detail;
  const record: ProjectRecord = {
    ...rest,
    updatedAt: now,
    suites: [...detail.suites, pointer],
  };
  await writeSuiteVersion(record, pointer, doc, options);
  await writeJson(projectPath(record.id, options), record);
  await upsertIndex(record, options);
  return pointer;
}

function rememberLatestRun(project: ProjectRecord, newest: RunSummary | undefined): void {
  project.lastVerdict = newest?.verdict;
  project.lastRunAt = newest?.finishedAt;
  project.lastSuiteName = newest?.manifestName || undefined;
}

export async function saveProjectRun(
  projectId: string,
  report: RunReport,
  options?: ProjectStoreOptions,
): Promise<void> {
  await writeJson(join(runsDir(projectId, options), `${report.id}.json`), report);
  const project = await loadRecord(projectId, options);
  if (!project) return;
  rememberLatestRun(project, (await listProjectRuns(projectId, options))[0]);
  project.updatedAt = report.finishedAt;
  await writeJson(projectPath(project.id, options), project);
  await upsertIndex(project, options);
}

export async function listProjectRuns(
  projectId: string,
  options?: ProjectStoreOptions,
): Promise<RunSummary[]> {
  let names: string[] = [];
  try {
    names = await readdir(runsDir(projectId, options));
  } catch {
    return [];
  }
  const runs: RunSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const report = await readJson<RunReport>(join(runsDir(projectId, options), name));
    if (!report) continue;
    runs.push({
      id: report.id,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      verdict: report.verdict,
      durationMs: report.durationMs,
      suiteId: report.suiteId,
      suiteVersion: report.suiteVersion,
      manifestName: report.manifestName,
      mode: report.mode,
    });
  }
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return runs;
}

export async function loadProjectRun(
  projectId: string,
  runId: string,
  options?: ProjectStoreOptions,
): Promise<RunReport | null> {
  return readJson<RunReport>(join(runsDir(projectId, options), `${runId}.json`));
}

/** Remove one stored execution and point the project at the newest run that remains. */
export async function deleteProjectRun(
  projectId: string,
  runId: string,
  options?: ProjectStoreOptions,
): Promise<boolean> {
  if (!/^p_[0-9a-f-]{36}$/i.test(projectId)) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(runId)) return false;
  const project = await loadRecord(projectId, options);
  if (!project || project.archived) return false;
  const file = join(runsDir(projectId, options), `${runId}.json`);
  const report = await readJson<RunReport>(file);
  if (!report || report.id !== runId) return false;
  await rm(file, { force: true });
  await forgetRunExports(runId);
  rememberLatestRun(project, (await listProjectRuns(projectId, options))[0]);
  project.updatedAt = new Date().toISOString();
  await writeJson(projectPath(project.id, options), project);
  await upsertIndex(project, options);
  return true;
}

/** Delete saved executions whose finish time is older than `ttlMs`. */
export async function expireProjectRuns(
  ttlMs: number,
  options?: ProjectStoreOptions,
  now = Date.now(),
): Promise<string[]> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return [];
  const removed: string[] = [];
  for (const row of await loadIndex(options)) {
    const runs = await listProjectRuns(row.id, options);
    for (const run of runs) {
      const finished = Date.parse(run.finishedAt);
      if (!Number.isFinite(finished) || now - finished < ttlMs) continue;
      if (await deleteProjectRun(row.id, run.id, options)) removed.push(run.id);
    }
  }
  return removed;
}

export async function listSavedRunIds(options?: ProjectStoreOptions): Promise<string[]> {
  const ids: string[] = [];
  for (const row of await loadIndex(options)) {
    for (const run of await listProjectRuns(row.id, options)) ids.push(run.id);
  }
  return ids;
}

export function projectAllowlistHosts(target: McpServerConfig): string[] {
  return allowlistHosts([target]);
}
