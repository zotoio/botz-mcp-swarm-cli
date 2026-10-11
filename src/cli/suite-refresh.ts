import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { buildDefaultSuiteNodes, type ServerSurface, type SuiteNode } from "../engine/core/suite-model.js";
import { introspectServer } from "../engine/core/suite-introspect.js";
import { parseSuiteFile, resolveSuiteExecution, type SuiteFile } from "./suite-file.js";
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
export function refreshSuiteModel(suite: SuiteFile, surface: ServerSurface) {
  const before = entries(suite.surface), after = entries(surface);
  const changes = {
    added: [...after.keys()].filter((key) => !before.has(key)).sort(),
    removed: [...before.keys()].filter((key) => !after.has(key)).sort(),
    changed: [...after.keys()].filter((key) => before.has(key) && before.get(key) !== after.get(key)).sort(),
  };
  const defaults = buildDefaultSuiteNodes(surface)[0]?.children ?? [];
  const known = new Set<string>();
  const disabled: string[] = [];
  const visit = (nodes: SuiteNode[]): SuiteNode[] => nodes.map((node) => {
    const key = slot(node);
    if (key) known.add(key);
    // Retain removed steps and their edits, but stop executing unavailable methods/entities.
    const retired = node.tool ? !surface.tools.some((item) => item.name === node.tool)
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
  const destination = nodes.find((node) => node.type === "group")?.children ?? nodes;
  const teardown = destination.findIndex((node) => node.method === "teardown");
  destination.splice(teardown < 0 ? destination.length : teardown, 0, ...additions);
  const updated = parseSuiteFile({ ...suite, surface, nodes, capturedAt: new Date().toISOString() });
  return { suite: updated, changes: { ...changes, disabledNodes: disabled, addedNodes: additions.map((node) => node.id) } };
}

export async function refreshSavedSuite(dir: string, options: { dryRun?: boolean; auth?: AuthFlags; botz?: ReturnType<typeof resolveBotzHome> } = {}) {
  const path = join(dir, "suite.json");
  const original = await readFile(path, "utf8");
  const { suite, target, baseDir } = await resolveSuiteExecution(dir, options);
  const surface = await introspectServer(target, baseDir);
  const result = refreshSuiteModel(suite, surface);
  if (!options.dryRun) await withFileLock(`${dir}.lock`, async () => {
    if (await readFile(path, "utf8") !== original) throw new Error("suite changed during discovery; retry refresh");
    // Parameter files are untouched, including any user-edited example values.
    await atomicWrite(path, JSON.stringify(result.suite, null, 2), 0o644);
  });
  return result;
}
export function registerRefreshCommand(suite: Command): void {
  addAuthOptions(suite.command("refresh").description("Discover changes while preserving edited steps, assertions, and parameters")
    .requiredOption("--suite <dir|name>", "Saved suite")
    .option("--dry-run", "Connect and show changes without writing")
    .option("--json", "Machine-readable changes"))
    .action(async (opts: AuthFlags & { suite: string; dryRun?: boolean; json?: boolean }) => {
      const botz = resolveBotzHome();
      const { changes } = await refreshSavedSuite(resolveSuiteArg(opts.suite, botz), { botz, dryRun: opts.dryRun, auth: authFlags(opts) });
      console.log(opts.json ? JSON.stringify({ applied: !opts.dryRun, ...changes }) : [
        opts.dryRun ? "Refresh preview (no files changed)." : "Suite refreshed.",
        ...Object.entries(changes).map(([kind, items]) => `${kind}: ${items.join(", ") || "(none)"}`),
        "Existing assertions and arguments are preserved; review changed schemas. Removed steps are retained disabled.",
      ].join("\n"));
    });
}
