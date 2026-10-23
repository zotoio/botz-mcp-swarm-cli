import type { ErrorClass, RunSample, RunTimeBucket } from "../types/run.js";
import { redactString, redactValue } from "./redaction.js";

export const SAMPLE_MAX_BYTES = 4096;
/** 24h of dense seconds; longer spans fall back to sparse buckets. */
export const MAX_DENSE_BUCKETS = 86_400;

/** Redact secrets and serialize, truncating to maxBytes (UTF-8). */
export function truncatePayload(value: unknown, maxBytes = SAMPLE_MAX_BYTES): { value: unknown; truncated: boolean; bytes: number } {
  if (value === undefined) return { value: undefined, truncated: false, bytes: 0 };
  const redacted = redactValue(value);
  let text: string;
  try {
    text = JSON.stringify(redacted) ?? "";
  } catch {
    text = String(redacted);
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { value: redacted, truncated: false, bytes };
  let cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  if (cut.endsWith("\uFFFD")) cut = cut.slice(0, -1);
  return { value: cut, truncated: true, bytes };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function p50p95(values: number[]): { p50: number; p95: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
}

export interface ToolCallRecord {
  tool: string;
  ok: boolean;
  latencyMs: number;
  args?: unknown;
  result?: unknown;
  errorClass?: ErrorClass;
  errorMessage?: string;
  nodeId?: string;
  /** Epoch ms when the call completed; defaults to now. */
  at?: number;
}

interface Bucket {
  calls: number;
  errors: number;
  vus: number;
  latencies: number[];
  byTool: Map<string, { calls: number; errors: number; latencies: number[] }>;
}

/** Collects per-tool first samples and per-second buckets for the whole run (unbounded by the log tail). */
export class RunRecorder {
  private readonly samples = new Map<string, RunSample>();
  private readonly buckets = new Map<number, Bucket>();
  private vus = 0;
  private vusMax = 0;

  constructor(private readonly startMs: number, private readonly maxBytes = SAMPLE_MAX_BYTES) {}

  setVus(active: number): void {
    this.vus = active;
    this.vusMax = Math.max(this.vusMax, active);
    this.bucket(Date.now()).vus = Math.max(this.bucket(Date.now()).vus, active);
  }

  private bucket(at: number): Bucket {
    const t = Math.max(0, Math.floor((at - this.startMs) / 1000));
    let b = this.buckets.get(t);
    if (!b) {
      b = { calls: 0, errors: 0, vus: this.vus, latencies: [], byTool: new Map() };
      this.buckets.set(t, b);
    }
    return b;
  }

  recordToolCall(call: ToolCallRecord): void {
    const at = call.at ?? Date.now();
    const b = this.bucket(at);
    b.calls += 1;
    if (!call.ok) b.errors += 1;
    b.latencies.push(call.latencyMs);
    b.vus = Math.max(b.vus, this.vus);
    const tool = b.byTool.get(call.tool) ?? { calls: 0, errors: 0, latencies: [] };
    tool.calls += 1;
    if (!call.ok) tool.errors += 1;
    tool.latencies.push(call.latencyMs);
    b.byTool.set(call.tool, tool);

    const sample = this.samples.get(call.tool) ?? { tool: call.tool };
    const slot = call.ok ? "success" : "error";
    if (!sample[slot]) {
      const args = truncatePayload(call.args ?? {}, this.maxBytes);
      const entry: NonNullable<RunSample["success"]> = {
        atMs: Math.max(0, at - this.startMs),
        latencyMs: call.latencyMs,
        args: args.value,
        ...(call.nodeId ? { nodeId: call.nodeId } : {}),
      };
      if (call.ok) {
        const result = truncatePayload(call.result, this.maxBytes);
        if (result.value !== undefined) entry.response = result.value;
        if (result.truncated || args.truncated) entry.truncated = true;
        entry.responseBytes = result.bytes;
      } else {
        entry.errorClass = call.errorClass;
        if (call.errorMessage) entry.errorMessage = redactString(call.errorMessage).slice(0, this.maxBytes);
        const result = truncatePayload(call.result, this.maxBytes);
        if (result.value !== undefined) entry.response = result.value;
        if (result.truncated || args.truncated) entry.truncated = true;
      }
      sample[slot] = entry;
      this.samples.set(call.tool, sample);
    }
  }

  sampleResults(): RunSample[] {
    return [...this.samples.values()].sort((a, b) => a.tool.localeCompare(b.tool));
  }

  /**
   * Per-second buckets from t=0 to the end of the run. Dense (idle seconds included)
   * up to MAX_DENSE_BUCKETS; beyond that only seconds with activity are emitted.
   */
  timeSeries(endMs: number = Date.now()): RunTimeBucket[] {
    const keys = [...this.buckets.keys()];
    const lastActive = keys.length > 0 ? Math.max(...keys) : -1;
    const last = Math.max(Math.floor(Math.max(0, endMs - this.startMs) / 1000), lastActive);
    const seconds = last + 1 <= MAX_DENSE_BUCKETS
      ? Array.from({ length: last + 1 }, (_unused, t) => t)
      : keys.sort((a, b) => a - b);
    const out: RunTimeBucket[] = [];
    let vus = 0;
    for (const t of seconds) {
      const b = this.buckets.get(t);
      if (b) vus = b.vus;
      const byTool: RunTimeBucket["byTool"] = {};
      const byToolLatency: RunTimeBucket["byToolLatency"] = {};
      for (const [name, tool] of b?.byTool ?? []) {
        byTool[name] = { calls: tool.calls, errors: tool.errors };
        byToolLatency[name] = p50p95(tool.latencies);
      }
      out.push({
        t,
        calls: b?.calls ?? 0,
        errors: b?.errors ?? 0,
        byTool,
        vus,
        latency: p50p95(b?.latencies ?? []),
        byToolLatency,
      });
    }
    return out;
  }
}
