import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { Command } from "commander";
import { resolveInferenceConfig } from "../engine/core/inference-model.js";
import { resolveBotzHome, resolveSuiteArg, suiteSearchDirs } from "./botz-home.js";
import { isMultiServer, loadSuiteFile, resolveSuiteExecution, suiteDefaultAlias, suiteServers } from "./suite-file.js";
import { crossServerFlows, DEFAULT_SERVER, formatCrossServerFlows, serverIssues, variableIssues } from "../engine/core/servers.js";
import { diagnosticError } from "./diagnostic-error.js";
import { addTargetOptions, targetOptions, type TargetOptions } from "./target-options.js";
import { addAuthOptions, authFlags } from "./suite-commands.js";
import type { AuthFlags } from "./suite-auth.js";

type Check = { name: string; ok: boolean; detail: string };
async function executable(command: string, cwd: string): Promise<boolean> {
  const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [resolve(cwd, command)] : (process.env.PATH ?? "").split(delimiter).map((p) => join(p, command));
  const extensions = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const candidate of candidates) for (const ext of extensions) {
    try { await access(candidate + ext, constants.X_OK); return true; } catch { /* Try next. */ }
  }
  return false;
}
async function writable(path: string): Promise<boolean> {
  let dir = resolve(path);
  while (true) {
    try { await access(dir, constants.W_OK); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = dirname(dir); if (parent === dir) return false; dir = parent;
    }
  }
}
function output(value: unknown, text: string, json?: boolean): void { console.log(json ? JSON.stringify(value) : text); }

export function registerDiagnostics(program: Command, suite: Command): void {
  suite.command("list").option("--json", "Machine-readable output").action(async (opts: { json?: boolean }) => {
    const botz = resolveBotzHome();
    const seen = new Set<string>();
    const found: { dir: string; name: string }[] = [];
    for (const dir of suiteSearchDirs(botz)) {
      const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []; throw error;
      });
      for (const entry of entries) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
        seen.add(entry.name);
        found.push({ dir, name: entry.name });
      }
    }
    const rows = await Promise.all(found.sort((a, b) => a.name.localeCompare(b.name)).map(async ({ dir, name }) => {
      try { const data = await loadSuiteFile(join(dir, name)); return { name: data.name, directory: name, valid: true }; }
      catch { return { name, directory: name, valid: false }; }
    }));
    output(rows, rows.map((r) => `${r.directory}\t${r.valid ? r.name : "invalid suite"}`).join("\n") || "No saved suites.", opts.json);
  });
  addTargetOptions(suite.command("validate").requiredOption("--suite <dir|name>", "Saved suite"))
    .option("--json", "Machine-readable output").action(async (opts: TargetOptions & { suite: string; json?: boolean }) => {
      try {
        const botz = resolveBotzHome();
        const { suite: data } = await resolveSuiteExecution(resolveSuiteArg(opts.suite, botz), {
          botz, ...await targetOptions(opts), resolveSecrets: false,
        });
        const defaultAlias = suiteDefaultAlias(data);
        const surfaces = Object.fromEntries(Object.entries(suiteServers(data)).map(([alias, server]) => [alias, server.surface]));
        const multi = Object.keys(surfaces).length > 1;
        const issues = serverIssues(data.nodes, surfaces, defaultAlias);
        // A tool missing from its server's surface is an error once steps can call different servers.
        const warnings = issues.filter((issue) => issue.warning || (issue.tool && !multi));
        const errors = [...issues.filter((issue) => issue.tool && multi), ...variableIssues(data.nodes, Object.keys(data.params))];
        const flows = crossServerFlows(data.nodes, defaultAlias);
        if (errors.length > 0) {
          output({ valid: false, code: "invalid_suite", detail: `${errors[0]!.path}: ${errors[0]!.message}`, issues: errors },
            ["Suite invalid:", ...errors.map((issue) => `  ${issue.path}: ${issue.message}`)].join("\n"), opts.json);
          process.exitCode = 1;
          return;
        }
        output({
          valid: true,
          schemaVersion: data.schemaVersion ?? 1,
          ...(isMultiServer(data) || defaultAlias !== DEFAULT_SERVER ? { servers: Object.keys(surfaces), defaultServer: defaultAlias } : {}),
          ...(warnings.length > 0 ? { warnings: warnings.map((issue) => `${issue.path}: ${issue.message}`) } : {}),
          ...(flows.length > 0 ? { crossServerFlows: flows } : {}),
        }, [
          "Suite valid (offline).",
          ...warnings.map((issue) => `Warning: ${issue.path}: ${issue.message}`),
          ...(flows.length > 0 ? ["Cross-server data flows", ...formatCrossServerFlows(flows)] : []),
        ].join("\n"), opts.json);
      } catch (error) {
        const diagnostic = diagnosticError(error);
        output({ valid: false, ...diagnostic }, `Suite invalid: ${diagnostic.detail}`, opts.json);
        process.exitCode = 1;
      }
    });
  addTargetOptions(addAuthOptions(program.command("doctor"))).description("Check local setup without contacting MCP or model servers")
    .option("--suite <dir|name>", "Check a saved suite and its credentials")
    .option("--inference", "Require a configured inference provider")
    .option("--output <dir>", "Check output directory permissions", ".")
    .option("--json", "Machine-readable output")
    .action(async (opts: AuthFlags & TargetOptions & { suite?: string; inference?: boolean; output: string; json?: boolean }) => {
      const botz = resolveBotzHome();
      const checks: Check[] = [{ name: "output", ok: await writable(opts.output), detail: "output directory writable" }];
      if (opts.inference) {
        try { const config = resolveInferenceConfig(); checks.push({ name: "inference", ok: config.provider === "ollama" || Boolean(config.apiKey), detail: "provider, model, and credentials configured" }); }
        catch { checks.push({ name: "inference", ok: false, detail: "check SWARM_LLM_PROVIDER, model, endpoint, and provider credentials" }); }
      }
      if (opts.suite) {
        try {
          const dir = resolveSuiteArg(opts.suite, botz);
          const { targets, baseDir, suite } = await resolveSuiteExecution(dir, { botz, auth: authFlags(opts), ...await targetOptions(opts) });
          checks.push({ name: "suite", ok: true, detail: "schema, parameters, executable steps, and credentials resolved" });
          const multi = isMultiServer(suite);
          for (const [alias, target] of targets) {
            if (target.transport !== "stdio") continue;
            const ok = await executable(target.command, target.cwd ?? baseDir);
            const where = multi ? `${alias}: ` : "";
            checks.push({ name: multi ? `stdio ${alias}` : "stdio", ok, detail: ok ? `${where}stdio executable available`
              : multi ? `${where}stdio executable ${basename(target.command)} missing; check its target.command, target.cwd, and PATH`
              : "stdio executable missing; check target.command, target.cwd, and PATH" });
          }
        } catch (error) { checks.push({ name: "suite", ok: false, detail: diagnosticError(error).detail }); }
      }
      const ok = checks.every((check) => check.ok);
      output({ ok, checks }, checks.map((check) => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`).join("\n"), opts.json);
      if (!ok) process.exitCode = 1;
    });
}
