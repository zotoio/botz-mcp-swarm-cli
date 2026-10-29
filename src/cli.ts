#!/usr/bin/env node
import { registerSkillsCommands } from "./cli/skills.js";
import { registerRefreshCommand } from "./cli/suite-refresh.js";
import { registerServerCommands } from "./cli/suite-servers.js";
import { registerAnalyseCommand } from "./cli/analyse-commands.js";
import { registerRunCommand } from "./cli/run-commands.js";
import { registerDiagnostics } from "./cli/diagnostics.js";
import { registerUpgradeCommand } from "./cli/upgrade.js";
import { loadLocalEnv } from "./engine/load-local-env.js";
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadRunReport,
  compareRuns,
  formatCompareMarkdown,
} from "./engine/core/compare.js";
import { recordSession, replayRecording } from "./engine/core/record-replay.js";
import { loadTargetFromOptions } from "./engine/core/load-target.js";
import {
  runDiscovery,
  saveDiscoveryDraft,
  approveDiscoveryDraft,
  suggestDescriptionOptimization,
  summarizeToolParameters,
} from "./engine/core/discovery.js";
import type { ReplayMode } from "./engine/types/recording.js";
import {
  generateDescriptionProposal,
  findToolDescriptor,
  createOptimizeHistoryEntry,
} from "./engine/core/llm-optimize.js";
import { appendOptimizeHistory } from "./engine/store/optimize-history.js";
import { saveOptimizeDrafts } from "./engine/service/store.js";
import { createSession } from "./engine/adapters/index.js";
import { resolveStdioTarget } from "./engine/core/target-resolve.js";
import { assertTargetAllowlisted } from "./engine/core/allowlist.js";
import { registerProjectCommands } from "./cli/project-commands.js";
import { registerSuiteCommands } from "./cli/suite-commands.js";
import {
  parseTransportChoice,
  resolveWorkerMaxVus,
  resolveWorkerOtelExport,
  resolveWorkerToken,
  runWorker,
  WORKER_MAX_VUS_ENV,
  WORKER_TOKEN_ENV,
} from "./cli/worker.js";
import { DEFAULT_SWARM_SERVER_URL, resolveSwarmServerUrl, SWARM_SERVER_URL_ENV } from "./cli/worker-transport.js";

function cliPackageVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

loadLocalEnv();

const program = new Command();

const pluginName = process.env.BOTZ_PLUGIN?.trim();
program
  .name(pluginName ? `botz ${pluginName}` : "botz-mcp-swarm")
  .description("From introspection to optimisation: point swarm at any MCP server and it builds, runs and scores the tests for you")
  .version(cliPackageVersion())
  // Root options only before the subcommand, so `project run --version <n>` is not the CLI version.
  .enablePositionalOptions();

registerSkillsCommands(program);
registerRunCommand(program);
registerUpgradeCommand(program);
registerRunCommand(program, "soak");

program
  .command("compare")
  .description("Compare two run reports for per-tool p95/error deltas")
  .requiredOption("--base <path>", "Path to base run JSON report")
  .requiredOption("--head <path>", "Path to head run JSON report")
  .option("--output <path>", "Optional output path for compare JSON")
  .action(async (opts: { base: string; head: string; output?: string }) => {
    const base = await loadRunReport(resolve(opts.base));
    const head = await loadRunReport(resolve(opts.head));
    const compare = compareRuns(base, head);
    console.log(formatCompareMarkdown(compare));
    if (compare.regressions.length > 0) {
      console.log(`\n${compare.regressions.length} regression(s) detected`);
      process.exitCode = 1;
    }
    if (opts.output) {
      await writeFile(opts.output, JSON.stringify(compare, null, 2), "utf8");
    }
  });

program
  .command("record")
  .description("Record redacted MCP wire fixtures to file")
  .option("--target <json>", "Target JSON (transport + connection details)")
  .option("--target-file <path>", "Path to target JSON file")
  .option("--protocol-era <era>", "MCP protocol era: auto (default), legacy, or modern")
  .requiredOption("--allowlist <hosts>", "Comma-separated allowlist hosts")
  .requiredOption("--output <path>", "Output recording file path")
  .action(
    async (opts: {
      target?: string;
      targetFile?: string;
      protocolEra?: string;
      allowlist: string;
      output: string;
    }) => {
      const target = await loadTargetFromOptions(opts);
      const allowlist = opts.allowlist.split(",").map((h) => h.trim());
      const baseDir = opts.targetFile ? dirname(resolve(opts.targetFile)) : process.cwd();
      console.log(`Recording session against ${target.transport} target...`);
      const recording = await recordSession(
        target,
        allowlist,
        resolve(opts.output),
        baseDir,
      );
      console.log(`Recorded ${recording.frames.length} frames to ${opts.output}`);
    },
  );

program
  .command("replay")
  .description("Replay a recorded fixture against a target")
  .requiredOption("--recording <path>", "Path to recording file")
  .option("--target <json>", "Target JSON (transport + connection details)")
  .option("--target-file <path>", "Path to target JSON file")
  .option("--protocol-era <era>", "MCP protocol era: auto (default), legacy, or modern")
  .requiredOption("--allowlist <hosts>", "Comma-separated allowlist hosts")
  .option("--mode <mode>", "Replay mode: as-recorded, max-rate, paced", "as-recorded")
  .option("--pace-ms <ms>", "Pace between frames in ms", "100")
  .action(
    async (opts: {
      recording: string;
      target?: string;
      targetFile?: string;
      allowlist: string;
      mode: string;
      paceMs: string;
    }) => {
      const target = await loadTargetFromOptions(opts);
      const allowlist = opts.allowlist.split(",").map((h) => h.trim());
      const mode = opts.mode as ReplayMode;
      const baseDir = opts.targetFile ? dirname(resolve(opts.targetFile)) : process.cwd();
      console.log(`Replaying ${opts.recording} in ${mode} mode...`);
      const result = await replayRecording(
        resolve(opts.recording),
        target,
        allowlist,
        mode,
        Number.parseInt(opts.paceMs, 10),
        baseDir,
      );
      console.log(`Replayed ${result.replayed} frames, ${result.errors} errors`);
      if (result.errors > 0) process.exitCode = 1;
    },
  );

program
  .command("discover")
  .description("Draft fixtures from allowlisted target (human approve required)")
  .option("--target <json>", "Target JSON")
  .option("--target-file <path>", "Path to target JSON file")
  .option("--protocol-era <era>", "MCP protocol era: auto (default), legacy, or modern")
  .requiredOption("--allowlist <hosts>", "Comma-separated allowlist hosts")
  .requiredOption("--output <path>", "Output discovery draft JSON path")
  .option("--include-write-tools", "Include write-like tools (default: read-only)")
  .action(
    async (opts: {
      target?: string;
      targetFile?: string;
      protocolEra?: string;
      allowlist: string;
      output: string;
      includeWriteTools?: boolean;
    }) => {
      const target = await loadTargetFromOptions(opts);
      const allowlist = opts.allowlist.split(",").map((h) => h.trim());
      const baseDir = opts.targetFile ? dirname(resolve(opts.targetFile)) : process.cwd();
      const draft = await runDiscovery(target, allowlist, baseDir, {
        includeWriteTools: opts.includeWriteTools,
      });
      await saveDiscoveryDraft(draft, resolve(opts.output));
      console.log(`Discovery draft ${draft.id} — ${draft.tools.length} tools`);
      console.log(`Status: ${draft.status} (human approve required)`);
      console.log(`Written: ${opts.output}`);
      for (const tool of draft.tools) {
        const suggestion = suggestDescriptionOptimization(tool);
        console.log(`  - ${tool.name}: ${suggestion.rationale[0]}`);
      }
    },
  );

program
  .command("optimize")
  .description(
    "Propose a clearer description for one tool from its live description and schema (does not call the tool; human Accept required)",
  )
  .option("--target <json>", "Target JSON")
  .option("--target-file <path>", "Target JSON file")
  .option("--protocol-era <era>", "MCP protocol era: auto (default), legacy, or modern")
  .requiredOption("--allowlist <hosts>", "Comma-separated allowlist hosts")
  .requiredOption("--tool <name>", "Tool to optimize")
  .action(
    async (opts: {
      target?: string;
      targetFile?: string;
      protocolEra?: string;
      allowlist: string;
      tool: string;
    }) => {
      const target = await loadTargetFromOptions(opts);
      const allowlist = opts.allowlist.split(",").map((h) => h.trim());
      assertTargetAllowlisted(target, allowlist);
      const baseDir = opts.targetFile ? dirname(resolve(opts.targetFile)) : process.cwd();
      const session = await createSession(target, undefined, baseDir);
      let found: Awaited<ReturnType<typeof findToolDescriptor>>;
      try {
        found = await findToolDescriptor(session, opts.tool);
      } finally {
        await session.close();
      }
      const tool = found.tool;
      if (!tool) {
        console.error(`Tool not found: ${opts.tool}`);
        console.error(`Available tools: ${found.names.join(", ") || "(none)"}`);
        process.exitCode = 1;
        return;
      }
      const proposal = await generateDescriptionProposal(tool);
      await appendOptimizeHistory(createOptimizeHistoryEntry(proposal, process.env.SWARM_PRINCIPAL));
      const resolvedTarget =
        target.transport === "stdio"
          ? resolveStdioTarget(target, baseDir)
          : target;
      await saveOptimizeDrafts([
        {
          ...proposal,
          target: resolvedTarget,
          allowlist,
        },
      ]);
      console.log(`Optimize proposal for ${tool.name} (${proposal.source})`);
      console.log(`Before: ${proposal.before || "(no description)"}`);
      for (const param of summarizeToolParameters(tool)) {
        console.log(`  ${param.name}${param.required ? "*" : ""}: ${param.description || "(no description)"}`);
      }
      console.log(`After:  ${proposal.after}`);
      for (const reason of proposal.rationale) console.log(`  - ${reason}`);
      console.log("Status: draft — explicit Accept required in dashboard");
      console.log(
        "To compare before/after, apply the description on the server and rerun tool evals: botz mcp-swarm suite run --suite <name> --inference",
      );
    },
  );

program
  .command("approve")
  .description("Approve a discovery draft and emit a runnable manifest")
  .requiredOption("--draft <path>", "Discovery draft JSON path")
  .requiredOption("--output <path>", "Output manifest JSON path")
  .requiredOption("--by <principal>", "Approving principal (bound identity)")
  .action(async (opts: { draft: string; output: string; by: string }) => {
    const manifest = await approveDiscoveryDraft(
      resolve(opts.draft),
      resolve(opts.output),
      opts.by,
    );
    console.log(`Approved manifest: ${manifest.name}`);
    console.log(`Scenarios: ${manifest.scenarios.length}`);
    console.log(`Written: ${opts.output}`);
  });

const suite = program.command("suite").description("Capture, inspect, refresh, and run standalone suites");
registerSuiteCommands(suite);
registerRunCommand(suite, "run", true);
registerRefreshCommand(suite);
registerServerCommands(suite);
registerAnalyseCommand(suite);
registerSuiteCommands(program); // Backward-compatible capture/show aliases.
registerDiagnostics(program, suite);
registerProjectCommands(program);

program
  .command("worker")
  .description("Run suites and distributed VU slices assigned by a Swarm server, and stream OTEL telemetry. Long-running; does not start the admin server")
  .option("--server <baseUrl>", `Swarm server base URL (defaults to ${SWARM_SERVER_URL_ENV} or ${DEFAULT_SWARM_SERVER_URL})`)
  .option("--token <token>", `Worker token. Defaults to ${WORKER_TOKEN_ENV} or SWARM_TOKEN`)
  .option("--transport <kind>", "auto (HTTP/2, then SSE), http2, or sse", "auto")
  .option("--max-vus <n>", `Maximum virtual users this worker can execute per assigned slice (defaults to ${WORKER_MAX_VUS_ENV} or 50)`)
  .option("--otel-export", "Opt in: send OpenTelemetry spans and metrics (/otlp/v1/traces & /otlp/v1/metrics) to the Swarm server (requires the worker token). Off by default; also SWARM_WORKER_OTEL_EXPORT=1")
  .option("--no-otel-export", "Do not send telemetry to the Swarm server (default)")
  .option("--label <name>", "Optional worker label advertised to the Swarm server")
  .option("--allow-stdio", "Run stdio targets. They start a local command chosen by the service, so they are refused by default")
  .option("--base-dir <dir>", "Directory that relative stdio target commands resolve against. Defaults to cwd")
  .action(
    async (opts: {
      server?: string;
      token?: string;
      transport?: string;
      maxVus?: string;
      otelExport?: boolean;
      label?: string;
      allowStdio?: boolean;
      baseDir?: string;
    }) => {
      const token = resolveWorkerToken(opts.token);
      const transport = parseTransportChoice(opts.transport);
      const server = resolveSwarmServerUrl(opts.server);
      const maxVus = resolveWorkerMaxVus(opts.maxVus);
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      const otelExport = resolveWorkerOtelExport(opts.otelExport, token);
      console.log(`Worker starting: server ${server}, transport ${transport}, maxVus ${maxVus}, otelExport ${otelExport}`);
      const exit = await runWorker({
        server,
        token,
        transport,
        maxVus,
        otelExport,
        label: opts.label,
        allowStdio: opts.allowStdio === true,
        baseDir: opts.baseDir ? resolve(opts.baseDir) : process.cwd(),
        signal: controller.signal,
      });
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (exit.code !== 0) throw new Error(exit.reason);
    },
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error("Error:", error instanceof Error ? error.message : error);
  if (!process.exitCode) process.exitCode = 1;
});
