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
