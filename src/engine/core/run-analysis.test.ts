import { describe, expect, it } from "vitest";
import type { RunReport } from "../types/run.js";
import type { SuiteNode, ToolCatalogEntry } from "./suite-model.js";
import {
  analyseRun, analysisAvailability, applyPatch, argsSchemaErrors, buildAnalysisContext, involvedNodeIds,
  parseAnalysisResponse, resolvePatchPath, revalidateForAccept, validateProposal, type SuiteDoc,
} from "./run-analysis.js";

const catalog: ToolCatalogEntry[] = [
  { name: "search", schemaHash: "h1", writeLike: false, inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] } },
  { name: "delete_item", schemaHash: "h2", writeLike: true, inputSchema: { type: "object", properties: { id: { type: "string" } } } },
];

const nodes: SuiteNode[] = [
  { id: "n_search", type: "sampler", enabled: true, method: "tools/call", tool: "search", args: { query: "x", limit: "ten" }, layout: { x: 1, y: 2 } },
  { id: "n_loop", type: "loop", enabled: true, iterations: 2, children: [
    { id: "n_inner", type: "sampler", enabled: true, method: "tools/call", tool: "search", args: { query: "y" } },
  ] },
  { id: "n_del", type: "sampler", enabled: false, method: "tools/call", tool: "delete_item", args: { id: "1" } },
];
const suite: SuiteDoc = { nodes, load: { durationMs: 1000, rampUpMs: 0, maxConcurrency: 1, jitterMs: 0, rampDownMs: 0 } as SuiteDoc["load"] };

const SECRET = ["canary", "value", "0451"].join("-");
const report = {
  id: "run_1", verdict: "fail", suiteVersion: 3,
  failReasons: ["Step n_search: error_class=protocol invalid params limit", `auth header Bearer ${SECRET}`],
  nodeOutcomes: [
    { nodeId: "n_search", label: "search", count: 10, errorCount: 10, errorMessage: "-32602 invalid params: limit must be integer" },
    { nodeId: "n_inner", label: "search", count: 4, errorCount: 0, retries: 3 },
  ],
  toolSeries: [], toolEvals: [], catalog: [{ name: "search", schemaHash: "old" }],
  retries: { total: 3, reason: "rate_limit", byMethod: { "tools/call": 3 }, sessionSetup: 0 },
  params: { q: "param-canary-xyz" },
  redactedArgs: [{ nodeId: "n_search", tool: "search", args: { query: "param-canary-xyz" } }],
  log: ["started", `x-api-key: ${SECRET}`],
} as unknown as RunReport;

describe("analysis context", () => {
  it("picks involved steps and their parents, drops layout, flags schema drift", () => {
    expect(involvedNodeIds(report, nodes)).toContain("n_search");
    const ctx = buildAnalysisContext({ report, suite, catalog }) as any;
    const ids = ctx.suite.steps.map((s: SuiteNode) => s.id);
    expect(ids).toContain("n_search");
    expect(ids).not.toContain("n_del");
    expect(JSON.stringify(ctx)).not.toContain("layout");
    expect(ctx.toolSchemas[0].schemaChangedSinceRun).toBe(true);
    expect(ctx.run.rateLimitRetries.total).toBe(3);
  });

  it("scrubs secrets from params, target headers and free text", () => {
    const ctx = buildAnalysisContext({ report, suite, catalog, target: { url: "https://x.test/mcp?key=urlsecret123", headers: { Authorization: "Bearer hdr-secret-999" } }, secrets: [SECRET] });
    const text = JSON.stringify(ctx);
    for (const s of [SECRET, "param-canary-xyz", "urlsecret123", "hdr-secret-999"]) expect(text).not.toContain(s);
  });
});

describe("parse", () => {
  it("keeps patches only on suite bugs and drops malformed items", () => {
    const out = parseAnalysisResponse("```json\n" + JSON.stringify({
      summary: "s",
      proposals: [
        { title: "Fix limit", category: "suite_bug", confidence: 0.9, rationale: "r", nodeIds: ["n_search"], patch: [{ op: "replace", path: "/nodes/@n_search/args/limit", value: 10 }] },
        { title: "Server 500", category: "server_bug", confidence: 0.4, rationale: "r", patch: [{ op: "remove", path: "/nodes/0" }], report: "report it" },
        { title: "No patch", category: "suite_bug", confidence: 0.3 },
        { title: "bad", category: "nonsense" },
      ],
    }) + "\n```");
    expect(out.proposals).toHaveLength(3);
    expect(out.proposals[1]!.patch).toBeUndefined();
    expect(out.proposals[2]!.status).toBe("invalid");
  });
  it("rejects non-JSON", () => {
    expect(() => parseAnalysisResponse("sorry")).toThrow("analysis_unparseable");
  });
});

describe("patches", () => {
  it("resolves nested step ids to index paths", () => {
    expect(resolvePatchPath(suite, "/nodes/@n_inner/args/query")).toEqual(["nodes", "1", "children", "0", "args", "query"]);
    expect(() => resolvePatchPath(suite, "/nodes/@missing/args")).toThrow("unknown step id");
    expect(() => resolvePatchPath(suite, "/target/url")).toThrow("outside");
  });
  it("applies add/replace/remove without mutating the base", () => {
    const next = applyPatch(suite, [
      { op: "replace", path: "/nodes/@n_search/args/limit", value: 10 },
      { op: "add", path: "/nodes/@n_inner/thinkMs", value: 50 },
      { op: "remove", path: "/load/jitterMs" },
    ]);
    expect((next.nodes[0]!.args as any).limit).toBe(10);
    expect(next.nodes[1]!.children![0]!.thinkMs).toBe(50);
    expect("jitterMs" in next.load).toBe(false);
    expect((suite.nodes[0]!.args as any).limit).toBe("ten");
  });
  it("refuses forbidden paths and oversized patches", () => {
    expect(() => applyPatch(suite, [{ op: "replace", path: "/nodes/@n_search/id", value: "x" }])).toThrow("may not change");
    expect(() => applyPatch(suite, [{ op: "replace", path: "/nodes/@n_search/layout", value: {} }])).toThrow("may not change");
    expect(() => applyPatch(suite, Array.from({ length: 21 }, () => ({ op: "remove" as const, path: "/load/jitterMs" })))).toThrow("more than");
  });
});

describe("validation", () => {
  const opts = { catalog, canRunDestructive: false };
  it("accepts a schema-correct fix", () => {
    const r = validateProposal(suite, { category: "suite_bug", patch: [{ op: "replace", path: "/nodes/@n_search/args/limit", value: 10 }] }, opts);
    expect(r.ok).toBe(true);
  });
  it("rejects args that break the tool schema", () => {
    const r = validateProposal(suite, { category: "suite_bug", patch: [{ op: "remove", path: "/nodes/@n_search/args/query" }] }, opts);
    expect(r).toMatchObject({ ok: false });
    expect(argsSchemaErrors({ query: "${q}" }, catalog[0]!.inputSchema as any)).toEqual([]);
  });
  it("does not let an existing error elsewhere block an unrelated fix", () => {
    // n_search already has limit: "ten" (invalid); fixing n_inner must still pass.
    const r = validateProposal(suite, { category: "suite_bug", patch: [{ op: "replace", path: "/nodes/@n_inner/args/query", value: "z" }] }, opts);
    expect(r.ok).toBe(true);
  });
  it("rejects newly enabling a destructive tool unless allowed", () => {
    const patch = [
      { op: "replace" as const, path: "/nodes/@n_search/args/limit", value: 1 },
      { op: "replace" as const, path: "/nodes/@n_del/enabled", value: true },
    ];
    expect(validateProposal(suite, { category: "suite_bug", patch }, opts)).toMatchObject({ ok: false, reason: expect.stringContaining("destructive") });
    expect(validateProposal(suite, { category: "suite_bug", patch }, { ...opts, canRunDestructive: true }).ok).toBe(true);
  });
  it("runs the compile hook and refuses non-suite categories", () => {
    const patch = [{ op: "replace" as const, path: "/nodes/@n_search/args/limit", value: 1 }];
    expect(validateProposal(suite, { category: "suite_bug", patch }, { ...opts, compile: () => { throw new Error("compile_no"); } })).toMatchObject({ reason: "compile_no" });
    expect(validateProposal(suite, { category: "environment", patch }, opts).ok).toBe(false);
  });
  it("marks a proposal stale when the suite moved and the patch no longer applies", () => {
    const moved: SuiteDoc = { ...suite, nodes: suite.nodes.filter((n) => n.id !== "n_search") };
    const p = { id: "fx", title: "t", category: "suite_bug" as const, confidence: 1, rationale: "", evidence: [], nodeIds: [], status: "proposed" as const, patch: [{ op: "replace" as const, path: "/nodes/@n_search/args/limit", value: 1 }] };
    expect(revalidateForAccept(moved, 4, 3, p, opts)).toMatchObject({ ok: false, stale: true });
    expect(revalidateForAccept(suite, 4, 3, { ...p, patch: [{ op: "replace", path: "/nodes/@n_search/args/limit", value: 2 }] }, opts).ok).toBe(true);
  });
});

describe("analyseRun", () => {
  it("calls the model once with redacted context and validates proposals", async () => {
    let sent = "";
    const analysis = await analyseRun({
      report, suite, catalog, secrets: [SECRET], validate: { catalog },
      env: {},
      infer: async (body) => {
        sent = JSON.stringify(body);
        return { usage: { prompt_tokens: 100, completion_tokens: 20 }, choices: [{ message: { content: JSON.stringify({ proposals: [
          { title: "Use integer limit", category: "suite_bug", confidence: 0.92, rationale: "schema says integer", nodeIds: ["n_search"], patch: [{ op: "replace", path: "/nodes/@n_search/args/limit", value: 10 }] },
          { title: "Bad", category: "suite_bug", confidence: 0.2, patch: [{ op: "replace", path: "/nodes/@gone/args", value: {} }] },
          { title: "Rate limited", category: "environment", confidence: 0.7, report: "3 retries" },
        ] }) } }] };
      },
    });
    expect(sent).not.toContain(SECRET);
    expect(sent).toContain("json_object");
    expect(analysis.proposals.map((p) => p.status)).toEqual(["proposed", "invalid", "proposed"]);
    expect(analysis.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(analysis.suiteVersion).toBe(3);
  });
});

describe("availability", () => {
  it("is off without a key, when disabled, and on with a key or fixture", () => {
    expect(analysisAvailability({}).enabled).toBe(false);
    expect(analysisAvailability({ OPENAI_API_KEY: "k", SWARM_ANALYSE: "off" })).toMatchObject({ enabled: false, reason: "disabled" });
    expect(analysisAvailability({ OPENAI_API_KEY: "k" }).enabled).toBe(true);
    expect(analysisAvailability({ SWARM_ANALYSE_FIXTURE: "/tmp/x.json" })).toMatchObject({ enabled: true, provider: "fixture" });
  });
});
