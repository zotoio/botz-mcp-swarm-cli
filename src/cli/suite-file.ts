import { SuiteInputSchema, SuiteLoadSchema } from "./suite-schema.js";
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
  normalizeLoadProfile,
  toolIsCalledByDefault,
  type LoadProfile,
  type ServerSurface,
  type SuiteNode,
} from "../engine/core/suite-model.js";
import { runManifest } from "../engine/core/runner.js";
import { applyToolEvalVerdict, evaluateSuiteTools, generateToolTestData } from "../engine/core/tool-evals.js";
import { inferenceSecretValues } from "../engine/core/inference-model.js";
import { TargetSchema, type Manifest, type Target } from "../engine/types/manifest.js";
import type { RunReport } from "../engine/types/run.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const BUILTIN = new Set(["__uuid", "__ts", "__thread", "__iter", "__loop"]);

export interface SuiteParam {
  example: string;
  usedBy: string[];
}

export interface SuiteFile {
  /** Unversioned files are read as legacy version 1. */
  schemaVersion?: 1;
  /** Stable credential identity; legacy suites use their name. */
  id?: string;
  /** Outside a repo, cwd is relative to the suite directory. */
  cwdBase?: "suite";
  kind: "botz-suite";
  capturedAt: string;
  name: string;
  target: Target;
  surface: ServerSurface;
  nodes: SuiteNode[];
  load: LoadProfile;
  params: Record<string, SuiteParam>;
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

export function captureLoadProfile(): LoadProfile {
  return {
    durationMs: 0,
    rampUpMs: 0,
    maxConcurrency: 1,
    jitterMs: 0,
    rampDownMs: 0,
    dwellMs: 0,
    iterations: 1,
    lanes: 1,
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
  const unknown = [...suiteArgParams(suite.nodes)].filter((name) => !suite.params[name]).sort();
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
  const target = suite.target.transport === "stdio"
    ? `stdio ${suite.target.command}`
    : `${suite.target.transport} ${suite.target.url}`;
  const auth = formatAuth(suite.target);
  const lines = [suite.name, `target: ${target}`];
  if (auth.length > 0) lines.push("auth:", ...auth);
  lines.push("", "steps:");
  const steps = enabledLabels(suite.nodes);
  if (steps.length === 0) lines.push("  (none)");
  else for (const step of steps) lines.push(`  ${step}`);
  lines.push("", "parameters:");
  const names = Object.keys(suite.params).sort();
  if (names.length === 0) lines.push("  (none)");
  else for (const name of names) lines.push(`  ${name}`);
  return lines.join("\n");
}

export function disabledToolNames(surface: ServerSurface): string[] {
  return surface.tools.filter((tool) => !toolIsCalledByDefault(tool)).map((tool) => tool.name);
}

export function parseSuiteFile(raw: unknown): SuiteFile {
  if (!isRecord(raw) || raw.kind !== "botz-suite") throw new Error("not a botz suite");
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) throw new Error("unsupported suite schemaVersion; upgrade the CLI");
  if (raw.id !== undefined && (typeof raw.id !== "string" || !/^[a-zA-Z0-9-]+$/.test(raw.id))) throw new Error("invalid suite id");
  const validated = SuiteInputSchema.parse(raw);
  const target = TargetSchema.parse(raw.target);
  if (typeof raw.name !== "string" || raw.name.trim().length === 0) throw new Error("suite name is required");
  if (!Array.isArray(raw.nodes)) throw new Error("suite nodes are required");
  if (!isRecord(raw.params)) throw new Error("suite params are required");
  if (!isRecord(raw.surface) || !Array.isArray(raw.surface.tools) || !Array.isArray(raw.surface.capabilities)) {
    throw new Error("suite surface is invalid");
  }
  const capabilities: unknown[] = raw.surface.capabilities;
  const params: Record<string, SuiteParam> = {};
  for (const [key, value] of Object.entries(raw.params)) {
    if (!isRecord(value) || typeof value.example !== "string" || !Array.isArray(value.usedBy)) {
      throw new Error(`parameter ${key} is invalid`);
    }
    params[key] = {
      example: value.example,
      usedBy: value.usedBy.filter((id): id is string => typeof id === "string"),
    };
  }
  const surface = raw.surface;
  return {
    kind: "botz-suite",
    schemaVersion: 1,
    ...(raw.cwdBase === "suite" ? { cwdBase: "suite" as const } : {}),
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : new Date().toISOString(),
    name: raw.name.trim(),
    target,
    surface: {
      serverName: typeof surface.serverName === "string" ? surface.serverName : undefined,
      serverVersion: typeof surface.serverVersion === "string" ? surface.serverVersion : undefined,
      capabilities: capabilities.filter((item): item is string => typeof item === "string"),
      tools: surface.tools as ServerSurface["tools"],
      resources: Array.isArray(surface.resources) ? surface.resources as ServerSurface["resources"] : [],
      resourceTemplates: Array.isArray(surface.resourceTemplates)
        ? surface.resourceTemplates as ServerSurface["resourceTemplates"]
        : [],
      prompts: Array.isArray(surface.prompts) ? surface.prompts as ServerSurface["prompts"] : [],
    },
    nodes: validated.nodes,
    load: normalizeLoadProfile(isRecord(raw.load) ? raw.load as Partial<LoadProfile> : {}),
    params,
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
  await atomicWrite(join(dir, "suite.json"), JSON.stringify(suite, null, 2), 0o644);
}

export async function readParamFile(path: string): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(raw)) throw new Error("parameter file must be a JSON object");
  return raw;
}

/**
 * Introspects the target and writes `suite.json`. Literal header and env values never reach the suite file:
 * they become `${env:NAME}` references and the literals go to `.botz/config.json` under the suite name.
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
}): Promise<SuiteFile & { savedCredentialNames: string[]; movedUrlParam?: string }> {
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
    surface,
    nodes,
    load: captureLoadProfile(),
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
    target?: Target;
    url?: string;
    load?: Partial<LoadProfile>;
}

/** Resolve the same paths, parameters, credentials, and load profile for run, doctor, and validation. */
export async function resolveSuiteExecution(dir: string, options: Partial<SuiteRunOptions> & { resolveSecrets?: boolean } = {}) {
  const suite = await loadSuiteFile(dir);
  const saved = !options.target && !options.url && options.botz ? await suiteCredentials(options.botz, suite.id ?? suite.name) : {};
  const home = options.botz?.home ?? homedir();
  const gitRoot = findGitRoot(dir) ?? options.botz?.repoRoot ?? findGitRoot(options.baseDir ?? process.cwd());
  if (options.target && options.url) throw new Error("provide --url or --target-file, not both");
  if (options.url && suite.target.transport === "stdio") throw new Error("--url requires an HTTP suite; use --target-file to change transport");
  // A replacement endpoint must receive explicitly supplied credentials, never the captured endpoint's secrets.
  const selected = options.target ? TargetSchema.parse(options.target) : options.url
    ? TargetSchema.parse({ transport: suite.target.transport, url: options.url }) : suite.target;
  const resolvedTarget = options.target ? absoluteStdio(selected, options.baseDir ?? process.cwd(), home)
    : runnableStdio(selected, suite.cwdBase === "suite" ? resolve(dir) : gitRoot, home);
  const { target: keyless } = moveUrlCredentials(
    applyAuthFlags(resolvedTarget, options.auth), options.auth?.urlKeyAsBearer,
  );
  assertNoUrlCredentials(keyless);
  const target = options.resolveSecrets === false ? keyless : resolveTargetSecrets(keyless, { ...saved, ...process.env });
  const params = await resolveSuiteParamValues(dir, suite, options.params);
  assertParamsReady(suite, params);
  const load = normalizeLoadProfile(SuiteLoadSchema.parse({
    ...suite.load,
    ...options.load,
    ...(options.iterations !== undefined ? { iterations: options.iterations } : {}),
    ...(options.concurrency !== undefined ? { maxConcurrency: options.concurrency } : {}),
  }));
  const manifest = compileSuite({
    name: suite.name,
    description: `Suite ${suite.name}`,
    target,
    allowlist: [],
    nodes: suite.nodes,
    load,
  }) as unknown as Manifest;
  const baseDir = (options.target ? options.baseDir ?? process.cwd() : undefined) ?? (suite.cwdBase === "suite" && target.transport === "stdio" ? target.cwd : gitRoot)
    ?? (target.transport === "stdio" ? target.cwd : undefined) ?? options.baseDir ?? dir;
  return { suite, saved, home, target, params, manifest, baseDir };
}

/**
 * Standalone run of a saved suite. The suite's own target is the only consent: no allowlist, org policy,
 * role grant, or principal is consulted. The returned report is already scrubbed of secrets and user paths.
 */
export async function runSavedSuite(
  dir: string,
  options: SuiteRunOptions,
): Promise<SuiteRunResult> {
  const { suite, saved, home, target, params, manifest, baseDir } = await resolveSuiteExecution(dir, options);
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
      const evals = await evaluateSuiteTools({ nodes: suite.nodes, target, baseDir,
        fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([
          ...(init?.signal ? [init.signal] : []), ...(options.signal ? [options.signal] : []),
        ]) }),
      });
      raw = applyToolEvalVerdict(raw, evals ?? { cases: [], failReasons: ["inference requested but suite has no enabled tool evals"] });
    } catch {
      raw = applyToolEvalVerdict(raw, { cases: [], failReasons: ["tool inference failed; check the model endpoint and configuration"] });
    }
  }
  raw.params = params;
  const scrub = makeReportScrubber({
    ...defaultScrubContext(options.botz?.cwd ?? process.cwd()),
    home,
    secrets: [...targetSecretValues(target), ...Object.values(saved),
      ...inferenceSecretValues(), process.env.TYPESAFE_API_KEY ?? ""],
    commands: stdioCommandPaths(target, baseDir),
  });
  const report = scrubReport(raw, scrub);
  const written = options.reportBaseName
    ? await writeNamedReports(report, options.outputDir, options.reportBaseName)
    : await writeReports(report, options.outputDir);
  return { report, ...written };
}

/** `botz-run-<timestamp>` for a cwd report. */
export function cwdReportBaseName(now: Date = new Date()): string {
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
function absoluteStdio(target: Target, cwd: string, home: string): Target {
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
function portableStdio(target: Target, roots: PathRoots): Target {
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
function runnableStdio(target: Target, gitRoot: string | null, home: string): Target {
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

function enabledLabels(nodes: SuiteNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (!node.enabled) continue;
    if (node.type === "group" || node.type === "loop") {
      if (node.children) enabledLabels(node.children, out);
      continue;
    }
    out.push(node.label ?? node.method ?? node.type);
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
