import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import { formatCompareMarkdown } from "../engine/core/compare.js";
import type { LoadProfile, SuiteNode } from "../engine/core/suite-model.js";
import {
  addProjectServer,
  addStructuredProject,
  addSuiteNode,
  cloneProjectSuite,
  cloneSuiteNode,
  compareProjectRuns,
  currentVersion,
  deleteSuiteNode,
  exportSuiteManifest,
  formatProjectList,
  formatProjectShow,
  formatSuiteTree,
  introspectProjectRef,
  listProjectRows,
  moveSuiteNode,
  projectReport,
  projectRunRows,
  addProjectSuite,
  editProjectServer,
  removeProjectSuite,
  removeStructuredProject,
  renameProjectRef,
  resolveProject,
  resolveSuite,
  runProjectSuite,
  setProjectSuiteEnabled,
  saveLoadProfile,
  saveSuiteFile,
  setSuiteNode,
} from "./project-ops.js";

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function registerProjectCommands(program: Command): void {
  const project = program
    .command("project")
    .description("Projects: introspected catalog, versioned suites, load runs, and catalog-aware compare");

  project
    .command("list")
    .description("List projects")
    .option("--all", "Include archived projects")
    .option("--json", "Print JSON")
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      const rows = await listProjectRows({ all: opts.all });
      if (opts.json) printJson(rows);
      else console.log(formatProjectList(rows));
    });

  project
    .command("show")
    .description("Show a project's catalog, suites, and load profile")
    .argument("<project>", "Project id, name, or allowlist key")
    .option("--json", "Print JSON")
    .action(async (ref: string, opts: { json?: boolean }) => {
      const detail = await resolveProject(ref);
      if (opts.json) printJson(detail);
      else console.log(formatProjectShow(detail));
    });

  project
    .command("add")
    .description("Create a project from an MCP server and generate a default suite for that server")
    .option("--name <name>", "Project name. Defaults to the server label")
    .option("--target <json>", "Server config JSON")
    .option("--target-file <path>", "Server config JSON file")
    .action(async (opts: { name?: string; target?: string; targetFile?: string }) => {
      const raw = await readTargetRaw(opts);
      const { project, label } = await addStructuredProject(raw, { name: opts.name });
      console.log(`Project ${project.id} for ${label}`);
      console.log(`Tools: ${project.catalog.length}${project.introspectError ? ` (${project.introspectError})` : ""}`);
      console.log(`Suite: ${project.suites[0]?.name ?? "none"} v${project.suites[0]?.currentVersion ?? 0}`);
    });

  project
    .command("server")
    .description("Servers inside a project")
    .command("add")
    .description("Add another MCP server to a project and generate a default suite for it")
    .argument("<project>", "Project id or name")
    .option("--target <json>", "Server config JSON")
    .option("--target-file <path>", "Server config JSON file")
    .option("--no-suite", "Add the server without generating a suite")
    .action(async (ref: string, opts: { target?: string; targetFile?: string; suite?: boolean }) => {
      const raw = await readTargetRaw(opts);
      const added = await addProjectServer(ref, raw, { generateSuite: opts.suite !== false });
      console.log(`Server ${added.serverId} on ${added.projectId}`);
      if (added.suiteId) console.log(`Suite ${added.suiteId}`);
    });

  project
    .command("server-edit")
    .description("Change a project server's name or connection")
    .argument("<project>", "Project id or name")
    .option("--server <id>", "Server id or name. Defaults to the first server")
    .option("--name <name>", "Display name")
    .option("--target <json>", "Server config JSON")
    .option("--target-file <path>", "Server config JSON file")
    .action(async (ref: string, opts: { server?: string; name?: string; target?: string; targetFile?: string }) => {
      const raw = opts.target || opts.targetFile ? await readTargetRaw(opts) : undefined;
      if (!opts.name && !raw) throw new Error("missing_target");
      const id = await editProjectServer(ref, opts.server, {
        name: opts.name,
        target: raw ? JSON.parse(raw) as never : undefined,
      });
      console.log(`Updated server ${id}`);
    });

  project
    .command("rename")
    .description("Rename a project")
    .argument("<project>", "Project id or name")
    .argument("<name>", "New project name")
    .action(async (ref: string, name: string) => {
      const renamed = await renameProjectRef(ref, name);
      console.log(`${renamed.id} is now ${renamed.name}`);
    });

  project
    .command("remove")
    .description("Archive a project. Servers are left unchanged")
    .argument("<project>", "Project id or name")
    .action(async (ref: string) => {
      const id = await removeStructuredProject(ref);
      console.log(`Archived ${id}`);
    });

  project
    .command("introspect")
    .description("Live-query a project server. An untouched stub suite for that server is replaced with a contract suite")
    .argument("<project>", "Project id or name")
    .option("--server <id>", "Server id. Defaults to the first server")
    .action(async (ref: string, opts: { server?: string }) => {
      const updated = await introspectProjectRef(ref, { serverId: opts.server });
      const server = (opts.server
        ? updated.servers?.find((item) => item.id === opts.server)
        : updated.servers?.[0]) ?? null;
      const catalog = server?.catalog ?? updated.catalog;
      console.log(`Tools: ${catalog.length}`);
      if (server?.introspectError) console.log(`Introspect error: ${server.introspectError}`);
      for (const tool of catalog) {
        console.log(`  ${tool.name}${tool.writeLike ? " (write, disabled)" : ""}`);
      }
    });

  const suite = project.command("suite").description("Versioned suite tree. Each edit saves the next immutable version");

  suite
    .command("show")
    .description("Print the current suite tree")
    .argument("<project>")
    .option("--suite <id>", "Suite id or name (default: first suite)")
    .option("--json", "Print the version document")
    .action(async (ref: string, opts: { suite?: string; json?: boolean }) => {
      const detail = await resolveProject(ref);
      const pointer = resolveSuite(detail, opts.suite);
      const version = currentVersion(detail, pointer);
      if (opts.json) printJson(version);
      else {
        console.log(`${pointer.name} v${version.version} (${pointer.id})`);
        console.log(formatSuiteTree(version.nodes));
      }
    });

  suite
    .command("save")
    .description("Save the next suite version from a JSON file { name?, nodes, load }")
    .argument("<project>")
    .requiredOption("--file <path>", "Suite version JSON")
    .option("--suite <id>")
    .action(async (ref: string, opts: { file: string; suite?: string }) => {
      const raw = JSON.parse(await readFile(resolve(opts.file), "utf8")) as {
        name?: string;
        nodes: SuiteNode[];
        load: LoadProfile;
      };
      const saved = await saveSuiteFile(ref, raw, opts.suite);
      console.log(`Saved ${saved.name} v${saved.version}`);
    });

  suite
    .command("add")
    .description("Add a suite at version 1 from a server's current catalog")
    .argument("<project>")
    .option("--name <name>")
    .option("--server <id>", "Server id or name. Defaults to the first server")
    .action(async (ref: string, opts: { name?: string; server?: string }) => {
      const added = await addProjectSuite(ref, opts);
      console.log(`Suite ${added.name} (${added.id}) v${added.currentVersion}`);
    });

  suite
    .command("clone")
    .description("Clone a suite into a new suite in the same project")
    .argument("<project>")
    .option("--suite <id>")
    .action(async (ref: string, opts: { suite?: string }) => {
      const cloned = await cloneProjectSuite(ref, opts.suite);
      console.log(`Cloned suite ${cloned.name} (${cloned.id})`);
    });

  suite
    .command("enable")
    .description("Enable a suite so it can be run")
    .argument("<project>")
    .option("--suite <id>")
    .action(async (ref: string, opts: { suite?: string }) => {
      const updated = await setProjectSuiteEnabled(ref, opts.suite, true);
      console.log(`Enabled ${updated.name} (${updated.id})`);
    });

  suite
    .command("disable")
    .description("Keep a suite in the project and stop it from running")
    .argument("<project>")
    .option("--suite <id>")
    .action(async (ref: string, opts: { suite?: string }) => {
      const updated = await setProjectSuiteEnabled(ref, opts.suite, false);
      console.log(`Disabled ${updated.name} (${updated.id})`);
    });

  suite
    .command("remove")
    .description("Remove a suite from the project. The last suite stays")
    .argument("<project>")
    .option("--suite <id>")
    .action(async (ref: string, opts: { suite?: string }) => {
      const id = await removeProjectSuite(ref, opts.suite);
      console.log(`Removed suite ${id}`);
    });

  suite
    .command("add-node")
    .description("Append a sampler, think, extractor, loop, or group and save a version")
    .argument("<project>")
    .requiredOption("--type <type>", "sampler | think | extractor | loop | group")
    .option("--suite <id>")
    .option("--parent <nodeId>", "Nest under a group or loop")
    .option("--method <method>", "initialize | tools/list | tools/call | resources/list | resources/read | prompts/list | prompts/get | ping | teardown")
    .option("--tool <name>")
    .option("--label <text>")
    .option("--think-ms <ms>")
    .option("--iterations <n>")
    .option("--variable <name>")
    .option("--path <jsonPath>")
    .option("--args <json>")
    .action(async (ref: string, opts: {
      type: string;
      suite?: string;
      parent?: string;
      method?: string;
      tool?: string;
      label?: string;
      thinkMs?: string;
      iterations?: string;
      variable?: string;
      path?: string;
      args?: string;
    }) => {
      const saved = await addSuiteNode(ref, {
        suite: opts.suite,
        type: opts.type,
        parent: opts.parent,
        method: opts.method,
        tool: opts.tool,
        label: opts.label,
        thinkMs: opts.thinkMs ? Number.parseInt(opts.thinkMs, 10) : undefined,
        iterations: opts.iterations ? Number.parseInt(opts.iterations, 10) : undefined,
        variable: opts.variable,
        path: opts.path,
        args: opts.args ? (JSON.parse(opts.args) as Record<string, unknown>) : undefined,
      });
      console.log(`Saved v${saved.version}`);
    });

  suite
    .command("clone-node")
    .description("Clone a node and save a version")
    .argument("<project>")
    .requiredOption("--node <id>")
    .option("--suite <id>")
    .action(async (ref: string, opts: { node: string; suite?: string }) => {
      const saved = await cloneSuiteNode(ref, opts.node, opts.suite);
      console.log(`Saved v${saved.version}`);
    });

  suite
    .command("delete-node")
    .description("Delete a node and save a version")
    .argument("<project>")
    .requiredOption("--node <id>")
    .option("--suite <id>")
    .action(async (ref: string, opts: { node: string; suite?: string }) => {
      const saved = await deleteSuiteNode(ref, opts.node, opts.suite);
      console.log(`Saved v${saved.version}`);
    });

  suite
    .command("set-node")
    .description("Enable, disable, or edit a node and save a version")
    .argument("<project>")
    .requiredOption("--node <id>")
    .option("--suite <id>")
    .option("--enable", "Enable the node")
    .option("--disable", "Disable the node")
    .option("--label <text>")
    .option("--method <method>")
    .option("--tool <name>")
    .option("--think-ms <ms>")
    .option("--iterations <n>")
    .option("--variable <name>")
    .option("--path <jsonPath>")
    .option("--args <json>")
    .action(async (ref: string, opts: {
      node: string;
      suite?: string;
      enable?: boolean;
      disable?: boolean;
      label?: string;
      method?: string;
      tool?: string;
      thinkMs?: string;
      iterations?: string;
      variable?: string;
      path?: string;
      args?: string;
    }) => {
      const saved = await setSuiteNode(ref, opts.node, {
        enabled: opts.disable ? false : opts.enable ? true : undefined,
        label: opts.label,
        method: opts.method as SuiteNode["method"],
        tool: opts.tool,
        thinkMs: opts.thinkMs ? Number.parseInt(opts.thinkMs, 10) : undefined,
        iterations: opts.iterations ? Number.parseInt(opts.iterations, 10) : undefined,
        variable: opts.variable,
        path: opts.path,
        args: opts.args ? (JSON.parse(opts.args) as Record<string, unknown>) : undefined,
      }, opts.suite);
      console.log(`Saved v${saved.version}`);
    });

  suite
    .command("move-node")
    .description("Reorder a node, or drop it onto a group or loop, and save a version")
    .argument("<project>")
    .requiredOption("--node <id>")
    .requiredOption("--over <id>", "Sibling to place before, or a group/loop to nest into")
    .option("--suite <id>")
    .action(async (ref: string, opts: { node: string; over: string; suite?: string }) => {
      const saved = await moveSuiteNode(ref, opts.node, opts.over, opts.suite);
      console.log(`Saved v${saved.version}`);
    });

  project
    .command("load")
    .description("Save a new suite version with an updated load profile")
    .argument("<project>")
    .option("--suite <id>")
    .option("--duration-ms <ms>")
    .option("--ramp-up-ms <ms>")
    .option("--concurrency <n>")
    .option("--jitter-ms <ms>")
    .option("--ramp-down-ms <ms>")
    .option("--dwell-ms <ms>", "Fixed pause between every pair of steps")
    .option("--iterations <n>", "Minimum full passes of the suite per virtual user. Defaults to 10")
    .action(async (ref: string, opts: {
      suite?: string;
      durationMs?: string;
      rampUpMs?: string;
      concurrency?: string;
      jitterMs?: string;
      rampDownMs?: string;
      dwellMs?: string;
      iterations?: string;
    }) => {
      const saved = await saveLoadProfile(ref, {
        durationMs: opts.durationMs ? Number.parseInt(opts.durationMs, 10) : undefined,
        rampUpMs: opts.rampUpMs ? Number.parseInt(opts.rampUpMs, 10) : undefined,
        maxConcurrency: opts.concurrency ? Number.parseInt(opts.concurrency, 10) : undefined,
        jitterMs: opts.jitterMs ? Number.parseInt(opts.jitterMs, 10) : undefined,
        rampDownMs: opts.rampDownMs ? Number.parseInt(opts.rampDownMs, 10) : undefined,
        dwellMs: opts.dwellMs ? Number.parseInt(opts.dwellMs, 10) : undefined,
        iterations: opts.iterations ? Number.parseInt(opts.iterations, 10) : undefined,
      }, opts.suite);
      console.log(`Saved ${saved.name} v${saved.version}`);
      console.log(
        `load: duration ${saved.load.durationMs}ms, ramp ${saved.load.rampUpMs}ms, concurrency ${saved.load.maxConcurrency}, jitter ${saved.load.jitterMs}ms, ramp-down ${saved.load.rampDownMs}ms, dwell ${saved.load.dwellMs}ms, iterations ${saved.load.iterations}`,
      );
    });

  project
    .command("run")
    .description("Run a suite version and follow the same progress events as the studio")
    .argument("<project>")
    .option("--suite <id>")
    .option("--version <n>", "Stored version to run. Defaults to the latest")
    .action(async (ref: string, opts: { suite?: string; version?: string }) => {
      const version = opts.version ? Number.parseInt(opts.version, 10) : undefined;
      const report = await runProjectSuite(ref, opts.suite, (line) => console.log(line), {
        version: version && version > 0 ? version : undefined,
      });
      console.log(`\nVerdict: ${report.verdict.toUpperCase()}`);
      for (const item of report.toolEvals ?? []) {
        console.log(
          `eval ${item.tool} ${item.polarity}: ${item.pass ? "pass" : "fail"} — ${item.prompt}`,
        );
      }
      for (const reason of report.failReasons) {
        console.log(`  - ${reason}`);
      }
      console.log(`Report: .botz/mcp-swarm/data/projects/${report.projectId}/runs/${report.id}.json`);
      for (const tool of report.toolSeries) {
        console.log(
          `${tool.toolName}: ${tool.count} calls, mean ${(tool.latencyMs.mean ?? tool.latencyMs.p50).toFixed(1)} ± ${(tool.latencyMs.std ?? 0).toFixed(1)} ms, p90 ${(tool.latencyMs.p90 ?? tool.latencyMs.p50).toFixed(1)} ms, p95 ${tool.latencyMs.p95.toFixed(1)} ms, p99 ${tool.latencyMs.p99.toFixed(1)} ms, errors ${(tool.errorRate * 100).toFixed(1)}%`,
        );
      }
      if (report.verdict === "fail") process.exitCode = 1;
    });

  project
    .command("runs")
    .description("List stored runs for a project")
    .argument("<project>")
    .option("--json")
    .action(async (ref: string, opts: { json?: boolean }) => {
      const runs = await projectRunRows(ref);
      if (opts.json) printJson(runs);
      else if (runs.length === 0) console.log("No runs.");
      else {
        for (const run of runs) {
          console.log(`${run.id}\t${run.verdict}\tv${run.suiteVersion ?? "?"}\t${run.startedAt}`);
        }
      }
    });

  project
    .command("report")
    .description("Print a stored run report")
    .argument("<project>")
    .argument("<runId>")
    .option("--json")
    .action(async (ref: string, runId: string, opts: { json?: boolean }) => {
      const report = await projectReport(ref, runId);
      if (opts.json) printJson(report);
      else {
        console.log(`${report.verdict.toUpperCase()} ${report.durationMs} ms`);
        for (const reason of report.failReasons) console.log(`  - ${reason}`);
        for (const tool of report.toolSeries) {
          console.log(
            `${tool.toolName}: ${tool.count} calls, mean ${(tool.latencyMs.mean ?? tool.latencyMs.p50).toFixed(1)} ± ${(tool.latencyMs.std ?? 0).toFixed(1)} ms, p90 ${(tool.latencyMs.p90 ?? tool.latencyMs.p50).toFixed(1)} ms, p95 ${tool.latencyMs.p95.toFixed(1)} ms, p99 ${tool.latencyMs.p99.toFixed(1)} ms, errors ${(tool.errorRate * 100).toFixed(1)}%`,
          );
        }
        for (const node of report.nodeOutcomes ?? []) {
          console.log(`${node.label}: ${node.count} (${node.errorCount} errors)`);
        }
      }
    });

  project
    .command("compare")
    .description("Compare two stored runs. Tools added, removed, or schema-changed are not scored as zero latency")
    .argument("<project>")
    .requiredOption("--base <runId>")
    .requiredOption("--head <runId>")
    .option("--output <path>", "Write compare JSON")
    .action(async (ref: string, opts: { base: string; head: string; output?: string }) => {
      const compare = await compareProjectRuns(ref, opts.base, opts.head);
      console.log(formatCompareMarkdown(compare));
      if (compare.regressions.length > 0) {
        console.log(`\n${compare.regressions.length} regression(s) detected`);
        process.exitCode = 1;
      }
      if (opts.output) {
        await writeFile(resolve(opts.output), JSON.stringify(compare, null, 2));
      }
    });

  project
    .command("export")
    .description("Compile the current suite version to a manifest the run command can execute")
    .argument("<project>")
    .requiredOption("--output <path>")
    .option("--suite <id>")
    .action(async (ref: string, opts: { output: string; suite?: string }) => {
      const path = await exportSuiteManifest(ref, opts.output, opts.suite);
      console.log(`Wrote ${path}`);
    });
}

async function readTargetRaw(opts: { target?: string; targetFile?: string }): Promise<string> {
  if (opts.targetFile) return readFile(resolve(opts.targetFile), "utf8");
  if (opts.target) return opts.target;
  throw new Error("missing_target");
}
