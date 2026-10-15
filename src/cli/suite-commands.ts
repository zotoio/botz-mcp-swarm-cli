import { resolve } from "node:path";
import type { Command } from "commander";
import type { AuthFlags } from "./suite-auth.js";
import {
  defaultSuiteDir,
  displayPath,
  ensureBotzHome,
  resolveBotzHome,
  resolveSuiteArg,
  suiteDirName,
} from "./botz-home.js";
import {
  captureSuite,
  defaultSuiteName,
  disabledToolNames,
  formatSuiteShow,
  hasEnabledTool,
  loadSuiteFile,
  targetFromCaptureFlags,
} from "./suite-file.js";

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function authFlags(opts: {
  urlKeyAsBearer?: boolean;
  header?: string[];
  headerEnv?: string[];
  bearerEnv?: string | string[];
  env?: string[];
  envFrom?: string[];
}): AuthFlags {
  return {
    urlKeyAsBearer: opts.urlKeyAsBearer,
    header: opts.header,
    headerEnv: opts.headerEnv,
    bearerEnv: opts.bearerEnv,
    env: opts.env,
    envFrom: opts.envFrom,
  };
}

export function addAuthOptions(command: Command): Command {
  return command
    .option("--url-key-as-bearer", "Explicitly convert a URL query key to bearer auth (only for servers that accept it)")
    .option("--header <name:value>", "HTTP header sent to the MCP server. Repeat for each header; prefix alias: for another server", collect, [])
    .option("--header-env <name=ENV>", "HTTP header whose value is read from the environment at connect time; prefix alias: for another server", collect, [])
    .option("--bearer-env <ENV>", "Send Authorization: Bearer from this environment variable; alias=ENV for another server", collect, [])
    .option("--env <key=value>", "stdio environment variable. Repeat for each variable; prefix alias: for another server", collect, [])
    .option("--env-from <key=ENV>", "stdio environment variable read from the environment at connect time; prefix alias: for another server", collect, []);
}

export function registerSuiteCommands(program: Command): void {
  const capture = program
    .command("capture")
    .description("Introspect an MCP server and save a suite directory")
    .option("--url <url>", "Streamable HTTP endpoint")
    .option("--command <bin>", "stdio command")
    .option("--arg <a>", "stdio argument. Repeat for each argument", collect, [])
    .option("--inference", "Generate schema-checked tool arguments, eval prompts, and assertions (opt in)", false)
    .option("--no-inference", "Use schema-derived fixtures instead of model-inferred test data")
    .option("--force", "Replace an existing suite and parameter examples")
    .option("--name <name>", "Suite name. Defaults to an endpoint-derived name or command")
    .option("--alias <alias>", "Alias for this server, for suites that will call more than one. Defaults to default");
  addAuthOptions(capture)
    .option("--out <dir>", "Directory for suite.json and params.example.json. Defaults to <suitesDir>/<name>: .botz/mcp-swarm/suites in the git repo, else ~/.botz/mcp-swarm/suites")
    .action(async (opts: {
      url?: string;
      command?: string;
      arg?: string[];
      name?: string;
      out?: string;
      inference?: boolean;
      force?: boolean;
      urlKeyAsBearer?: boolean;
      header?: string[];
      headerEnv?: string[];
      bearerEnv?: string[];
      env?: string[];
      envFrom?: string[];
      alias?: string;
    }) => {
      const target = targetFromCaptureFlags(opts);
      const botz = resolveBotzHome();
      const name = opts.name?.trim() || defaultSuiteName(target);
      const outDir = opts.out ? resolve(opts.out) : defaultSuiteDir(botz, name);
      if (!opts.out) await ensureBotzHome(botz);
      const suite = await captureSuite({
        target,
        force: opts.force,
        outDir,
        name,
        baseDir: process.cwd(),
        auth: authFlags(opts),
        botz,
        inference: opts.inference,
        alias: opts.alias,
      });
      if (suite.movedUrlParam) {
        console.log(`Moved the URL query parameter ${suite.movedUrlParam} to an Authorization: Bearer header`);
      }
      const moved = suite.savedCredentialNames;
      if (moved.length > 0) {
        console.log(`Credentials saved to ${botz.display}/config.json (not committed): ${moved.join(", ")}`);
      }
      const disabled = disabledToolNames(suite.surface);
      const params = Object.keys(suite.params);
      console.log(`Tools: ${suite.surface.tools.length}`);
      if (opts.inference === true && hasEnabledTool(suite.nodes)) console.log("Test data: model-inferred arguments, prompts, and assertions for enabled tools");
      if (disabled.length > 0) console.log(`Disabled: ${disabled.join(", ")}`);
      console.log(`Parameters: ${params.length > 0 ? params.join(", ") : "(none)"}`);
      console.log(`Written: ${displayPath(outDir, botz, opts.out ?? suiteDirName(name))}`);
    });

  program
    .command("show")
    .description("Print a saved suite's target, enabled steps, and parameters")
    .requiredOption("--suite <dir>", "Suite directory, or a suite name under the configured suites directory")
    .action(async (opts: { suite: string }) => {
      const suite = await loadSuiteFile(resolveSuiteArg(opts.suite, resolveBotzHome()));
      console.log(formatSuiteShow(suite));
    });
}

export { collect };
