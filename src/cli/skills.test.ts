import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { manageSkills, marketplaceHelp, registerSkillsCommands } from "./skills.js";
let scratch: string, base: string;
const skill = "mcp-swarm";
const agentDirs = { cursor: ".cursor", "claude-code": ".claude", codex: ".agents" } as const;
type Agent = keyof typeof agentDirs;
const run = (action: "status" | "uninstall", agents?: Agent[]) => manageSkills({ action, agents, base });
const target = (agent = ".cursor", name = skill) => join(base, agent, "skills", name);
const registryPath = () => join(base, ".botz/mcp-swarm/skill-installations.json");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
// Recreate what CLI 0.6.x left behind: skill directories plus a hash registry.
function legacyInstall(agents: Agent[], names = [skill, "mcp-swarm-diagnose", "mcp-swarm-upgrade"]): void {
  const installations = [];
  for (const agent of agents) for (const name of names) {
    mkdirSync(target(agentDirs[agent], name), { recursive: true });
    writeFileSync(join(target(agentDirs[agent], name), "SKILL.md"), `skill ${name}`);
    installations.push({ agent, name, version: "0.6.1", files: { "SKILL.md": sha(`skill ${name}`) } });
  }
  mkdirSync(join(base, ".botz/mcp-swarm"), { recursive: true });
  writeFileSync(registryPath(), JSON.stringify({ schemaVersion: 1, installations }));
}
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "botz-skills-"));
  base = join(scratch, "user"); mkdirSync(base);
});
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); process.exitCode = undefined; vi.restoreAllMocks(); });
describe("CLI-managed skills from 0.6.x", () => {
  it("reports nothing and writes nothing without a registry", () => {
    expect(run("status")).toEqual([]);
    expect(run("uninstall")).toEqual([]);
    expect(existsSync(join(base, ".botz"))).toBe(false);
  });
  it("reports managed, modified, and missing copies per agent", () => {
    legacyInstall(["cursor", "claude-code"]);
    writeFileSync(join(target(), "SKILL.md"), "local changes");
    rmSync(target(".claude"), { recursive: true });
    const states = Object.fromEntries(run("status").map(r => [`${r.agent}/${r.name}`, r.state]));
    expect(states).toMatchObject({ "cursor/mcp-swarm": "modified", "cursor/mcp-swarm-diagnose": "managed", "claude-code/mcp-swarm": "missing" });
    expect(run("status", ["codex"])).toEqual([]);
    expect(run("status").every(r => r.installedVersion === "0.6.1")).toBe(true);
  });
  it("uninstalls unchanged copies and preserves edits and unrelated skills", () => {
    legacyInstall(["cursor", "codex"]);
    writeFileSync(join(target(), "SKILL.md"), "local changes");
    mkdirSync(target(".cursor", "unrelated"));
    writeFileSync(join(target(".cursor", "unrelated"), "SKILL.md"), "mine");
    const results = run("uninstall");
    expect(results.find(r => r.agent === "cursor" && r.name === skill)?.state).toBe("modified");
    expect(results.filter(r => r.state === "uninstalled")).toHaveLength(5);
    expect(readFileSync(join(target(), "SKILL.md"), "utf8")).toBe("local changes");
    expect(existsSync(target(".agents"))).toBe(false);
    expect(existsSync(join(target(".cursor", "unrelated"), "SKILL.md"))).toBe(true);
    const registry = JSON.parse(readFileSync(registryPath(), "utf8"));
    expect(registry.installations.map((i: { name: string }) => i.name)).toEqual([skill]);
  });
  it("limits uninstall to the selected agent", () => {
    legacyInstall(["cursor", "codex"]);
    expect(run("uninstall", ["codex"]).every(r => r.state === "uninstalled")).toBe(true);
    expect(run("status").every(r => r.agent === "cursor" && r.state === "managed")).toBe(true);
  });
  it("refuses directory links without changing their targets", () => {
    legacyInstall(["cursor"]);
    const external = join(scratch, "external"); mkdirSync(join(external, skill), { recursive: true });
    rmSync(join(base, ".cursor/skills"), { recursive: true });
    symlinkSync(external, join(base, ".cursor/skills"), process.platform === "win32" ? "junction" : "dir");
    expect(run("uninstall").every(r => r.state === "conflict")).toBe(true);
    expect(existsSync(join(external, skill))).toBe(true);
  });
  it("serializes removals and rejects malformed records", () => {
    legacyInstall(["cursor"]);
    writeFileSync(join(base, ".botz/mcp-swarm/skill-installations.lock"), "");
    expect(() => run("uninstall")).toThrow("Another skills operation");
    rmSync(join(base, ".botz/mcp-swarm/skill-installations.lock"));
    writeFileSync(registryPath(), '{"schemaVersion":99}');
    expect(() => run("uninstall")).toThrow();
    expect(existsSync(join(base, ".botz/mcp-swarm/skill-installations.lock"))).toBe(false);
  });
  it("points install and update to the zoto-agents marketplace", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const action of ["install", "update"]) {
      const program = new Command().exitOverride(); registerSkillsCommands(program);
      await program.parseAsync(["skills", action, "--agent", "cursor"], { from: "user" });
      expect(process.exitCode).toBe(1);
    }
    expect(error).toHaveBeenCalledWith(marketplaceHelp);
    expect(marketplaceHelp).toContain("zotoio/zoto-agents");
  });
});
