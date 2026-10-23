import type { RampDownConfig } from "../engine/core/suite-model.js";

function integer(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${label} must be an integer >= 0`);
  return Number(value);
}

/** `--ramp-down-strategy` / `--drain-timeout-ms`, or undefined when neither is set. */
export function rampDownFlags(opts: { rampDownStrategy?: string; drainTimeoutMs?: string }): RampDownConfig | undefined {
  const strategy = opts.rampDownStrategy;
  if (strategy !== undefined && strategy !== "graceful" && strategy !== "immediate") {
    throw new Error("ramp-down-strategy must be graceful or immediate");
  }
  const drainTimeoutMs = integer(opts.drainTimeoutMs, "drain-timeout-ms");
  if (strategy === undefined && drainTimeoutMs === undefined) return undefined;
  return { ...(strategy ? { strategy } : {}), ...(drainTimeoutMs !== undefined ? { drainTimeoutMs } : {}) };
}
