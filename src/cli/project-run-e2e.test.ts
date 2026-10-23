import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Standalone `project` commands in a separate process, against a stdio fixture the user added. */

const FIXTURE = `
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema, CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const server = new Server({name:'project-fixture',version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async()=>({tools:[{name:'echo',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{message:{type:'string'}},required:['message']}}]}));
server.setRequestHandler(CallToolRequestSchema, async r=>({isError:r.params.arguments.message==='fail',content:[{type:'text',text:String(r.params.arguments.message)}]}));
await server.connect(new StdioServerTransport());
`;

/** The CLI package root, so the test also runs from a workspace that holds this package. */
const pkg = fileURLToPath(new URL("../..", import.meta.url));
let root = "";
let work = "";
let entry = "";
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(SWARM_|OTEL_|OPENAI_|ANTHROPIC_|TYPESAFE_)/.test(key)) delete env[key];

function cli(args: string[], code = 0): string {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: work, env, encoding: "utf8", timeout: 30_000 });
  expect(result.status, result.stderr + result.stdout).toBe(code);
  return result.stdout + result.stderr;
}

const json = <T>(args: string[]): T => JSON.parse(cli([...args, "--json"])) as T;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "project-e2e-"));
  // The built CLI and the fixture resolve packages from root/node_modules.
  await symlink(resolve(pkg, "node_modules"), join(root, "node_modules"), "dir");
  await writeFile(join(root, "package.json"), '{"private":true,"type":"module","version":"0.0.0-test"}');
  await build({
    entry: { cli: resolve(pkg, "src/cli.ts") }, format: "esm", platform: "node", target: "node22",
    outDir: join(root, "dist"), clean: true, dts: false, sourcemap: false, fixedExtension: false,
    deps: { neverBundle: true }, config: false, logLevel: "silent",
  });
  entry = join(root, "dist", "cli.js");
  work = join(root, "work");
  await mkdir(join(work, ".git"), { recursive: true });
  await writeFile(join(work, "fixture.mjs"), FIXTURE);
}, 60_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("standalone project commands", () => {
  it("adds, runs, lists, and compares runs", () => {
    expect(cli(["project", "add", "--name", "fxp", "--target", '{"transport":"stdio","command":"node","args":["fixture.mjs"]}']))
      .toMatch(/Tools: 1\n/);
    cli(["project", "load", "fxp", "--duration-ms", "200", "--ramp-down-ms", "300", "--ramp-up-ms", "0", "--jitter-ms", "0", "--dwell-ms", "0"]);

    const passed = cli(["project", "run", "fxp"]);
    expect(passed).toMatch(/Verdict: PASS/);
    expect(passed).not.toMatch(/report_missing/);

    // A failing echo step is a stored, failing run with an error-rate regression against the passing one.
    const version = json<{ nodes: Array<{ id: string; tool?: string; children?: unknown[] }> }>(["project", "suite", "show", "fxp"]);
    const flat = (nodes: Array<{ id: string; tool?: string; children?: unknown[] }>): Array<{ id: string; tool?: string }> =>
      nodes.flatMap((node) => [node, ...flat((node.children ?? []) as typeof nodes)]);
    const echo = flat(version.nodes).find((node) => node.tool === "echo");
    expect(echo).toBeDefined();
    cli(["project", "suite", "set-node", "fxp", "--node", echo!.id, "--args", '{"message":"fail"}']);
    expect(cli(["project", "run", "fxp"], 1)).toMatch(/Verdict: FAIL/);

    const runs = json<Array<{ id: string; verdict: string }>>(["project", "runs", "fxp"]);
    expect(runs.map((run) => run.verdict)).toEqual(["fail", "pass"]);
    const [head, base] = runs;

    expect(cli(["project", "compare", "fxp", "--base", base!.id, "--head", base!.id])).toMatch(/\| echo \| unchanged \| yes \|/);
    expect(cli(["project", "compare", "fxp", "--base", base!.id, "--head", head!.id], 1)).toMatch(/echo: error_rate increased/);
  });

  it("stores and prints the reason when a run fails before producing a report", () => {
    cli(["project", "add", "--name", "outside", "--target", '{"transport":"stdio","command":"node","args":["fixture.mjs"]}']);
    cli(["project", "server-edit", "outside", "--target", JSON.stringify({ transport: "stdio", command: "node", args: ["fixture.mjs"], cwd: root })]);
    const output = cli(["project", "run", "outside"], 1);
    expect(output).toMatch(/stdio_command_outside_repo/);
    expect(output).not.toMatch(/report_missing/);

    const runs = json<Array<{ id: string; verdict: string }>>(["project", "runs", "outside"]);
    expect(runs).toHaveLength(1);
    const report = json<{ verdict: string; failReasons: string[] }>(["project", "report", "outside", runs[0]!.id]);
    expect(report.verdict).toBe("fail");
    expect(report.failReasons.join("\n")).toMatch(/stdio_command_outside_repo/);
  });

  it("exits non-zero when a project command fails", () => {
    cli(["project", "show", "missing"], 1);
    cli(["project", "run", "fxp", "--version", "0"], 1);
    cli(["project", "run", "fxp", "--version", "99"], 1);
    cli(["project", "report", "fxp", "missing"], 1);
    cli(["project", "compare", "fxp", "--base", "missing", "--head", "missing"], 1);
    expect(cli(["project", "add", "--name", "broken", "--target", '{"transport":"stdio","command":"node","args":["missing.mjs"]}'], 1))
      .toMatch(/Tools: 0 \(/);
    expect(cli(["project", "introspect", "broken"], 1)).toMatch(/Introspect error/);
    expect(cli(["project", "server", "add", "fxp", "--target", '{"transport":"stdio","command":"node","args":["missing.mjs"]}'], 1))
      .toMatch(/Introspect error/);
  });
});
