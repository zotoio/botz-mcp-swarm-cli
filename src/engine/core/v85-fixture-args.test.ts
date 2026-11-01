import { describe, expect, it } from "vitest";
import { schemaAccepts } from "./contract.js";
import { applySuiteChanges, proposeStepResync, repairArgs, snapshotFromSurface, stepForAddedPrimitive } from "./server-updates.js";
import { defaultToolEvals } from "./suite-model.js";
import { errorSuggestions, identifierCandidates, resolveReferenceValues, type CallToolFn } from "./reference-discovery.js";
import { isPlaceholderValue, referenceParams, sampleArgsForTool } from "./tool-args.js";

// Exact tool schemas from mcp.botz.ai tools/list in Swarm run 7223c148 (Smoke v85).
const agentRef = { description: "Agent reference: slug name, permanent id (guid), short id, or name@short_id", type: "string" };
const agentInstall = { name: "agent_install", description: "Build a deterministic install plan for installing or staging a subagent definition.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: agentRef, version: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }], default: null }, client: { type: "string", default: "auto" } } } };
const agentDiff = { name: "agent_diff", annotations: { readOnlyHint: true }, inputSchema: { type: "object", additionalProperties: false, required: ["name", "from_version"], properties: { name: { description: "Agent reference: slug, guid, or short id", type: "string" }, from_version: { type: "integer", minimum: 1 }, to_version: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }], default: null } } } };
const agentPreferred = { name: "agent_preferred_skills", description: "List an agent's preferred skills.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: agentRef, include_bodies: { type: "boolean", default: false }, catalog: { anyOf: [{ type: "string" }, { type: "null" }], default: null } } } };
const updatesCheck = { name: "updates_check", annotations: { readOnlyHint: true }, inputSchema: { type: "object", additionalProperties: false, required: ["manifest"], properties: { manifest: { anyOf: [{ type: "array", items: { type: "object", additionalProperties: true } }, { type: "object", additionalProperties: true }], description: "Installed manifest entries" } } } };
const skillSuggest = { name: "skill_suggest", annotations: { readOnlyHint: true }, inputSchema: { type: "object", required: ["request"], properties: { request: { type: "string" }, kind: { type: "string", default: "skill", description: "'skill' or 'agent' (subagent)" } } } };
const skillGet = { name: "skill_get", annotations: { readOnlyHint: true }, inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string", description: "Skill or agent ref: slug name, permanent id (guid), short id, or name@short_id" } } } };
const tools = [agentInstall, agentDiff, agentPreferred, updatesCheck, skillSuggest, skillGet];
const snap = snapshotFromSurface({ capabilities: ["tools"], tools: tools.map((t) => ({ ...t, schemaHash: "x", writeLike: false })), resources: [], resourceTemplates: [], prompts: [] } as never);

describe("Smoke v85 regressions: schema-valid fixture args", () => {
  it("updates_check manifest (array|object anyOf) is sampled as a valid array, never the string 'fixture'", () => {
    const args = sampleArgsForTool(updatesCheck as never);
    expect(args.manifest).toEqual([]);
    expect(schemaAccepts(updatesCheck.inputSchema, args)).toBe(true);
  });

  it("repairs the saved v85 updates_check args {manifest:'fixture'}", () => {
    const fixed = repairArgs(updatesCheck as never, { manifest: "fixture" });
    expect(schemaAccepts(updatesCheck.inputSchema, fixed)).toBe(true);
  });

  it("detects agent reference params by schema intent (and keeps skill_get on its own noun)", () => {
    expect(referenceParams(agentInstall as never)).toEqual([{ param: "name", domain: "agent" }]);
    expect(referenceParams(agentDiff as never)).toEqual([{ param: "name", domain: "agent" }]);
    expect(referenceParams(skillGet as never)).toEqual([{ param: "name", domain: "skill" }]);
    expect(isPlaceholderValue("fixture")).toBe(true);
    expect(isPlaceholderValue("agent-fixture")).toBe(true);
    expect(isPlaceholderValue("fixture-agent")).toBe(false);
  });

  it("resolves a real agent slug via skill_suggest(kind=agent) and verifies it, never a skill name", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const call: CallToolFn = async (name, args) => {
      calls.push([name, args]);
      if (name === "skill_suggest") return { success: true, result: { structuredContent: { name: args.kind === "agent" ? "implementation-coordinator-agent" : "fixture", kind: args.kind } } };
      if (name === "agent_install" || name === "agent_preferred_skills" || name === "agent_diff") {
        return args.name === "fixture" ? { success: false, errorMessage: "'fixture' is a skill, not an agent." } : { success: true, result: {} };
      }
      return { success: false, errorMessage: "unknown" };
    };
    const refs = await resolveReferenceValues(tools as never, call, { domains: ["agent"] });
    expect(refs.agent).toBe("implementation-coordinator-agent");
    expect(calls.find(([n]) => n === "skill_suggest")?.[1].kind).toBe("agent");
  });

  it("falls back to the server's 'did you mean' error hint when no discovery tool exists", async () => {
    const call: CallToolFn = async (_n, args) => args.name === "fixture-agent" ? { success: true, result: {} } : { success: false, errorMessage: "'fixture' is a skill, not an agent. Did you mean 'log-triage-agent' or 'fixture-agent'?" };
    const refs = await resolveReferenceValues([agentInstall] as never, call);
    expect(refs.agent).toBe("fixture-agent");
    expect(errorSuggestions("x. Did you mean 'a-agent' or 'b'?")).toEqual(["a-agent", "b"]);
    expect(identifierCandidates({ results: [{ name: "fixture", kind: "skill" }, { name: "x-agent", kind: "agent" }] }, "agent")).toEqual(["x-agent"]);
  });

  it("new steps use the resolved slug and positive evals state the concrete value", () => {
    const node = stepForAddedPrimitive({ kind: "tool", key: "agent_install", change: "added" }, snap, undefined, { agent: "fixture-agent" })!;
    expect(node.args).toEqual({ name: "fixture-agent" });
    const pos = node.evals!.find((e) => e.polarity === "positive")!;
    expect(pos.prompt).toContain('name = "fixture-agent"');
    expect(pos.assertions[1]!.text).toContain('pass name = "fixture-agent"');
    const diff = stepForAddedPrimitive({ kind: "tool", key: "agent_diff", change: "added" }, snap, undefined, { agent: "fixture-agent" })!;
    expect(diff.args).toEqual({ name: "fixture-agent", from_version: 1 });
  });

  it("update-from-server repairs the exact v85 steps (args + stale 'Include name.' evals)", () => {
    const stale = (tool: { name: string; description?: string; inputSchema: { required: string[] } }) => defaultToolEvals(tool);
    const nodes = [
      { id: "nmvxksdu61", type: "sampler", enabled: true, method: "tools/call", tool: "agent_diff", args: { name: "fixture", from_version: 1 }, evals: stale(agentDiff as never) },
      { id: "nmvxksdu62", type: "sampler", enabled: true, method: "tools/call", tool: "agent_install", args: { name: "fixture" }, evals: stale(agentInstall as never) },
      { id: "nmvxksdu63", type: "sampler", enabled: true, method: "tools/call", tool: "agent_preferred_skills", args: { name: "fixture" }, evals: stale(agentPreferred as never) },
      { id: "nmvxksdu7b", type: "sampler", enabled: true, method: "tools/call", tool: "updates_check", args: { manifest: "fixture" } },
    ] as never[];
    expect((nodes[1] as { evals: Array<{ prompt: string }> }).evals[0]!.prompt).toMatch(/Include name\.$/);
    const proposals = proposeStepResync({ suiteId: "s", nodes, callsServer: () => true } as never, snap, { references: { agent: "fixture-agent" } });
    const { nodes: out } = applySuiteChanges(nodes, proposals);
    const by = Object.fromEntries((out as Array<{ id: string; args: Record<string, unknown>; evals?: Array<{ polarity: string; prompt: string }> }>).map((n) => [n.id, n]));
    expect(by.nmvxksdu61!.args).toEqual({ name: "fixture-agent", from_version: 1 });
    expect(by.nmvxksdu62!.args).toEqual({ name: "fixture-agent" });
    expect(by.nmvxksdu63!.args).toEqual({ name: "fixture-agent" });
    expect(schemaAccepts(updatesCheck.inputSchema, by.nmvxksdu7b!.args)).toBe(true);
    for (const id of ["nmvxksdu62", "nmvxksdu63"]) {
      const pos = by[id]!.evals!.find((e) => e.polarity === "positive")!;
      expect(pos.prompt).toContain('"fixture-agent"');
      expect(pos.prompt).not.toMatch(/Include name\./);
    }
  });
});

describe("Smoke v87 regression: extractor placeholder fallback with no producer step", () => {
  it("points `||agent-fixture` at the resolved agent and rewrites consumer evals quoting it", async () => {
    const { suiteRefreshProposals } = await import("./server-updates.js");
    const nodes = [
      { id: "nmvnnz27f1c", type: "sampler", enabled: false, method: "tools/call", tool: "agent_search", args: { query: "x" } },
      { id: "nmvrp5c3j3", type: "extractor", enabled: true, variable: "agent_name", path: "structuredContent.matches.0.name|agents.0.name||agent-fixture" },
      { id: "nmvxksdu62", type: "sampler", enabled: true, method: "tools/call", tool: "agent_install", args: { name: "{{agent_name}}" }, evals: [{ id: "auto-agent_install-pos", polarity: "positive", prompt: "Build an install plan for the subagent named 'agent-fixture' (pass name='agent-fixture').", assertions: [{ id: "a", text: "Called agent_install with name 'agent-fixture'." }] }] },
    ] as never[];
    const proposals = suiteRefreshProposals({ suiteId: "s", nodes, callsServer: () => true } as never, snap, { references: { agent: "fixture-agent" } });
    const { nodes: out } = applySuiteChanges(nodes, proposals);
    const by = Object.fromEntries((out as Array<{ id: string; path?: string; args?: Record<string, unknown>; evals?: Array<{ prompt: string; assertions: Array<{ text: string }> }> }>).map((n) => [n.id, n]));
    expect(by.nmvrp5c3j3!.path).toBe("structuredContent.matches.0.name|agents.0.name||fixture-agent");
    expect(by.nmvxksdu62!.args).toEqual({ name: "${agent_name}" });
    expect(by.nmvxksdu62!.evals![0]!.prompt).toContain("'fixture-agent'");
    expect(by.nmvxksdu62!.evals![0]!.prompt).not.toContain("agent-fixture");
    expect(by.nmvxksdu62!.evals![0]!.assertions[0]!.text).toContain("'fixture-agent'");
  });
});

describe("Smoke v87 regression: variable-arg steps with built-in 'Include name.' evals", () => {
  it("regenerates them with the value the extractor fallback will send", async () => {
    const { suiteRefreshProposals } = await import("./server-updates.js");
    const nodes = [
      { id: "x1", type: "extractor", enabled: true, variable: "agent_name", path: "agents.0.name||agent-fixture" },
      { id: "nmvxksdu61", type: "sampler", enabled: true, method: "tools/call", tool: "agent_diff", args: { name: "{{agent_name}}", from_version: 1 }, evals: defaultToolEvals(agentDiff as never) },
    ] as never[];
    const proposals = suiteRefreshProposals({ suiteId: "s", nodes, callsServer: () => true } as never, snap, { references: { agent: "fixture-agent" } });
    const { nodes: out } = applySuiteChanges(nodes, proposals);
    const diff = (out as Array<{ id: string; evals?: Array<{ polarity: string; prompt: string }> }>).find((n) => n.id === "nmvxksdu61")!;
    expect(diff.evals!.find((e) => e.polarity === "positive")!.prompt).toContain('name = "fixture-agent", from_version = 1');
  });
});

describe("Smoke v88 regression: mustache variable refs", () => {
  it("rewrites {{agent_name}} to ${agent_name} so the runner substitutes it", async () => {
    const { normalizeVariableRefs } = await import("./server-updates.js");
    expect(normalizeVariableRefs({ name: "{{agent_name}}", m: [{ id: "{{ skill_name }}" }] })).toEqual({ name: "${agent_name}", m: [{ id: "${skill_name}" }] });
    expect(repairArgs(agentInstall as never, { name: "{{agent_name}}" })).toEqual({ name: "${agent_name}" });
  });
});
