import type { CallSlo } from "./call-slo.js";
import type { ServerSurface, SuiteNode } from "./suite-model.js";

/** Alias of the one server in a single-server suite or manifest. */
export const DEFAULT_SERVER = "default";
/** Servers a suite may use. */
export const MAX_SERVERS = 8;

const ALIAS = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const VAR_TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const BUILTIN_VARS = new Set(["__uuid", "__ts", "__thread", "__iter", "__loop"]);

/** 1 to 32 characters of a-z, 0-9 and -, not starting or ending with -. */
export function isServerAlias(value: unknown): value is string {
  return typeof value === "string" && ALIAS.test(value);
}

export function assertServerAlias(value: string, field = "alias"): void {
  if (!isServerAlias(value)) {
    throw new Error(`${field}: "${value}" is not a valid alias; use 1-32 characters of a-z, 0-9 and -`);
  }
}

/** A readable alias from a server name, unique among `taken`: `GitHub Prod` becomes `github-prod`. */
export function aliasFromName(name: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28).replace(/-+$/g, "") || "server";
  let alias = base;
  for (let n = 2; used.has(alias); n++) alias = `${base}-${n}`;
  return alias;
}

/** Server names may only be set on steps that call a server, and on frames whose children inherit them. */
export function nodeTakesServer(node: Pick<SuiteNode, "type">): boolean {
  return node.type === "sampler" || node.type === "group" || node.type === "loop";
}

/**
 * The server every sampler resolves to: its own `server`, else the nearest frame's, else the default.
 * Extractors and thinks are absent, since they call no server.
 */
export function resolveNodeServers(nodes: SuiteNode[], defaultServer: string = DEFAULT_SERVER): Map<string, string> {
  const resolved = new Map<string, string>();
  const walk = (list: SuiteNode[], inherited: string) => {
    for (const node of list) {
      const own = nodeTakesServer(node) ? node.server ?? inherited : inherited;
      if (node.type === "sampler") resolved.set(node.id, own);
      if (node.children?.length) walk(node.children, own);
    }
  };
  walk(nodes, defaultServer);
  return resolved;
}

/** Aliases used by enabled samplers. */
export function usedServers(nodes: SuiteNode[], defaultServer: string = DEFAULT_SERVER): Set<string> {
  const enabled = new Set<string>();
  const walk = (list: SuiteNode[], active: boolean) => {
    for (const node of list) {
      const on = active && node.enabled !== false;
      if (on && node.type === "sampler") enabled.add(node.id);
      if (node.children?.length) walk(node.children, on);
    }
  };
  walk(nodes, true);
  const servers = new Set<string>();
  for (const [id, alias] of resolveNodeServers(nodes, defaultServer)) if (enabled.has(id)) servers.add(alias);
  return servers;
}

/** Copy of the tree with every sampler on another server disabled. Used to run per-server tool evals. */
export function nodesForServer(nodes: SuiteNode[], alias: string, defaultServer: string = DEFAULT_SERVER): SuiteNode[] {
  const servers = resolveNodeServers(nodes, defaultServer);
  const walk = (list: SuiteNode[]): SuiteNode[] => list.map((node) => ({
    ...node,
    ...(node.type === "sampler" && servers.get(node.id) !== alias ? { enabled: false } : {}),
    ...(node.children ? { children: walk(node.children) } : {}),
  }));
  return walk(nodes);
}

export interface ServerIssue {
  path: string;
  message: string;
  /** A warning is reported but does not make the suite invalid. */
  warning?: boolean;
  /** A tool step whose tool is not in its server's saved surface. Checked by validation, not at load. */
  tool?: boolean;
}

/**
 * Server references in a node tree: every `server` names a known alias, sits on a node that calls a
 * server or on a frame, and every tool step's tool is on its server's surface.
 */
export function serverIssues(
  nodes: SuiteNode[],
  surfaces: Record<string, Pick<ServerSurface, "tools"> | undefined>,
  defaultServer: string = DEFAULT_SERVER,
): ServerIssue[] {
  const issues: ServerIssue[] = [];
  const aliases = new Set(Object.keys(surfaces));
  if (!aliases.has(defaultServer)) issues.push({ path: "defaultServer", message: `"${defaultServer}" is not a server` });
  const walk = (list: SuiteNode[], prefix: string, inherited: string, active: boolean) => {
    list.forEach((node, index) => {
      const path = `${prefix}[${index}]`;
      const on = active && node.enabled !== false;
      if (node.server !== undefined) {
        if (!nodeTakesServer(node)) {
          issues.push({ path: `${path}.server`, message: `${node.type === "extractor" ? "extractors" : "think steps"} do not call a server` });
        } else if (!aliases.has(node.server)) {
          issues.push({ path: `${path}.server`, message: `"${node.server}" is not a server` });
        }
      }
      const own = nodeTakesServer(node) ? node.server ?? inherited : inherited;
      if (on && node.type === "sampler" && node.method === "tools/call" && node.tool && aliases.has(own)) {
        const surface = surfaces[own];
        if (surface && !surface.tools.some((tool) => tool.name === node.tool)) {
          issues.push({ path: `${path}.tool`, message: `${node.tool} is not on server ${own}`, tool: true });
        }
      }
      if (node.children?.length) walk(node.children, `${path}.children`, own, on);
    });
  };
  walk(nodes, "nodes", defaultServer, true);
  if (aliases.size > 1) {
    const used = usedServers(nodes, defaultServer);
    for (const alias of [...aliases].sort()) {
      if (!used.has(alias)) issues.push({ path: `servers.${alias}`, message: `server ${alias} is not used by an enabled step`, warning: true });
    }
  }
  return issues;
}

interface FlatStep {
  node: SuiteNode;
  path: string;
  server?: string;
}

function flatten(nodes: SuiteNode[], defaultServer: string): FlatStep[] {
  const servers = resolveNodeServers(nodes, defaultServer);
  const out: FlatStep[] = [];
  const walk = (list: SuiteNode[], prefix: string, active: boolean) => {
    list.forEach((node, index) => {
      const path = `${prefix}[${index}]`;
      const on = active && node.enabled !== false;
      if (!on) return;
      if (node.type === "group" || node.type === "loop") {
        walk(node.children ?? [], `${path}.children`, on);
        return;
      }
      out.push({ node, path, server: servers.get(node.id) });
    });
  };
  walk(nodes, "nodes", true);
  return out;
}

function tokens(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(VAR_TOKEN)) {
      const name = match[1];
      if (name && !BUILTIN_VARS.has(name)) found.add(name);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) tokens(item, found);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) tokens(item, found);
  }
  return found;
}

function readsOf(node: SuiteNode): Set<string> {
  return tokens([node.args, node.tool, node.prompt, node.resourceUri, node.path]);
}

/**
 * Variable checks in run order: two extractors may not set the same name, and a step may only use a
 * name that a parameter or an earlier extractor sets.
 */
export function variableIssues(nodes: SuiteNode[], params: Iterable<string> = []): ServerIssue[] {
  const known = new Set(params);
  const setBy = new Map<string, string>();
  const issues: ServerIssue[] = [];
  for (const step of flatten(nodes, DEFAULT_SERVER)) {
    for (const name of readsOf(step.node)) {
      if (!known.has(name) && !setBy.has(name)) {
        issues.push({ path: `${step.path}`, message: `\${${name}} is not set before this step` });
      }
    }
    if (step.node.type === "extractor" && step.node.variable) {
      const name = step.node.variable.trim();
      const first = setBy.get(name);
      if (first) issues.push({ path: `${step.path}.variable`, message: `${name} is already set by ${first}` });
      else setBy.set(name, step.node.id);
    }
  }
  return issues;
}

export interface CrossServerFlow {
  variable: string;
  fromServer: string;
  fromNode: string;
  toServer: string;
  toNode: string;
}

/** Values that an extractor reads from one server's result and a later step sends to another server. */
export function crossServerFlows(nodes: SuiteNode[], defaultServer: string = DEFAULT_SERVER): CrossServerFlow[] {
  const steps = flatten(nodes, defaultServer);
  const producer = new Map<string, { server: string; node: string }>();
  const flows: CrossServerFlow[] = [];
  let lastCall: FlatStep | undefined;
  for (const step of steps) {
    if (step.node.type === "extractor") {
      const name = step.node.variable?.trim();
      if (name && lastCall?.server && !producer.has(name)) producer.set(name, { server: lastCall.server, node: lastCall.node.id });
      continue;
    }
    if (step.node.type !== "sampler" || !step.server) continue;
    for (const name of readsOf(step.node)) {
      const from = producer.get(name);
      if (from && from.server !== step.server) {
        flows.push({ variable: name, fromServer: from.server, fromNode: from.node, toServer: step.server, toNode: step.node.id });
      }
    }
    lastCall = step;
  }
  return flows;
}

export function formatCrossServerFlows(flows: CrossServerFlow[]): string[] {
  if (flows.length === 0) return [];
  const width = (pick: (flow: CrossServerFlow) => string) => Math.max(...flows.map((flow) => pick(flow).length));
  const a = width((flow) => flow.fromServer), b = width((flow) => flow.fromNode), c = width((flow) => flow.variable), d = width((flow) => flow.toServer);
  return flows.map((flow) =>
    `  ${flow.fromServer.padEnd(a)}  ${flow.fromNode.padEnd(b)} -> ${flow.variable.padEnd(c)} -> ${flow.toServer.padEnd(d)}  ${flow.toNode}`);
}

/** Per-server objectives, with blank fields dropped. */
export type ServerSlos = Record<string, CallSlo>;
