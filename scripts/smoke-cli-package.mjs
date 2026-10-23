#!/usr/bin/env node
/** Installs and tests the actual consumer artifact. No workspace imports or local swarm service. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";

const tarball = resolve(process.argv[2] ?? (() => { throw new Error("usage: smoke-cli-package.mjs <tarball>"); })());
const scratch = mkdtempSync(join(tmpdir(), "botz-consumer-"));
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(SWARM_|OTEL_|OPENAI_|ANTHROPIC_|TYPESAFE_)/.test(key)) delete env[key];
try {
  writeFileSync(join(scratch, "package.json"), '{"private":true,"type":"module"}');
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: scratch, env, stdio: "pipe", shell: process.platform === "win32", timeout: 180_000 });
  // Deliberately use a subdirectory and a conflicting root script.
  mkdirSync(join(scratch, ".git"));
  const sub = join(scratch, "sub"); mkdirSync(sub);
  const entry = join(scratch, "node_modules/@zotoio/botz-mcp-swarm-cli/dist/cli.js");
  const pkg = JSON.parse(readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8"));
  for (const alias of ["swarm", "botz-mcp-swarm"]) {
    const bin = join(scratch, "node_modules/.bin", alias + (process.platform === "win32" ? ".cmd" : ""));
    assert.equal(execFileSync(bin, ["--version"], { cwd: scratch, env, encoding: "utf8", shell: process.platform === "win32" }).trim(), pkg.version);
  }
  assert.equal(Object.hasOwn(pkg.bin, "botz"), false, "extension must not own the host command");
  const pluginEnv = { ...env, BOTZ_PLUGIN: "mcp-swarm" };
  const pluginHelp = execFileSync(process.execPath, [entry, "--help"], { cwd: scratch, env: pluginEnv, encoding: "utf8" });
  assert.match(pluginHelp, /Usage: botz mcp-swarm/);
  const nestedHelp = execFileSync(process.execPath, [entry, "suite", "run", "--help"], { cwd: scratch, env: pluginEnv, encoding: "utf8" });
  assert.match(nestedHelp, /--suite/);
  const invalidPlugin = spawnSync(process.execPath, [entry, "not-a-command"], { cwd: scratch, env: pluginEnv, encoding: "utf8" });
  assert.notEqual(invalidPlugin.status, 0);
  writeFileSync(join(scratch, "fixture.mjs"), 'throw new Error("wrong working directory");');
  writeFileSync(join(sub, "fixture.mjs"), `
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema, CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const server = new Server({name:'consumer-fixture',version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async()=>({tools:[{name:'echo',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{message:{type:'string'}},required:['message']}}]}));
server.setRequestHandler(CallToolRequestSchema, async r=>({isError:r.params.arguments.message==='fail',content:[{type:'text',text:String(r.params.arguments.message)}]}));
await server.connect(new StdioServerTransport());
`);
  const cli = (args, cwd = scratch, code = 0) => {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, code, result.stderr + result.stdout);
    return result.stdout;
  };
  // Skills ship in zotoio/zoto-agents; the CLI only reports and removes 0.6.x copies.
  const skills = args => JSON.parse(cli(["skills", ...args, "--scope", "project", "--json"], sub)).results;
  assert.deepEqual(skills(["status"]), []);
  assert.deepEqual(skills(["uninstall"]), []);
  cli(["skills", "install", "--agent", "cursor"], sub, 1);
  assert.deepEqual(JSON.parse(cli(["upgrade", "--json"], sub)).actions, [], "a fresh install needs no upgrade");
  cli(["suite", "capture", "--command", process.execPath, "--arg", "fixture.mjs", "--name", "demo"], sub);
  cli(["capture", "--command", process.execPath, "--arg", "fixture.mjs", "--name", "demo", "--no-inference"], sub, 1);
  cli(["show", "--suite", "demo"]);
  cli(["suite", "show", "--suite", "demo"]);
  assert.equal(JSON.parse(cli(["suite", "validate", "--suite", "demo", "--json"])).valid, true);
  assert.equal(JSON.parse(cli(["doctor", "--suite", "demo", "--json"])).ok, true);
  assert.equal(JSON.parse(cli(["suite", "list", "--json"])).length, 1);
  cli(["run", "--suite", "demo", "--no-inference", "--output", "reports"]);
  cli(["run", "--suite", "demo", "--no-inference", "--output", "reports"], sub);
  cli(["run", "--suite", "demo", "--no-inference", "--set", "message=fail", "--output", "reports"], scratch, 1);
  const suitePath = join(scratch, ".botz/mcp-swarm/suites/demo/suite.json");
  const original = readFileSync(suitePath, "utf8");
  assert.equal(JSON.parse(cli(["suite", "refresh", "--suite", "demo", "--dry-run", "--json"])).applied, false);
  assert.equal(readFileSync(suitePath, "utf8"), original);
  assert.equal(JSON.parse(cli(["suite", "refresh", "--suite", "demo", "--json"])).applied, true);
  const concurrent = JSON.parse(cli(["suite", "run", "--suite", "demo", "--iterations", "2", "--concurrency", "2", "--format", "json", "--output", "reports"]));
  assert.equal(concurrent.verdict, "pass");
  assert.equal(concurrent.toolSeries.find(t => t.toolName === "echo").count, 4);
  assert.equal(concurrent.toolEvals, undefined);
  const timed = JSON.parse(cli(["soak", "--suite", "demo", "--duration-ms", "100", "--ramp-up-ms", "10", "--ramp-down-ms", "10", "--format", "json", "--output", "reports"]));
  assert.equal(timed.mode, "load"); assert.equal(timed.loadProfile.durationMs, 100);
  assert.match(cli(["suite", "run", "--suite", "demo", "--format", "junit", "--output", "reports"]), /^<\?xml/);
  const invalid = JSON.parse(cli(["suite", "run", "--suite", "demo", "--concurrency", "2x", "--format", "json"], scratch, 2));
  assert.equal(invalid.error.code, "INVALID_OPTION");
  writeFileSync(join(scratch, "target.json"), JSON.stringify({transport:"stdio",command:process.execPath,args:[join(sub,"fixture.mjs")]}));
  assert.equal(JSON.parse(cli(["suite", "run", "--suite", "demo", "--target-file", "target.json", "--format", "json", "--output", "reports"])).verdict, "pass");
  writeFileSync(join(scratch, "manifest.json"), JSON.stringify({ name:"consumer", target:{transport:"stdio",command:process.execPath,args:[join(sub,"fixture.mjs")]},allowlist:["stdio"],scenarios:[{name:"echo",iterations:1,steps:[{method:"tools/call",tool:"echo",args:{message:"hello"}}]}] }));
  cli(["run", "--manifest", "manifest.json", "--output", "reports"]);
  cli(["soak", "--manifest", "manifest.json", "--duration-ms", "100", "--output", "reports"]);
  cli(["run", "--manifest", "manifest.json"]);
  assert.ok(readdirSync(join(scratch, ".botz/mcp-swarm/runs")).some(n => n.endsWith(".json")), "default reports land in .botz/mcp-swarm/runs");
  assert.ok(!existsSync(join(scratch, ".botz/mcp-swarm/data")) && !existsSync(join(scratch, ".swarm-data")));
  const reports = readdirSync(join(scratch,"reports")).filter(n=>n.endsWith(".json")).map(n=>JSON.parse(readFileSync(join(scratch,"reports",n),"utf8")));
  assert.ok(reports.some(r=>r.verdict==="fail"));
  assert.ok(reports.every(r=>r.otelStatus==="disabled"));
  // Standalone projects: the target the user added is the run's consent, with no service policy.
  const project = (args, code = 0) => cli(["project", ...args], sub, code);
  const projectJson = args => JSON.parse(project([...args, "--json"]));
  assert.match(project(["add", "--name", "fxp", "--target", JSON.stringify({transport:"stdio",command:process.execPath,args:["fixture.mjs"]})]), /Tools: 1\n/);
  project(["load", "fxp", "--duration-ms", "200", "--ramp-down-ms", "300", "--ramp-up-ms", "0", "--jitter-ms", "0", "--dwell-ms", "0"]);
  assert.match(project(["run", "fxp"]), /Verdict: PASS/);
  const flatNodes = nodes => nodes.flatMap(n => [n, ...flatNodes(n.children ?? [])]);
  const echoNode = flatNodes(projectJson(["suite", "show", "fxp"]).nodes).find(n => n.tool === "echo");
  project(["suite", "set-node", "fxp", "--node", echoNode.id, "--args", '{"message":"fail"}']);
  assert.match(project(["run", "fxp"], 1), /Verdict: FAIL/);
  const projectRuns = projectJson(["runs", "fxp"]);
  assert.deepEqual(projectRuns.map(r => r.verdict), ["fail", "pass"]);
  project(["compare", "fxp", "--base", projectRuns[1].id, "--head", projectRuns[1].id]);
  assert.match(project(["compare", "fxp", "--base", projectRuns[1].id, "--head", projectRuns[0].id], 1), /error_rate increased/);
  project(["server-edit", "fxp", "--target", JSON.stringify({transport:"stdio",command:process.execPath,args:["fixture.mjs"],cwd:dirname(scratch)})]);
  assert.match(project(["run", "fxp"], 1), /stdio_command_outside_repo/);
  assert.match(projectJson(["report", "fxp", projectJson(["runs", "fxp"])[0].id]).failReasons.join("\n"), /stdio_command_outside_repo/);
  project(["run", "fxp", "--version", "0"], 1);
  project(["show", "missing"], 1);
  env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:9";
  cli(["run", "--manifest", "manifest.json", "--output", "failed-telemetry"]);
  const failedExport = readdirSync(join(scratch, "failed-telemetry")).find(n => n.endsWith(".json"));
  const exportReport = JSON.parse(readFileSync(join(scratch, "failed-telemetry", failedExport), "utf8"));
  assert.equal(exportReport.verdict, "pass");
  assert.equal(exportReport.otelStatus, "failed");
  assert.equal(exportReport.otelExported, false);
  console.log("Consumer package smoke passed: legacy skills status/uninstall, aliases, capture, portability, diagnostics, pass/fail, refresh, overrides, concurrency, JSON/JUnit, manifest, soak, no service state, standalone project add/run/runs/compare.");
} finally { rmSync(scratch, { recursive: true, force: true }); }
