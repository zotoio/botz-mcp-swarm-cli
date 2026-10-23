import { SuiteInputSchema, SuiteLoadSchema, SuiteV2Schema } from "./suite-schema.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { atomicWrite, withFileLock } from "./file-store.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  applyAuthFlags,
  assertNoUrlCredentials,
  formatAuth,
  moveUrlCredentials,
  resolveTargetSecrets,
  splitAuthFlags,
  splitLiteralCredentials,
  type AuthFlags,
} from "./suite-auth.js";
import {
  expandHome,
  findGitRoot,
  isPathLike,
  portablePath,
  saveSuiteCredentials,
  suiteCredentials,
  type BotzHome,
  type PathRoots,
} from "./botz-home.js";
import {
  defaultScrubContext,
  makeReportScrubber,
  scrubReport,
  stdioCommandPaths,
  targetSecretValues,
} from "./report-scrub.js";
import { formatMarkdownReport, writeReports } from "../engine/core/report.js";
import { introspectServer } from "../engine/core/suite-introspect.js";
import {
  buildDefaultSuiteNodes,
  compileSuite,
  generatedLoadProfile,
  normalizeLoadProfile,
  toolIsCalledByDefault,
  type LoadProfile,
  type ServerSurface,
  type SuiteNode,
  type SurfaceLatency,
} from "../engine/core/suite-model.js";
import { runManifest } from "../engine/core/runner.js";
import { runServer } from "../engine/core/run-server.js";
import { applyToolEvalVerdict, evaluateSuiteTools, generateToolTestData } from "../engine/core/tool-evals.js";
import { inferenceSecretValues } from "../engine/core/inference-model.js";
import { resolveSuiteLimits, type SuiteLimits, type SuiteLimitsInput } from "../engine/core/suite-limits.js";
import { TargetSchema, type Manifest, type Target } from "../engine/types/manifest.js";
import type { RunReport } from "../engine/types/run.js";
import { normalizeCallSlo, type CallSlo } from "../engine/core/call-slo.js";
import {
  assertServerAlias,
  crossServerFlows,
  DEFAULT_SERVER,
  formatCrossServerFlows,
  nodesForServer,
  resolveNodeServers,
  serverIssues,
  usedServers,
} from "../engine/core/servers.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const BUILTIN = new Set(["__uuid", "__ts", "__thread", "__iter", "__loop"]);

export interface SuiteParam {
  example: string;
  usedBy: string[];
}

/** One server of a suite: where it is and what it offered when captured. */
export interface SuiteServer {
  target: Target;
  surface: ServerSurface;
  capturedAt?: string;
  /** Objectives over every tool call on this server. */
  slo?: CallSlo;
}

export interface SuiteFile {
  /** Unversioned files are read as legacy version 1. Version 2 holds more than one server. */
  schemaVersion?: 1 | 2;
  /** Stable credential identity; legacy suites use their name. */
  id?: string;
  /** Outside a repo, cwd is relative to the suite directory. */
  cwdBase?: "suite";
  kind: "botz-suite";
  capturedAt: string;
  name: string;
  /** The default server's target. Steps without `server` call it. */
  target: Target;
  /** The default server's surface. */
  surface: ServerSurface;
  /** Alias of the default server. Absent means `default`. */
  defaultServer?: string;
  /** The default server's objective, over every tool call on it. */
  serverSlo?: CallSlo;
  /** Servers other than the default, by alias. */
  servers?: Record<string, SuiteServer>;
  nodes: SuiteNode[];
  /** Call-count and payload limits. --max-call-count / --max-payload-bytes win over these; these win over env vars. */
  limits?: SuiteLimitsInput;
  load: LoadProfile;
  params: Record<string, SuiteParam>;
}

export function suiteDefaultAlias(suite: Pick<SuiteFile, "defaultServer">): string {
  return suite.defaultServer ?? DEFAULT_SERVER;
}

/** Every server of a suite by alias, default first. */
export function suiteServers(suite: SuiteFile): Record<string, SuiteServer> {
  return {
    [suiteDefaultAlias(suite)]: { target: suite.target, surface: suite.surface, ...(suite.serverSlo ? { slo: suite.serverSlo } : {}) },
    ...(suite.servers ?? {}),
  };
}

export function isMultiServer(suite: Pick<SuiteFile, "servers">): boolean {
  return Object.keys(suite.servers ?? {}).length > 0;
}

/** Version 1 for one server called `default` with no server objective, version 2 otherwise. */
export function suiteNeedsV2(suite: SuiteFile): boolean {
  return isMultiServer(suite) || suiteDefaultAlias(suite) !== DEFAULT_SERVER || Boolean(suite.serverSlo);
}

/** The file form: version 1 keeps `target` and `surface` at the top, version 2 lists `servers`. */
export function suiteToJson(suite: SuiteFile): Record<string, unknown> {
  const { target, surface, defaultServer: _defaultServer, serverSlo: _serverSlo, servers: _servers, schemaVersion: _version, ...rest } = suite;
  if (!suiteNeedsV2(suite)) {
    return {
      kind: "botz-suite",
      schemaVersion: 1,
      ...(rest.cwdBase ? { cwdBase: rest.cwdBase } : {}),
      ...(rest.id ? { id: rest.id } : {}),
      capturedAt: rest.capturedAt,
      name: rest.name,
      target,
      surface,
      nodes: rest.nodes,
      load: rest.load,
      params: rest.params,
    };
  }
  return {
    kind: "botz-suite",
    schemaVersion: 2,
    ...(rest.id ? { id: rest.id } : {}),
    ...(rest.cwdBase ? { cwdBase: rest.cwdBase } : {}),
    capturedAt: rest.capturedAt,
    name: rest.name,
    defaultServer: suiteDefaultAlias(suite),
    servers: suiteServers(suite),
    nodes: rest.nodes,
    load: rest.load,
    params: rest.params,
  };
}


export interface SuiteRunResult {
  report: RunReport;
  jsonPath: string;
  markdownPath: string;
}

interface Slot {
  nodeId: string;
  key: string;
  example: string;
  owner: string;
}

/** Single-pass smoke capture, with the shared grace period for later timed runs. */
export function captureLoadProfile(nodes: SuiteNode[] = [], latency?: SurfaceLatency): LoadProfile {
  return {
    ...generatedLoadProfile(nodes, latency),
    durationMs: 0,
    rampUpMs: 0,
    jitterMs: 0,
    dwellMs: 0,
  };
}

export function targetFromCaptureFlags(input: { url?: string; command?: string; arg?: string[] }): Target {
  if (input.url && input.command) throw new Error("provide --url or --command");
  if (input.url) return { transport: "streamable-http", url: input.url };
  if (input.command) {
    const args = (input.arg ?? []).filter((item) => item.length > 0);
    return {
      transport: "stdio",
      command: input.command,
      ...(args.length > 0 ? { args } : {}),
    };
  }
  throw new Error("provide --url or --command");
}

export function parameterizeSuiteNodes(
  nodes: SuiteNode[],
  surface: ServerSurface,
): { nodes: SuiteNode[]; params: Record<string, SuiteParam> } {
  const slots: Slot[] = [];
  collectSlots(nodes, surface, slots);
  const assigned = assignParams(slots);
  return { nodes: applyNames(nodes, assigned.names), params: assigned.params };
}

export function assertParamsReady(suite: SuiteFile, values: Record<string, string>): void {
  const missing = Object.keys(suite.params)
    .filter((key) => !Object.prototype.hasOwnProperty.call(values, key))
    .sort();
  if (missing.length > 0) throw new Error(`missing parameter: ${missing.join(", ")}`);
  // Names an extractor sets are filled in during the run, not supplied as parameters.
  const extracted = extractorVariables(suite.nodes);
  const unknown = [...suiteArgParams(suite.nodes)].filter((name) => !suite.params[name] && !extracted.has(name)).sort();
  if (unknown.length > 0) throw new Error(`unknown parameter: ${unknown.join(", ")}`);
}

/** Captured values are the default; files and CLI values override them. */
export async function resolveSuiteParamValues(
  dir: string,
  suite: SuiteFile,
  overrides: Record<string, string> = {},
): Promise<Record<string, string>> {
  const captured = Object.fromEntries(Object.entries(suite.params).map(([name, spec]) => [name, spec.example]));
  let file: Record<string, unknown> | undefined;
  try {
    file = await readParamFile(join(dir, "params.example.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { ...captured, ...mergeParamValues(file, []), ...overrides };
}

export function mergeParamValues(
  file: Record<string, unknown> | undefined,
  sets: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (file) {
    for (const [key, value] of Object.entries(file)) {
      if (typeof value !== "string") throw new Error(`parameter ${key} must be a string`);
      out[key] = value;
    }
  }
  for (const set of sets) {
    const eq = set.indexOf("=");
    if (eq <= 0) throw new Error(`parameter must be key=value: ${set}`);
    out[set.slice(0, eq)] = set.slice(eq + 1);
  }
  return out;
}

export function formatSuiteShow(suite: SuiteFile): string {
  const describe = (target: Target) => target.transport === "stdio"
    ? `stdio ${target.command}`
    : `${target.transport} ${target.url}`;
  const lines = [suite.name];
  const multi = isMultiServer(suite);
  const defaultAlias = suiteDefaultAlias(suite);
  if (!multi && defaultAlias === DEFAULT_SERVER) {
    lines.push(`target: ${describe(suite.target)}`);
    const auth = formatAuth(suite.target);
    if (auth.length > 0) lines.push("auth:", ...auth);
  } else {
    lines.push("servers:");
    for (const [alias, server] of Object.entries(suiteServers(suite))) {
      lines.push(`  ${alias}${alias === defaultAlias ? " (default)" : ""}: ${describe(server.target)}`);
      for (const line of formatAuth(server.target)) lines.push(`  ${line}`);
    }
  }
  lines.push("", "steps:");
  const servers = resolveNodeServers(suite.nodes, defaultAlias);
  const steps = enabledLabels(suite.nodes);
  if (steps.length === 0) lines.push("  (none)");
  else for (const step of steps) {
    const alias = step.sampler ? servers.get(step.id) : undefined;
    lines.push(`  ${multi && alias ? `[${alias}] ` : ""}${step.label}`);
  }
  lines.push("", "parameters:");
  const names = Object.keys(suite.params).sort();
  if (names.length === 0) lines.push("  (none)");
  else for (const name of names) lines.push(`  ${name}`);
  const flows = formatCrossServerFlows(crossServerFlows(suite.nodes, defaultAlias));
  if (flows.length > 0) lines.push("", "Cross-server data flows", ...flows);
  return lines.join("\n");
}

export function disabledToolNames(surface: ServerSurface): string[] {
  return surface.tools.filter((tool) => !toolIsCalledByDefault(tool)).map((tool) => tool.name);
}

export function parseSuiteFile(raw: unknown): SuiteFile {
  if (!isRecord(raw) || raw.kind !== "botz-suite") throw new Error("not a botz suite");
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1 && raw.schemaVersion !== 2) throw new Error("unsupported suite schemaVersion; upgrade the CLI");
  if (raw.id !== undefined && (typeof raw.id !== "string" || !/^[a-zA-Z0-9-]+$/.test(raw.id))) throw new Error("invalid suite id");
  const suite = raw.schemaVersion === 2 ? parseV2(raw) : parseV1(raw);
  const surfaces = Object.fromEntries(Object.entries(suiteServers(suite)).map(([alias, server]) => [alias, server.surface]));
  const problem = serverIssues(suite.nodes, surfaces, suiteDefaultAlias(suite)).find((issue) => !issue.warning && !issue.tool);
  if (problem) throw new Error(`${problem.path}: ${problem.message}`);
  return suite;
}

function parseV1(raw: Record<string, unknown>): SuiteFile {
  const validated = SuiteInputSchema.parse(raw);
  const target = TargetSchema.parse(raw.target);
  if (typeof raw.name !== "string" || raw.name.trim().length === 0) throw new Error("suite name is required");
  if (!Array.isArray(raw.nodes)) throw new Error("suite nodes are required");
  if (!isRecord(raw.params)) throw new Error("suite params are required");
  return {
    ...suiteHeader(raw),
    target,
    surface: parseSurface(raw.surface),
    nodes: validated.nodes,
    load: normalizeLoadProfile(isRecord(raw.load) ? raw.load as Partial<LoadProfile> : {}),
    params: parseParams(raw.params),
  };
}

function parseV2(raw: Record<string, unknown>): SuiteFile {
  const validated = SuiteV2Schema.parse(raw);
  const defaultAlias = validated.defaultServer;
  const servers = raw.servers as Record<string, Record<string, unknown>>;
  const parsed = (alias: string): SuiteServer => {
    const entry = validated.servers[alias]!;
    const slo = normalizeCallSlo(entry.slo);
    return {
      target: TargetSchema.parse(entry.target),
      surface: parseSurface(servers[alias]?.surface),
      ...(entry.capturedAt ? { capturedAt: entry.capturedAt } : {}),
      ...(slo ? { slo } : {}),
    };
  };
  const main = parsed(defaultAlias);
  const others = Object.keys(validated.servers).filter((alias) => alias !== defaultAlias);
  return {
    ...suiteHeader(raw),
    schemaVersion: 2,
    target: main.target,
    surface: main.surface,
    ...(defaultAlias !== DEFAULT_SERVER ? { defaultServer: defaultAlias } : {}),
    ...(main.slo ? { serverSlo: main.slo } : {}),
    ...(others.length > 0 ? { servers: Object.fromEntries(others.map((alias) => [alias, parsed(alias)])) } : {}),
    nodes: validated.nodes,
    load: normalizeLoadProfile(isRecord(raw.load) ? raw.load as Partial<LoadProfile> : {}),
    params: parseParams(raw.params),
  };
}

function suiteHeader(raw: Record<string, unknown>) {
  if (typeof raw.name !== "string" || raw.name.trim().length === 0) throw new Error("suite name is required");
  return {
    kind: "botz-suite" as const,
    schemaVersion: 1 as 1 | 2,
    ...(raw.cwdBase === "suite" ? { cwdBase: "suite" as const } : {}),
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : new Date().toISOString(),
    name: raw.name.trim(),
  };
}

function parseParams(raw: unknown): Record<string, SuiteParam> {
  if (!isRecord(raw)) throw new Error("suite params are required");
  const params: Record<string, SuiteParam> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value) || typeof value.example !== "string" || !Array.isArray(value.usedBy)) {
      throw new Error(`parameter ${key} is invalid`);
    }
    params[key] = {
      example: value.example,
      usedBy: value.usedBy.filter((id): id is string => typeof id === "string"),
    };
  }
  return params;
}

function parseSurface(surface: unknown): ServerSurface {
  if (!isRecord(surface) || !Array.isArray(surface.tools) || !Array.isArray(surface.capabilities)) {
    throw new Error("suite surface is invalid");
  }
  const capabilities: unknown[] = surface.capabilities;
  return {
    serverName: typeof surface.serverName === "string" ? surface.serverName : undefined,
    serverVersion: typeof surface.serverVersion === "string" ? surface.serverVersion : undefined,
    capabilities: capabilities.filter((item): item is string => typeof item === "string"),
    tools: surface.tools as ServerSurface["tools"],
    resources: Array.isArray(surface.resources) ? surface.resources as ServerSurface["resources"] : [],
    resourceTemplates: Array.isArray(surface.resourceTemplates)
      ? surface.resourceTemplates as ServerSurface["resourceTemplates"]
      : [],
    prompts: Array.isArray(surface.prompts) ? surface.prompts as ServerSurface["prompts"] : [],
  };
}

export async function loadSuiteFile(dir: string): Promise<SuiteFile> {
  const raw = JSON.parse(await readFile(join(dir, "suite.json"), "utf8")) as unknown;
  return parseSuiteFile(raw);
}

export async function writeSuiteDir(dir: string, suite: SuiteFile): Promise<void> {
  await mkdir(dir, { recursive: true });

  const examples: Record<string, string> = {};
  for (const [key, spec] of Object.entries(suite.params)) examples[key] = spec.example;
  await atomicWrite(join(dir, "params.example.json"), JSON.stringify(examples, null, 2), 0o644);
  await atomicWrite(join(dir, "suite.json"), JSON.stringify(suiteToJson(suite), null, 2), 0o644);
}

export async function readParamFile(path: string): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(raw)) throw new Error("parameter file must be a JSON object");
  return raw;
}

/**
 * Introspects the target and writes `suite.json`. Literal header and env values never reach the suite file:
 * they become `${env:NAME}` references and the literals go to `.botz/mcp-swarm/config.json` under the suite name.
 */
export async function captureSuite(input: {
  force?: boolean;
  inference?: boolean;
  target: Target;
  outDir: string;
  name?: string;
  baseDir?: string;
  auth?: AuthFlags;
  /** Where literal credentials are kept. Required when the target carries a literal header or env value. */
  botz?: BotzHome;
  /** Alias of the captured server. Defaults to `default`. */
  alias?: string;
}): Promise<SuiteFile & { savedCredentialNames: string[]; movedUrlParam?: string }> {
  if (input.alias !== undefined) assertServerAlias(input.alias, "--alias");
  const assertWritable = () => {
    if (!input.force && (existsSync(join(input.outDir, "suite.json")) || existsSync(join(input.outDir, "params.example.json")))) {
      throw new Error("suite already exists; choose another name or pass --force to replace it");
    }
  };
  assertWritable();
  const cwd = resolve(input.baseDir ?? process.cwd());
  const home = input.botz?.home ?? homedir();
  const gitRoot = input.botz ? input.botz.repoRoot : findGitRoot(cwd);
  const typed = absoluteStdio(applyAuthFlags(input.target, input.auth), cwd, home);
  const { target: keyless, movedParam } = moveUrlCredentials(typed, input.auth?.urlKeyAsBearer);
  assertNoUrlCredentials(keyless);
  const { target: referenced, credentials } = splitLiteralCredentials(keyless);
  if (Object.keys(credentials).length > 0 && !input.botz) {
    throw new Error("literal credentials need a .botz config location");
  }
  const surface = await introspectServer(
    resolveTargetSecrets(referenced, { ...process.env, ...credentials }),
    cwd,
  );
  const defaults = buildDefaultSuiteNodes(surface);
  if (input.inference === true) {
    const infer = async (list: SuiteNode[], enabled = true): Promise<void> => {
      for (const node of list) {
        const active = enabled && node.enabled !== false;
        if (node.children) await infer(node.children, active);
        if (!active || node.method !== "tools/call" || !node.tool) continue;
        const tool = surface.tools.find((entry) => entry.name === node.tool);
        if (!tool) continue;
        const fixture = await generateToolTestData(tool);
        node.args = fixture.args;
        node.evals = fixture.evals;
      }
    };
    await infer(defaults);
  }
  const { nodes, params } = parameterizeSuiteNodes(defaults, surface);
  const name = input.name?.trim() || defaultSuiteName(typed);
  const suite: SuiteFile = {
    kind: "botz-suite",
    schemaVersion: 1,
    id: randomUUID(),
    capturedAt: new Date().toISOString(),
    name,
    target: portableStdio(referenced, { gitRoot, home, cwd }),
    // Latency differs on every capture; it only sizes the load profile below.
    surface: { ...surface, latency: undefined },
    ...(input.alias && input.alias !== DEFAULT_SERVER ? { defaultServer: input.alias } : {}),
    nodes,
    load: captureLoadProfile(nodes, surface.latency),
    params,
  };
  if (!gitRoot && suite.target.transport === "stdio") {
    suite.cwdBase = "suite";
    suite.target.cwd = relative(resolve(input.outDir), cwd) || ".";
  }
  await withFileLock(`${input.outDir}.lock`, async () => {
    assertWritable();
    if (input.force && existsSync(join(input.outDir, "suite.json"))) {
      suite.id = (await loadSuiteFile(input.outDir)).id ?? suite.id;
    }
    if (input.botz) await saveSuiteCredentials(input.botz, suite.id!, credentials);
    await writeSuiteDir(input.outDir, suite);
  });
  return {
    ...suite,
    savedCredentialNames: Object.keys(credentials).sort(),
    ...(movedParam ? { movedUrlParam: movedParam } : {}),
  };
}

export interface SuiteRunOptions {
    params: Record<string, string>;
    signal?: AbortSignal;
    outputDir: string;
    /** File name without extension. Defaults to the run id. */
    reportBaseName?: string;
    iterations?: number;
    concurrency?: number;
    /** Run the saved tool-selection evals once and include them in the verdict. */
    inference?: boolean;
    baseDir?: string;
    auth?: AuthFlags;
    /** Supplies literal credentials saved at capture time. The environment wins over them. */
    botz?: BotzHome;
    /** Replaces the default server's target. */
    target?: Target;
    /** Replaces the default server's URL. Refused on a multi-server suite. */
    url?: string;
    /** Replaces servers by alias: a complete target, or a URL string for an HTTP server. */
    targets?: Record<string, Target | string>;
    load?: Partial<LoadProfile>;
    /** --max-call-count / --max-payload-bytes. These win over the suite file's `limits`. */
    limits?: Partial<SuiteLimits>;
    /** Environment for SWARM_MAX_CALL_COUNT / SWARM_MAX_PAYLOAD_BYTES. Defaults to process.env. */
    env?: NodeJS.ProcessEnv;
}

/** Prefixes an error with the server it concerns, when the suite has more than one. */
function forServer<T>(alias: string, multi: boolean, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (!multi || !(error instanceof Error)) throw error;
    throw Object.assign(new Error(`server ${alias}: ${error.message}`, { cause: error }), { name: error.name });
  }
}

/** Resolve the same paths, parameters, credentials, and load profile for run, doctor, and validation. */
export async function resolveSuiteExecution(dir: string, options: Partial<SuiteRunOptions> & { resolveSecrets?: boolean } = {}) {
  const suite = await loadSuiteFile(dir);
  const defaultAlias = suiteDefaultAlias(suite);
  const all = suiteServers(suite);
  const aliases = Object.keys(all);
  const multi = aliases.length > 1;
  const saved = options.botz ? await suiteCredentials(options.botz, suite.id ?? suite.name) : {};
  const home = options.botz?.home ?? homedir();
  const gitRoot = findGitRoot(dir) ?? options.botz?.repoRoot ?? findGitRoot(options.baseDir ?? process.cwd());
  if (options.target && options.url) throw new Error("provide --url or --target-file, not both");
  if (options.url && multi) throw new Error(`suite ${suite.name} has ${aliases.length} servers; use --target <alias>=<url>`);
  const overrides: Record<string, Target> = {};
  for (const [alias, value] of Object.entries(options.targets ?? {})) {
    const server = all[alias];
    if (!server) throw new Error(`--target: "${alias}" is not a server in suite ${suite.name}; servers: ${aliases.join(", ")}`);
    if (typeof value === "string") {
      if (server.target.transport === "stdio") throw new Error(`--target ${alias}=<url> requires an HTTP server; use --target-file to change transport`);
      overrides[alias] = TargetSchema.parse({ transport: server.target.transport, url: value });
    } else {
      overrides[alias] = TargetSchema.parse(value);
    }
  }
  if (options.target) overrides[defaultAlias] = TargetSchema.parse(options.target);
  if (options.url) {
    if (suite.target.transport === "stdio") throw new Error("--url requires an HTTP suite; use --target-file to change transport");
    overrides[defaultAlias] = TargetSchema.parse({ transport: suite.target.transport, url: options.url });
  }
  const auth = splitAuthFlags(options.auth, aliases.filter((alias) => alias !== defaultAlias));
  const root = suite.cwdBase === "suite" ? resolve(dir) : gitRoot;
  const targets = new Map<string, Target>();
  for (const alias of aliases) {
    const server = all[alias]!;
    const override = overrides[alias];
    const flags = alias === defaultAlias ? auth.main : { urlKeyAsBearer: options.auth?.urlKeyAsBearer, ...auth.byServer[alias] };
    targets.set(alias, forServer(alias, multi, () => {
      // A replacement endpoint must receive explicitly supplied credentials, never the captured endpoint's secrets.
      const resolvedTarget = override ? absoluteStdio(override, options.baseDir ?? process.cwd(), home)
        : runnableStdio(server.target, root, home);
      const { target: keyless } = moveUrlCredentials(applyAuthFlags(resolvedTarget, flags), flags.urlKeyAsBearer);
      assertNoUrlCredentials(keyless);
      return options.resolveSecrets === false ? keyless : resolveTargetSecrets(keyless, { ...(override ? {} : saved), ...process.env });
    }));
  }
  const target = targets.get(defaultAlias)!;
  const params = await resolveSuiteParamValues(dir, suite, options.params);
  assertParamsReady(suite, params);
  const load = normalizeLoadProfile(SuiteLoadSchema.parse({
    ...suite.load,
    ...options.load,
    ...(options.iterations !== undefined ? { iterations: options.iterations } : {}),
    ...(options.concurrency !== undefined ? { maxConcurrency: options.concurrency } : {}),
  }));
  const used = usedServers(suite.nodes, defaultAlias);
  const others = Object.fromEntries([...targets].filter(([alias]) => alias !== defaultAlias && used.has(alias)));
  const serverSlos = Object.fromEntries(Object.entries(all).flatMap(([alias, server]) => (server.slo ? [[alias, server.slo]] : [])));
  const limits = resolveSuiteLimits({ suite: suite.limits, flags: options.limits, env: options.env ?? process.env });
  const manifest = compileSuite({
    name: suite.name,
    description: `Suite ${suite.name}`,
    target,
    targets: others,
    defaultServer: defaultAlias,
    serverSlos,
    allowlist: [],
    nodes: suite.nodes,
    load,
    limits,
  }) as unknown as Manifest;
  const baseDir = (overrides[defaultAlias] ? options.baseDir ?? process.cwd() : undefined) ?? (suite.cwdBase === "suite" && target.transport === "stdio" ? target.cwd : gitRoot)
    ?? (target.transport === "stdio" ? target.cwd : undefined) ?? options.baseDir ?? dir;
  return { suite, saved: Object.keys(overrides).length === aliases.length ? {} : saved, home, target, targets, params, manifest, baseDir, limits };
}

/**
 * Standalone run of a saved suite. The suite's own target is the only consent: no allowlist, org policy,
 * role grant, or principal is consulted. The returned report is already scrubbed of secrets and user paths.
 */
export async function runSavedSuite(
  dir: string,
  options: SuiteRunOptions,
): Promise<SuiteRunResult> {
  const { suite, saved, home, target, targets, params, manifest, baseDir } = await resolveSuiteExecution(dir, options);
  const defaultAlias = suiteDefaultAlias(suite);
  const all = suiteServers(suite);
  const multi = isMultiServer(suite);
  let raw = await runManifest({
    manifest,
    mode: "load",
    manifestDir: baseDir,
    vars: params,
    strictParams: true,
    standaloneTarget: true,
    signal: options.signal,
  });
  if (options.inference === true && !options.signal?.aborted && hasEnabledTool(suite.nodes)) {
    try {
      const fetchImpl: typeof fetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.any([
        ...(init?.signal ? [init.signal] : []), ...(options.signal ? [options.signal] : []),
      ]) });
      const runs = [];
      // Each tool's evals run against its own server.
      for (const alias of Object.keys(all)) {
        const nodes = multi ? nodesForServer(suite.nodes, alias, defaultAlias) : suite.nodes;
        if (!hasEnabledTool(nodes)) continue;
        const result = await evaluateSuiteTools({ nodes, target: targets.get(alias)!, baseDir, fetchImpl });
        if (result) runs.push(result);
      }
      const evals = runs.length > 0
        ? { cases: runs.flatMap((run) => run.cases), failReasons: runs.flatMap((run) => run.failReasons) }
        : undefined;
      raw = applyToolEvalVerdict(raw, evals ?? { cases: [], failReasons: ["inference requested but suite has no enabled tool evals"] });
    } catch {
      raw = applyToolEvalVerdict(raw, { cases: [], failReasons: ["tool inference failed; check the model endpoint and configuration"] });
    }
  }
  raw.params = params;
  raw.server = runServer(target, {
    name: raw.server?.name ?? suite.surface.serverName,
    version: raw.server?.version ?? suite.surface.serverVersion,
  });
  // A server's name and version fall back to what it offered when captured.
  raw.servers = raw.servers?.map((item) => {
    const surface = all[item.alias]?.surface;
    return {
      ...item,
      ...(item.name ?? surface?.serverName ? { name: item.name ?? surface?.serverName } : {}),
      ...(item.version ?? surface?.serverVersion ? { version: item.version ?? surface?.serverVersion } : {}),
    };
  });
  raw.catalog = Object.entries(all).flatMap(([alias, server]) => server.surface.tools.map((tool) => ({
    ...(multi ? { server: alias } : {}),
    name: tool.name,
    schemaHash: tool.schemaHash,
    writeLike: tool.writeLike,
  })));
  const scrub = makeReportScrubber({
    ...defaultScrubContext(options.botz?.cwd ?? process.cwd()),
    home,
    secrets: [...[...targets.values()].flatMap((item) => targetSecretValues(item)), ...Object.values(saved),
      ...inferenceSecretValues(), process.env.TYPESAFE_API_KEY ?? ""],
    commands: [...targets.values()].flatMap((item) => stdioCommandPaths(item, baseDir)),
  });
  const report = scrubReport(raw, scrub);
  const written = options.reportBaseName
    ? await writeNamedReports(report, options.outputDir, options.reportBaseName)
    : await writeReports(report, options.outputDir);
  return { report, ...written };
}

/** `botz-run-<timestamp>` for a report in the default runs directory. */
export function runReportBaseName(now: Date = new Date()): string {
  return `botz-run-${now.toISOString().replace(/[:.]/g, "-")}`;
}

async function writeNamedReports(
  report: RunReport,
  outputDir: string,
  baseName: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(outputDir, { recursive: true });
  const jsonPath = join(outputDir, `${baseName}.json`);
  const markdownPath = join(outputDir, `${baseName}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, formatMarkdownReport(report), "utf8");
  return { jsonPath, markdownPath };
}

/** Typed stdio command and file args made absolute against the cwd, so introspection and storage agree. */
export function absoluteStdio(target: Target, cwd: string, home: string): Target {
  if (target.transport !== "stdio") return target;
  const absolute = (value: string, bareFiles: boolean) =>
    isPathLike(value, cwd, bareFiles) ? resolve(cwd, expandHome(value, home)) : value;
  return {
    ...target,
    cwd: resolve(cwd, expandHome(target.cwd ?? ".", home)),
    command: absolute(target.command, true),
    ...(target.args ? { args: target.args.map((arg) => absolute(arg, false)) } : {}),
  };
}

/** Absolute stdio paths stored relative to the git root inside a repo, else as `~/...` under home. */
export function portableStdio(target: Target, roots: PathRoots): Target {
  if (target.transport !== "stdio") return target;
  const portable = (value: string) => (isAbsolute(value) ? portablePath(value, roots) : value);
  return {
    ...target,
    cwd: target.cwd === roots.gitRoot ? "." : portable(target.cwd ?? roots.cwd),
    command: portable(target.command),
    ...(target.args ? { args: target.args.map(portable) } : {}),
  };
}

/** Stored stdio paths back to absolute: `~/...` under home, relative paths against the git root. */
export function runnableStdio(target: Target, gitRoot: string | null, home: string): Target {
  if (target.transport !== "stdio") return target;
  const runnable = (value: string, bareFiles: boolean) => {
    const expanded = expandHome(value, home);
    if (isAbsolute(expanded) || !gitRoot || !isPathLike(expanded, gitRoot, bareFiles)) return expanded;
    return resolve(gitRoot, expanded);
  };
  return {
    ...target,
    ...(target.cwd ? { cwd: resolve(gitRoot ?? process.cwd(), expandHome(target.cwd, home)) } : {}),
    command: runnable(target.command, true),
    ...(target.args ? { args: target.args.map((arg) => runnable(arg, false)) } : {}),
  };
}

export function defaultSuiteName(target: Target): string {
  if (target.transport === "stdio") return basename(target.command) || "stdio";
  const url = new URL(target.url);
  const suffix = createHash("sha256").update(`${url.origin}${url.pathname}`).digest("hex").slice(0, 8);
  return `${url.hostname}-${suffix}`;
}

function collectSlots(nodes: SuiteNode[], surface: ServerSurface, slots: Slot[], parentEnabled = true): void {
  for (const node of nodes) {
    const active = parentEnabled && node.enabled !== false;
    if (node.children?.length) collectSlots(node.children, surface, slots, active);
    if (!active || node.type !== "sampler" || !node.args) continue;
    const required = requiredKeys(node, surface);
    if (!required) continue;
    for (const [key, value] of Object.entries(node.args)) {
      if (!required.keys.has(key) || typeof value !== "string" || !IDENT.test(key)) continue;
      slots.push({ nodeId: node.id, key, example: value, owner: required.owner });
    }
  }
}

function requiredKeys(node: SuiteNode, surface: ServerSurface): { keys: Set<string>; owner: string } | null {
  if (node.method === "tools/call" && node.tool) {
    const tool = surface.tools.find((item) => item.name === node.tool);
    return { keys: new Set(tool?.inputSchema?.required ?? []), owner: node.tool };
  }
  if (node.method === "prompts/get" && node.prompt) {
    const prompt = surface.prompts.find((item) => item.name === node.prompt);
    const keys = (prompt?.arguments ?? []).filter((arg) => arg.required).map((arg) => arg.name);
    return { keys: new Set(keys), owner: node.prompt };
  }
  return null;
}

function assignParams(slots: Slot[]): { params: Record<string, SuiteParam>; names: Map<string, string> } {
  const params: Record<string, SuiteParam> = {};
  const names = new Map<string, string>();
  const byKey = new Map<string, Slot[]>();
  for (const slot of slots) {
    const list = byKey.get(slot.key) ?? [];
    list.push(slot);
    byKey.set(slot.key, list);
  }
  for (const [key, group] of byKey) {
    const sameExample = group.every((slot) => slot.example === group[0]?.example);
    if (sameExample && !BUILTIN.has(key)) {
      params[key] = {
        example: group[0]?.example ?? "",
        usedBy: unique(group.map((slot) => slot.nodeId)),
      };
      for (const slot of group) names.set(slotId(slot), key);
      continue;
    }
    for (const slot of group) {
      let name = sanitize(`${slot.owner}_${slot.key}`);
      if (!IDENT.test(name) || BUILTIN.has(name)) name = `p_${name}`;
      while (params[name] && params[name]?.example !== slot.example) name = `${name}_${slot.nodeId}`;
      const existing = params[name];
      if (existing) {
        if (!existing.usedBy.includes(slot.nodeId)) existing.usedBy.push(slot.nodeId);
      } else {
        params[name] = { example: slot.example, usedBy: [slot.nodeId] };
      }
      names.set(slotId(slot), name);
    }
  }
  return { params, names };
}

function applyNames(nodes: SuiteNode[], names: Map<string, string>): SuiteNode[] {
  return nodes.map((node) => {
    const children = node.children ? applyNames(node.children, names) : undefined;
    const args = renamedArgs(node, names);
    if (!children && !args) return node;
    return {
      ...node,
      ...(args ? { args } : {}),
      ...(children ? { children } : {}),
    };
  });
}

function renamedArgs(node: SuiteNode, names: Map<string, string>): Record<string, unknown> | undefined {
  if (!node.args) return undefined;
  let changed = false;
  const args: Record<string, unknown> = { ...node.args };
  for (const key of Object.keys(args)) {
    const param = names.get(`${node.id}\0${key}`);
    if (!param) continue;
    args[key] = `\${${param}}`;
    changed = true;
  }
  return changed ? args : undefined;
}

function suiteArgParams(nodes: SuiteNode[], found: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    if (node.enabled === false) continue;
    if (node.args) collectTokens(node.args, found);
    if (node.children) suiteArgParams(node.children, found);
  }
  return found;
}

function extractorVariables(nodes: SuiteNode[], found: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    if (node.enabled === false) continue;
    if (node.type === "extractor" && node.variable?.trim()) found.add(node.variable.trim());
    if (node.children) extractorVariables(node.children, found);
  }
  return found;
}

function collectTokens(value: unknown, found: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(TOKEN)) {
      const name = match[1];
      if (name && !BUILTIN.has(name)) found.add(name);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTokens(item, found);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectTokens(item, found);
  }
}

function enabledLabels(nodes: SuiteNode[], out: Array<{ id: string; label: string; sampler: boolean }> = []) {
  for (const node of nodes) {
    if (!node.enabled) continue;
    if (node.type === "group" || node.type === "loop") {
      if (node.children) enabledLabels(node.children, out);
      continue;
    }
    out.push({ id: node.id, label: node.label ?? node.tool ?? node.prompt ?? node.variable ?? node.method ?? node.type, sampler: node.type === "sampler" });
  }
  return out;
}

function slotId(slot: Slot): string {
  return `${slot.nodeId}\0${slot.key}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(cleaned) ? `p_${cleaned}` : cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasEnabledTool(nodes: SuiteNode[]): boolean {
  return nodes.some((node) => node.enabled !== false && (node.method === "tools/call" || hasEnabledTool(node.children ?? [])));
}
