import { formatLoadTimeline } from "./load-timeline.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunReport } from "../types/run.js";

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** True when the run called more than one server. */
export function isMultiServerReport(report: Pick<RunReport, "servers">): boolean {
  return (report.servers?.length ?? 0) > 1;
}

export function formatMarkdownReport(report: RunReport): string {
  const multi = isMultiServerReport(report);
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
    ...(multi
      ? report.servers!.map((server) =>
          `| Server ${server.alias} | ${[server.name ?? "unknown", server.version].filter(Boolean).join(" ")} · \`${server.endpoint}\` |`)
      : report.server
      ? [
          `| Server | ${[report.server.name ?? "unknown", report.server.version].filter(Boolean).join(" ")} |`,
          `| Endpoint | \`${report.server.endpoint}\` |`,
        ]
      : []),
    `| Duration | ${report.durationMs}ms |`,
    `| Silent Green | ${report.silentGreen ? "YES (FAIL)" : "no"} |`,
    ``,
  ];

  if (report.flow && report.flow.passes > 0) {
    const { flow } = report;
    lines.push(
      `## Flow`,
      ``,
      `- Passes: ${flow.passes} (failed ${flow.passesFailed}, stopped by a missing variable ${flow.passesSkipped})`,
      `- Pass duration: p50 ${flow.latencyMs.p50.toFixed(1)}ms, p95 ${flow.latencyMs.p95.toFixed(1)}ms, p99 ${flow.latencyMs.p99.toFixed(1)}ms`,
      ``,
    );
  }

  if (multi) {
    // The first server in run order with failed calls is where the flow broke.
    const firstFailing = report.servers!.find((server) => server.errorRate > 0)?.alias;
    lines.push(
      `## Servers`,
      ``,
      `| Server | Calls | Error Rate | p50 | p95 | p99 | Sessions |`,
      `|--------|-------|------------|-----|-----|-----|----------|`,
    );
    for (const server of report.servers!) {
      const mark = server.alias === firstFailing ? " (first failure)" : "";
      lines.push(
        `| ${server.alias}${mark} | ${server.calls} | ${pct(server.errorRate)} | ${server.latencyMs.p50.toFixed(1)} | ${server.latencyMs.p95.toFixed(1)} | ${server.latencyMs.p99.toFixed(1)} | ${server.sessionMetrics.started} |`,
      );
    }
    lines.push(``);
  }

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
    const suts = report.processSummary.suts;
    if (suts) {
      for (const [alias, item] of Object.entries(suts)) {
        lines.push(
          `| sut ${alias} | ${item.pid} | ${formatBytes(item.rssBytes.max)} | ${item.cpuRatio.max.toFixed(3)} | ${item.cpuRatio.avg.toFixed(3)} | |`,
        );
      }
    } else if (sut) {
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
      multi ? `| Server | Tool | Calls | Error Rate | Mean (ms) | Std | p90 | p95 | p99 |` : `| Tool | Calls | Error Rate | Mean (ms) | Std | p90 | p95 | p99 |`,
      multi ? `|--------|------|-------|------------|-----------|-----|-----|-----|-----|` : `|------|-------|------------|-----------|-----|-----|-----|-----|`,
    );
    for (const tool of report.toolSeries) {
      const latency = tool.latencyMs;
      lines.push(
        `| ${multi ? `${tool.server ?? ""} | ` : ""}${tool.toolName} | ${tool.count} | ${(tool.errorRate * 100).toFixed(1)}% | ${(latency.mean ?? latency.p50).toFixed(1)} | ${(latency.std ?? 0).toFixed(1)} | ${(latency.p90 ?? latency.p50).toFixed(1)} | ${latency.p95.toFixed(1)} | ${latency.p99.toFixed(1)} |`,
      );
    }
    lines.push(``);
  }

  if (multi && (report.nodeOutcomes?.length ?? 0) > 0) {
    lines.push(
      `## Steps`,
      ``,
      `| Step | Server | Runs | Errors | Skipped |`,
      `|------|--------|------|--------|---------|`,
    );
    for (const node of report.nodeOutcomes!) {
      lines.push(`| ${node.label} | ${node.server ?? ""} | ${node.count} | ${node.errorCount} | ${node.skipped ?? 0} |`);
    }
    lines.push(``);
  }

  if ((report.variables?.length ?? 0) > 0) {
    lines.push(
      `## Variables`,
      ``,
      `| Variable | Set by | Server | Resolved |`,
      `|----------|--------|--------|----------|`,
    );
    for (const variable of report.variables!) {
      const flag = variable.resolvedRate < 1 ? " ⚠" : "";
      lines.push(`| ${variable.name} | ${variable.setBy} | ${variable.server ?? ""} | ${pct(variable.resolvedRate)}${flag} |`);
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

  if (report.rampDown) {
    const r = report.rampDown;
    lines.push(
      `## Ramp-down`,
      ``,
      `- Strategy: ${r.strategy}`,
      `- Drain deadline: ${r.drainDeadlineMs}ms after start`,
      ...(r.passEstimateMs !== undefined ? [`- Pass estimate (p90): ${r.passEstimateMs}ms`] : []),
      `- Incomplete passes (cut off by drain deadline): ${r.incompletePasses}`,
      `- Calls cancelled by ramp-down: ${r.cancelledByRampDown}`,
      `- Passes not started (would not finish in time): ${r.skippedPasses}`,
      ``,
      `_Cancelled calls and incomplete passes are excluded from error rate, thresholds and pass/fail._`,
      ``,
    );
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
