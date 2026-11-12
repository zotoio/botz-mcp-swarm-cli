import { DEFAULT_LOAD_PROFILE } from "./load-defaults.js";

/**
 * Inter-call pacing. `dwellMs` is the load-rate contract — `load-presets` derives it from a
 * per-user TPS target and `suite-model` estimates pass time from it — so jitter on it is
 * symmetric and mean-preserving: each pause is uniform in [dwellMs×(1−r), dwellMs×(1+r)], so
 * the average pause, and the advertised TPS, are unchanged.
 */

/** Where a pause was inserted: between sequential steps, between DAG waves, between passes of one VU. */
export type DwellKind = "step" | "wave" | "pass_jitter";

/** Clamp a configured jitter ratio into 0..1. */
export function resolveDwellJitterRatio(
  value: number | undefined | null,
  fallback: number = DEFAULT_LOAD_PROFILE.dwellJitterRatio,
): number {
  const raw = value ?? fallback;
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(1, Math.max(0, raw));
}

/**
 * One dwell, jittered. Uniform in [dwellMs×(1−r), dwellMs×(1+r)] and floored at 0, so the mean
 * stays dwellMs. `dwellMs` of 0 stays 0 (no dwell) and a ratio of 0 is the exact configured dwell.
 */
export function jitteredDwellMs(
  dwellMs: number,
  jitterRatio: number,
  random: () => number = Math.random,
): number {
  if (!(dwellMs > 0)) return 0;
  const ratio = resolveDwellJitterRatio(jitterRatio, 0);
  if (ratio === 0) return Math.round(dwellMs);
  const span = dwellMs * ratio;
  return Math.max(0, Math.round(dwellMs - span + 2 * span * random()));
}

/** Pause between passes of one virtual user: uniform 0..jitterMs, as `load.jitterMs` has always been. */
export function passJitterMs(jitterMs: number, random: () => number = Math.random): number {
  if (!(jitterMs > 0)) return 0;
  return Math.floor(random() * (jitterMs + 1));
}

export interface PacingKindStats {
  kind: DwellKind;
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
}

export interface PacingSummary {
  /** Configured dwell, as the run resolved it. */
  dwellMs: number;
  dwellJitterRatio: number;
  /** Configured `load.jitterMs`, on load runs. */
  passJitterMs?: number;
  byKind: PacingKindStats[];
}

interface KindTotals {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
}

const KIND_ORDER: readonly DwellKind[] = ["step", "wave", "pass_jitter"];

/** Aggregates every measured pause of a run. Aggregates only: a load run would flood a per-dwell event stream. */
export class PacingCollector {
  private readonly totals = new Map<DwellKind, KindTotals>();

  record(kind: DwellKind, actualMs: number): void {
    const ms = Math.max(0, actualMs);
    const current = this.totals.get(kind);
    if (!current) {
      this.totals.set(kind, { count: 1, totalMs: ms, minMs: ms, maxMs: ms });
      return;
    }
    current.count += 1;
    current.totalMs += ms;
    current.minMs = Math.min(current.minMs, ms);
    current.maxMs = Math.max(current.maxMs, ms);
  }

  get count(): number {
    let total = 0;
    for (const item of this.totals.values()) total += item.count;
    return total;
  }

  /** The report section, or undefined when the run never paused. */
  summary(configured: { dwellMs: number; dwellJitterRatio: number; passJitterMs?: number }): PacingSummary | undefined {
    if (this.totals.size === 0) return undefined;
    const byKind = KIND_ORDER.filter((kind) => this.totals.has(kind)).map((kind) => {
      const item = this.totals.get(kind)!;
      return {
        kind,
        count: item.count,
        totalMs: item.totalMs,
        minMs: item.minMs,
        maxMs: item.maxMs,
        meanMs: Math.round(item.totalMs / item.count),
      };
    });
    return {
      dwellMs: configured.dwellMs,
      dwellJitterRatio: configured.dwellJitterRatio,
      ...(configured.passJitterMs !== undefined ? { passJitterMs: configured.passJitterMs } : {}),
      byKind,
    };
  }
}

export interface PaceOptions {
  /** Epoch ms a pause must not sleep past (the run's drain deadline). */
  deadline?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called once the pause finished, with what was actually slept. */
  onPaced?: (kind: DwellKind, actualMs: number, plannedMs: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The one place a run pauses between calls: clamps to the drain deadline, sleeps, measures, reports. */
export async function pace(kind: DwellKind, plannedMs: number, options: PaceOptions = {}): Promise<number> {
  const now = options.now ?? Date.now;
  let wait = Math.max(0, Math.round(plannedMs));
  if (options.deadline !== undefined) wait = Math.min(wait, Math.max(0, options.deadline - now()));
  if (wait <= 0) return 0;
  const startedAt = now();
  await (options.sleep ?? defaultSleep)(wait);
  const actualMs = Math.max(0, now() - startedAt);
  options.onPaced?.(kind, actualMs, wait);
  return actualMs;
}
