import { readFile } from "node:fs/promises";
import type {
  CatalogCompareStatus,
  CompareDelta,
  CompareReport,
  RunReport,
  ToolSeries,
} from "../types/run.js";

export async function loadRunReport(path: string): Promise<RunReport> {
  const content = await readFile(path, "utf8");
  return JSON.parse(content) as RunReport;
}

function catalogMap(report: RunReport): Map<string, string> | null {
  if (!report.catalog || report.catalog.length === 0) return null;
  return new Map(report.catalog.map((tool) => [tool.name, tool.schemaHash]));
}

function classifyTool(
  name: string,
  baseCatalog: Map<string, string> | null,
  headCatalog: Map<string, string> | null,
  baseTool: ToolSeries | undefined,
  headTool: ToolSeries | undefined,
): CatalogCompareStatus {
  if (baseCatalog && headCatalog) {
    const baseHash = baseCatalog.get(name);
    const headHash = headCatalog.get(name);
    if (baseHash && headHash && baseHash !== headHash) return "schema-changed";
    if (baseHash && headHash) return "unchanged";
    if (headHash && !baseHash) return "added";
    if (baseHash && !headHash) return "removed";
  }
  if (baseTool && headTool) return "unchanged";
  if (headTool && !baseTool) return "added";
  if (baseTool && !headTool) return "removed";
  return "unchanged";
}

function fmtMs(value: number | null): string {
  return value == null ? "—" : value.toFixed(1);
}

function fmtPct(value: number | null): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function compareRuns(base: RunReport, head: RunReport): CompareReport {
  const deltas: CompareDelta[] = [];
  const regressions: string[] = [];
  const baseTools = new Map(base.toolSeries.map((tool) => [tool.toolName, tool]));
  const headTools = new Map(head.toolSeries.map((tool) => [tool.toolName, tool]));
  const baseCatalog = catalogMap(base);
  const headCatalog = catalogMap(head);
  const names = new Set<string>([
    ...baseTools.keys(),
    ...headTools.keys(),
    ...(baseCatalog?.keys() ?? []),
    ...(headCatalog?.keys() ?? []),
  ]);

  for (const toolName of names) {
    const baseTool = baseTools.get(toolName);
    const headTool = headTools.get(toolName);
    const catalogStatus = classifyTool(toolName, baseCatalog, headCatalog, baseTool, headTool);
    const scored = catalogStatus === "unchanged" && Boolean(baseTool) && Boolean(headTool);
    const baseP95 = baseTool ? baseTool.latencyMs.p95 : null;
    const headP95 = headTool ? headTool.latencyMs.p95 : null;
    const baseErrorRate = baseTool ? baseTool.errorRate : null;
    const headErrorRate = headTool ? headTool.errorRate : null;
    const p95Delta = scored && baseP95 != null && headP95 != null ? headP95 - baseP95 : 0;
    const p95DeltaPct =
      scored && baseP95 != null && headP95 != null
        ? baseP95 > 0
          ? (p95Delta / baseP95) * 100
          : headP95 > 0
            ? 100
            : 0
        : 0;
    const errorRateDelta =
      scored && baseErrorRate != null && headErrorRate != null ? headErrorRate - baseErrorRate : 0;

    deltas.push({
      toolName,
      catalogStatus,
      scored,
      baseP95,
      headP95,
      p95Delta,
      p95DeltaPct,
      baseErrorRate,
      headErrorRate,
      errorRateDelta,
    });

    if (!scored) continue;
    if (p95Delta > 0 && (baseP95 ?? 0) > 0 && p95DeltaPct > 20) {
      regressions.push(
        `${toolName}: p95 regressed ${p95DeltaPct.toFixed(1)}% (${(baseP95 ?? 0).toFixed(1)}ms → ${(headP95 ?? 0).toFixed(1)}ms)`,
      );
    }
    if (errorRateDelta > 0) {
      regressions.push(
        `${toolName}: error_rate increased ${(errorRateDelta * 100).toFixed(1)}% (${((baseErrorRate ?? 0) * 100).toFixed(1)}% → ${((headErrorRate ?? 0) * 100).toFixed(1)}%)`,
      );
    }
  }

  return {
    baseRunId: base.id,
    headRunId: head.id,
    generatedAt: new Date().toISOString(),
    deltas,
    regressions,
  };
}

export function formatCompareMarkdown(compare: CompareReport): string {
  const lines = [
    `# Compare Report`,
    ``,
    `Base: \`${compare.baseRunId}\``,
    `Head: \`${compare.headRunId}\``,
    ``,
    `## Per-Tool Deltas`,
    ``,
    `| Tool | Catalog | Scored | Base p95 | Head p95 | Δ p95 | Base err | Head err | Δ err |`,
    `|------|---------|--------|----------|----------|-------|----------|----------|-------|`,
  ];

  for (const delta of compare.deltas) {
    lines.push(
      `| ${delta.toolName} | ${delta.catalogStatus} | ${delta.scored ? "yes" : "no"} | ${fmtMs(delta.baseP95)} | ${fmtMs(delta.headP95)} | ${delta.p95Delta >= 0 ? "+" : ""}${delta.p95Delta.toFixed(1)} | ${fmtPct(delta.baseErrorRate)} | ${fmtPct(delta.headErrorRate)} | ${delta.errorRateDelta >= 0 ? "+" : ""}${(delta.errorRateDelta * 100).toFixed(1)}% |`,
    );
  }

  if (compare.regressions.length > 0) {
    lines.push(``, `## Regressions`, ``);
    for (const regression of compare.regressions) {
      lines.push(`- ${regression}`);
    }
  }

  return lines.join("\n");
}
