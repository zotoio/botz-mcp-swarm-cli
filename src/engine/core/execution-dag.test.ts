import { describe, expect, it } from "vitest";
import { dagPredecessors } from "@zotoio/botz-mcp-swarm-engine/core/execution-dag.js";
import { compileSuite, type SuiteNode } from "./suite-model.js";

function step(id: string, extra: Partial<SuiteNode> = {}): SuiteNode {
  return { id, type: "sampler", enabled: true, label: id, method: "ping", ...extra };
}

describe("execution dag", () => {
  it("fans independent calls out of initialize and joins them at teardown", () => {
    const preds = dagPredecessors([
      step("init", { method: "initialize" }),
      step("a", { method: "tools/call", tool: "a" }),
      step("b", { method: "tools/call", tool: "b" }),
      step("end", { method: "teardown" }),
    ]);
    expect(preds.get("init")).toEqual([]);
    expect(preds.get("a")).toEqual(["init"]);
    expect(preds.get("b")).toEqual(["init"]);
    expect(preds.get("end")?.sort()).toEqual(["a", "b"]);
  });

  it("keeps an extractor behind its producer and a think as a barrier", () => {
    const preds = dagPredecessors([
      step("init", { method: "initialize" }),
      step("a", { method: "tools/call", tool: "a" }),
      { id: "pull", type: "extractor", enabled: true, label: "Pull", variable: "name", path: "name" },
      step("b", { method: "tools/call", tool: "b", args: { name: "${name}" } }),
      step("c", { method: "tools/call", tool: "c" }),
      { id: "pause", type: "think", enabled: true, label: "Pause", thinkMs: 10 },
      step("d", { method: "tools/call", tool: "d" }),
    ]);
    expect(preds.get("pull")).toEqual(["a"]);
    expect(preds.get("b")?.sort()).toEqual(["init", "pull"]);
    expect(preds.get("c")).toEqual(["init"]);
    expect(preds.get("pause")?.sort()).toEqual(["a", "b", "c", "init"]);
    expect(preds.get("d")).toEqual(["pause"]);
  });

  it("compiles a loop so the next pass waits for the whole previous pass", () => {
    const manifest = compileSuite({
      name: "dag",
      target: { transport: "stdio", command: "mock-server/run.sh" },
      allowlist: ["stdio"],
      load: { durationMs: 0, rampUpMs: 0, maxConcurrency: 4, jitterMs: 0, rampDownMs: 0, dwellMs: 0, iterations: 1 },
      nodes: [
        step("init", { method: "initialize" }),
        {
          id: "loop",
          type: "loop",
          enabled: true,
          label: "Loop",
          iterations: 2,
          children: [
            step("a", { method: "tools/call", tool: "a" }),
            step("b", { method: "tools/call", tool: "b" }),
          ],
        },
        step("end", { method: "teardown" }),
      ],
    });
    const steps = manifest.scenarios[0]?.steps ?? [];
    const wait = (id: string, loopIndex: number) =>
      steps.find((item) => item.nodeId === id && item.loopIndex === loopIndex)?.waitFor ?? [];
    const index = (id: string, loopIndex?: number) =>
      steps.findIndex((item) => item.nodeId === id && item.loopIndex === loopIndex);
    expect(wait("a", 0).map((item) => steps[item]?.nodeId)).toEqual(["init"]);
    expect(wait("b", 0).map((item) => steps[item]?.nodeId)).toEqual(["init"]);
    expect(wait("a", 1).map((item) => steps[item]?.nodeId).sort()).toEqual(["a", "b", "init"]);
    expect(wait("b", 1).map((item) => steps[item]?.nodeId).sort()).toEqual(["a", "b", "init"]);
    expect(steps[index("a", 1)]?.waitFor?.includes(index("b", 1))).toBe(false);
    const end = steps.find((item) => item.nodeId === "end");
    expect(end?.waitFor?.map((item) => steps[item]?.nodeId).sort()).toEqual(["a", "b"]);
    expect(end?.waitFor?.every((item) => steps[item]?.loopIndex === 1)).toBe(true);
  });
});