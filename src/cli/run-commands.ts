import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Option, type Command } from "commander";
import { parseManifest } from "../engine/types/manifest.js";
import { runManifest } from "../engine/core/runner.js";
import { writeReports } from "../engine/core/report.js";
import type { LoadProfile } from "../engine/core/suite-model.js";
import { addAuthOptions, authFlags, collect } from "./suite-commands.js";
import type { AuthFlags } from "./suite-auth.js";
import { cwdReportBaseName, mergeParamValues, readParamFile, runSavedSuite } from "./suite-file.js";
import { displayPath, resolveBotzHome, resolveSuiteArg } from "./botz-home.js";
import { withRunSignal } from "./run-signal.js";
import { selectRunMode } from "./run-mode.js";
import { addTargetOptions, targetOptions, type TargetOptions } from "./target-options.js";
import { printRunResult, type OutputFormat } from "./run-output.js";
import { diagnosticError } from "./diagnostic-error.js";

interface RunOptions extends AuthFlags, TargetOptions {
  manifest?: string; suite?: string; params?: string; set?: string[]; inference?: boolean;
  iterations?: string; concurrency?: string; durationMs?: string; rampUpMs?: string;
  rampDownMs?: string; dwellMs?: string; jitterMs?: string; output?: string;
  soak?: boolean; soakDurationMs?: string; maxIterations?: string; format: OutputFormat;
}
export function integer(value: string | undefined, label: string, minimum = 0): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return Number(value);
}
function suiteLoad(opts: RunOptions, soak: boolean): Partial<LoadProfile> {
  const pairs = {
    iterations: integer(opts.iterations ?? opts.maxIterations, "iterations", 1),
    maxConcurrency: integer(opts.concurrency, "concurrency", 1),
    durationMs: integer(opts.durationMs ?? opts.soakDurationMs ?? (soak ? "5000" : undefined), "duration-ms"),
    rampUpMs: integer(opts.rampUpMs, "ramp-up-ms"), rampDownMs: integer(opts.rampDownMs, "ramp-down-ms"),
    dwellMs: integer(opts.dwellMs, "dwell-ms"), jitterMs: integer(opts.jitterMs, "jitter-ms"),
  };
  return Object.fromEntries(Object.entries(pairs).filter(([, value]) => value !== undefined));
}
export function registerRunCommand(parent: Command, name = "run", suiteOnly = false): void {
  const command = parent.command(name).description(name === "soak" ? "Run a sustained suite or manifest test" : "Execute a saved suite or test manifest")
    .option("--suite <dir|name>", "Saved suite directory or name")
    .option("--inference", "Opt in to model evals and assertion judging", false)
    .option("--no-inference", "Skip model evals (the default)")
    .option("--params <file>", "JSON string map overriding suite parameters")
    .option("--set <key=value>", "Override a suite parameter (repeatable)", collect, [])
    .option("--iterations <n>", "Minimum suite passes per virtual user")
    .option("--concurrency <n>", "Suite virtual users")
    .option("--duration-ms <ms>", "Suite load hold duration, or manifest soak duration")
    .option("--ramp-up-ms <ms>", "Suite virtual-user ramp-up duration")
    .option("--ramp-down-ms <ms>", "Suite drain duration")
    .option("--dwell-ms <ms>", "Delay between suite steps")
    .option("--jitter-ms <ms>", "Maximum random delay between suite passes")
    .option("--soak", "Sustained run; suites use the load engine (default 5000ms)")
    .option("--soak-duration-ms <ms>", "Alias for --duration-ms with soak mode")
    .option("--output <dir>", "Report directory; defaults to cwd for suites or .runs for manifests")
    .addOption(new Option("--format <format>", "stdout format; JSON and Markdown files are always written").choices(["text", "json", "junit"]).default("text"));
  if (!suiteOnly) command.option("--manifest <path>", "Test manifest JSON");
  if (name === "soak") command.option("--max-iterations <n>", "Maximum manifest soak passes (use --iterations for suites)");
  addTargetOptions(addAuthOptions(command));
  command.action(async (opts: RunOptions) => {
    try {
      if (Boolean(opts.suite) === Boolean(opts.manifest)) throw new Error("provide exactly one of --suite or --manifest");
      if (opts.durationMs && opts.soakDurationMs) throw new Error("provide --duration-ms or --soak-duration-ms, not both");
      const soak = name === "soak" || Boolean(opts.soak || opts.soakDurationMs);
      if (opts.suite) {
        if (opts.maxIterations) throw new Error("--max-iterations applies to manifests; use --iterations for the suite pass minimum");
        const params = mergeParamValues(opts.params ? await readParamFile(resolve(opts.params)) : undefined, opts.set ?? []);
        const botz = resolveBotzHome();
        const target = await targetOptions(opts);
        const result = await withRunSignal((signal) => runSavedSuite(resolveSuiteArg(opts.suite!, botz), {
          signal, params, ...target, load: suiteLoad(opts, soak), inference: opts.inference === true,
          outputDir: opts.output ? resolve(opts.output) : process.cwd(),
          reportBaseName: opts.output ? undefined : cwdReportBaseName(), baseDir: process.cwd(), auth: authFlags(opts), botz,
        }));
        const shown = (path: string) => opts.output ? displayPath(path, botz, join(opts.output, basename(path))) : basename(path);
        printRunResult(result.report, { jsonPath: shown(result.jsonPath), markdownPath: shown(result.markdownPath) }, opts.format);
        return;
      }
      if (opts.url || opts.targetFile || opts.params || opts.set?.length || opts.iterations || opts.concurrency || opts.rampUpMs || opts.rampDownMs || opts.dwellMs || opts.jitterMs
        || command.getOptionValueSource("inference") === "cli" || opts.header?.length || opts.headerEnv?.length || opts.bearerEnv || opts.env?.length || opts.envFrom?.length || opts.urlKeyAsBearer) {
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
      const paths = await writeReports(report, opts.output ?? ".runs");
      printRunResult(report, paths, opts.format);
    } catch (error) {
      if (opts.format === "json") console.log(JSON.stringify({ error: diagnosticError(error) }));
      else console.error(`Error: ${error instanceof Error ? error.message : "run failed"}`);
      if (!process.exitCode) process.exitCode = 2;
    }
  });
}
