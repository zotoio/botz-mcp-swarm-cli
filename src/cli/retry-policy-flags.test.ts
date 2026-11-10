import { describe, expect, it } from "vitest";
import { mergeUnavailableRetryBudget, parseUnavailableRetryBudgetMs } from "./retry-policy-flags.js";
import type { Manifest } from "../engine/types/manifest.js";

describe("retry-policy-flags", () => {
  it("parses and caps unavailable retry budget", () => {
    expect(parseUnavailableRetryBudgetMs("30000")).toBe(30_000);
    expect(() => parseUnavailableRetryBudgetMs("90001")).toThrow(/90/);
  });

  it("merges budget into manifest retry blocks", () => {
    const base = { name: "t", target: { transport: "stdio" as const, command: "x" }, allowlist: [], nodes: [], load: { durationMs: 1, maxConcurrency: 1, iterations: 1 } } as Manifest;
    const next = mergeUnavailableRetryBudget(base, 45_000);
    expect(next.retry?.unavailableBudgetMs).toBe(45_000);
    expect(next.load.retry?.unavailableBudgetMs).toBe(45_000);
  });
});
