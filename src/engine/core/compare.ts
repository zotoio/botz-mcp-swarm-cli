import { readFile } from "node:fs/promises";
import type {
  CatalogCompareStatus,
  CompareDelta,
  CompareReport,
  RunReport,
  RunServer,
  ToolSeries,
} from "../types/run.js";
import { formatRunServer } from "./run-server.js";

export async function loadRunReport(path: string): Promise<RunReport> {
  const content = await readFile(path, "utf8");
  return JSON.parse(content) as RunReport;
}

/** Alias of a report's default server. A report from before servers were recorded takes the other side's. */
function defaultAlias(report: RunReport, other: RunReport): string {
  return report.servers?.[0]?.alias ?? other.servers?.[0]?.alias ?? "default";
}

function multiServer(report: RunReport): boolean {
  return (report.servers?.length ?? 0) > 1;
}

/** Tool key: the name on single-server comparisons, else server and name. */
function toolKey(multi: boolean, server: string | undefined, fallback: string, name: string): string {
  return multi ? `${server ?? fallback}\0${name}` : name;
}

function catalogMap(report: RunReport, multi: boolean, fallback: string): Map<string, string> | null {
  if (!report.catalog || report.catalog.length === 0) return null;
  return new Map(report.catalog.map((tool) => [toolKey(multi, tool.server, fallback, tool.name), tool.schemaHash]));
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

/** Reports from before `server` was recorded are not compared. */
function serverWarnings(base: RunServer | undefined, head: RunServer | undefined, alias?: string): string[] {
  if (!base || !head) return [];
  const warnings: string[] = [];
  const which = alias ? `server ${alias} ` : "";
  if ((base.name ?? "") !== (head.name ?? "")) {
    warnings.push(`${which}${alias ? "name" : "server"} differs: base ${base.name ?? "unknown"}, head ${head.name ?? "unknown"}`);
  }
  if (base.transport !== head.transport || base.endpoint !== head.endpoint) {
    warnings.push(
      `${which}endpoint differs: base ${base.transport} ${base.endpoint}, head ${head.transport} ${head.endpoint}`,
    );
  }
  return warnings;
}

/** Per alias: servers added or removed, and each shared server's name, transport, and endpoint. */
function serverSetWarnings(base: RunReport, head: RunReport): string[] {
  const baseServers = new Map((base.servers ?? []).map((server) => [server.alias, server]));
  const headServers = new Map((head.servers ?? []).map((server) => [server.alias, server]));
  if (baseServers.size === 0 || headServers.size === 0) return serverWarnings(base.server, head.server);
  const warnings: string[] = [];
  for (const alias of headServers.keys()) if (!baseServers.has(alias)) warnings.push(`server ${alias} added in head`);
  for (const alias of baseServers.keys()) if (!headServers.has(alias)) warnings.push(`server ${alias} removed in head`);
  for (const [alias, server] of baseServers) {
    const other = headServers.get(alias);
    if (other) warnings.push(...serverWarnings(server, other, alias));
  }
  return warnings;
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
  const multi = multiServer(base) || multiServer(head);
  const baseDefault = defaultAlias(base, head);
  const headDefault = defaultAlias(head, base);
  const baseTools = new Map(base.toolSeries.map((tool) => [toolKey(multi, tool.server, baseDefault, tool.toolName), tool]));
  const headTools = new Map(head.toolSeries.map((tool) => [toolKey(multi, tool.server, headDefault, tool.toolName), tool]));
  const baseCatalog = catalogMap(base, multi, baseDefault);
  const headCatalog = catalogMap(head, multi, headDefault);
  const keys = new Set<string>([
    ...baseTools.keys(),
    ...headTools.keys(),
    ...(baseCatalog?.keys() ?? []),
    ...(headCatalog?.keys() ?? []),
  ]);

  for (const key of keys) {
    const split = key.indexOf("\0");
    const server = split >= 0 ? key.slice(0, split) : undefined;
    const toolName = split >= 0 ? key.slice(split + 1) : key;
    const label = server ? `${server}/${toolName}` : toolName;
    const baseTool = baseTools.get(key);
    const headTool = headTools.get(key);
    const catalogStatus = classifyTool(key, baseCatalog, headCatalog, baseTool, headTool);
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
      ...(server ? { server } : {}),
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
        `${label}: p95 regressed ${p95DeltaPct.toFixed(1)}% (${(baseP95 ?? 0).toFixed(1)}ms → ${(headP95 ?? 0).toFixed(1)}ms)`,
      );
    }
    if (errorRateDelta > 0) {
      regressions.push(
        `${label}: error_rate increased ${(errorRateDelta * 100).toFixed(1)}% (${((baseErrorRate ?? 0) * 100).toFixed(1)}% → ${((headErrorRate ?? 0) * 100).toFixed(1)}%)`,
      );
    }
  }

  let flow: CompareReport["flow"];
  if (base.flow && head.flow && base.flow.passes > 0 && head.flow.passes > 0) {
    const baseP95 = base.flow.latencyMs.p95;
    const headP95 = head.flow.latencyMs.p95;
    const p95Delta = headP95 - baseP95;
    const p95DeltaPct = baseP95 > 0 ? (p95Delta / baseP95) * 100 : headP95 > 0 ? 100 : 0;
    flow = { baseP95, headP95, p95Delta, p95DeltaPct };
    // On a single-server run the flow is the sum of its steps, which the tool rows already score.
    if (multi && p95Delta > 0 && baseP95 > 0 && p95DeltaPct > 20) {
      regressions.push(`flow: p95 regressed ${p95DeltaPct.toFixed(1)}% (${baseP95.toFixed(1)}ms → ${headP95.toFixed(1)}ms)`);
    }
  }

  return {
    baseRunId: base.id,
    headRunId: head.id,
    generatedAt: new Date().toISOString(),
    ...(base.server ? { baseServer: base.server } : {}),
    ...(head.server ? { headServer: head.server } : {}),
    ...(flow ? { flow } : {}),
    warnings: multi ? serverSetWarnings(base, head) : serverWarnings(base.server, head.server),
    deltas,
    regressions,
  };
}

export function formatCompareMarkdown(compare: CompareReport): string {
  const lines = [
    `# Compare Report`,
    ``,
    `Base: \`${compare.baseRunId}\`${compare.baseServer ? ` — ${formatRunServer(compare.baseServer)}` : ""}`,
    `Head: \`${compare.headRunId}\`${compare.headServer ? ` — ${formatRunServer(compare.headServer)}` : ""}`,
    ``,
  ];

  if (compare.warnings?.length) {
    lines.push(`## Warnings`, ``);
    for (const warning of compare.warnings) lines.push(`- ${warning}`);
    lines.push(``);
  }

  const multi = compare.deltas.some((delta) => delta.server !== undefined);
  if (compare.flow) {
    const { flow } = compare;
    lines.push(`Flow p95: ${flow.baseP95.toFixed(1)}ms → ${flow.headP95.toFixed(1)}ms (${flow.p95Delta >= 0 ? "+" : ""}${flow.p95DeltaPct.toFixed(1)}%)`, ``);
  }
  lines.push(
    `## Per-Tool Deltas`,
    ``,
    `| ${multi ? "Server | " : ""}Tool | Catalog | Scored | Base p95 | Head p95 | Δ p95 | Base err | Head err | Δ err |`,
    `|${multi ? "--------|" : ""}------|---------|--------|----------|----------|-------|----------|----------|-------|`,
  );

  const sorted = multi ? [...compare.deltas].sort((a, b) => (a.server ?? "").localeCompare(b.server ?? "")) : compare.deltas;
  for (const delta of sorted) {
    lines.push(
      `| ${multi ? `${delta.server ?? ""} | ` : ""}${delta.toolName} | ${delta.catalogStatus} | ${delta.scored ? "yes" : "no"} | ${fmtMs(delta.baseP95)} | ${fmtMs(delta.headP95)} | ${delta.p95Delta >= 0 ? "+" : ""}${delta.p95Delta.toFixed(1)} | ${fmtPct(delta.baseErrorRate)} | ${fmtPct(delta.headErrorRate)} | ${delta.errorRateDelta >= 0 ? "+" : ""}${(delta.errorRateDelta * 100).toFixed(1)}% |`,
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
