import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyseSuiteReport, applyProposals, formatAnalysis, latestReportFor } from "./analyse-commands.js";
import { captureLoadProfile, type SuiteFile } from "./suite-file.js";
import type { RunReport } from "../engine/types/run.js";

const suite: SuiteFile = {
  kind: "botz-suite", capturedAt: "2026-10-23T00:00:00.000Z", name: "docs",
  target: { transport: "streamable-http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer hdr-canary-77" } },
  surface: { capabilities: ["tools"], resources: [], resourceTemplates: [], prompts: [], tools: [
    { name: "search", schemaHash: "h", writeLike: false, inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] } },
    { name: "delete_doc", schemaHash: "d", writeLike: true, inputSchema: { type: "object", properties: {} } },
  ] },
  nodes: [
    { id: "n_search", type: "sampler", enabled: true, method: "tools/call", tool: "search", args: { query: "x", limit: "10" } },
    { id: "n_del", type: "sampler", enabled: false, method: "tools/call", tool: "delete_doc", args: {} },
  ],
  load: captureLoadProfile(),
  params: {},
};
const report = {
  id: "run_1", manifestName: "docs", verdict: "fail", suiteVersion: 1, failReasons: ["Step n_search: -32602 limit must be integer"],
  nodeOutcomes: [{ nodeId: "n_search", label: "search", count: 3, errorCount: 3, errorMessage: "-32602" }], toolSeries: [], log: [],
} as unknown as RunReport;

const reply = (proposals: unknown[]) => async (body: Record<string, unknown>) => {
  expect(JSON.stringify(body)).not.toContain("hdr-canary-77");
  return { choices: [{ message: { content: JSON.stringify({ summary: "limit is a string", proposals }) } }] };
};

describe("suite analyse", () => {
  it("analyses a report against the suite and applies a fix", async () => {
    const analysis = await analyseSuiteReport({ suite, report, env: {}, infer: reply([
      { title: "Integer limit", category: "suite_bug", confidence: 0.9, nodeIds: ["n_search"], patch: [{ op: "replace", path: "/nodes/@n_search/args/limit", value: 10 }] },
      { title: "Rate limited", category: "environment", confidence: 0.5, report: "429s" },
    ]) });
    expect(analysis.proposals.map((p) => p.status)).toEqual(["proposed", "proposed"]);
    const text = formatAnalysis(analysis);
    expect(text).toContain("suite fix");
    expect(text).toContain("environment (report only)");
    expect(text).toContain(`--apply ${analysis.proposals[0]!.id}`);
    const next = applyProposals(suite, analysis, ["all"]);
    expect(next.nodes[0]!.args).toMatchObject({ limit: 10 });
    expect(suite.nodes[0]!.args).toMatchObject({ limit: "10" });
    expect(() => applyProposals(suite, analysis, [analysis.proposals[1]!.id])).toThrow("report only");
  });

  it("refuses enabling a destructive tool unless allowed", async () => {
    const analysis = await analyseSuiteReport({ suite, report, env: {}, infer: reply([
      { title: "Enable delete", category: "suite_bug", confidence: 0.4, patch: [{ op: "replace", path: "/nodes/@n_del/enabled", value: true }] },
    ]) });
    expect(analysis.proposals[0]!.status).toBe("invalid");
  });

  it("finds the newest report for the suite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runs-"));
    await writeFile(join(dir, "botz-run-2026-10-01.json"), JSON.stringify({ manifestName: "docs" }));
    await writeFile(join(dir, "botz-run-2026-10-02.json"), JSON.stringify({ manifestName: "other" }));
    await writeFile(join(dir, "botz-run-2026-10-02.analysis.json"), "{}");
    expect(await latestReportFor(dir, "docs")).toBe(join(dir, "botz-run-2026-10-01.json"));
    expect(await latestReportFor(join(dir, "missing"), "docs")).toBeNull();
  });
});
