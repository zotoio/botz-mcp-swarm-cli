import { describe, expect, it } from "vitest";
import { planErrors } from "@zotoio/botz-mcp-swarm-engine/core/error-plan.js";

describe("error action plan", () => {
  it("turns a fail reason and a log line into one action each", () => {
    const plan = planErrors({
      failReasons: [
        "Tool echo error_rate 0.400 exceeds max 0.1",
        "Silent green: traffic intended but no pass/fail scenario outcomes recorded",
      ],
      log: ["12:04:01.123  mcp.tool.call.errors  tool=echo error_class=timeout"],
    });
    expect(plan.map((item) => item.cause)).toEqual([
      "A tool's error rate is over the suite limit.",
      "The run intended traffic and recorded no pass or fail.",
      "A call exceeded its time limit.",
    ]);
    expect(plan[0]?.action).toContain("error class");
    expect(plan[2]?.evidence).toContain("error_class=timeout");
    expect(plan[2]?.tool).toBe("echo");
  });

  it("keeps a passing run free of actions", () => {
    expect(planErrors({
      failReasons: [],
      log: [
        "12:04:01.401  mcp.step  node=echo phase=done result=ok latencyMs=401",
      ],
    })).toEqual([]);
  });

  it("treats a fetch failure as a reachability problem", () => {
    const plan = planErrors({
      failReasons: ["Scenario Smoke error: fetch failed"],
    });
    expect(plan.map((item) => item.cause)).toEqual([
      "The swarm could not reach the server.",
    ]);
    expect(plan[0]?.evidence).toContain("fetch failed");
  });

  it("keeps a warm-up line on the warm-up action", () => {
    const plan = planErrors({
      failReasons: [
        "Session warm-up failed: fetch failed",
        "Scenario Smoke error: fetch failed",
      ],
    });
    expect(plan.map((item) => item.cause)).toEqual([
      "The suite could not open a session, so no step ran.",
      "The swarm could not reach the server.",
    ]);
    expect(plan[1]?.evidence).toContain("Scenario Smoke error");
  });

  it("explains a ramp-down deadline without blaming a step", () => {
    const plan = planErrors({
      failReasons: ["Scenario Smoke fail: ramp-down deadline"],
    });
    expect(plan.map((item) => item.cause)).toEqual([
      "The suite was still running when ramp-down ended.",
    ]);
  });

  it("mentions each cause once", () => {
    const plan = planErrors({
      log: [
        "12:01:00.000  stderr  connect ECONNREFUSED 127.0.0.1:9",
        "12:01:01.000  mcp.rpc.duration  method=initialize result=transport",
      ],
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]?.action).toContain("command or URL");
  });
});
