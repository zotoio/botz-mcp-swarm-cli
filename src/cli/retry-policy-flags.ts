import type { Manifest } from "../engine/types/manifest.js";

const MAX_UNAVAILABLE_BUDGET_MS = 90_000;

/** Validate `--unavailable-retry-budget-ms` (platform engine default is 90s per step). */
export function parseUnavailableRetryBudgetMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") throw new Error("unavailable-retry-budget-ms must be a positive integer");
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
    throw new Error("unavailable-retry-budget-ms must be a non-negative integer");
  }
  const n = Number(trimmed);
  if (n < 0) throw new Error("unavailable-retry-budget-ms must be a non-negative integer");
  if (n > MAX_UNAVAILABLE_BUDGET_MS) {
    throw new Error(`unavailable-retry-budget-ms cannot exceed ${MAX_UNAVAILABLE_BUDGET_MS} (90s per step)`);
  }
  return n;
}

/** Overlay unavailable / gateway retry budget onto a manifest before run. */
export function mergeUnavailableRetryBudget(manifest: Manifest, unavailableBudgetMs: number | undefined): Manifest {
  if (unavailableBudgetMs === undefined) return manifest;
  const patch = { unavailableBudgetMs } as const;
  return {
    ...manifest,
    retry: { ...(manifest.retry ?? {}), ...patch },
    load: {
      ...manifest.load,
      retry: { ...(manifest.load?.retry ?? {}), ...patch },
    },
  } as Manifest;
}
