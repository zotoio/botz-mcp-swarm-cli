import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jitteredDwellMs,
  pace,
  PacingCollector,
  passJitterMs,
  resolveDwellJitterRatio,
} from "./dwell.js";

describe("jittered dwell maths", () => {
  it("is symmetric and mean-preserving around the configured dwell", () => {
    expect(jitteredDwellMs(100, 0.2, () => 0)).toBe(80);
    expect(jitteredDwellMs(100, 0.2, () => 0.5)).toBe(100);
    expect(jitteredDwellMs(100, 0.2, () => 1)).toBe(120);
    expect(jitteredDwellMs(100, 1, () => 0)).toBe(0);
    expect(jitteredDwellMs(100, 1, () => 1)).toBe(200);
  });

  it("stays inside [d(1-r), d(1+r)] and averages d over many draws", () => {
    let seed = 1;
    // Deterministic pseudo-random so the mean assertion cannot flake.
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const draws = Array.from({ length: 5000 }, () => jitteredDwellMs(250, 0.4, random));
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(150);
    expect(Math.max(...draws)).toBeLessThanOrEqual(350);
    const mean = draws.reduce((sum, value) => sum + value, 0) / draws.length;
    expect(Math.abs(mean - 250)).toBeLessThan(5);
  });

  it("keeps the old behaviour at ratio 0, and no dwell at all at dwellMs 0", () => {
    expect(jitteredDwellMs(120, 0, () => 0)).toBe(120);
    expect(jitteredDwellMs(120, 0, () => 1)).toBe(120);
    expect(jitteredDwellMs(0, 0.5, () => 1)).toBe(0);
    expect(jitteredDwellMs(0, 0, () => 0.5)).toBe(0);
  });

  it("clamps a configured ratio into 0..1 and falls back on nonsense", () => {
    expect(resolveDwellJitterRatio(undefined)).toBe(0.2);
    expect(resolveDwellJitterRatio(null, 0.5)).toBe(0.5);
    expect(resolveDwellJitterRatio(2)).toBe(1);
    expect(resolveDwellJitterRatio(-1)).toBe(0);
    expect(resolveDwellJitterRatio(Number.NaN, 0.3)).toBe(0.3);
  });

  it("keeps pass jitter uniform in 0..jitterMs", () => {
    expect(passJitterMs(100, () => 0)).toBe(0);
    expect(passJitterMs(100, () => 0.999)).toBe(100);
    expect(passJitterMs(0, () => 0.5)).toBe(0);
  });
});

describe("pace", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sleeps the planned pause and reports what it slept", async () => {
    const onPaced = vi.fn();
    const promise = pace("step", 250, { onPaced });
    await vi.advanceTimersByTimeAsync(250);
    await expect(promise).resolves.toBe(250);
    expect(onPaced).toHaveBeenCalledWith("step", 250, 250);
  });

  it("never sleeps past the drain deadline", async () => {
    const onPaced = vi.fn();
    const promise = pace("wave", 5000, { deadline: Date.now() + 100, onPaced });
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBe(100);
    expect(onPaced).toHaveBeenCalledWith("wave", 100, 100);
  });

  it("does not sleep at all once the deadline has passed", async () => {
    const onPaced = vi.fn();
    await expect(pace("step", 500, { deadline: Date.now() - 1, onPaced })).resolves.toBe(0);
    expect(onPaced).not.toHaveBeenCalled();
  });
});

describe("PacingCollector", () => {
  it("aggregates per kind and reports the configured pacing", () => {
    const collector = new PacingCollector();
    collector.record("step", 80);
    collector.record("step", 120);
    collector.record("step", 100);
    collector.record("pass_jitter", 40);
    expect(collector.count).toBe(4);
    expect(collector.summary({ dwellMs: 100, dwellJitterRatio: 0.2, passJitterMs: 100 })).toEqual({
      dwellMs: 100,
      dwellJitterRatio: 0.2,
      passJitterMs: 100,
      byKind: [
        { kind: "step", count: 3, totalMs: 300, minMs: 80, maxMs: 120, meanMs: 100 },
        { kind: "pass_jitter", count: 1, totalMs: 40, minMs: 40, maxMs: 40, meanMs: 40 },
      ],
    });
  });

  it("has no summary when the run never paused", () => {
    expect(new PacingCollector().summary({ dwellMs: 0, dwellJitterRatio: 0.2 })).toBeUndefined();
  });
});
