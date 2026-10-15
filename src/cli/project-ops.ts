import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compareRuns } from "../engine/core/compare.js";
import { followSuiteRun, startSuiteRun } from "../engine/core/project-run.js";
import {
  blankSuiteNode,
  cloneNode,
  compileSuite,
  deleteNode,
  insertNode,
  moveNode,
  updateNode,
  type LoadProfile,
  SAMPLER_METHODS,
  type SamplerMethod,
  type SuiteNode,
  type SuiteNodeType,
} from "../engine/core/suite-model.js";
import {
  allowlistEntryLabel,
  isMcpServerConfig,
  parseAllowlistEntryJson,
  type McpServerConfig,
} from "../engine/service/mcp-allowlist.js";
import { LoadProfileSchema } from "../engine/types/manifest.js";
import { normalizeCallSlo, type CallSlo } from "../engine/core/call-slo.js";
import { nodeTakesServer, usedServers } from "../engine/core/servers.js";
import type { CompareReport, RunProgressEvent, RunReport } from "../engine/types/run.js";
import {
  addServerToProject,
  archiveProject,
  createProject,
  getProject,
  listProjectRuns,
  listProjects,
  listProjectsIncludingArchived,
  loadProjectRun,
  addSuiteToProject,
  projectServerId,
  projectSuiteServers,
  reintrospectProject,
  removeSuite,
  renameProject,
  saveSuiteVersion,
  setSuiteEnabled,
  updateProjectServer,
  cloneSuite,
  type ProjectDetail,
  type ProjectIndexRow,
  type ProjectStoreOptions,
  type SuitePointer,
  type SuiteVersionDocument,
} from "../engine/store/project-store.js";

const NODE_TYPES = new Set<SuiteNodeType>(["sampler", "think", "extractor", "loop", "group"]);
const METHODS = new Set<SamplerMethod>(SAMPLER_METHODS);

export async function resolveProject(ref: string, options?: ProjectStoreOptions): Promise<ProjectDetail> {
  const rows = await listProjectsIncludingArchived(options);
  const match = rows.find((row) => row.id === ref || row.name === ref || row.allowlistKey === ref);
  if (!match) throw new Error(`project_not_found: ${ref}`);
  const detail = await getProject(match.id, options);
  if (!detail) throw new Error(`project_not_found: ${ref}`);
  return detail;
}

export function resolveSuite(project: ProjectDetail, ref?: string): SuitePointer {
  const suite = ref
    ? project.suites.find((item) => item.id === ref || item.name === ref)
    : project.suites[0];
  if (!suite) throw new Error(ref ? `suite_not_found: ${ref}` : "suite_not_found");
  return suite;
}

export function currentVersion(project: ProjectDetail, suite: SuitePointer): SuiteVersionDocument {
  const version = project.versions[suite.id];
  if (!version) throw new Error(`suite_version_missing: ${suite.id}`);
  return version;
}

export async function listProjectRows(options?: ProjectStoreOptions & { all?: boolean }): Promise<ProjectIndexRow[]> {
  return options?.all ? listProjectsIncludingArchived(options) : listProjects(options);
}

export function formatProjectList(rows: ProjectIndexRow[]): string {
  if (rows.length === 0) return "No projects.";
  const header = ["ID", "NAME", "SERVERS", "TRANSPORT", "TOOLS", "SUITES", "VERDICT", "LAST RUN"].join("\t");
  const lines = rows.map((row) =>
    [row.id, row.name, row.serverCount ?? 1, row.transport, row.toolCount, row.suiteCount, row.lastVerdict ?? "none", row.lastRunAt ?? ""].join("\t"),
  );
  return [header, ...lines].join("\n");
}

export function formatSuiteTree(nodes: SuiteNode[], indent = 0): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const bits = [node.label ?? node.type, node.type];
    if (node.method) bits.push(node.method);
    if (node.tool) bits.push(node.tool);
    if (!node.enabled) bits.push("disabled");
    lines.push(`${"  ".repeat(indent)}- ${bits.join(" · ")} [${node.id}]`);
    if (node.children?.length) lines.push(formatSuiteTree(node.children, indent + 1));
  }
  return lines.join("\n");
}

export function formatProjectShow(project: ProjectDetail): string {
  const lines = [
    `${project.name} (${project.id})`,
    `archived: ${project.archived ? "yes" : "no"}`,
    `last verdict: ${project.lastVerdict ?? "none"}`,
    "",
    "Servers:",
    ...(project.servers ?? []).map(
      (server) =>
        `  ${server.name} (${server.id}) ${server.target.transport}${server.introspectError ? ` — ${server.introspectError}` : ""} · ${server.catalog.length} tools`,
    ),
    "",
    "Catalog:",
    ...(project.servers ?? []).flatMap((server) =>
      server.catalog.map(
        (tool) => `  ${server.name}: ${tool.name}${tool.writeLike ? " (write, disabled in the default suite)" : ""} ${tool.schemaHash}`,
      ),
    ),
    project.surface
      ? `Primitives: ${project.surface.capabilities.join(", ") || "none"} · resources ${project.surface.resources.length} · prompts ${project.surface.prompts.length}`
      : "",
    "",
    "Suites:",
  ];
  for (const suite of project.suites) {
    const version = project.versions[suite.id];
    const serverName = project.servers?.find((server) => server.id === suite.serverId)?.name ?? "";
    const others = version ? [...usedServers(version.nodes, suite.serverId ?? "")].filter((id) => id !== suite.serverId)
      .map((id) => project.servers?.find((server) => server.id === id)?.name ?? id) : [];
    const parent = suite.basedOn?.[String(suite.currentVersion)] ?? version?.basedOn;
    lines.push(`  ${suite.name} v${suite.currentVersion} (${suite.id})${parent ? ` · from v${parent}` : ""}${serverName ? ` · ${serverName}` : ""}${others.length > 0 ? ` + ${others.join(", ")}` : ""}${suite.enabled === false ? " · disabled" : ""}`);
    if (version) {
      const load = version.load;
      lines.push(
        `    load: duration ${load.durationMs}ms, ramp ${load.rampUpMs}ms, concurrency ${load.maxConcurrency}, jitter ${load.jitterMs}ms, ramp-down ${load.rampDownMs}ms, dwell ${load.dwellMs ?? 0}ms, iterations ${load.iterations ?? 10}`,
      );
      lines.push(formatSuiteTree(version.nodes, 2));
    }
  }
  return lines.filter((line) => line !== "").join("\n");
}

/** Compiles a suite tree against every server its steps call, so a bad edit fails before it is saved. */
function compileProjectNodes(
  project: ProjectDetail,
  suite: SuitePointer,
  nodes: SuiteNode[],
  load: LoadProfile,
  version: { name: string; slo?: SuiteVersionDocument["slo"]; serverSlo?: SuiteVersionDocument["serverSlo"] },
): void {
  const servers = projectSuiteServers(project, suite, { nodes, serverSlo: version.serverSlo });
  compileSuite({
    name: version.name,
    target: servers.target,
    targets: servers.targets,
    defaultServer: servers.defaultAlias,
    serverSlos: servers.serverSlos,
    allowlist: servers.allowlist,
    nodes: servers.nodes,
    load,
    slo: version.slo,
  });
}

/** A project server named by id, name, or alias, as stored on steps: its id. */
function stepServerId(project: ProjectDetail, ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  const id = projectServerId(project, ref);
  if (!id) throw new Error(`server_not_found: ${ref}`);
  return id;
}

/** Sets or clears one project server's objective on a suite, as a new version. */
export async function setSuiteServerSlo(
  projectRef: string,
  serverRef: string,
  slo: CallSlo | undefined,
  suiteRef?: string,
  options?: ProjectStoreOptions,
): Promise<SuiteVersionDocument> {
  const project = await resolveProject(projectRef, options);
  const suite = resolveSuite(project, suiteRef);
  const version = currentVersion(project, suite);
  const id = stepServerId(project, serverRef)!;
  const { [id]: _old, ...rest } = version.serverSlo ?? {};
  const next = normalizeCallSlo(slo);
  const saved = await saveSuiteVersion(project.id, suite.id, {
    name: version.name,
    nodes: version.nodes,
    load: version.load,
    slo: version.slo ?? null,
    serverSlo: next ? { ...rest, [id]: next } : rest,
    basedOn: version.version,
  }, options);
  if (!saved) throw new Error("suite_not_found");
  return saved;
}

async function persistSuite(
  project: ProjectDetail,
  suite: SuitePointer,
  version: SuiteVersionDocument,
  nodes: SuiteNode[],
  load: LoadProfile,
  options?: ProjectStoreOptions,
): Promise<SuiteVersionDocument> {
  compileProjectNodes(project, suite, nodes, load, version);
  const saved = await saveSuiteVersion(project.id, suite.id, {
    name: version.name,
    nodes,
    load,
    slo: version.slo ?? null,
    basedOn: version.version,
  }, options);
  if (!saved) throw new Error("suite_not_found");
  return saved;
}

export async function addSuiteNode(
  projectRef: string,
  input: {
    suite?: string;
    type: string;
    parent?: string;
    method?: string;
    tool?: string;
    label?: string;
    thinkMs?: number;
    iterations?: number;
    variable?: string;
    path?: string;
    args?: Record<string, unknown>;
    /** Project server id, name, or alias the step calls. */
    server?: string;
    required?: boolean;
  },
  options?: ProjectStoreOptions,
): Promise<SuiteVersionDocument> {
  if (!NODE_TYPES.has(input.type as SuiteNodeType)) throw new Error(`unknown_node_type: ${input.type}`);
  const project = await resolveProject(projectRef, options);
  const suite = resolveSuite(project, input.suite);
  const version = currentVersion(project, suite);
  const node = blankSuiteNode(input.type as SuiteNodeType);
  if (input.label) node.label = input.label;
  if (input.method) {
    if (!METHODS.has(input.method as SamplerMethod)) throw new Error(`unknown_method: ${input.method}`);
    node.method = input.method as SamplerMethod;
  }
  if (input.tool) node.tool = input.tool;
  if (input.thinkMs !== undefined) node.thinkMs = input.thinkMs;
  if (input.iterations !== undefined) node.iterations = input.iterations;
  if (input.variable) node.variable = input.variable;
  if (input.path) node.path = input.path;
  if (input.args) node.args = input.args;
  if (input.server !== undefined) {
    if (!nodeTakesServer(node)) throw new Error("server_not_allowed: extractors and think steps call no server");
    node.server = stepServerId(project, input.server);
  }
  if (input.required !== undefined) {
    if (node.type !== "extractor") throw new Error("required_not_allowed: only extractors take --required");
    node.required = input.required;
  }
  const nodes = insertNode(version.nodes, node, input.parent);
  return persistSuite(project, suite, version, nodes, version.load, options);
}

export async function cloneSuiteNode(
  projectRef: string,
  nodeId: string,
  suiteRef?: string,
  options?: ProjectStoreOptions,
): Promise<SuiteVersionDocument> {
  const project = await resolveProject(projectRef, options);
  const suite = resolveSuite(project, suiteRef);
  const version = currentVersion(project, suite);
  const source = findInTree(version.nodes, nodeId);
  if (!source) throw new Error(`node_not_found: ${nodeId}`);
  return persistSuite(project, suite, version, insertNode(version.nodes, cloneNode(source)), version.load, options);
}

export async function deleteSuiteNode(
  projectRef: string,
  nodeId: string,
  suiteRef?: string,
  options?: ProjectStoreOptions,
): Promise<SuiteVersionDocument> {
  const project = await resolveProject(projectRef, options);
  const suite = resolveSuite(project, suiteRef);
  const version = currentVersion(project, suite);
  if (!findInTree(version.nodes, nodeId)) throw new Error(`node_not_found: ${nodeId}`);
  return persistSuite(project, suite, version, deleteNode(version.nodes, nodeId), version.load, options);
}

export async function setSuiteNode(
  projectRef: string,
  nodeId: string,
  patch: Partial<SuiteNode>,
  suiteRef?: string,
  options?: ProjectStoreOptions,
): Promise<SuiteVersionDocument> {
  const project = await resolveProject(projectRef, options);
  const suite = resolveSuite(project, suiteRef);
  const version = currentVersion(project, suite);
  if (!findInTree(version.nodes, nodeId)) throw new Error(`node_not_found: ${nodeId}`);
  if (patch.method && !METHODS.has(patch.method)) throw new Error(`unknown_method: ${patch.method}`);
  const { server, ...others } = patch;
  const defined = Object.fromEntries(Object.entries(others).filter((entry) => entry[1] !== undefined)) as Partial<SuiteNode>;
  let nodes = updateNode(version.nodes, nodeId, defined);
  if (server !== undefined) {
    const target = findInTree(nodes, nodeId)!;
    if (!nodeTakesServer(target)) throw new Error("server_not_allowed: extractors and think steps call no server");
    // An empty server clears it, so the step calls its frame's server or the suite's own.
    const id = server === "" ? undefined : stepServerId(project, server);
    nodes = replaceInTree(nodes, nodeId, (node) => {
      const { server: _old, ...rest } = node;
      return id ? { ...rest, server: id } : rest;
    });
  }
  return persistSuite(project, suite, version, nodes, version.load, options);
}

export async function moveSuiteNode(
  projectRef: string,
  nodeId: string,
  overId: string,
  suiteRef?: string,
  options?: ProjectStoreOptions,
): Promise<SuiteVersionDocument> {
  const project = await resolveProject(projectRef, options);
  const suite = resolveSuite(project, suiteRef);
  const version = currentVersion(project, suite);
  return persistSuite(project, suite, version, moveNode(version.nodes, nodeId, overId), version.load, options);
}

export async function saveSuiteFile(
  projectRef: string,
  file: { name?: string; nodes: SuiteNode[]; load: LoadProfile },
  suiteRef?: string,
  options?: ProjectStoreOptions,
): Promise<SuiteVersionDocument> {
  const project = await resolveProject(projectRef, options);
  const suite = resolveSuite(project, suiteRef);
  const load = LoadProfileSchema.parse(file.load);
  if (!Array.isArray(file.nodes)) throw new Error("nodes_invalid");
  compileProjectNodes(project, suite, file.nodes, load, { name: file.name ?? suite.name });
  const saved = await saveSuiteVersion(
    project.id,
    suite.id,
    { name: file.name, nodes: file.nodes, load },
    options,
  );
  if (!saved) throw new Error("suite_not_found");
  return saved;
}

export async function saveLoadProfile(
  projectRef: string,
  patch: Partial<LoadProfile>,
  suiteRef?: string,
  options?: ProjectStoreOptions,
): Promise<SuiteVersionDocument> {
  const project = await resolveProject(projectRef, options);
  const suite = resolveSuite(project, suiteRef);
  const version = currentVersion(project, suite);
  const defined = Object.fromEntries(Object.entries(patch).filter((entry) => entry[1] !== undefined));
  const load = LoadProfileSchema.parse({ ...version.load, ...defined });
  return persistSuite(project, suite, version, version.nodes, load, options);
}

export async function addStructuredProject(
  raw: string,
  options?: ProjectStoreOptions & { name?: string },
): Promise<{ project: Awaited<ReturnType<typeof createProject>>; label: string }> {
  const parsed = parseAllowlistEntryJson(raw);
  if (!parsed.ok) throw new Error(parsed.reason);
  if (!isMcpServerConfig(parsed.entry)) throw new Error("host_strings_do_not_create_projects");
  const entry: McpServerConfig = parsed.entry;
  const project = await createProject(
    { name: options?.name, server: entry },
    { ...options, skipIntrospect: options?.skipIntrospect ?? false },
  );
  return { project, label: allowlistEntryLabel(entry) };
}

export async function addProjectServer(
  projectRef: string,
  raw: string,
  options?: ProjectStoreOptions & { generateSuite?: boolean },
): Promise<{ projectId: string; serverId: string; suiteId?: string; introspectError?: string }> {
  const parsed = parseAllowlistEntryJson(raw);
  if (!parsed.ok) throw new Error(parsed.reason);
  if (!isMcpServerConfig(parsed.entry)) throw new Error("host_strings_do_not_create_projects");
  const project = await resolveProject(projectRef, options);
  const updated = await addServerToProject(project.id, parsed.entry, options);
  if (!updated) throw new Error("project_not_found");
  const server = updated.servers?.[updated.servers.length - 1];
  if (!server) throw new Error("server_not_found");
  return {
    projectId: updated.id,
    serverId: server.id,
    suiteId: updated.suites.at(-1)?.id,
    introspectError: server.introspectError,
  };
}

export async function removeStructuredProject(ref: string, options?: ProjectStoreOptions): Promise<string> {
  const project = await resolveProject(ref, options);
  await archiveProject(project.id, options);
  return project.id;
}

export async function introspectProjectRef(ref: string, options?: ProjectStoreOptions & { serverId?: string }) {
  const project = await resolveProject(ref, options);
  const updated = await reintrospectProject(project.id, options);
  if (!updated) throw new Error("project_not_found");
  return updated;
}

export async function cloneProjectSuite(projectRef: string, suiteRef?: string, options?: ProjectStoreOptions) {
  const project = await resolveProject(projectRef, options);
  const suite = resolveSuite(project, suiteRef);
  const cloned = await cloneSuite(project.id, suite.id, options);
  if (!cloned) throw new Error("suite_not_found");
  return cloned;
}

export async function setProjectSuiteEnabled(
  projectRef: string,
  suiteRef: string | undefined,
  enabled: boolean,
  options?: ProjectStoreOptions,
) {
  const project = await resolveProject(projectRef, options);
  const suite = resolveSuite(project, suiteRef);
  const updated = await setSuiteEnabled(project.id, suite.id, enabled, options);
  if (!updated) throw new Error("suite_not_found");
  return updated;
}

export async function removeProjectSuite(projectRef: string, suiteRef?: string, options?: ProjectStoreOptions) {
  const project = await resolveProject(projectRef, options);
  const suite = resolveSuite(project, suiteRef);
  const removed = await removeSuite(project.id, suite.id, options);
  if (removed !== "ok") throw new Error(removed);
  return suite.id;
}

export async function exportSuiteManifest(
  projectRef: string,
  output: string,
  suiteRef?: string,
  options?: ProjectStoreOptions,
): Promise<string> {
  const project = await resolveProject(projectRef, options);
  const suite = resolveSuite(project, suiteRef);
  const version = currentVersion(project, suite);
  const servers = projectSuiteServers(project, suite, version);
  const manifest = compileSuite({
    name: version.name,
    description: `Project ${project.name} suite ${version.name} v${version.version}`,
    target: servers.target,
    targets: servers.targets,
    defaultServer: servers.defaultAlias,
    serverSlos: servers.serverSlos,
    allowlist: servers.allowlist,
    nodes: servers.nodes,
    load: version.load,
    slo: version.slo,
  });
  const path = resolve(output);
  await writeFile(path, JSON.stringify(manifest, null, 2));
  return path;
}

export function formatProgress(event: RunProgressEvent): string | null {
  const attrs = event.attributes;
  // Multi-server runs name the server each call went to.
  const server = typeof attrs.server === "string" && attrs.server ? `[${attrs.server}] ` : "";
  if (event.name === "mcp.load.vus") return `vus ${String(attrs.active ?? 0)}`;
  if (event.name === "mcp.tool.call.duration") {
    return `${server}${String(attrs.tool ?? "tool")} ${String(attrs.latencyMs ?? "")}ms ${String(attrs.result ?? "")}`;
  }
  if (event.name === "mcp.rpc.duration" && !attrs.tool) {
    return `${server}${String(attrs.method ?? "rpc")} ${String(attrs.latencyMs ?? "")}ms ${String(attrs.result ?? "")}`;
  }
  if (event.name === "mcp.scenario.result") return `scenario ${String(attrs.result ?? "")}`;
  if (event.name === "run.finished") {
    return `finished ${String(attrs.verdict ?? "")}${attrs.message ? `: ${String(attrs.message)}` : ""}`;
  }
  return null;
}

export async function renameProjectRef(projectRef: string, name: string, options?: ProjectStoreOptions) {
  const project = await resolveProject(projectRef, options);
  const renamed = await renameProject(project.id, name, options);
  if (!renamed) throw new Error("name_required");
  return renamed;
}

export async function editProjectServer(
  projectRef: string,
  serverRef: string | undefined,
  patch: { name?: string; target?: McpServerConfig },
  options?: ProjectStoreOptions,
) {
  const project = await resolveProject(projectRef, options);
  const server = serverRef
    ? project.servers?.find((item) => item.id === serverRef || item.name === serverRef)
    : project.servers?.[0];
  if (!server) throw new Error("server_not_found");
  const updated = await updateProjectServer(project.id, server.id, patch, options);
  if (!updated) throw new Error("server_not_found");
  return server.id;
}

export async function addProjectSuite(
  projectRef: string,
  input: { name?: string; server?: string } = {},
  options?: ProjectStoreOptions,
) {
  const project = await resolveProject(projectRef, options);
  const server = input.server
    ? project.servers?.find((item) => item.id === input.server || item.name === input.server)
    : project.servers?.[0];
  if (input.server && !server) throw new Error("server_not_found");
  const added = await addSuiteToProject(project.id, { name: input.name, serverId: server?.id }, options);
  if (!added) throw new Error("suite_add_failed");
  return added;
}

export async function runProjectSuite(
  projectRef: string,
  suiteRef: string | undefined,
  onLine: (line: string) => void,
  options?: ProjectStoreOptions & { version?: number; inference?: boolean },
): Promise<RunReport> {
  const project = await resolveProject(projectRef, options);
  if (project.archived) throw new Error("project_archived");
  const suite = resolveSuite(project, suiteRef);
  const started = await startSuiteRun({
    projectId: project.id,
    suiteId: suite.id,
    version: options?.version,
    principal: process.env.SWARM_PRINCIPAL ?? "cli",
    // A standalone run has no org policy: the servers the operator added to the project are the
    // target consent, matched exactly like structured org allowlist entries.
    orgTargetAllowlist: (project.servers ?? []).map((server) => server.target),
    orgGatewayAllowlist: [],
    dataDir: options?.dataDir,
    dispatch: "local",
    // Model evals are opt in, as for `suite run`.
    evals: options?.inference === true,
  });
  if (!started.ok) throw new Error(started.error);
  onLine(`run ${started.runId}`);
  const finished = await followSuiteRun(started.runId, (event) => {
    const line = formatProgress(event);
    if (line) onLine(line);
  });
  const report = await loadProjectRun(project.id, started.runId, options);
  if (!report) {
    throw new Error(typeof finished.attributes.message === "string" ? finished.attributes.message : "report_missing");
  }
  return report;
}

export async function compareProjectRuns(
  projectRef: string,
  baseId: string,
  headId: string,
  options?: ProjectStoreOptions,
): Promise<CompareReport> {
  const project = await resolveProject(projectRef, options);
  const base = await loadProjectRun(project.id, baseId, options);
  const head = await loadProjectRun(project.id, headId, options);
  if (!base || !head) throw new Error("run_not_found");
  return compareRuns(base, head);
}

export async function projectRunRows(projectRef: string, options?: ProjectStoreOptions) {
  const project = await resolveProject(projectRef, options);
  return listProjectRuns(project.id, options);
}

export async function projectReport(projectRef: string, runId: string, options?: ProjectStoreOptions): Promise<RunReport> {
  const project = await resolveProject(projectRef, options);
  const report = await loadProjectRun(project.id, runId, options);
  if (!report) throw new Error("run_not_found");
  return report;
}

function replaceInTree(nodes: SuiteNode[], id: string, change: (node: SuiteNode) => SuiteNode): SuiteNode[] {
  return nodes.map((node) => {
    if (node.id === id) return change(node);
    return node.children ? { ...node, children: replaceInTree(node.children, id, change) } : node;
  });
}

function findInTree(nodes: SuiteNode[], id: string): SuiteNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const nested = findInTree(node.children, id);
      if (nested) return nested;
    }
  }
  return null;
}
