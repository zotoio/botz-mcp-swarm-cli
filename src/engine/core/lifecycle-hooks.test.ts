import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runManifest } from "./runner.js";
import { compileSuite, type SuiteNode } from "./suite-model.js";
import { parseManifest, type Manifest } from "../types/manifest.js";

/** One stdio server whose fixture state lives in a file, so setup/teardown effects are observable. */
const SERVER = `
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema, CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {readFileSync, writeFileSync, appendFileSync, existsSync} from 'node:fs';
const STATE = process.env.HOOK_STATE;
const LOG = STATE + '.log';
const text = (value, isError = false) => ({ isError, content: [{ type: 'text', text: String(value) }] });
const obj = {type:'object',properties:{},additionalProperties:true};
const server = new Server({name:'hooks',version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async()=>({tools:['ensure_fixture','use_fixture','cleanup','boom'].map(name=>({name,inputSchema:obj}))}));
server.setRequestHandler(CallToolRequestSchema, async r=>{
  appendFileSync(LOG, r.params.name + '\\n');
  if (r.params.name === 'ensure_fixture') { writeFileSync(STATE, 'present'); if (r.params.arguments && r.params.arguments.run_id) writeFileSync(STATE + '.run', String(r.params.arguments.run_id)); return text('ok'); }
  if (r.params.name === 'cleanup') { writeFileSync(STATE, 'gone'); return text('cleaned'); }
  if (r.params.name === 'boom') return text('boom failed', true);
  const present = existsSync(STATE) && readFileSync(STATE, 'utf8') === 'present';
  return present ? text('used') : text("no agent matching 'fixture-agent'", true);
});
await server.connect(new StdioServerTransport());
`;

let root = "";
let state = "";

const call = (id: string, tool: string, extra: Partial<SuiteNode> = {}): SuiteNode => ({
  id, type: "sampler", enabled: true, method: "tools/call", tool, args: {}, ...extra,
});

function manifestFor(nodes: SuiteNode[], iterations = 1): Manifest {
  return parseManifest(compileSuite({
    name: "hooks",
    target: { transport: "stdio", command: process.execPath, args: [join(root, "server.mjs")], env: { HOOK_STATE: state } },
    allowlist: ["stdio"],
    nodes,
    load: { durationMs: 0, rampUpMs: 0, rampDownMs: 0, jitterMs: 0, dwellMs: 0, maxConcurrency: 1, iterations },
  }));
}

const log = async () => (await readFile(`${state}.log`, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "hooks-"));
  await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
  await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}');
  await writeFile(join(root, "server.mjs"), SERVER);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
let n = 0;
beforeEach(() => { n += 1; state = join(root, `state-${n}`); });

describe("compileSuite lifecycle hooks", () => {
  it("moves top-level hooks to manifest setup/teardown and orders scenario hooks", () => {
    const m = compileSuite({
      name: "s", target: { transport: "stdio", command: "x" }, allowlist: ["stdio"], load: {},
      nodes: [
        { ...call("td", "cleanup"), hook: "teardown" },
        { id: "sc", type: "group", enabled: true, label: "Agents", children: [
          call("use", "use_fixture"),
          { ...call("sct", "cleanup"), hook: "teardown" },
          { ...call("scs", "ensure_fixture"), hook: "setup" },
        ] },
        { ...call("su", "ensure_fixture"), hook: "setup" },
      ],
    });
    expect(m.setup?.map((s) => s.nodeId)).toEqual(["su"]);
    expect(m.teardown?.map((s) => s.nodeId)).toEqual(["td"]);
    const steps = m.scenarios[0]!.steps;
    expect(steps.map((s) => s.nodeId)).toEqual(["scs", "use", "sct"]);
    expect(steps.map((s) => s.hook)).toEqual(["setup", undefined, "teardown"]);
    expect(steps[1]!.waitFor).toContain(0);
    expect(steps[2]!.waitFor).toEqual(expect.arrayContaining([0, 1]));
  });
});

describe("runner lifecycle hooks", () => {
  it("suite setup runs once before scenarios and teardown once after", async () => {
    const report = await runManifest({ manifest: manifestFor([
      { ...call("su", "ensure_fixture"), hook: "setup" },
      call("use", "use_fixture"),
      { ...call("td", "cleanup"), hook: "teardown" },
    ], 2) });
    expect(report.verdict).toBe("pass");
    expect(await log()).toEqual(["ensure_fixture", "use_fixture", "use_fixture", "cleanup"]);
  }, 30_000);

  it("${__runId} in a setup hook resolves to the run's own id (fixtures tagged for run-end cleanup)", async () => {
    const report = await runManifest({
      runId: "run-hooks-123",
      manifest: manifestFor([
        { ...call("su", "ensure_fixture", { args: { run_id: "${__runId}" } }), hook: "setup" },
        call("use", "use_fixture"),
      ]),
    });
    expect(report.verdict).toBe("pass");
    expect(await readFile(`${state}.run`, "utf8")).toBe("run-hooks-123");
  }, 30_000);

  it("a failed suite setup skips every scenario, fails clearly and still tears down", async () => {
    const report = await runManifest({ manifest: manifestFor([
      { ...call("su", "boom"), hook: "setup" },
      call("use", "use_fixture"),
      { ...call("td", "cleanup"), hook: "teardown" },
    ]) });
    expect(report.verdict).toBe("fail");
    expect(report.failReasons.some((r) => r.startsWith("Suite setup failed"))).toBe(true);
    expect(await log()).toEqual(["boom", "cleanup"]);
    expect(report.hookErrors?.[0]).toMatchObject({ hook: "setup", scope: "suite" });
  }, 30_000);

  it("teardown errors are reported but do not fail the verdict", async () => {
    const report = await runManifest({ manifest: manifestFor([
      { ...call("su", "ensure_fixture"), hook: "setup" },
      call("use", "use_fixture"),
      { ...call("td", "boom"), hook: "teardown" },
      { id: "sc", type: "group", enabled: true, label: "S", children: [
        call("use2", "use_fixture"),
        { ...call("sct", "boom", { label: "scenario cleanup" }), hook: "teardown" },
      ] },
    ]) });
    expect(report.verdict).toBe("pass");
    expect(report.failReasons).toEqual([]);
    expect(report.hookErrors?.map((e) => `${e.scope}:${e.hook}`).sort()).toEqual(["scenario:teardown", "suite:teardown"]);
  }, 30_000);

  it("scenario setup failure skips the scenario body; scenario teardown still runs; re-ensure recreates", async () => {
    const report = await runManifest({ manifest: manifestFor([
      { id: "sc", type: "group", enabled: true, label: "S", children: [
        { ...call("scs", "boom"), hook: "setup" },
        call("use", "use_fixture"),
        { ...call("sct", "cleanup"), hook: "teardown" },
      ] },
    ]) });
    expect(report.verdict).toBe("fail");
    expect(await log()).toEqual(["boom", "cleanup"]);

    n += 1; state = join(root, `state-${n}`);
    const again = await runManifest({ manifest: manifestFor([
      { ...call("su", "ensure_fixture"), hook: "setup" },
      call("use", "use_fixture"),
      call("mid", "cleanup", { label: "deletes fixture" }),
      call("ensure2", "ensure_fixture", { label: "re-ensure fixture" }),
      call("use2", "use_fixture"),
      { ...call("td", "cleanup"), hook: "teardown" },
    ]) });
    expect(again.verdict).toBe("pass");
  }, 30_000);
});

describe("lifecycle hooks in generation and update-from-server", () => {
  const ensure = { name: "swarm_ensure_test_fixtures", description: "Idempotently create (or re-create) the 'fixture-agent' test subagent.", schemaHash: "a", writeLike: false, annotations: { idempotentHint: true, destructiveHint: false } };
  const done = { name: "swarm_run_completed", description: "Receive end-of-run completion signal, flush telemetry, and clean up ephemeral test assets.", schemaHash: "b", writeLike: false };
  const purge = { name: "swarm_cleanup_test_assets", description: "Clean up any skills created during Swarm test runs.", schemaHash: "c", writeLike: false, annotations: { destructiveHint: true } };
  const plain = { name: "agent_install", description: "Build an install plan. `name` must be an agent slug (e.g. 'fixture-agent').", schemaHash: "d", writeLike: false };

  it("classifies tools by intent, not by server", async () => {
    const { toolLifecycleRole } = await import("./suite-model.js");
    expect(toolLifecycleRole(ensure)).toBe("setup");
    expect(toolLifecycleRole(done)).toBe("teardown");
    expect(toolLifecycleRole(purge)).toBe("teardown");
    expect(toolLifecycleRole(plain)).toBeUndefined();
    expect(toolLifecycleRole({ name: "delete_user", description: "Delete a user." })).toBeUndefined();
  });

  it("generated suites put fixture setup first and cleanup last as suite hooks", async () => {
    const { buildDefaultSuiteNodes } = await import("./suite-model.js");
    const nodes = buildDefaultSuiteNodes([plain, ensure, done, purge]);
    expect(nodes[0]).toMatchObject({ tool: "swarm_ensure_test_fixtures", hook: "setup", enabled: true });
    expect(nodes.at(-2)).toMatchObject({ tool: "swarm_run_completed", hook: "teardown", enabled: true });
    expect(nodes.at(-1)).toMatchObject({ tool: "swarm_cleanup_test_assets", hook: "teardown", enabled: false });
    const group = nodes.find((n) => n.type === "group")!;
    expect(group.children!.some((c) => c.tool === "agent_install")).toBe(true);
    expect(group.children!.some((c) => c.hook)).toBe(false);
  });

  it("update-from-server adds the setup hook, moves an existing cleanup step to teardown, and re-ensures after body cleanup", async () => {
    const { suiteRefreshProposals, applySuiteChanges, snapshotFromSurface, reensureAfterCleanup } = await import("./server-updates.js");
    const nodes: SuiteNode[] = [{ id: "g", type: "group", enabled: true, label: "Smoke", children: [
      call("inst", "agent_install", { args: { name: "fixture-agent" } }),
      call("rc", "swarm_run_completed", { args: { run_id: "fixture" } }),
    ] }];
    const next = snapshotFromSurface({ capabilities: ["tools"], tools: [plain, ensure, done], resources: [], resourceTemplates: [], prompts: [] });
    const proposals = suiteRefreshProposals({ suiteId: "s", nodes, callsServer: () => true }, next);
    const kinds = proposals.map((p) => `${p.action}:${p.primitive.key}`);
    expect(kinds).toContain("set-hook:swarm_run_completed");
    expect(kinds).toContain("add-step:swarm_ensure_test_fixtures");
    const { nodes: out } = applySuiteChanges(nodes, proposals);
    expect(out[0]).toMatchObject({ tool: "swarm_ensure_test_fixtures", hook: "setup" });
    expect(out.at(-1)).toMatchObject({ tool: "swarm_run_completed", hook: "teardown" });
    // a cleanup kept in the body is followed by a re-ensure
    const kept = reensureAfterCleanup([out[0]!, { id: "g2", type: "group", enabled: true, children: [call("rc2", "swarm_run_completed"), call("use", "agent_install")] }]);
    expect(kept[1]!.children!.map((c) => c.tool)).toEqual(["swarm_run_completed", "swarm_ensure_test_fixtures", "agent_install"]);
    expect(kept[1]!.children![1]!.hook).toBeUndefined();
  });

  it("hook helpers add, set, and list hooks", async () => {
    const { addHookStep, setNodeHook, listHookSteps } = await import("./suite-model.js");
    const base: SuiteNode[] = [{ id: "sc", type: "group", enabled: true, label: "S", children: [call("a", "agent_install")] }];
    const one = addHookStep(base, { hook: "setup", tool: "swarm_ensure_test_fixtures" });
    const two = addHookStep(one.nodes, { hook: "teardown", tool: "cleanup", parentId: "sc" });
    const three = setNodeHook(two.nodes, "a", "setup");
    expect(listHookSteps(three).map((h) => `${h.scope}:${h.hook}`)).toEqual(["suite:setup", "scenario:setup", "scenario:teardown"]);
    expect(listHookSteps(setNodeHook(three, "a", undefined)).length).toBe(2);
  });
});
