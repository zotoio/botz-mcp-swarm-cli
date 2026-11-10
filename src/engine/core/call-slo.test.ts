import { describe, expect, it } from "vitest";
import { callSloFailures, effectiveCallSlo, normalizeCallSlo, toleratedStepIds } from "./call-slo.js";

describe("call objectives", () => {
  it("keeps positive durations and an error rate from 0 to 1", () => {
    expect(normalizeCallSlo({ maxP95Ms: 0, maxP99Ms: 80.2, maxErrorRate: 1.4 })).toEqual({
      maxP99Ms: 80,
      maxErrorRate: 1,
    });
    expect(normalizeCallSlo(null)).toBeUndefined();
    expect(effectiveCallSlo({ maxP95Ms: 200, maxErrorRate: 0.1 }, { maxP95Ms: 40 })).toEqual({
      maxP95Ms: 40,
      maxP99Ms: undefined,
      maxErrorRate: 0.1,
    });
  });

  it("lets a tool call replace the suite duration and error rate", () => {
    const steps = [
      { nodeId: "fast", label: "fast", tool: "echo", slo: { maxP95Ms: 40 } },
      { nodeId: "loose", label: "loose", tool: "echo", slo: { maxErrorRate: 0.5, maxP95Ms: 300 } },
    ];
    const within = callSloFailures({
      suite: { maxP95Ms: 200, maxErrorRate: 0 },
      steps,
      samples: [
        { nodeId: "fast", toolName: "echo", latencyMs: 30, failed: false },
        { nodeId: "loose", toolName: "echo", latencyMs: 250, failed: true },
        { nodeId: "loose", toolName: "echo", latencyMs: 10, failed: false },
      ],
    });
    expect(within).toEqual([]);

    const over = callSloFailures({
      suite: { maxP95Ms: 200, maxP99Ms: 300 },
      steps,
      samples: [
        { nodeId: "fast", toolName: "echo", latencyMs: 90, failed: false },
        { nodeId: "loose", toolName: "echo", latencyMs: 10, failed: true },
        { nodeId: "loose", toolName: "echo", latencyMs: 10, failed: true },
      ],
    });
    expect(over[0]).toContain("Step fast p95");
    expect(over[1]).toContain("Step loose error_rate");
    expect(over.some((line) => line.includes("p99"))).toBe(false);
  });

  it("uses the suite objective when the call has no step id", () => {
    const reasons = callSloFailures({
      suite: { maxP95Ms: 100 },
      steps: [],
      samples: [{ toolName: "echo", latencyMs: 150, failed: false }],
    });
    expect(reasons).toEqual(["Tool echo p95 150.0ms exceeds max 100ms"]);
  });

  it("maxFailedCalls absorbs a single blip on a step; default behaviour is unchanged", () => {
    const samples = [
      { nodeId: "flaky", toolName: "add", latencyMs: 5, failed: true },
      ...Array.from({ length: 9 }, () => ({ nodeId: "flaky", toolName: "add", latencyMs: 5, failed: false })),
    ];
    const strict = { steps: [{ nodeId: "flaky", label: "add" }], samples };
    expect(callSloFailures(strict)).toEqual(["Step add error_rate 0.100 exceeds max 0"]);
    expect(toleratedStepIds(strict).size).toBe(0);
    const lenient = { steps: [{ nodeId: "flaky", label: "add", slo: { maxFailedCalls: 1 } }], samples };
    expect(callSloFailures(lenient)).toEqual([]);
    expect([...toleratedStepIds(lenient)]).toEqual(["flaky"]);
    const twoBlips = { ...lenient, samples: [...samples, { nodeId: "flaky", toolName: "add", latencyMs: 5, failed: true }] };
    expect(callSloFailures(twoBlips)[0]).toContain("Step add error_rate");
  });

  it("normalizes maxFailedCalls to a positive integer", () => {
    expect(normalizeCallSlo({ maxFailedCalls: 2.7 })).toEqual({ maxFailedCalls: 2 });
    expect(normalizeCallSlo({ maxFailedCalls: 0 })).toBeUndefined();
    expect(effectiveCallSlo(undefined, undefined)).not.toHaveProperty("maxFailedCalls");
  });
});
