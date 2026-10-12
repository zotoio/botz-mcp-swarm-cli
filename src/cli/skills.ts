import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, parse, relative } from "node:path";
import { Command, Option } from "commander";
import { z } from "zod";
import { findGitRoot } from "./botz-home.js";

export const agentDirectories = { cursor: ".cursor", "claude-code": ".claude", codex: ".agents" } as const;
type Agent = keyof typeof agentDirectories;
type Action = "install" | "update" | "status" | "uninstall";
const agentSchema = z.enum(["cursor", "claude-code", "codex"]);
const nameSchema = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const recordSchema = z.object({
  agent: agentSchema, name: nameSchema, version: z.string(),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
}).strict();
const registrySchema = z.object({ schemaVersion: z.literal(1), installations: z.array(recordSchema) }).strict();
type Registry = z.infer<typeof registrySchema>;
type Installation = z.infer<typeof recordSchema>;
type Files = Record<string, Buffer>;
export type SkillsResult = { agent: Agent; name: string; state: string; installedVersion?: string; bundledVersion: string };

// Reject symlinks in managed paths, including broken links. Never traverse a user's linked configuration.
function assertNoLinks(path: string): void {
  let current = parse(resolve(path)).root;
  for (const part of relative(current, resolve(path)).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
function readFiles(root: string, prefix = ""): Files {
  assertNoLinks(root);
  const files: Files = {};
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, readFiles(join(root, entry.name), `${name}/`));
    else if (entry.isFile()) files[name] = readFileSync(join(root, entry.name));
    else throw new Error(`Refusing non-regular skill file: ${name}`);
  }
  return files;
}
function hashes(files: Files): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([name, content]) => [name, createHash("sha256").update(content).digest("hex")]));
}
function same(a: Record<string, string>, b: Record<string, string>): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
}
function saveRegistry(path: string, registry: Registry): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(registry, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

export function manageSkills(input: {
  action: Action; packageRoot: string; base: string; agents?: Agent[];
}): SkillsResult[] {
  const { action, packageRoot } = input;
  const base = realpathSync(input.base);
  const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version as string;
  const source = join(realpathSync(packageRoot), "agent-plugin", "skills");
  const bundled = new Map<string, Files>();
  for (const name of readdirSync(source).sort()) {
    nameSchema.parse(name);
    const files = readFiles(join(source, name));
    if (!files["SKILL.md"]) throw new Error(`Missing SKILL.md: ${name}`);
    bundled.set(name, files);
  }
  const registryPath = join(base, ".botz", "mcp-swarm", "skill-installations.json");
  assertNoLinks(registryPath);
  const lock = join(base, ".botz", "mcp-swarm", "skill-installations.lock");
  let lockFd: number | undefined;
  if (action !== "status") {
    mkdirSync(dirname(registryPath), { recursive: true });
    try { lockFd = openSync(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Another skills operation is running. If it was interrupted, remove ${lock} before retrying.`);
      throw error;
    }
  }
  try {
    const registry: Registry = existsSync(registryPath)
      ? registrySchema.parse(JSON.parse(readFileSync(registryPath, "utf8")))
      : { schemaVersion: 1, installations: [] };
    const agents = [...new Set(input.agents ?? (action === "status" ? Object.keys(agentDirectories) as Agent[] : registry.installations.map(i => i.agent)))];
    if (action === "install" && !agents.length) throw new Error("Choose at least one --agent: cursor, claude-code, codex");
    const results: SkillsResult[] = [];
    for (const agent of agents) {
      agentSchema.parse(agent);
      const installed = registry.installations.filter(i => i.agent === agent);
      const names = new Set([...installed.map(i => i.name), ...((action === "install" || action === "status" || (action === "update" && installed.length)) ? bundled.keys() : [])]);
      for (const name of names) {
        const record = installed.find(i => i.name === name);
        const target = join(base, agentDirectories[agent], "skills", name);
        const files = bundled.get(name);
        let state: string;
        try {
          assertNoLinks(target);
          const actual = existsSync(target) ? hashes(readFiles(target)) : undefined;
          state = !actual ? (record ? "missing" : "not-installed") : !record ? "unmanaged" : !same(actual, record.files) ? "modified" : !files ? "retired" : record.version === version && same(actual, hashes(files)) ? "current" : "outdated";
        } catch { state = "conflict"; }
        if (action !== "status" && !["modified", "unmanaged", "conflict"].includes(state)) {
          if ((action === "uninstall" || !files) && record) {
            replace(target, undefined, () => {
              const next = { ...registry, installations: registry.installations.filter(i => !(i.agent === agent && i.name === name)) };
              saveRegistry(registryPath, next);
              registry.installations = next.installations;
            });
            state = "uninstalled";
          } else if (files && action !== "uninstall" && state !== "current") {
            const nextRecord: Installation = { agent, name, version, files: hashes(files) };
            replace(target, files, () => {
              const next = { ...registry, installations: [...registry.installations.filter(i => !(i.agent === agent && i.name === name)), nextRecord] };
              saveRegistry(registryPath, next);
              registry.installations = next.installations;
            });
            state = record ? "updated" : "installed";
          }
        }
        results.push({ agent, name, state, installedVersion: registry.installations.find(i => i.agent === agent && i.name === name)?.version, bundledVersion: version });
      }
    }
    return results;
  } finally {
    if (lockFd !== undefined) { closeSync(lockFd); rmSync(lock); }
  }
}

// Stage outside discovery directories; roll back the directory if registry persistence fails.
function replace(target: string, files: Files | undefined, commit: () => void): void {
  const stagingRoot = dirname(dirname(target));
  mkdirSync(stagingRoot, { recursive: true });
  const stage = join(stagingRoot, `.botz-skill-${randomUUID()}`);
  const backup = `${stage}.backup`;
  let moved = false;
  let promoted = false;
  try {
    if (files) {
      mkdirSync(stage);
      for (const [name, content] of Object.entries(files)) {
        const file = join(stage, name);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
    }
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) { renameSync(target, backup); moved = true; }
    if (files) { renameSync(stage, target); promoted = true; }
    commit();
  } catch (error) {
    if (promoted) rmSync(target, { recursive: true });
    if (moved) renameSync(backup, target);
    throw error;
  } finally { rmSync(stage, { recursive: true, force: true }); }
  rmSync(backup, { recursive: true, force: true });
}

export function registerSkillsCommands(program: Command, packageRoot: string): void {
  const skills = program.command("skills").description("Install and manage bundled Agent Skills (offline, explicit updates)");
  for (const action of ["install", "update", "status", "uninstall"] as const) {
    skills.command(action)
      .description({ install: "Install bundled skills for selected agents", update: "Refresh managed skills from this CLI version", status: "Show bundled and installed skill versions", uninstall: "Remove unchanged managed skills" }[action])
      .addOption(new Option("--agent <agent>", "Agent to manage; repeat for multiple agents").choices(Object.keys(agentDirectories)).argParser((value: string, previous: string[]) => [...previous, value]).default([]))
      .addOption(new Option("--scope <scope>", "Installation scope").choices(["user", "project"]).default("user"))
      .option("--json", "Print structured results")
      .action((opts: { agent: Agent[]; scope: string; json?: boolean }) => {
        if (action === "install" && !opts.agent.length) throw new Error("skills install requires --agent cursor, --agent claude-code, or --agent codex");
        const base = opts.scope === "user" ? homedir() : findGitRoot(process.cwd()) ?? process.cwd();
        const results = manageSkills({ action, packageRoot, base, agents: opts.agent.length ? opts.agent : undefined });
        if (opts.json) console.log(JSON.stringify({ scope: opts.scope, results }, null, 2));
        else {
          for (const result of results) console.log(`${result.agent}: ${result.name}: ${result.state} (installed ${result.installedVersion ?? "none"}, bundled ${result.bundledVersion})`);
          if (!results.length) console.log(`No managed skills in ${opts.scope} scope. Use skills install --agent <agent> first.`);
          if (action !== "status") console.log("Reload your agent to discover changes. Modified and unmanaged skills are preserved; move them aside before retrying.");
        }
        if (results.some(r => ["modified", "unmanaged", "conflict"].includes(r.state))) process.exitCode = 1;
      });
  }
}
