/**
 * Active VUs and throughput over time, overall and per tool.
 *
 * Overall VUs come from the runner's `mcp.load.vus` updates. Per-tool "VUs" are calls of that tool
 * in flight at once (each tool call is an interval ending when its result arrives). TPS counts
 * completed tools/call results per second. Runs without VU updates (scenario manifests) use
 * overall calls in flight as VUs.
 */
export interface LoadTimelineToolPoint {
  calls: number;
  errors: number;
  /** Most calls of this tool in flight at once during the bucket. */
  peakInFlight: number;
}

export interface LoadTimelinePoint {
  /** Bucket start, ms from run start. */
  tMs: number;
  /** Most active VUs during the bucket. */
  vus: number;
  /** Completed tool calls in the bucket, per second. */
  tps: number;
  errors: number;
  tools: Record<string, LoadTimelineToolPoint>;
}

export interface LoadStats {
  peakVus: number;
  avgVus: number;
  peakTps: number;
  avgTps: number;
  calls: number;
  errors: number;
}

export interface LoadTimeline {
  bucketMs: number;
  durationMs: number;
  points: LoadTimelinePoint[];
  summary: { overall: LoadStats; tools: Record<string, LoadStats> };
}

interface CallSpan { tool: string; start: number; end: number; ok: boolean }

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export class LoadTimelineCollector {
  private readonly vus: Array<{ t: number; active: number }> = [];
  private readonly calls: CallSpan[] = [];
  private readonly t0: number;

  constructor(private readonly bucketMs = 1000, now = Date.now()) {
    this.t0 = now;
  }

  setVus(active: number, now = Date.now()): void {
    this.vus.push({ t: Math.max(0, now - this.t0), active: Math.max(0, active) });
  }

  recordToolCall(tool: string, latencyMs: number, ok: boolean, now = Date.now()): void {
    const end = Math.max(0, now - this.t0);
    this.calls.push({ tool, start: Math.max(0, end - Math.max(0, latencyMs)), end, ok });
  }

  finish(now = Date.now()): LoadTimeline {
    const durationMs = Math.max(1, now - this.t0, ...this.calls.map((c) => c.end));
    return buildTimeline(this.vus, this.calls, durationMs, this.bucketMs);
  }
}

/** Sweep line: max concurrency in [from, to) and total busy time. */
function concurrency(spans: CallSpan[], from: number, to: number): { peak: number; busyMs: number } {
  const edges: Array<[number, number]> = [];
  for (const s of spans) {
    const a = Math.max(from, s.start);
    const b = Math.min(to, s.end);
    if (b > a || (s.start === s.end && s.start >= from && s.start < to)) {
      edges.push([a, 1], [Math.max(b, a), -1]);
    }
  }
  edges.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  let cur = 0;
  let peak = 0;
  let busy = 0;
  let last = from;
  for (const [t, d] of edges) {
    busy += cur * (t - last);
    last = t;
    cur += d;
    peak = Math.max(peak, cur);
  }
  return { peak, busyMs: busy };
}

/** Step function value of VUs over [from, to): max and integral. */
function vuStats(vus: Array<{ t: number; active: number }>, from: number, to: number): { peak: number; areaMs: number } {
  let current = 0;
  for (const v of vus) if (v.t <= from) current = v.active;
  let peak = current;
  let area = 0;
  let last = from;
  for (const v of vus) {
    if (v.t <= from || v.t >= to) continue;
    area += current * (v.t - last);
    last = v.t;
    current = v.active;
    peak = Math.max(peak, current);
  }
  area += current * (to - last);
  return { peak, areaMs: area };
}

export function buildTimeline(
  vusIn: Array<{ t: number; active: number }>,
  calls: CallSpan[],
  durationMs: number,
  bucketMs = 1000,
): LoadTimeline {
  const vus = [...vusIn].sort((a, b) => a.t - b.t);
  const tools = [...new Set(calls.map((c) => c.tool))].sort();
  const buckets = Math.max(1, Math.ceil(durationMs / bucketMs));
  const points: LoadTimelinePoint[] = [];
  for (let i = 0; i < buckets; i++) {
    const from = i * bucketMs;
    const to = Math.min(durationMs, from + bucketMs);
    const span = Math.max(1, to - from);
    const done = calls.filter((c) => c.end >= from && (c.end < to || (i === buckets - 1 && c.end <= to)));
    const byTool: Record<string, LoadTimelineToolPoint> = {};
    for (const tool of tools) {
      const mine = calls.filter((c) => c.tool === tool);
      const finished = done.filter((c) => c.tool === tool);
      byTool[tool] = { calls: finished.length, errors: finished.filter((c) => !c.ok).length, peakInFlight: concurrency(mine, from, to).peak };
    }
    points.push({
      tMs: from,
      // Scenario (manifest) runs do not publish VU counts; fall back to calls in flight.
      vus: vus.length ? vuStats(vus, from, to).peak : concurrency(calls, from, to).peak,
      tps: round((done.length * 1000) / span),
      errors: done.filter((c) => !c.ok).length,
      tools: byTool,
    });
  }
  const seconds = durationMs / 1000;
  const inFlight = concurrency(calls, 0, durationMs);
  const overallVus = vus.length ? vuStats(vus, 0, durationMs) : { peak: inFlight.peak, areaMs: inFlight.busyMs };
  const summaryTools: Record<string, LoadStats> = {};
  for (const tool of tools) {
    const mine = calls.filter((c) => c.tool === tool);
    const c = concurrency(mine, 0, durationMs);
    summaryTools[tool] = {
      peakVus: c.peak,
      avgVus: round(c.busyMs / durationMs),
      peakTps: Math.max(0, ...points.map((p) => round((p.tools[tool]!.calls * 1000) / Math.max(1, Math.min(bucketMs, durationMs - p.tMs))))),
      avgTps: round(mine.length / seconds),
      calls: mine.length,
      errors: mine.filter((x) => !x.ok).length,
    };
  }
  return {
    bucketMs,
    durationMs,
    points,
    summary: {
      overall: {
        peakVus: overallVus.peak,
        avgVus: round(overallVus.areaMs / durationMs),
        peakTps: Math.max(0, ...points.map((p) => p.tps)),
        avgTps: round(calls.length / seconds),
        calls: calls.length,
        errors: calls.filter((c) => !c.ok).length,
      },
      tools: summaryTools,
    },
  };
}

const BARS = "▁▂▃▄▅▆▇█";

/** Unicode sparkline, resampled to at most `width` characters (max per cell). */
export function sparkline(values: number[], width = 40): string {
  if (values.length === 0) return "";
  const cells = Math.min(width, values.length);
  const per = values.length / cells;
  const sampled = Array.from({ length: cells }, (_, i) => Math.max(...values.slice(Math.floor(i * per), Math.max(Math.floor((i + 1) * per), Math.floor(i * per) + 1))));
  const max = Math.max(...sampled);
  if (max <= 0) return BARS[0]!.repeat(cells);
  return sampled.map((v) => BARS[Math.min(BARS.length - 1, Math.round((v / max) * (BARS.length - 1)))]).join("");
}

/** Compact text block for CLI output and the Markdown report. */
export function formatLoadTimeline(t: LoadTimeline, opts: { width?: number } = {}): string[] {
  const width = opts.width ?? 40;
  const o = t.summary.overall;
  const rows: string[][] = [["", "peak VUs", "avg VUs", "peak TPS", "avg TPS", "calls", "errors"]];
  rows.push(["overall", String(o.peakVus), String(o.avgVus), String(o.peakTps), String(o.avgTps), String(o.calls), String(o.errors)]);
  for (const [tool, s] of Object.entries(t.summary.tools)) {
    rows.push([tool, String(s.peakVus), String(s.avgVus), String(s.peakTps), String(s.avgTps), String(s.calls), String(s.errors)]);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  const table = rows.map((r) => r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join("  "));
  return [
    `Load over ${Math.round(t.durationMs / 100) / 10}s (${t.bucketMs} ms buckets)`,
    `  VUs ${sparkline(t.points.map((p) => p.vus), width)}`,
    `  TPS ${sparkline(t.points.map((p) => p.tps), width)}`,
    ...table.map((line) => `  ${line}`),
  ];
}
