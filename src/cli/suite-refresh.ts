import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { buildDefaultSuiteNodes, type ServerSurface, type SuiteNode } from "../engine/core/suite-model.js";
import { introspectServer } from "../engine/core/suite-introspect.js";
import { isMultiServer, parseSuiteFile, resolveSuiteExecution, suiteDefaultAlias, suiteServers, suiteToJson, type SuiteFile } from "./suite-file.js";
import { resolveNodeServers } from "../engine/core/servers.js";
import { atomicWrite, withFileLock } from "./file-store.js";
import { resolveBotzHome, resolveSuiteArg } from "./botz-home.js";
import { addAuthOptions, authFlags } from "./suite-commands.js";
import type { AuthFlags } from "./suite-auth.js";

function slot(node: SuiteNode): string | undefined {
  return node.type === "sampler" ? JSON.stringify([node.method, node.tool, node.resourceUri, node.prompt]) : undefined;
}
function entries(surface: ServerSurface): Map<string, string> {
  return new Map([
    ...surface.tools.map((item) => [`tool:${item.name}`, item.schemaHash] as [string, string]),
    ...surface.resources.map((item) => [`resource:${item.uri}`, JSON.stringify(item)] as [string, string]),
    ...surface.prompts.map((item) => [`prompt:${item.name}`, JSON.stringify(item)] as [string, string]),
    ...surface.resourceTemplates.map((item) => [`template:${item.uriTemplate}`, JSON.stringify(item)] as [string, string]),
    ...surface.capabilities.map((item) => [`capability:${item}`, ""] as [string, string]),
  ]);
}
export interface RefreshChanges {
  added: string[];
  removed: string[];
  changed: string[];
  disabledNodes: string[];
  addedNodes: string[];
}

/**
 * Applies one server's new surface. Only steps that call that server are retired; new default steps join the
 * captured contract group (the default server's first group, or a frame that calls the server).
 */
export function refreshSuiteModel(suite: SuiteFile, surface: ServerSurface, alias: string = suiteDefaultAlias(suite)) {
  const all = suiteServers(suite);
  const current = all[alias];
  if (!current) throw new Error(`"${alias}" is not a server in suite ${suite.name}`);
  const defaultAlias = suiteDefaultAlias(suite);
  const resolved = resolveNodeServers(suite.nodes, defaultAlias);
  const before = entries(current.surface), after = entries(surface);
  const changes = {
    added: [...after.keys()].filter((key) => !before.has(key)).sort(),
    removed: [...before.keys()].filter((key) => !after.has(key)).sort(),
    changed: [...after.keys()].filter((key) => before.has(key) && before.get(key) !== after.get(key)).sort(),
  };
  const defaults = buildDefaultSuiteNodes(surface)[0]?.children ?? [];
  const known = new Set<string>();
  const disabled: string[] = [];
  const visit = (nodes: SuiteNode[]): SuiteNode[] => nodes.map((node) => {
    const mine = node.type !== "sampler" || resolved.get(node.id) === alias;
    const key = mine ? slot(node) : undefined;
    if (key) known.add(key);
    // Retain removed steps and their edits, but stop executing unavailable methods/entities.
    const retired = !mine || node.type !== "sampler" ? false
      : node.tool ? !surface.tools.some((item) => item.name === node.tool)
      : node.prompt ? !surface.prompts.some((item) => item.name === node.prompt)
      : node.method === "resources/read" ? !surface.resources.some((item) => item.uri === node.resourceUri) && surface.resourceTemplates.length === 0
      : node.method?.startsWith("tools/") ? !surface.capabilities.includes("tools")
      : node.method?.startsWith("resources/") ? !surface.capabilities.includes("resources")
      : node.method?.startsWith("prompts/") ? !surface.capabilities.includes("prompts") : false;
    if (retired && node.enabled) disabled.push(node.id);
    return { ...node, ...(retired ? { enabled: false } : {}), ...(node.children ? { children: visit(node.children) } : {}) };
  });
  const nodes = visit(structuredClone(suite.nodes));
  const additions = defaults.filter((node) => { const key = slot(node); return key && !known.has(key); });
  // Add inside the captured group before shutdown; leave custom hierarchy and existing steps intact.
  const destination = alias === defaultAlias
    ? nodes.find((node) => node.type === "group" && (node.server ?? defaultAlias) === alias)?.children ?? nodes
    : nodes.find((node) => node.type === "group" && node.server === alias)?.children;
  if (destination) {
    const teardown = destination.findIndex((node) => node.method === "teardown");
    destination.splice(teardown < 0 ? destination.length : teardown, 0, ...additions);
  }
  const placed = destination ? additions : [];
  const servers = { ...all, [alias]: { ...current, surface: { ...surface, latency: undefined }, ...(alias === defaultAlias ? {} : { capturedAt: new Date().toISOString() }) } };
  const main = servers[defaultAlias]!;
  const others = Object.fromEntries(Object.entries(servers).filter(([key]) => key !== defaultAlias));
  const updated = parseSuiteFile(suiteToJson({
    ...suite,
    target: main.target,
    surface: main.surface,
    ...(Object.keys(others).length > 0 ? { servers: others } : {}),
    nodes,
    capturedAt: alias === defaultAlias ? new Date().toISOString() : suite.capturedAt,
  }));
  const result: RefreshChanges = { ...changes, disabledNodes: disabled, addedNodes: placed.map((node) => node.id) };
  return { suite: updated, changes: result };
}

export async function refreshSavedSuite(dir: string, options: { dryRun?: boolean; auth?: AuthFlags; botz?: ReturnType<typeof resolveBotzHome>; server?: string } = {}) {
  const path = join(dir, "suite.json");
  const original = await readFile(path, "utf8");
  const { suite, targets, baseDir } = await resolveSuiteExecution(dir, options);
  if (options.server && !targets.has(options.server)) throw new Error(`"${options.server}" is not a server in suite ${suite.name}`);
  let updated = suite;
  const byServer: Record<string, RefreshChanges> = {};
  for (const [alias, target] of targets) {
    if (options.server && alias !== options.server) continue;
    const surface = await introspectServer(target, baseDir);
    const result = refreshSuiteModel(updated, surface, alias);
    updated = result.suite;
    byServer[alias] = result.changes;
  }
  if (!options.dryRun) await withFileLock(`${dir}.lock`, async () => {
    if (await readFile(path, "utf8") !== original) throw new Error("suite changed during discovery; retry refresh");
    // Parameter files are untouched, including any user-edited example values.
    await atomicWrite(path, JSON.stringify(suiteToJson(updated), null, 2), 0o644);
  });
  const only = Object.keys(byServer).length === 1 && !isMultiServer(suite) ? Object.values(byServer)[0]! : undefined;
  return { suite: updated, changes: only ?? Object.values(byServer)[0]!, byServer, multi: isMultiServer(suite) };
}

export function registerRefreshCommand(suite: Command): void {
  addAuthOptions(suite.command("refresh").description("Discover changes while preserving edited steps, assertions, and parameters")
    .requiredOption("--suite <dir|name>", "Saved suite")
    .option("--server <alias>", "Refresh one server of a multi-server suite")
    .option("--dry-run", "Connect and show changes without writing")
    .option("--json", "Machine-readable changes"))
    .action(async (opts: AuthFlags & { suite: string; server?: string; dryRun?: boolean; json?: boolean }) => {
      const botz = resolveBotzHome();
      const { changes, byServer, multi } = await refreshSavedSuite(resolveSuiteArg(opts.suite, botz), { botz, dryRun: opts.dryRun, auth: authFlags(opts), server: opts.server });
      const lines = (items: RefreshChanges, indent = "") => Object.entries(items).map(([kind, list]) => `${indent}${kind}: ${list.join(", ") || "(none)"}`);
      if (opts.json) {
        console.log(JSON.stringify(multi ? { applied: !opts.dryRun, servers: byServer } : { applied: !opts.dryRun, ...changes }));
        return;
      }
      console.log([
        opts.dryRun ? "Refresh preview (no files changed)." : "Suite refreshed.",
        ...(multi ? Object.entries(byServer).flatMap(([alias, items]) => [`${alias}:`, ...lines(items, "  ")]) : lines(changes)),
        "Existing assertions and arguments are preserved; review changed schemas. Removed steps are retained disabled.",
      ].join("\n"));
    });
}
