/** Conservative starting load; drain is a grace allowance, not a mandatory wait. */
export const DEFAULT_LOAD_PROFILE = Object.freeze({
  durationMs: 30_000,
  rampUpMs: 5_000,
  maxConcurrency: 1,
  jitterMs: 100,
  rampDownMs: 60_000,
  dwellMs: 100,
  iterations: 1,
  lanes: 1,
});

export type RampDownStrategy = "graceful" | "immediate";

/** Graceful ramp-down retires VUs across the window; immediate stops every VU at hold end (pre-0.11 behaviour). */
export const DEFAULT_RAMP_DOWN = Object.freeze({
  strategy: "graceful" as RampDownStrategy,
  /** Extra grace after the ramp-down window before in-flight passes are cancelled. */
  drainTimeoutMs: 0,
});
