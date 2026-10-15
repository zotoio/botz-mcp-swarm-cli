import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Multi-server suites through the built CLI: standalone suite files and project suites, against stdio fixtures. */

const HEADER = `
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema, CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const open = {type:'object',properties:{},additionalProperties:true};
const text = (value, isError = false) => ({ isError, content: [{ type: 'text', text: String(value) }] });
`;
const ISSUES = `${HEADER}
const server = new Server({name:'issues',version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async()=>({tools:[{name:'search_issues',annotations:{readOnlyHint:true},inputSchema:open}]}));
server.setRequestHandler(CallToolRequestSchema, async()=>({ content: [], structuredContent: { items: [{ title: 'Disk full on node-7' }] } }));
await server.connect(new StdioServerTransport());
`;
const TRACKER = `${HEADER}
const server = new Server({name:'tracker',version:'2'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async()=>({tools:[{name:'lookup_issue',annotations:{readOnlyHint:true},inputSchema:open}]}));
server.setRequestHandler(CallToolRequestSchema, async r=>r.params.arguments.summary === 'Disk full on node-7'
  ? { content: [], structuredContent: { key: 'OPS-42' } } : text('wrong summary', true));
await server.connect(new StdioServerTransport());
`;
const CHAT = `${HEADER}
const server = new Server({name:'chat',version:'3'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async()=>({tools:[{name:'read_channel',annotations:{readOnlyHint:true},inputSchema:open}]}));
server.setRequestHandler(CallToolRequestSchema, async r=>text(r.params.arguments.text === 'Opened OPS-42' ? 'ok' : 'bad', r.params.arguments.text !== 'Opened OPS-42'));
await server.connect(new StdioServerTransport());
`;

const FLOW = [
  { id: "find", type: "sampler", enabled: true, method: "tools/call", tool: "search_issues", args: { query: "is:open" } },
  { id: "title", type: "extractor", enabled: true, path: "structuredContent.items[0].title", variable: "issueTitle", required: true },
  { id: "ticket", type: "sampler", enabled: true, server: "tracker", method: "tools/call", tool: "lookup_issue", args: { summary: "${issueTitle}" } },
  { id: "key", type: "extractor", enabled: true, path: "structuredContent.key", variable: "ticketKey" },
  { id: "notify", type: "sampler", enabled: true, server: "chat", method: "tools/call", tool: "read_channel", args: { text: "Opened ${ticketKey}" } },
];

/** The CLI package root, so the test also runs from a workspace that holds this package. */
const pkg = fileURLToPath(new URL("../..", import.meta.url));
let root = "";
let work = "";
let entry = "";
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(SWARM_|OTEL_|OPENAI_|ANTHROPIC_|TYPESAFE_)/.test(key)) delete env[key];

function run(args: string[]) {
  return spawnSync(process.execPath, [entry, ...args], { cwd: work, env, encoding: "utf8", timeout: 60_000 });
}

function cli(args: string[], code = 0): string {
  const result = run(args);
  expect(result.status, result.stderr + result.stdout).toBe(code);
  return result.stdout + result.stderr;
}

const suitePath = () => join(work, ".botz", "mcp-swarm", "suites", "triage", "suite.json");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "multi-server-e2e-"));
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
  await writeFile(join(work, "issues.mjs"), ISSUES);
  await writeFile(join(work, "tracker.mjs"), TRACKER);
  await writeFile(join(work, "chat.mjs"), CHAT);
}, 60_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("multi-server standalone suites", () => {
  it("adds servers, wires a flow, validates, runs, and manages aliases", async () => {
    cli(["suite", "capture", "--command", "node", "--arg", "issues.mjs", "--name", "triage", "--alias", "issues"]);
    expect(cli(["suite", "server", "add", "--suite", "triage", "--alias", "tracker", "--command", "node", "--arg", "tracker.mjs"]))
      .toMatch(/Server tracker: 1 tools/);
    expect(cli(["suite", "server", "add", "--suite", "triage", "--alias", "chat", "--command", "node", "--arg", "chat.mjs", "--steps"]))
      .toMatch(/added in a disabled frame "chat contract"/);
    expect(cli(["suite", "server", "add", "--suite", "triage", "--alias", "chat", "--command", "node", "--arg", "chat.mjs"], 1))
      .toMatch(/already has a server called chat/);

    const saved = JSON.parse(await readFile(suitePath(), "utf8"));
    expect(saved.schemaVersion).toBe(2);
    expect(saved.defaultServer).toBe("issues");
    expect(Object.keys(saved.servers)).toEqual(["issues", "tracker", "chat"]);
    saved.nodes = FLOW;
    await writeFile(suitePath(), JSON.stringify(saved, null, 2));

    const rows = JSON.parse(cli(["suite", "server", "list", "--suite", "triage", "--json"])) as Array<{ alias: string; default: boolean; steps: number }>;
    expect(rows.map((row) => [row.alias, row.default, row.steps])).toEqual([["issues", true, 1], ["tracker", false, 1], ["chat", false, 1]]);

    const validated = cli(["suite", "validate", "--suite", "triage"]);
    expect(validated).toMatch(/Suite valid/);
    expect(validated).toMatch(/issues\s+find\s+-> issueTitle -> tracker\s+ticket/);
    expect(validated).toMatch(/tracker\s+ticket -> ticketKey\s+-> chat\s+notify/);
    expect(cli(["suite", "show", "--suite", "triage"])).toMatch(/\[tracker\] lookup_issue/);

    const junit = cli(["suite", "run", "--suite", "triage", "--format", "junit"]);
    expect(junit).toMatch(/classname="tracker"/);
    expect(junit).toMatch(/failures="0"/);
    const runs = join(work, ".botz", "mcp-swarm", "runs");
    const reportFile = (await readdir(runs)).find((name) => name.endsWith(".json"))!;
    const reportText = await readFile(join(runs, reportFile), "utf8");
    const report = JSON.parse(reportText) as { servers: Array<{ alias: string; name: string }>; catalog: Array<{ server?: string }> };
    expect(report.servers.map((server) => `${server.alias}:${server.name}`)).toEqual(["issues:issues", "tracker:tracker", "chat:chat"]);
    expect(new Set(report.catalog.map((tool) => tool.server))).toEqual(new Set(["issues", "tracker", "chat"]));
    expect(reportText).not.toContain("Disk full on node-7");
    const markdown = await readFile(join(runs, reportFile.replace(/\.json$/, ".md")), "utf8");
    expect(markdown).toMatch(/## Servers/);
    expect(markdown).toMatch(/## Variables/);

    expect(cli(["suite", "run", "--suite", "triage", "--url", "http://127.0.0.1:9/mcp"], 2)).toMatch(/has 3 servers; use --target <alias>=<url>/);
    expect(cli(["suite", "run", "--suite", "triage", "--target", "nope=http://127.0.0.1:9/mcp"], 2)).toMatch(/"nope" is not a server/);
    expect(cli(["suite", "run", "--suite", "triage", "--target", "tracker=http://127.0.0.1:9/mcp"], 2)).toMatch(/requires an HTTP server/);

    expect(cli(["suite", "server", "remove", "--suite", "triage", "--alias", "tracker"], 1)).toMatch(/used by enabled steps: ticket/);
    expect(cli(["suite", "server", "remove", "--suite", "triage", "--alias", "issues"], 1)).toMatch(/is the default server/);
    cli(["suite", "server", "rename", "--suite", "triage", "--alias", "chat", "--to", "slack"]);
    expect(cli(["suite", "show", "--suite", "triage"])).toMatch(/\[slack\] read_channel/);
    expect(cli(["suite", "server", "slo", "--suite", "triage", "--alias", "tracker", "--max-error-rate", "0"])).toMatch(/errors<=0/);

    const refreshed = JSON.parse(cli(["suite", "refresh", "--suite", "triage", "--dry-run", "--json"])) as { servers: Record<string, unknown> };
    expect(Object.keys(refreshed.servers)).toEqual(["issues", "tracker", "slack"]);

    expect(cli(["doctor", "--suite", "triage"])).toMatch(/OK stdio slack: slack: stdio executable available/);
    cli(["suite", "server", "remove", "--suite", "triage", "--alias", "slack", "--force"]);
    cli(["suite", "server", "remove", "--suite", "triage", "--alias", "tracker", "--force"]);
    const single = JSON.parse(await readFile(suitePath(), "utf8"));
    // One server left, but its alias and objective still need version 2.
    expect(single.schemaVersion).toBe(2);
    expect(Object.keys(single.servers)).toEqual(["issues"]);
  }, 120_000);

  it("runs a project suite whose steps call two project servers", async () => {
    cli(["project", "add", "--name", "flowp", "--target", '{"transport":"stdio","command":"node","args":["issues.mjs"]}']);
    const added = cli(["project", "server", "add", "flowp", "--no-suite", "--target", '{"transport":"stdio","command":"node","args":["tracker.mjs"]}']);
    const serverId = /Server (\S+) on/.exec(added)![1]!;
    const file = join(work, "flow.json");
    await writeFile(file, JSON.stringify({
      nodes: FLOW.slice(0, 3).map((node) => {
        const { server: _server, ...rest } = node as { server?: string };
        return rest;
      }),
      load: { durationMs: 0, rampUpMs: 0, maxConcurrency: 1, jitterMs: 0, rampDownMs: 0, dwellMs: 0, iterations: 1, lanes: 4 },
    }));
    cli(["project", "suite", "save", "flowp", "--file", file]);
    cli(["project", "suite", "set-node", "flowp", "--node", "ticket", "--server", serverId]);
    expect(cli(["project", "suite", "set-node", "flowp", "--node", "title", "--server", serverId], 1)).toMatch(/server_not_allowed/);
    expect(cli(["project", "show", "flowp"])).toMatch(/ \+ /);
    const output = cli(["project", "run", "flowp"]);
    expect(output).toMatch(/Verdict: PASS/);
    const runs = JSON.parse(cli(["project", "runs", "flowp", "--json"])) as Array<{ id: string }>;
    const report = JSON.parse(cli(["project", "report", "flowp", runs[0]!.id, "--json"])) as {
      servers: Array<{ alias: string; calls: number }>;
      toolSeries: Array<{ server?: string; toolName: string }>;
    };
    expect(report.servers).toHaveLength(2);
    expect(report.servers.every((server) => server.calls === 1)).toBe(true);
    expect(report.toolSeries.map((tool) => tool.toolName).sort()).toEqual(["lookup_issue", "search_issues"]);
    expect(report.toolSeries.every((tool) => typeof tool.server === "string")).toBe(true);
  }, 120_000);
});
