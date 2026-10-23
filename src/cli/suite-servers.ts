import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { normalizeCallSlo, type CallSlo } from "../engine/core/call-slo.js";
import { serverEndpoint } from "../engine/core/run-server.js";
import {
  assertServerAlias,
  DEFAULT_SERVER,
  MAX_SERVERS,
  nodeTakesServer,
  resolveNodeServers,
} from "../engine/core/servers.js";
import { introspectServer } from "../engine/core/suite-introspect.js";
import { buildDefaultSuiteNodes, generatedLoadProfile, type SuiteNode } from "../engine/core/suite-model.js";
import { envRefPrefix } from "../engine/core/target-env-ref.js";
import { generateToolTestData } from "../engine/core/tool-evals.js";
import type { Target } from "../engine/types/manifest.js";
import {
  displayPath,
  findGitRoot,
  renameSuiteCredentials,
  resolveBotzHome,
  resolveSuiteArg,
  saveSuiteCredentials,
  type BotzHome,
} from "./botz-home.js";
import { atomicWrite, withFileLock } from "./file-store.js";
import {
  applyAuthFlags,
  assertNoUrlCredentials,
  moveUrlCredentials,
  resolveTargetSecrets,
  splitLiteralCredentials,
  type AuthFlags,
} from "./suite-auth.js";
import { addAuthOptions, authFlags, collect } from "./suite-commands.js";
import {
  absoluteStdio,
  disabledToolNames,
  isMultiServer,
  loadSuiteFile,
  parameterizeSuiteNodes,
  parseSuiteFile,
  portableStdio,
  suiteDefaultAlias,
  suiteServers,
  suiteToJson,
  targetFromCaptureFlags,
  type SuiteFile,
  type SuiteParam,
  type SuiteServer,
} from "./suite-file.js";

const TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Read, change, check, and write a suite under its lock. The change sees the file as it is on disk. */
async function updateSuite(dir: string, change: (suite: SuiteFile) => SuiteFile | Promise<SuiteFile>): Promise<SuiteFile> {
  return withFileLock(`${dir}.lock`, async () => {
    const before = await readFile(join(dir, "suite.json"), "utf8");
    const changed = await change(parseSuiteFile(JSON.parse(before)));
    // Parse the result so a change can never write a suite that would not load.
    const checked = parseSuiteFile(suiteToJson(changed));
    await atomicWrite(join(dir, "suite.json"), JSON.stringify(suiteToJson(checked), null, 2), 0o644);
    return checked;
  });
}

function withoutDefault(suite: SuiteFile, servers: Record<string, SuiteServer>): SuiteFile {
  const defaultAlias = suiteDefaultAlias(suite);
  const main = servers[defaultAlias]!;
  const others = Object.fromEntries(Object.entries(servers).filter(([alias]) => alias !== defaultAlias));
  const { servers: _old, serverSlo: _slo, ...rest } = suite;
  return {
    ...rest,
    target: main.target,
    surface: main.surface,
    ...(main.slo ? { serverSlo: main.slo } : {}),
    ...(Object.keys(others).length > 0 ? { servers: others } : {}),
  };
}

function renameTokens(value: unknown, names: Map<string, string>): unknown {
  if (typeof value === "string") return value.replace(TOKEN, (match, name: string) => (names.has(name) ? `\${${names.get(name)}}` : match));
  if (Array.isArray(value)) return value.map((item) => renameTokens(item, names));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, renameTokens(item, names)]));
  }
  return value;
}

/** New parameters join the suite's; a name already taken with another example gets the alias in front. */
function mergeParams(
  existing: Record<string, SuiteParam>,
  added: Record<string, SuiteParam>,
  nodes: SuiteNode[],
  alias: string,
): { params: Record<string, SuiteParam>; nodes: SuiteNode[] } {
  const params = { ...existing };
  const renames = new Map<string, string>();
  for (const [name, spec] of Object.entries(added)) {
    const current = params[name];
    if (!current) {
      params[name] = spec;
      continue;
    }
    if (current.example === spec.example) {
      params[name] = { ...current, usedBy: [...new Set([...current.usedBy, ...spec.usedBy])] };
      continue;
    }
    let renamed = `${alias.replace(/-/g, "_")}_${name}`;
    while (params[renamed]) renamed = `${renamed}_2`;
    renames.set(name, renamed);
    params[renamed] = spec;
  }
  if (renames.size === 0) return { params, nodes };
  const rename = (list: SuiteNode[]): SuiteNode[] => list.map((node) => ({
    ...node,
    ...(node.args ? { args: renameTokens(node.args, renames) as Record<string, unknown> } : {}),
    ...(node.children ? { children: rename(node.children) } : {}),
  }));
  return { params, nodes: rename(nodes) };
}

/**
 * Introspects another server and adds it to a suite under `alias`. Literal credentials go to config.json
 * under names that carry the alias. With `steps`, the server's default contract steps are added in a
 * disabled frame that calls it, following the same write-like rules as capture.
 */
export async function addSuiteServer(dir: string, input: {
  alias: string;
  target: Target;
  auth?: AuthFlags;
  botz?: BotzHome;
  baseDir?: string;
  steps?: boolean;
  inference?: boolean;
}): Promise<{ suite: SuiteFile; server: SuiteServer; savedCredentialNames: string[]; movedUrlParam?: string; addedSteps: number }> {
  assertServerAlias(input.alias, "--alias");
  const current = await loadSuiteFile(dir);
  const existing = suiteServers(current);
  if (existing[input.alias]) throw new Error(`suite ${current.name} already has a server called ${input.alias}`);
  if (Object.keys(existing).length >= MAX_SERVERS) throw new Error(`a suite may use at most ${MAX_SERVERS} servers`);
  const cwd = resolve(input.baseDir ?? process.cwd());
  const home = input.botz?.home ?? homedir();
  const gitRoot = input.botz ? input.botz.repoRoot : findGitRoot(cwd);
  const typed = absoluteStdio(applyAuthFlags(input.target, input.auth), cwd, home);
  const { target: keyless, movedParam } = moveUrlCredentials(typed, input.auth?.urlKeyAsBearer);
  assertNoUrlCredentials(keyless);
  const { target: referenced, credentials } = splitLiteralCredentials(keyless, input.alias);
  if (Object.keys(credentials).length > 0 && !input.botz) throw new Error("literal credentials need a .botz config location");
  const surface = await introspectServer(resolveTargetSecrets(referenced, { ...process.env, ...credentials }), cwd);
  const server: SuiteServer = {
    target: portableStdio(referenced, { gitRoot, home, cwd }),
    surface: { ...surface, latency: undefined },
    capturedAt: new Date().toISOString(),
  };
  let added: { nodes: SuiteNode[]; params: Record<string, SuiteParam> } = { nodes: [], params: {} };
  if (input.steps) {
    const defaults = buildDefaultSuiteNodes(surface);
    if (input.inference === true) {
      for (const node of flatten(defaults)) {
        if (!node.enabled || node.method !== "tools/call" || !node.tool) continue;
        const tool = surface.tools.find((entry) => entry.name === node.tool);
        if (!tool) continue;
        const fixture = await generateToolTestData(tool);
        node.args = fixture.args;
        node.evals = fixture.evals;
      }
    }
    const parameterized = parameterizeSuiteNodes(defaults, surface);
    added = {
      nodes: parameterized.nodes.map((node) => ({
        ...node,
        server: input.alias,
        enabled: false,
        label: `${input.alias} contract`,
      })),
      params: parameterized.params,
    };
  }
  const suite = await updateSuite(dir, (latest) => {
    const servers = { ...suiteServers(latest), [input.alias]: server };
    if (servers[input.alias] !== server) throw new Error(`suite ${latest.name} already has a server called ${input.alias}`);
    const merged = mergeParams(latest.params, added.params, added.nodes, input.alias);
    // The slowest server sizes the drain, so in-flight calls on it can finish.
    const rampDownMs = Math.max(latest.load.rampDownMs, generatedLoadProfile(latest.nodes, surface.latency).rampDownMs);
    return withoutDefault({
      ...latest,
      nodes: [...latest.nodes, ...merged.nodes],
      params: merged.params,
      load: { ...latest.load, rampDownMs },
    }, servers);
  });
  if (input.botz) await saveSuiteCredentials(input.botz, suite.id ?? suite.name, credentials);
  return {
    suite,
    server,
    savedCredentialNames: Object.keys(credentials).sort(),
    ...(movedParam ? { movedUrlParam: movedParam } : {}),
    addedSteps: flatten(added.nodes).filter((node) => node.type === "sampler").length,
  };
}

function flatten(nodes: SuiteNode[]): SuiteNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

/** Enabled samplers that call `alias`. */
function stepsOn(suite: SuiteFile, alias: string): SuiteNode[] {
  const servers = resolveNodeServers(suite.nodes, suiteDefaultAlias(suite));
  const enabled: SuiteNode[] = [];
  const walk = (list: SuiteNode[], active: boolean) => {
    for (const node of list) {
      const on = active && node.enabled !== false;
      if (on && node.type === "sampler" && servers.get(node.id) === alias) enabled.push(node);
      if (node.children) walk(node.children, on);
    }
  };
  walk(suite.nodes, true);
  return enabled;
}

export interface ServerRow {
  alias: string;
  default: boolean;
  transport: Target["transport"];
  endpoint: string;
  tools: number;
  steps: number;
  slo?: CallSlo;
}

export function listSuiteServers(suite: SuiteFile): ServerRow[] {
  const defaultAlias = suiteDefaultAlias(suite);
  return Object.entries(suiteServers(suite)).map(([alias, server]) => ({
    alias,
    default: alias === defaultAlias,
    transport: server.target.transport,
    endpoint: serverEndpoint(server.target),
    tools: server.surface.tools.length,
    steps: stepsOn(suite, alias).length,
    ...(server.slo ? { slo: server.slo } : {}),
  }));
}

/**
 * Removes a server. Refused while an enabled step calls it, unless `force`, which disables those steps.
 * The default server cannot be removed; make another server the default first.
 */
export async function removeSuiteServer(dir: string, alias: string, force = false): Promise<{ suite: SuiteFile; disabled: string[] }> {
  let disabled: string[] = [];
  const suite = await updateSuite(dir, (latest) => {
    const servers = suiteServers(latest);
    if (!servers[alias]) throw new Error(`"${alias}" is not a server in suite ${latest.name}`);
    if (alias === suiteDefaultAlias(latest)) throw new Error(`${alias} is the default server; make another server the default first`);
    const using = stepsOn(latest, alias).map((node) => node.id);
    if (using.length > 0 && !force) throw new Error(`server ${alias} is used by enabled steps: ${using.join(", ")}; pass --force to disable them`);
    disabled = using;
    const resolved = resolveNodeServers(latest.nodes, suiteDefaultAlias(latest));
    const strip = (list: SuiteNode[]): SuiteNode[] => list.map((node) => {
      const { server, ...rest } = node;
      const onAlias = node.type === "sampler" && resolved.get(node.id) === alias;
      return {
        ...(server === alias ? rest : node),
        ...(onAlias ? { enabled: false } : {}),
        ...(node.children ? { children: strip(node.children) } : {}),
      };
    });
    const { [alias]: _removed, ...rest } = servers;
    return withoutDefault({ ...latest, nodes: strip(latest.nodes) }, rest);
  });
  return { suite, disabled };
}

/** Renames an alias in the server list, steps, credential references, and saved credentials. */
export async function renameSuiteServer(dir: string, from: string, to: string, botz?: BotzHome): Promise<SuiteFile> {
  assertServerAlias(to, "--to");
  let renamedCredentials = false;
  const suite = await updateSuite(dir, (latest) => {
    const servers = suiteServers(latest);
    if (!servers[from]) throw new Error(`"${from}" is not a server in suite ${latest.name}`);
    if (servers[to]) throw new Error(`suite ${latest.name} already has a server called ${to}`);
    const isDefault = suiteDefaultAlias(latest) === from;
    const rename = (list: SuiteNode[]): SuiteNode[] => list.map((node) => ({
      ...node,
      ...(node.server === from ? { server: to } : {}),
      ...(node.children ? { children: rename(node.children) } : {}),
    }));
    const renamed = Object.fromEntries(Object.entries(servers).map(([alias, server]) => {
      if (alias !== from) return [alias, server];
      // The default server's credential names carry no alias, so only another server's names change.
      renamedCredentials = !isDefault;
      return [to, isDefault ? server : { ...server, target: renameEnvRefs(server.target, envRefPrefix(from), envRefPrefix(to)) }];
    }));
    return withoutDefault({
      ...latest,
      ...(isDefault ? { defaultServer: to === DEFAULT_SERVER ? undefined : to } : {}),
      nodes: rename(latest.nodes),
    }, renamed);
  });
  if (renamedCredentials && botz) await renameSuiteCredentials(botz, suite.id ?? suite.name, envRefPrefix(from), envRefPrefix(to));
  return suite;
}

function renameEnvRefs(target: Target, from: string, to: string): Target {
  const swap = (values?: Record<string, string>) => values
    ? Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.split(`\${env:${from}`).join(`\${env:${to}`)]))
    : undefined;
  if (target.transport === "stdio") return target.env ? { ...target, env: swap(target.env) } : target;
  return target.headers ? { ...target, headers: swap(target.headers) } : target;
}

/**
 * Makes another server the default. Steps keep calling the server they called before: top-level steps and
 * frames without their own server are pinned to the old default.
 */
export async function setDefaultSuiteServer(dir: string, alias: string): Promise<SuiteFile> {
  return updateSuite(dir, (latest) => {
    const servers = suiteServers(latest);
    if (!servers[alias]) throw new Error(`"${alias}" is not a server in suite ${latest.name}`);
    const previous = suiteDefaultAlias(latest);
    if (previous === alias) return latest;
    const nodes = latest.nodes.map((node) => (nodeTakesServer(node) && node.server === undefined ? { ...node, server: previous } : node));
    const unpin = (list: SuiteNode[]): SuiteNode[] => list.map((node) => {
      const { server, ...rest } = node;
      return { ...(server === alias ? rest : node), ...(node.children ? { children: unpin(node.children) } : {}) };
    });
    return withoutDefault({ ...latest, defaultServer: alias === DEFAULT_SERVER ? undefined : alias, nodes: unpin(nodes) }, servers);
  });
}

/** Sets or clears one server's objective. */
export async function setSuiteServerSlo(dir: string, alias: string, slo: CallSlo | undefined): Promise<SuiteFile> {
  return updateSuite(dir, (latest) => {
    const servers = suiteServers(latest);
    const server = servers[alias];
    if (!server) throw new Error(`"${alias}" is not a server in suite ${latest.name}`);
    const normalized = normalizeCallSlo(slo);
    const { slo: _old, ...rest } = server;
    return withoutDefault(latest, { ...servers, [alias]: normalized ? { ...rest, slo: normalized } : rest });
  });
}

function sloText(slo?: CallSlo): string {
  if (!slo) return "";
  return [
    slo.maxP95Ms !== undefined ? `p95<=${slo.maxP95Ms}ms` : "",
    slo.maxP99Ms !== undefined ? `p99<=${slo.maxP99Ms}ms` : "",
    slo.maxErrorRate !== undefined ? `errors<=${slo.maxErrorRate}` : "",
  ].filter(Boolean).join(" ");
}

function number(value: string | undefined, label: string, max?: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (max !== undefined && parsed > max)) throw new Error(`${label} must be a number${max !== undefined ? ` from 0 to ${max}` : " >= 0"}`);
  return parsed;
}

export function registerServerCommands(suite: Command): void {
  const server = suite.command("server").description("Add, list, rename, and remove the MCP servers a suite calls");

  addAuthOptions(server.command("add")
    .description("Introspect another MCP server and add it to a suite under an alias")
    .requiredOption("--suite <dir|name>", "Saved suite")
    .requiredOption("--alias <alias>", "Short name steps use for this server: 1-32 of a-z, 0-9 and -")
    .option("--url <url>", "Streamable HTTP endpoint")
    .option("--command <bin>", "stdio command")
    .option("--arg <a>", "stdio argument. Repeat for each argument", collect, [])
    .option("--steps", "Also add the server's default contract steps, in a disabled frame")
    .option("--inference", "With --steps, generate tool arguments and eval prompts with a model (opt in)", false))
    .action(async (opts: AuthFlags & { suite: string; alias: string; url?: string; command?: string; arg?: string[]; steps?: boolean; inference?: boolean }) => {
      const botz = resolveBotzHome();
      const dir = resolveSuiteArg(opts.suite, botz);
      const result = await addSuiteServer(dir, {
        alias: opts.alias,
        target: targetFromCaptureFlags(opts),
        auth: authFlags(opts),
        botz,
        baseDir: process.cwd(),
        steps: opts.steps,
        inference: opts.inference,
      });
      if (result.movedUrlParam) console.log(`Moved the URL query parameter ${result.movedUrlParam} to an Authorization: Bearer header`);
      if (result.savedCredentialNames.length > 0) {
        console.log(`Credentials saved to ${botz.display}/config.json (not committed): ${result.savedCredentialNames.join(", ")}`);
      }
      console.log(`Server ${opts.alias}: ${result.server.surface.tools.length} tools`);
      const disabled = disabledToolNames(result.server.surface);
      if (opts.steps) console.log(`Steps: ${result.addedSteps} added in a disabled frame "${opts.alias} contract"; enable them in the suite`);
      if (opts.steps && disabled.length > 0) console.log(`Disabled: ${disabled.join(", ")}`);
      console.log(`Written: ${displayPath(join(dir, "suite.json"), botz, opts.suite)}`);
    });

  server.command("list")
    .description("Show each server's alias, endpoint, tools, and the steps that call it")
    .requiredOption("--suite <dir|name>", "Saved suite")
    .option("--json", "Machine-readable output")
    .action(async (opts: { suite: string; json?: boolean }) => {
      const suite = await loadSuiteFile(resolveSuiteArg(opts.suite, resolveBotzHome()));
      const rows = listSuiteServers(suite);
      if (opts.json) {
        console.log(JSON.stringify(rows));
        return;
      }
      for (const row of rows) {
        const slo = sloText(row.slo);
        console.log(`${row.alias}${row.default ? " (default)" : ""}\t${row.transport} ${row.endpoint}\t${row.tools} tools\t${row.steps} steps${slo ? `\t${slo}` : ""}`);
      }
    });

  server.command("remove")
    .description("Remove a server. Refused while an enabled step calls it")
    .requiredOption("--suite <dir|name>", "Saved suite")
    .requiredOption("--alias <alias>", "Server to remove")
    .option("--force", "Disable the steps that call it")
    .action(async (opts: { suite: string; alias: string; force?: boolean }) => {
      const { suite, disabled } = await removeSuiteServer(resolveSuiteArg(opts.suite, resolveBotzHome()), opts.alias, opts.force);
      if (disabled.length > 0) console.log(`Disabled steps: ${disabled.join(", ")}`);
      console.log(`Removed ${opts.alias}. Servers: ${Object.keys(suiteServers(suite)).join(", ")}`);
    });

  server.command("rename")
    .description("Rename a server's alias in the suite, its steps, and its saved credentials")
    .requiredOption("--suite <dir|name>", "Saved suite")
    .requiredOption("--alias <alias>", "Current alias")
    .requiredOption("--to <alias>", "New alias")
    .action(async (opts: { suite: string; alias: string; to: string }) => {
      const botz = resolveBotzHome();
      const suite = await renameSuiteServer(resolveSuiteArg(opts.suite, botz), opts.alias, opts.to, botz);
      console.log(`Renamed ${opts.alias} to ${opts.to}. Servers: ${Object.keys(suiteServers(suite)).join(", ")}`);
      if (isMultiServer(suite) && opts.alias !== suiteDefaultAlias(suite)) {
        console.log(`Environment variables for ${opts.to} now start with ${envRefPrefix(opts.to)}`);
      }
    });

  server.command("default")
    .description("Make another server the default. Steps keep calling the server they called")
    .requiredOption("--suite <dir|name>", "Saved suite")
    .requiredOption("--alias <alias>", "New default server")
    .action(async (opts: { suite: string; alias: string }) => {
      await setDefaultSuiteServer(resolveSuiteArg(opts.suite, resolveBotzHome()), opts.alias);
      console.log(`Default server: ${opts.alias}`);
    });

  server.command("slo")
    .description("Set a server's objectives, judged over every tool call on it. No limits clears them")
    .requiredOption("--suite <dir|name>", "Saved suite")
    .requiredOption("--alias <alias>", "Server")
    .option("--max-p95-ms <ms>", "p95 tool-call duration limit")
    .option("--max-p99-ms <ms>", "p99 tool-call duration limit")
    .option("--max-error-rate <rate>", "Share of tool calls that may fail, from 0 to 1")
    .action(async (opts: { suite: string; alias: string; maxP95Ms?: string; maxP99Ms?: string; maxErrorRate?: string }) => {
      const slo = {
        maxP95Ms: number(opts.maxP95Ms, "--max-p95-ms"),
        maxP99Ms: number(opts.maxP99Ms, "--max-p99-ms"),
        maxErrorRate: number(opts.maxErrorRate, "--max-error-rate", 1),
      };
      const suite = await setSuiteServerSlo(resolveSuiteArg(opts.suite, resolveBotzHome()), opts.alias, slo);
      const text = sloText(suiteServers(suite)[opts.alias]?.slo);
      console.log(text ? `Server ${opts.alias}: ${text}` : `Server ${opts.alias}: no objectives`);
    });
}
