import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Option, type Command } from "commander";
import { parseManifest } from "../engine/types/manifest.js";
import { runManifest } from "../engine/core/runner.js";
import { writeReports } from "../engine/core/report.js";
import { parseSuiteLimit, SUITE_LIMIT_CEILINGS, type SuiteLimits } from "../engine/core/suite-limits.js";
import type { LoadProfile } from "../engine/core/suite-model.js";
import { LOAD_PRESETS, type LoadPresetId } from "../engine/core/load-presets.js";
import { addAuthOptions, authFlags, collect } from "./suite-commands.js";
import { anyAuthFlags, type AuthFlags } from "./suite-auth.js";
import { runReportBaseName, mergeParamValues, readParamFile, runSavedSuite } from "./suite-file.js";
import { displayPath, ensureBotzHome, resolveBotzHome, resolveSuiteArg, type BotzHome } from "./botz-home.js";
import { withRunSignal } from "./run-signal.js";
import { selectRunMode } from "./run-mode.js";
import { addTargetOptions, targetOptions, type TargetOptions } from "./target-options.js";
import { printRunResult, type OutputFormat } from "./run-output.js";
import { diagnosticError } from "./diagnostic-error.js";
import { rampDownFlags } from "./ramp-down-flags.js";
import { runRemoteSuite } from "./remote-run.js";
import { DEFAULT_SWARM_SERVER_URL } from "./worker-transport.js";

interface RunOptions extends AuthFlags, TargetOptions {
  manifest?: string; suite?: string; project?: string; params?: string; set?: string[]; inference?: boolean; allowStdio?: boolean;
  iterations?: string; concurrency?: string; durationMs?: string; rampUpMs?: string;
  rampDownMs?: string; dwellMs?: string; jitterMs?: string; output?: string;
  soak?: boolean; soakDurationMs?: string; maxIterations?: string; format: OutputFormat;
  maxCallCount?: string; maxPayloadBytes?: string; rampDownStrategy?: string; drainTimeoutMs?: string;
  preset?: LoadPresetId; skipImageGen?: boolean; skipExpensiveLlm?: boolean;
  remote?: boolean; central?: boolean; server?: string; token?: string; dispatch?: "local" | "worker";
}
export function integer(value: string | undefined, label: string, minimum = 0): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return Number(value);
}
function suiteLoad(opts: RunOptions, soak: boolean): Partial<LoadProfile> {
  const presetBase = opts.preset && LOAD_PRESETS[opts.preset] ? { ...LOAD_PRESETS[opts.preset].load } : {};
  const pairs = {
    iterations: integer(opts.iterations ?? opts.maxIterations, "iterations", 1),
    maxConcurrency: integer(opts.concurrency, "concurrency", 1),
    durationMs: integer(opts.durationMs ?? opts.soakDurationMs ?? (soak ? "5000" : undefined), "duration-ms"),
    rampUpMs: integer(opts.rampUpMs, "ramp-up-ms"), rampDownMs: integer(opts.rampDownMs, "ramp-down-ms"),
    dwellMs: integer(opts.dwellMs, "dwell-ms"), jitterMs: integer(opts.jitterMs, "jitter-ms"),
  };
  const load: Partial<LoadProfile> = { ...presetBase, ...Object.fromEntries(Object.entries(pairs).filter(([, value]) => value !== undefined)) };
  const rampDown = rampDownFlags(opts);
  if (rampDown) load.rampDown = rampDown;
  return load;
}
export function suiteLimitFlags(opts: { maxCallCount?: string; maxPayloadBytes?: string }): Partial<SuiteLimits> {
  const pairs = { maxCallCount: parseSuiteLimit("maxCallCount", opts.maxCallCount), maxPayloadBytes: parseSuiteLimit("maxPayloadBytes", opts.maxPayloadBytes) };
  return Object.fromEntries(Object.entries(pairs).filter(([, value]) => value !== undefined));
}
/** `--output`, else the configured runs directory; the default location gets its `.gitignore` first. */
async function reportDir(output: string | undefined, botz: BotzHome): Promise<string> {
  if (output) return resolve(output);
  await ensureBotzHome(botz);
  return botz.runsDir;
}

function shownReports(paths: { jsonPath: string; markdownPath: string }, botz: BotzHome, output: string | undefined) {
  const shown = (path: string) => displayPath(path, botz, output ? join(output, basename(path)) : basename(path));
  return { jsonPath: shown(paths.jsonPath), markdownPath: shown(paths.markdownPath) };
}

export function registerRunCommand(parent: Command, name = "run", suiteOnly = false): void {
  const command = parent.command(name).description(name === "soak" ? "Run a sustained suite or manifest test" : "Execute a saved suite, test manifest, or central Swarm server suite")
    .option("--suite <dir|name>", "Saved suite directory or name (or central project/suite id when --remote is used)")
    .option("--project <id>", "Project id on the central Swarm server (when --remote / --server is used)")
    .option("--remote", `Execute the suite on the central Swarm server (defaults --server to SWARM_SERVER_URL or ${DEFAULT_SWARM_SERVER_URL})`)
    .option("--central", `Alias for --remote (executes on ${DEFAULT_SWARM_SERVER_URL})`)
    .option("--server <url>", `Central Swarm server base URL (defaults to SWARM_SERVER_URL or ${DEFAULT_SWARM_SERVER_URL} when --remote is used)`)
    .option("--token <token>", "Bearer token (bzt_... or OAuth token) for central Swarm server (defaults to SWARM_TOKEN / SWARM_WORKER_TOKEN)")
    .addOption(new Option("--dispatch <mode>", "Central server execution dispatch mode (local or worker)").choices(["local", "worker"]))
    .option("--inference", "Opt in to model evals and assertion judging", false)
    .option("--allow-stdio", "Allow stdio servers declared in suite.json; they start a local command, so they are refused by default")
    .option("--no-inference", "Skip model evals (the default)")
    .option("--params <file>", "JSON string map overriding suite parameters")
    .option("--set <key=value>", "Override a suite parameter (repeatable)", collect, [])
    .addOption(new Option("--preset <preset>", "Named load profile preset (smoke, baseline, peak, spike, soak)").choices(["smoke", "baseline", "peak", "spike", "soak"]))
    .option("--skip-image-gen", "Send X-Swarm-Skip-Image-Gen: 1 header during load/soak runs")
    .option("--skip-expensive-llm", "Send X-Swarm-Skip-Expensive-Llm: 1 header during load/soak runs")
    .option("--iterations <n>", "Minimum suite passes per virtual user")
    .option("--concurrency <n>", "Suite virtual users")
    .option("--duration-ms <ms>", "Suite load hold duration, or manifest soak duration")
    .option("--ramp-up-ms <ms>", "Suite virtual-user ramp-up duration")
    .option("--ramp-down-ms <ms>", "Suite drain duration")
    .option("--ramp-down-strategy <strategy>", "graceful (default: retire VUs across the ramp-down window) or immediate")
    .option("--drain-timeout-ms <ms>", "Extra grace after ramp-down before in-flight passes are cancelled (default 0)")
    .option("--dwell-ms <ms>", "Delay between suite steps")
    .option("--jitter-ms <ms>", "Maximum random delay between suite passes")
    .option("--max-call-count <n>", `Suite call-count limit (overrides suite limits; env SWARM_MAX_CALL_COUNT; default 100000; max ${SUITE_LIMIT_CEILINGS.maxCallCount})`)
    .option("--max-payload-bytes <n>", `Suite per-payload byte limit (overrides suite limits; env SWARM_MAX_PAYLOAD_BYTES; default 1048576; max ${SUITE_LIMIT_CEILINGS.maxPayloadBytes})`)
    .option("--soak", "Sustained run; suites use the load engine (default 5000ms)")
    .option("--soak-duration-ms <ms>", "Alias for --duration-ms with soak mode")
    .option("--output <dir>", "Report directory; defaults to runsDir in .botz/mcp-swarm/settings.json, else .botz/mcp-swarm/runs")
    .addOption(new Option("--format <format>", "stdout format; JSON and Markdown files are always written").choices(["text", "json", "junit"]).default("text"));
  if (!suiteOnly) command.option("--manifest <path>", "Test manifest JSON");
  if (name === "soak") command.option("--max-iterations <n>", "Maximum manifest soak passes (use --iterations for suites)");
  addTargetOptions(addAuthOptions(command));
  command.action(async (opts: RunOptions) => {
    try {
      const useRemote = Boolean(opts.remote || opts.central || opts.server || opts.project);
      if (useRemote) {
        const projectId = (opts.project ?? opts.suite ?? "").trim();
        if (!projectId) throw new Error("provide --suite <id> or --project <id> when running on the central Swarm server");
        const suiteId = opts.project && opts.suite ? opts.suite.trim() : undefined;
        const botz = resolveBotzHome();
        const outputDir = await reportDir(opts.output, botz);
        const result = await withRunSignal((signal) =>
          runRemoteSuite({
            server: opts.server,
            token: opts.token,
            projectId,
            suiteId,
            preset: opts.preset,
            dispatch: opts.dispatch,
            concurrency: integer(opts.concurrency, "concurrency", 1),
            durationMs: integer(opts.durationMs ?? opts.soakDurationMs, "duration-ms", 1),
            skipImageGen: opts.skipImageGen || opts.preset === "soak",
            skipExpensiveLlm: opts.skipExpensiveLlm || opts.preset === "soak",
            outputDir,
            signal,
          }),
        );
        const paths = shownReports(
          {
            jsonPath: result.jsonPath ?? join(outputDir, `${result.report.id}.json`),
            markdownPath: result.markdownPath ?? join(outputDir, `${result.report.id}.md`),
          },
          botz,
          opts.output,
        );
        printRunResult(result.report, paths, opts.format);
        return;
      }

      if (Boolean(opts.suite) === Boolean(opts.manifest)) throw new Error("provide exactly one of --suite or --manifest");
      if (opts.durationMs && opts.soakDurationMs) throw new Error("provide --duration-ms or --soak-duration-ms, not both");
      const soak = name === "soak" || Boolean(opts.soak || opts.soakDurationMs);
      if (opts.suite) {
        if (opts.maxIterations) throw new Error("--max-iterations applies to manifests; use --iterations for the suite pass minimum");
        const params = mergeParamValues(opts.params ? await readParamFile(resolve(opts.params)) : undefined, opts.set ?? []);
        const botz = resolveBotzHome();
        if (opts.skipImageGen || opts.preset === "soak") {
          opts.header = [...(opts.header ?? []), "X-Swarm-Skip-Image-Gen: 1"];
        }
        if (opts.skipExpensiveLlm || opts.preset === "soak") {
          opts.header = [...(opts.header ?? []), "X-Swarm-Skip-Expensive-Llm: 1"];
        }
        const target = await targetOptions(opts);
        const outputDir = await reportDir(opts.output, botz);
        const result = await withRunSignal((signal) => runSavedSuite(resolveSuiteArg(opts.suite!, botz), {
          signal, params, ...target, load: suiteLoad(opts, soak), limits: suiteLimitFlags(opts), inference: opts.inference === true,
          outputDir, reportBaseName: opts.output ? undefined : runReportBaseName(), baseDir: process.cwd(), auth: authFlags(opts), botz,
          allowStdio: opts.allowStdio === true,
        }));
        printRunResult(result.report, shownReports(result, botz, opts.output), opts.format);
        return;
      }
      if (opts.url || opts.targetFile || opts.target?.length || opts.params || opts.set?.length || opts.iterations || opts.concurrency || opts.rampUpMs || opts.rampDownMs || opts.rampDownStrategy || opts.drainTimeoutMs || opts.dwellMs || opts.jitterMs
        || command.getOptionValueSource("inference") === "cli" || opts.header?.length || opts.headerEnv?.length || anyAuthFlags({ bearerEnv: opts.bearerEnv }) || opts.env?.length || opts.envFrom?.length || opts.urlKeyAsBearer) {
        throw new Error("target overrides, load flags, parameters, inference, and credentials apply to --suite; edit the manifest for these settings");
      }
      const path = resolve(opts.manifest!);
      const raw = JSON.parse(await readFile(path, "utf8"));
      const duration = integer(opts.durationMs ?? opts.soakDurationMs, "duration-ms", 1);
      const maxIterations = integer(opts.maxIterations, "max-iterations", 1);
      const explicitSoak = soak || duration !== undefined;
      if (explicitSoak || maxIterations !== undefined) {
        raw.soak ??= {};
        if (duration !== undefined) raw.soak.durationMs = duration;
        if (maxIterations !== undefined) raw.soak.maxIterations = maxIterations;
        if (!raw.soak.durationMs && !raw.soak.maxIterations) raw.soak.durationMs = 5000;
      }
      const manifest = parseManifest(raw);
      const report = await withRunSignal((signal) => runManifest({ signal, manifest, manifestDir: dirname(path), mode: selectRunMode(manifest, explicitSoak) }));
      const botz = resolveBotzHome();
      const paths = await writeReports(report, await reportDir(opts.output, botz));
      printRunResult(report, shownReports(paths, botz, opts.output), opts.format);
    } catch (error) {
      if (opts.format === "json") console.log(JSON.stringify({ error: diagnosticError(error) }));
      else console.error(`Error: ${error instanceof Error ? error.message : "run failed"}`);
      if (!process.exitCode) process.exitCode = 2;
    }
  });
}
