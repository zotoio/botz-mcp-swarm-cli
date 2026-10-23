import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runManifest } from "./runner.js";
import { compileSuite, type SuiteNode } from "./suite-model.js";
import { parseManifest, type Manifest, type Target } from "../types/manifest.js";

/** Three stdio servers: issues hands a title to tracker, tracker hands a key to chat. */

const HEADER = `
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema, CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const text = (value, isError = false) => ({ isError, content: [{ type: 'text', text: String(value) }] });
`;
const object = "{type:'object',properties:{},additionalProperties:true}";

const ISSUES = `${HEADER}
const server = new Server({name:'issues',version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async()=>({tools:[{name:'search_issues',inputSchema:${object}}]}));
server.setRequestHandler(CallToolRequestSchema, async r=>{
  if (r.params.arguments.query === 'none') return { content: [], structuredContent: { items: [] } };
  return { content: [], structuredContent: { items: [{ title: 'Disk full on node-7' }] } };
});
await server.connect(new StdioServerTransport());
`;

const TRACKER = `${HEADER}
const server = new Server({name:'tracker',version:'2'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async()=>({tools:[{name:'create_issue',inputSchema:${object}},{name:'search_issues',inputSchema:${object}}]}));
server.setRequestHandler(CallToolRequestSchema, async r=>{
  if (r.params.name === 'search_issues') return text('tracker search');
  const summary = r.params.arguments.summary;
  if (summary !== 'Disk full on node-7') return text('wrong summary', true);
  return { content: [], structuredContent: { key: 'OPS-42' } };
});
await server.connect(new StdioServerTransport());
`;

const CHAT = `${HEADER}
const server = new Server({name:'chat',version:'3'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async()=>({tools:[{name:'post_message',inputSchema:${object}}]}));
server.setRequestHandler(CallToolRequestSchema, async r=>r.params.arguments.text === 'Opened OPS-42' ? text('posted') : text('bad text', true));
await server.connect(new StdioServerTransport());
`;

let root = "";
const stdio = (file: string): Target => ({ transport: "stdio", command: process.execPath, args: [join(root, file)] });

function flowNodes(query = "is:open"): SuiteNode[] {
  return [
    { id: "find", type: "sampler", enabled: true, method: "tools/call", tool: "search_issues", args: { query } },
    { id: "title", type: "extractor", enabled: true, path: "structuredContent.items[0].title", variable: "issueTitle", required: true },
    { id: "ticket", type: "sampler", enabled: true, server: "tracker", method: "tools/call", tool: "create_issue", args: { summary: "${issueTitle}" } },
    { id: "key", type: "extractor", enabled: true, path: "structuredContent.key", variable: "ticketKey" },
    { id: "notify", type: "sampler", enabled: true, server: "chat", method: "tools/call", tool: "post_message", args: { text: "Opened ${ticketKey}" } },
  ];
}

function manifestFor(nodes: SuiteNode[], options: { concurrency?: number; iterations?: number; serverSlos?: Record<string, { maxErrorRate?: number }> } = {}): Manifest {
  return parseManifest(compileSuite({
    name: "triage",
    target: stdio("issues.mjs"),
    defaultServer: "issues",
    targets: { tracker: stdio("tracker.mjs"), chat: stdio("chat.mjs") },
    serverSlos: options.serverSlos,
    allowlist: ["stdio"],
    nodes,
    load: { durationMs: 0, rampUpMs: 0, rampDownMs: 0, jitterMs: 0, dwellMs: 0, maxConcurrency: options.concurrency ?? 1, iterations: options.iterations ?? 1 },
  }));
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "multi-server-"));
  await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
  await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}');
  await writeFile(join(root, "issues.mjs"), ISSUES);
  await writeFile(join(root, "tracker.mjs"), TRACKER);
  await writeFile(join(root, "chat.mjs"), CHAT);
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("multi-server runs", () => {
  it("passes extracted values from one server to the next", async () => {
    const report = await runManifest({ manifest: manifestFor(flowNodes()), mode: "load", standaloneTarget: true });
    expect(report.failReasons).toEqual([]);
    expect(report.verdict).toBe("pass");
    expect(report.servers?.map((server) => [server.alias, server.name, server.calls, server.errorRate])).toEqual([
      ["issues", "issues", 1, 0],
      ["tracker", "tracker", 1, 0],
      ["chat", "chat", 1, 0],
    ]);
    expect(report.server?.name).toBe("issues");
    expect(report.toolSeries.map((tool) => `${tool.server}/${tool.toolName}`).sort()).toEqual(["chat/post_message", "issues/search_issues", "tracker/create_issue"]);
    expect(report.nodeOutcomes?.find((node) => node.nodeId === "ticket")?.server).toBe("tracker");
    expect(report.nodeOutcomes?.find((node) => node.nodeId === "title")?.server).toBeUndefined();
    expect(report.flow).toMatchObject({ passes: 1, passesFailed: 0, passesSkipped: 0 });
    expect(report.variables).toEqual([
      { name: "issueTitle", setBy: "title", server: "issues", resolved: 1, missing: 0, resolvedRate: 1 },
      { name: "ticketKey", setBy: "key", server: "tracker", resolved: 1, missing: 0, resolvedRate: 1 },
    ]);
    // Extracted values never reach the report; the arguments show the variable instead.
    const text = JSON.stringify(report);
    expect(text).not.toContain("Disk full on node-7");
    expect(text).not.toContain("OPS-42");
    expect(report.redactedArgs?.find((item) => item.nodeId === "ticket")?.args).toEqual({ summary: "${issueTitle}" });
  }, 30_000);

  it("keeps same-named tools on different servers apart", async () => {
    const nodes: SuiteNode[] = [
      { id: "a", type: "sampler", enabled: true, method: "tools/call", tool: "search_issues", args: {} },
      { id: "b", type: "sampler", enabled: true, server: "tracker", method: "tools/call", tool: "search_issues", args: {} },
    ];
    const report = await runManifest({ manifest: manifestFor(nodes), mode: "load", standaloneTarget: true });
    expect(report.toolSeries.filter((tool) => tool.toolName === "search_issues").map((tool) => tool.server).sort()).toEqual(["issues", "tracker"]);
    // chat is never called, so no pass checks out a chat session.
    expect(report.servers?.find((server) => server.alias === "chat")?.sessionMetrics.started).toBe(0);
  }, 30_000);

  it("skips steps after a missing required value and never opens their servers", async () => {
    const report = await runManifest({ manifest: manifestFor(flowNodes("none")), mode: "load", standaloneTarget: true });
    expect(report.verdict).toBe("fail");
    expect(report.failReasons.join("\n")).toContain("extract_missing: issueTitle (structuredContent.items[0].title)");
    const outcome = (id: string) => report.nodeOutcomes?.find((node) => node.nodeId === id);
    expect(outcome("ticket")).toMatchObject({ count: 0, errorCount: 0, skipped: 1 });
    expect(outcome("notify")).toMatchObject({ count: 0, skipped: 1 });
    // A GitHub-side gap is not a Jira error.
    expect(report.servers?.find((server) => server.alias === "tracker")).toMatchObject({ calls: 0, errorRate: 0 });
    expect(report.servers?.find((server) => server.alias === "tracker")?.sessionMetrics.started).toBe(0);
    expect(report.flow).toMatchObject({ passes: 1, passesFailed: 1, passesSkipped: 1 });
    expect(report.variables?.[0]).toMatchObject({ name: "issueTitle", resolved: 0, missing: 1, resolvedRate: 0 });
  }, 30_000);

  it("holds one session per server per virtual user", async () => {
    const report = await runManifest({ manifest: manifestFor(flowNodes(), { concurrency: 3, iterations: 2 }), mode: "load", standaloneTarget: true });
    expect(report.verdict).toBe("pass");
    expect(report.flow?.passes).toBe(6);
    for (const server of report.servers ?? []) {
      expect(server.calls).toBe(6);
      expect(server.sessionMetrics).toMatchObject({ started: 6, active: 0, failed: 0 });
    }
  }, 60_000);

  it("judges per-server objectives", async () => {
    const nodes = flowNodes();
    nodes[2] = { ...nodes[2]!, args: { summary: "wrong" } };
    const report = await runManifest({ manifest: manifestFor(nodes, { serverSlos: { tracker: { maxErrorRate: 0 } } }), mode: "load", standaloneTarget: true });
    expect(report.failReasons).toContain("Server tracker error_rate 1.000 exceeds max 0");
  }, 30_000);

  it("names the server that cannot be reached", async () => {
    const manifest = manifestFor(flowNodes());
    manifest.targets!.tracker = { transport: "stdio", command: join(root, "missing-server") };
    const report = await runManifest({ manifest, mode: "load", standaloneTarget: true });
    expect(report.verdict).toBe("fail");
    expect(report.failReasons.join("\n")).toMatch(/Session warm-up failed on tracker/);
  }, 30_000);

  it("rejects a step that names an unknown server", () => {
    const manifest = manifestFor(flowNodes()) as unknown as Record<string, unknown> & { scenarios: Array<{ steps: Array<{ server?: string }> }> };
    manifest.scenarios[0]!.steps[2]!.server = "jira2";
    expect(() => parseManifest(manifest)).toThrow(/jira2\W* is not a server/);
  });

  it("leaves single-server reports in their old shape", async () => {
    const manifest = parseManifest(compileSuite({
      name: "single",
      target: stdio("issues.mjs"),
      allowlist: ["stdio"],
      nodes: [flowNodes()[0]!],
      load: { durationMs: 0, maxConcurrency: 1, iterations: 1, dwellMs: 0 },
    }));
    const report = await runManifest({ manifest, mode: "load", standaloneTarget: true });
    expect(report.verdict).toBe("pass");
    expect(report.servers?.map((server) => server.alias)).toEqual(["default"]);
    expect(report.toolSeries[0]).not.toHaveProperty("server");
    expect(report.nodeOutcomes?.[0]).not.toHaveProperty("server");
    expect(report.variables).toBeUndefined();
  }, 30_000);
});
