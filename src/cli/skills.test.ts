import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { manageSkills, registerSkillsCommands } from "./skills.js";
let scratch: string, base: string, packageRoot: string;
const skill = "mcp-swarm";
const run = (action: "install" | "update" | "status" | "uninstall", agents?: ("cursor" | "claude-code" | "codex")[]) => manageSkills({ action, agents, base, packageRoot });
const target = (agent = ".cursor") => join(base, agent, "skills", skill);
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "botz-skills-"));
  base = join(scratch, "user"); mkdirSync(base);
  packageRoot = join(scratch, "package"); mkdirSync(packageRoot);
  cpSync(fileURLToPath(new URL("../../agent-plugin", import.meta.url)), join(packageRoot, "agent-plugin"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: "1.0.0" }));
});
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });
describe("managed skills", () => {
  it("reports status without creating configuration", () => {
    expect(run("status")).toHaveLength(9);
    expect(existsSync(join(base, ".botz"))).toBe(false);
  });
  it("installs independently for all adapters and is idempotent", () => {
    expect(run("install", ["cursor", "claude-code", "codex"]).every(r => r.state === "installed")).toBe(true);
    for (const agent of [".cursor", ".claude", ".agents"]) expect(existsSync(join(target(agent), "SKILL.md"))).toBe(true);
    expect(run("install", ["cursor"]).every(r => r.state === "current")).toBe(true);
    expect(run("status").every(r => r.installedVersion === "1.0.0")).toBe(true);
  });
  it("updates registered agents, adds new skills, and removes retired skills", () => {
    run("install", ["cursor"]);
    const source = join(packageRoot, "agent-plugin/skills");
    rmSync(join(source, "mcp-swarm-diagnose"), { recursive: true });
    mkdirSync(join(source, "mcp-extra")); writeFileSync(join(source, "mcp-extra/SKILL.md"), "new skill");
    writeFileSync(join(source, skill, "SKILL.md"), "new content");
    writeFileSync(join(packageRoot, "package.json"), '{"version":"2.0.0"}');
    expect(run("status", ["cursor"]).find(r => r.name === skill)?.state).toBe("outdated");
    expect(run("update").map(r => r.state)).toEqual(["updated", "uninstalled", "updated", "installed"]);
    expect(readFileSync(join(target(), "SKILL.md"), "utf8")).toBe("new content");
    expect(existsSync(join(base, ".claude"))).toBe(false);
    expect(run("uninstall").every(r => r.state === "uninstalled")).toBe(true);
    expect(run("update")).toEqual([]);
  });
  it("preserves edits, additions, and unrelated skills", () => {
    run("install", ["cursor"]);
    writeFileSync(join(target(), "SKILL.md"), "local changes");
    for (const other of ["mcp-swarm-diagnose", "mcp-swarm-upgrade"]) writeFileSync(join(base, ".cursor/skills", other, "notes.md"), "notes");
    mkdirSync(join(base, ".cursor/skills/unrelated"));
    writeFileSync(join(base, ".cursor/skills/unrelated/SKILL.md"), "mine");
    for (const action of ["update", "uninstall"] as const) expect(run(action).every(r => r.state === "modified")).toBe(true);
    expect(readFileSync(join(target(), "SKILL.md"), "utf8")).toBe("local changes");
    expect(existsSync(join(base, ".cursor/skills/unrelated/SKILL.md"))).toBe(true);
  });
  it("does not adopt unmanaged skills, including identical copies", () => {
    mkdirSync(target(), { recursive: true });
    cpSync(join(packageRoot, "agent-plugin/skills", skill), target(), { recursive: true });
    expect(run("install", ["cursor"]).find(r => r.name === skill)?.state).toBe("unmanaged");
    run("uninstall");
    expect(existsSync(join(target(), "SKILL.md"))).toBe(true);
  });
  it("repairs missing installations and preserves partial deletions", () => {
    run("install", ["cursor"]);
    rmSync(target(), { recursive: true });
    expect(run("status", ["cursor"])[0].state).toBe("missing");
    expect(run("update")[0].state).toBe("updated");
    rmSync(join(target(), "SKILL.md"));
    expect(run("update").find(r => r.name === skill)?.state).toBe("modified");
  });
  it("refuses directory links without changing their targets", () => {
    const external = join(scratch, "external"); mkdirSync(external);
    mkdirSync(join(base, ".cursor"));
    symlinkSync(external, join(base, ".cursor/skills"), process.platform === "win32" ? "junction" : "dir");
    expect(run("install", ["cursor"]).every(r => r.state === "conflict")).toBe(true);
    expect(existsSync(join(external, skill))).toBe(false);
  });
  it("serializes mutations and rejects malformed records", () => {
    mkdirSync(join(base, ".botz", "mcp-swarm"), { recursive: true });
    writeFileSync(join(base, ".botz/mcp-swarm/skill-installations.lock"), "");
    expect(() => run("install", ["cursor"])).toThrow("Another skills operation");
    rmSync(join(base, ".botz/mcp-swarm/skill-installations.lock"));
    writeFileSync(join(base, ".botz/mcp-swarm/skill-installations.json"), '{"schemaVersion":99}');
    expect(() => run("install", ["cursor"])).toThrow();
    expect(existsSync(join(base, ".botz/mcp-swarm/skill-installations.lock"))).toBe(false);
  });
  it("rejects installation without an agent before writing", async () => {
    const program = new Command().exitOverride(); registerSkillsCommands(program, packageRoot);
    await expect(program.parseAsync(["skills", "install"], { from: "user" })).rejects.toThrow("requires --agent");
  });
});
