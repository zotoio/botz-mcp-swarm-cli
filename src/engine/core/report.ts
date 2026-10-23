import { formatLoadTimeline } from "./load-timeline.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunReport } from "../types/run.js";

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function formatMarkdownReport(report: RunReport): string {
  const lines: string[] = [
    `# botz-mcp-swarm Run Report`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| Run ID | \`${report.id}\` |`,
    `| Manifest | ${report.manifestName} |`,
    `| Mode | ${report.mode} |`,
    `| Verdict | **${report.verdict.toUpperCase()}** |`,
    `| Transport | ${report.transport} |`,
    ...(report.server
      ? [
          `| Server | ${[report.server.name ?? "unknown", report.server.version].filter(Boolean).join(" ")} |`,
          `| Endpoint | \`${report.server.endpoint}\` |`,
        ]
      : []),
    `| Duration | ${report.durationMs}ms |`,
    `| Silent Green | ${report.silentGreen ? "YES (FAIL)" : "no"} |`,
    ``,
  ];

  if (report.soak) {
    lines.push(
      `## Soak`,
      ``,
      `- Iterations: ${report.soak.iterations}`,
      `- Soak duration: ${report.soak.durationMs}ms`,
      `- Interval: ${report.soak.intervalMs}ms`,
      ``,
    );
  }

  if (report.processSummary) {
    const { worker, sut, otelSpikeFlag } = report.processSummary;
    lines.push(
      `## Process Gauges`,
      ``,
      `| Role | PID | RSS (max) | CPU max | CPU avg | OTel spike |`,
      `|------|-----|-----------|---------|---------|------------|`,
      `| worker | ${worker.pid} | ${formatBytes(worker.rssBytes.max)} | ${worker.cpuRatio.max.toFixed(3)} | ${worker.cpuRatio.avg.toFixed(3)} | ${otelSpikeFlag ? "YES" : "no"} |`,
    );
    if (sut) {
      lines.push(
        `| sut | ${sut.pid} | ${formatBytes(sut.rssBytes.max)} | ${sut.cpuRatio.max.toFixed(3)} | ${sut.cpuRatio.avg.toFixed(3)} | |`,
      );
    }
    lines.push(``);
  }

  if (report.failReasons.length > 0) {
    lines.push(`## Fail Reasons`, ``);
    for (const reason of report.failReasons) {
      lines.push(`- ${reason}`);
    }
    lines.push(``);
  }

  lines.push(`## Session Metrics`, ``);
  lines.push(`- Started: ${report.sessionMetrics.started}`);
  lines.push(`- Active: ${report.sessionMetrics.active}`);
  lines.push(`- Failed: ${report.sessionMetrics.failed}`);
  lines.push(``);

  if (report.toolSeries.length > 0) {
    lines.push(
      `## Per-Tool Metrics`,
      ``,
      `| Tool | Calls | Error Rate | Mean (ms) | Std | p90 | p95 | p99 |`,
      `|------|-------|------------|-----------|-----|-----|-----|-----|`,
    );
    for (const tool of report.toolSeries) {
      const latency = tool.latencyMs;
      lines.push(
        `| ${tool.toolName} | ${tool.count} | ${(tool.errorRate * 100).toFixed(1)}% | ${(latency.mean ?? latency.p50).toFixed(1)} | ${(latency.std ?? 0).toFixed(1)} | ${(latency.p90 ?? latency.p50).toFixed(1)} | ${latency.p95.toFixed(1)} | ${latency.p99.toFixed(1)} |`,
      );
    }
    lines.push(``);
  }

  if (report.toolEvals && report.toolEvals.length > 0) {
    lines.push(`## Tool Evals`, ``);
    for (const item of report.toolEvals) {
      const calls = item.toolCalls.map((call) => call.name).join(", ") || "none";
      lines.push(
        `- **${item.tool}** (${item.polarity}) ${item.pass ? "pass" : "fail"} — ${item.prompt} — calls: ${calls}${item.reason ? ` — ${item.reason}` : ""}`,
      );
    }
    lines.push(``);
  }

  if (report.scenarioOutcomes.length > 0) {
    lines.push(`## Scenario Outcomes`, ``);
    for (const outcome of report.scenarioOutcomes) {
      lines.push(
        `- **${outcome.scenario}**: ${outcome.outcome}${outcome.message ? ` — ${outcome.message}` : ""}`,
      );
    }
    lines.push(``);
  }

  if (report.loadTimeline && report.loadTimeline.summary.overall.calls > 0) {
    lines.push(`## Load over time`, ``, "```", ...formatLoadTimeline(report.loadTimeline, { width: 60 }), "```", ``);
  }

  lines.push(`## Quotas`, ``);
  lines.push(`- Calls: ${report.quotas.callCount}`);
  lines.push(`- Max payload seen: ${report.quotas.maxPayloadBytesSeen} bytes`);
  if (report.limits) lines.push(`- Limits: max ${report.limits.maxCallCount} calls, max ${report.limits.maxPayloadBytes} bytes per payload`);
  lines.push(``);

  return lines.join("\n");
}

export async function writeReports(
  report: RunReport,
  outputDir: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(outputDir, { recursive: true });
  const jsonPath = join(outputDir, `${report.id}.json`);
  const markdownPath = join(outputDir, `${report.id}.md`);

  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, formatMarkdownReport(report), "utf8");

  return { jsonPath, markdownPath };
}
