import { describe, expect, it } from "vitest";
import { callSloFailures, toleratedStepIds } from "./call-slo.js";

const samples = (n: number, failed: number) => Array.from({ length: n }, (_, i) => ({ nodeId: "a", toolName: "t", latencyMs: 5, failed: i < failed }));

describe("step maxFailedCalls", () => {
  it("absorbs a blip within the allowance and fails beyond it", () => {
    const steps = [{ nodeId: "a", label: "A", tool: "t", slo: { maxFailedCalls: 1 } }];
    expect(callSloFailures({ steps, samples: samples(10, 1) })).toEqual([]);
    expect([...toleratedStepIds({ steps, samples: samples(10, 1) })]).toEqual(["a"]);
    expect(callSloFailures({ steps, samples: samples(10, 2) }).length).toBeGreaterThan(0);
    expect(toleratedStepIds({ steps, samples: samples(10, 2) }).size).toBe(0);
  });
  it("default (unset) keeps failing on any error", () => {
    expect(callSloFailures({ steps: [{ nodeId: "a", label: "A", tool: "t" }], samples: samples(10, 1) }).length).toBeGreaterThan(0);
  });
});
