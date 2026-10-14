import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, parse, relative } from "node:path";
import { Command, Option } from "commander";
import { z } from "zod";
import { findGitRoot } from "./botz-home.js";

export const agentDirectories = { cursor: ".cursor", "claude-code": ".claude", codex: ".agents" } as const;
type Agent = keyof typeof agentDirectories;
type Action = "status" | "uninstall";
const agentSchema = z.enum(["cursor", "claude-code", "codex"]);
const nameSchema = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const recordSchema = z.object({
  agent: agentSchema, name: nameSchema, version: z.string(),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
}).strict();
const registrySchema = z.object({ schemaVersion: z.literal(1), installations: z.array(recordSchema) }).strict();
type Registry = z.infer<typeof registrySchema>;
type Files = Record<string, Buffer>;
export type SkillsResult = { agent: Agent; name: string; state: string; installedVersion: string };

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

export const marketplaceHelp = `MCP Swarm Agent Skills are published as the botz-mcp-swarm plugin in the zotoio/zoto-agents marketplace:
  Claude Code: /plugin marketplace add zotoio/zoto-agents
               /plugin install botz-mcp-swarm@zoto-agents
  Codex:       codex plugin marketplace add zotoio/zoto-agents
  Cursor:      add zotoio/zoto-agents as a plugin marketplace, then install botz-mcp-swarm
Remove skills installed by CLI 0.6.x first, so they are not discovered twice: botz mcp-swarm skills uninstall`;

/** Report or remove skills that CLI 0.6.x copied into agent directories. */
export function manageSkills(input: { action: Action; base: string; agents?: Agent[] }): SkillsResult[] {
  const { action } = input;
  const base = realpathSync(input.base);
  const registryPath = join(base, ".botz", "mcp-swarm", "skill-installations.json");
  assertNoLinks(registryPath);
  if (!existsSync(registryPath)) return [];
  const lock = join(base, ".botz", "mcp-swarm", "skill-installations.lock");
  let lockFd: number | undefined;
  if (action === "uninstall") {
    try { lockFd = openSync(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Another skills operation is running. If it was interrupted, remove ${lock} before retrying.`);
      throw error;
    }
  }
  try {
    const registry: Registry = registrySchema.parse(JSON.parse(readFileSync(registryPath, "utf8")));
    const agents = [...new Set(input.agents ?? registry.installations.map(i => i.agent))];
    const results: SkillsResult[] = [];
    for (const agent of agents) {
      agentSchema.parse(agent);
      for (const record of registry.installations.filter(i => i.agent === agent)) {
        const target = join(base, agentDirectories[agent], "skills", record.name);
        let state: string;
        try {
          assertNoLinks(target);
          state = !existsSync(target) ? "missing" : same(hashes(readFiles(target)), record.files) ? "managed" : "modified";
        } catch { state = "conflict"; }
        if (action === "uninstall" && (state === "managed" || state === "missing")) {
          remove(target, () => {
            const next = { ...registry, installations: registry.installations.filter(i => i !== record) };
            saveRegistry(registryPath, next);
            registry.installations = next.installations;
          });
          state = "uninstalled";
        }
        results.push({ agent, name: record.name, state, installedVersion: record.version });
      }
    }
    return results;
  } finally {
    if (lockFd !== undefined) { closeSync(lockFd); rmSync(lock); }
  }
}

// Move aside first; restore the directory if registry persistence fails.
function remove(target: string, commit: () => void): void {
  const backup = join(dirname(target), `.botz-skill-${randomUUID()}.backup`);
  const moved = existsSync(target);
  if (moved) renameSync(target, backup);
  try { commit(); }
  catch (error) {
    if (moved) renameSync(backup, target);
    throw error;
  }
  if (moved) rmSync(backup, { recursive: true, force: true });
}

export function registerSkillsCommands(program: Command): void {
  const skills = program.command("skills").description("Find and remove Agent Skills installed by CLI 0.6.x (skills now ship in zotoio/zoto-agents)");
  for (const action of ["install", "update"] as const) {
    skills.command(action)
      .description("Removed: install the botz-mcp-swarm plugin from zotoio/zoto-agents")
      .allowUnknownOption()
      .allowExcessArguments()
      .action(() => {
        console.error(marketplaceHelp);
        process.exitCode = 1;
      });
  }
  for (const action of ["status", "uninstall"] as const) {
    skills.command(action)
      .description({ status: "Show skills installed by CLI 0.6.x", uninstall: "Remove unchanged skills installed by CLI 0.6.x" }[action])
      .addOption(new Option("--agent <agent>", "Agent to manage; repeat for multiple agents").choices(Object.keys(agentDirectories)).argParser((value: string, previous: string[]) => [...previous, value]).default([]))
      .addOption(new Option("--scope <scope>", "Installation scope").choices(["user", "project"]).default("user"))
      .option("--json", "Print structured results")
      .action((opts: { agent: Agent[]; scope: string; json?: boolean }) => {
        const base = opts.scope === "user" ? homedir() : findGitRoot(process.cwd()) ?? process.cwd();
        const results = manageSkills({ action, base, agents: opts.agent.length ? opts.agent : undefined });
        if (opts.json) console.log(JSON.stringify({ scope: opts.scope, results }, null, 2));
        else {
          for (const result of results) console.log(`${result.agent}: ${result.name}: ${result.state} (installed ${result.installedVersion})`);
          if (!results.length) console.log(`No CLI-managed skills in ${opts.scope} scope.`);
          else if (action === "status") console.log("These copies are no longer updated. Run skills uninstall, then install the plugin:\n" + marketplaceHelp);
          else console.log("Reload your agent to discover changes. Modified skills are preserved; move them aside or delete them yourself.");
        }
        if (results.some(r => ["modified", "conflict"].includes(r.state))) process.exitCode = 1;
      });
  }
}
