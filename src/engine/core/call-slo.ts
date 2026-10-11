import { summarizeLatencies } from "./metrics.js";

/** Optional duration and error objectives for a tool call. */
export interface CallSlo {
  /** p95 duration, milliseconds. */
  maxP95Ms?: number;
  /** p99 duration, milliseconds. */
  maxP99Ms?: number;
  /** Share of calls that may fail, from 0 to 1. */
  maxErrorRate?: number;
}

export interface CallSloSample {
  nodeId?: string;
  toolName?: string;
  latencyMs: number;
  failed: boolean;
}

export interface CallSloStep {
  nodeId?: string;
  label?: string;
  tool?: string;
  slo?: CallSlo;
}

function positiveMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
}

function errorRate(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** Drop blank or invalid fields. An empty objective is omitted. */
export function normalizeCallSlo(value: unknown): CallSlo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<CallSlo>;
  const slo: CallSlo = {};
  const maxP95Ms = positiveMs(raw.maxP95Ms);
  const maxP99Ms = positiveMs(raw.maxP99Ms);
  const maxErrorRate = errorRate(raw.maxErrorRate);
  if (maxP95Ms !== undefined) slo.maxP95Ms = maxP95Ms;
  if (maxP99Ms !== undefined) slo.maxP99Ms = maxP99Ms;
  if (maxErrorRate !== undefined) slo.maxErrorRate = maxErrorRate;
  return Object.keys(slo).length > 0 ? slo : undefined;
}

/** Step fields replace the suite objective. Unset step fields keep the suite value. */
export function effectiveCallSlo(suite: CallSlo | undefined, step: CallSlo | undefined): CallSlo {
  return {
    maxP95Ms: step?.maxP95Ms ?? suite?.maxP95Ms,
    maxP99Ms: step?.maxP99Ms ?? suite?.maxP99Ms,
    maxErrorRate: step?.maxErrorRate ?? suite?.maxErrorRate ?? 0,
  };
}

function judge(kind: "Step" | "Tool", name: string, samples: CallSloSample[], limits: CallSlo): string[] {
  if (samples.length === 0) return [];
  const reasons: string[] = [];
  const errors = samples.filter((sample) => sample.failed).length;
  const errorRate = errors / samples.length;
  const maxErrorRate = limits.maxErrorRate ?? 0;
  if (errorRate > maxErrorRate) {
    reasons.push(
      `${kind} ${name} error_rate ${errorRate.toFixed(3)} exceeds max ${maxErrorRate}`,
    );
  }
  const latency = summarizeLatencies(samples.map((sample) => sample.latencyMs));
  if (limits.maxP95Ms !== undefined && latency.p95 > limits.maxP95Ms) {
    reasons.push(
      `${kind} ${name} p95 ${latency.p95.toFixed(1)}ms exceeds max ${limits.maxP95Ms}ms`,
    );
  }
  if (limits.maxP99Ms !== undefined && latency.p99 > limits.maxP99Ms) {
    reasons.push(
      `${kind} ${name} p99 ${latency.p99.toFixed(1)}ms exceeds max ${limits.maxP99Ms}ms`,
    );
  }
  return reasons;
}

/**
 * Check each tool-call step against its own objective, then the suite objective.
 * A step field replaces that suite field. Calls with no step id use the suite objective.
 */
export function callSloFailures(input: {
  suite?: CallSlo;
  steps: CallSloStep[];
  samples: CallSloSample[];
}): string[] {
  const byNode = new Map<string, CallSloSample[]>();
  const unscoped = new Map<string, CallSloSample[]>();
  for (const sample of input.samples) {
    if (sample.nodeId) {
      const list = byNode.get(sample.nodeId) ?? [];
      list.push(sample);
      byNode.set(sample.nodeId, list);
      continue;
    }
    const tool = sample.toolName?.trim();
    if (!tool) continue;
    const list = unscoped.get(tool) ?? [];
    list.push(sample);
    unscoped.set(tool, list);
  }

  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const step of input.steps) {
    const id = step.nodeId?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const samples = byNode.get(id) ?? [];
    byNode.delete(id);
    const name = step.label?.trim() || step.tool?.trim() || id;
    reasons.push(...judge("Step", name, samples, effectiveCallSlo(input.suite, step.slo)));
  }
  for (const [id, samples] of byNode) {
    const name = samples[0]?.toolName?.trim() || id;
    reasons.push(...judge("Step", name, samples, effectiveCallSlo(input.suite, undefined)));
  }
  for (const [tool, samples] of unscoped) {
    reasons.push(...judge("Tool", tool, samples, effectiveCallSlo(input.suite, undefined)));
  }
  return reasons;
}
