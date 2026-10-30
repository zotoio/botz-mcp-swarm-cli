import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Command } from "commander";
import type { ServerSurface } from "../engine/core/suite-model.js";
import { addStructuredProject, resolveProject } from "./project-ops.js";
import {
  formatUpdateCheck,
  parseTagList,
  projectAcceptServerUpdate,
  projectDescribe,
  projectServerChangelog,
  projectServerUpdates,
  projectSuiteRows,
  projectTag,
  projectTaggedRunRows,
} from "./server-update-ops.js";
import { registerProjectCommands } from "./project-commands.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const v1: ServerSurface = {
  protocolVersion: "2025-06-18",
  serverName: "demo",
  serverVersion: "1.0.0",
  capabilities: ["tools"],
  tools: [{ name: "echo", schemaHash: "a", writeLike: false, inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } }],
  resources: [],
  resourceTemplates: [],
  prompts: [],
};
const v2: ServerSurface = { ...v1, serverVersion: "1.1.0", protocolVersion: "2025-11-25", tools: [] };

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "swarm-cli-updates-"));
  dirs.push(dataDir);
  const { project } = await addStructuredProject(JSON.stringify({ transport: "streamable-http", url: "http://127.0.0.1:9/mcp" }), { dataDir, introspect: async () => v1 });
  return { dataDir, projectId: project.id };
}

describe("server update CLI ops", () => {
  it("checks, prints, and accepts an update", async () => {
    const { dataDir, projectId } = await setup();
    const clean = await projectServerUpdates(projectId, undefined, { dataDir, probe: async () => v1 });
    expect(formatUpdateCheck(clean.results)).toContain("MCP 2025-06-18");
    const changed = await projectServerUpdates(projectId, undefined, { dataDir, probe: async () => v2 });
    const text = formatUpdateCheck(changed.results);
    expect(text).toContain("removed: tool echo");
    expect(changed.results[0]?.proposals[0]?.action).toBe("disable-step");
    const accepted = await projectAcceptServerUpdate(projectId, undefined, { notes: "echo retired" }, { dataDir });
    expect(accepted.suiteVersions).toHaveLength(1);
    const log = await projectServerChangelog(projectId, undefined, { dataDir });
    expect(log[0]?.protocolVersion).toBe("2025-11-25");
    expect(log[0]?.versionHistory[0]?.notes).toBe("echo retired");
  });

  it("describes and tags suites and runs, and filters by tag", async () => {
    const { dataDir, projectId } = await setup();
    await projectDescribe(projectId, "suite", undefined, "contract smoke", { dataDir });
    await projectDescribe(projectId, "server", undefined, "local echo", { dataDir });
    const tags = await projectTag(projectId, "suite", { id: "", tags: parseTagList(["Smoke,nightly"]) }, { dataDir });
    expect(tags).toEqual(["nightly", "smoke"]);
    expect(await projectSuiteRows(projectId, ["smoke"], { dataDir })).toHaveLength(1);
    expect(await projectSuiteRows(projectId, ["other"], { dataDir })).toHaveLength(0);
    await projectTag(projectId, "run", { id: "r1", tags: ["x"] }, { dataDir });
    expect(await projectTaggedRunRows(projectId, ["x"], { dataDir })).toEqual([]);
    const detail = await resolveProject(projectId, { dataDir });
    expect(detail.suites[0]?.description).toBe("contract smoke");
    expect(detail.servers?.[0]?.description).toBe("local echo");
    expect(detail.runTags).toEqual({ r1: ["x"] });
  });

  it("registers the new commands", () => {
    const program = new Command();
    registerProjectCommands(program);
    const project = program.commands.find((c) => c.name() === "project")!;
    const names = (cmd: Command) => cmd.commands.map((c) => c.name());
    expect(names(project.commands.find((c) => c.name() === "server")!)).toEqual(expect.arrayContaining(["add", "updates", "accept-update", "discard-update", "changelog", "describe"]));
    expect(names(project.commands.find((c) => c.name() === "suite")!)).toEqual(expect.arrayContaining(["describe", "tag", "list"]));
    expect(names(project)).toEqual(expect.arrayContaining(["scenarios", "scenario-tag", "run-tag", "runs"]));
    const runs = project.commands.find((c) => c.name() === "runs")!;
    expect(runs.options.map((o) => o.long)).toContain("--tags");
  });
});
