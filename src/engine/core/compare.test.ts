import { describe, expect, it } from "vitest";
import { compareRuns, formatCompareMarkdown } from "./compare.js";
import { formatMarkdownReport } from "./report.js";
import type { RunReport, RunServer, ToolSeries } from "../types/run.js";

function tool(toolName: string, p95: number): ToolSeries {
  return {
    toolName,
    count: 10,
    errorRate: 0,
    errorClass: { none: 10, protocol: 0, application: 0, timeout: 0, transport: 0, quota: 0, allowlist: 0, auth: 0 },
    latencyMs: { p50: p95, p95, p99: p95 },
    bytesIn: 0,
    bytesOut: 0,
  };
}

function report(id: string, extra: Partial<RunReport> = {}): RunReport {
  return {
    id,
    manifestName: "demo",
    manifestHash: "h",
    startedAt: "2026-10-14T00:00:00.000Z",
    finishedAt: "2026-10-14T00:00:01.000Z",
    durationMs: 1000,
    verdict: "pass",
    failReasons: [],
    silentGreen: false,
    mode: "load",
    transport: "streamable-http",
    sessionMetrics: { transport: "streamable-http", started: 1, active: 0, failed: 0 },
    toolSeries: [tool("echo", 10), tool("search", 10)],
    rpcSeries: [],
    scenarioOutcomes: [],
    quotas: { concurrencyUsed: 1, callCount: 20, maxPayloadBytesSeen: 0 },
    ...extra,
  };
}

const prod: RunServer = { name: "demo", version: "1.0.0", transport: "streamable-http", endpoint: "https://prod.example/mcp" };

describe("compare servers", () => {
  it("does not warn when both runs hit the same server, even across versions", () => {
    const compare = compareRuns(report("a", { server: prod }), report("b", { server: { ...prod, version: "1.1.0" } }));
    expect(compare.warnings).toEqual([]);
    expect(compare.baseServer).toEqual(prod);
    const markdown = formatCompareMarkdown(compare);
    expect(markdown).toContain("Base: `a` — demo 1.0.0 · streamable-http https://prod.example/mcp");
    expect(markdown).toContain("Head: `b` — demo 1.1.0 · streamable-http https://prod.example/mcp");
    expect(markdown).not.toContain("## Warnings");
  });

  it("warns when the server name, transport, or endpoint differs", () => {
    const head: RunServer = { name: "other", transport: "stdio", endpoint: "node index.js" };
    const compare = compareRuns(report("a", { server: prod }), report("b", { server: head }));
    expect(compare.warnings).toEqual([
      "server differs: base demo, head other",
      "endpoint differs: base streamable-http https://prod.example/mcp, head stdio node index.js",
    ]);
    const markdown = formatCompareMarkdown(compare);
    expect(markdown).toContain("## Warnings\n\n- server differs: base demo, head other\n- endpoint differs:");
    expect(markdown.indexOf("## Warnings")).toBeLessThan(markdown.indexOf("## Per-Tool Deltas"));
  });

  it("skips the server check for reports that predate it", () => {
    const compare = compareRuns(report("a"), report("b", { server: prod }));
    expect(compare.warnings).toEqual([]);
    expect(compare).not.toHaveProperty("baseServer");
    expect(formatCompareMarkdown(compare)).toContain("Base: `a`\n");
  });

  it("does not score a tool whose schema changed between suite runs", () => {
    const catalog = [{ name: "echo", schemaHash: "e1" }, { name: "search", schemaHash: "s1" }];
    const base = report("a", { catalog });
    const head = report("b", {
      catalog: [{ name: "echo", schemaHash: "e1" }, { name: "search", schemaHash: "s2" }],
      toolSeries: [tool("echo", 10), tool("search", 50)],
    });
    const deltas = new Map(compareRuns(base, head).deltas.map((delta) => [delta.toolName, delta]));
    expect(deltas.get("echo")).toMatchObject({ catalogStatus: "unchanged", scored: true });
    expect(deltas.get("search")).toMatchObject({ catalogStatus: "schema-changed", scored: false, p95Delta: 0 });
    expect(compareRuns(base, head).regressions).toEqual([]);
  });
});

describe("markdown report", () => {
  it("shows the server in the header when recorded", () => {
    const markdown = formatMarkdownReport(report("a", { server: prod }));
    expect(markdown).toContain("| Server | demo 1.0.0 |\n| Endpoint | `https://prod.example/mcp` |");
    expect(formatMarkdownReport(report("a"))).not.toContain("| Server |");
    expect(formatMarkdownReport(report("a", { server: { transport: "stdio", endpoint: "uvx x" } }))).toContain("| Server | unknown |");
  });
});
