import { describe, expect, it } from "vitest";
import { buildDefaultSuiteNodes, compileSuite, defaultLoadProfile, type SuiteNode } from "./suite-model.js";
import {
  connectData,
  connectEntry,
  connectFlow,
  deriveEdges,
  disconnectData,
  frameAtPoint,
  layoutSuite,
  executionEdges,
  layoutSuiteFan,
  liftToRoot,
  nestInFrame,
  hasCustomLayout,
  resetSuiteLayout,
  resolvePositions,
  runOrder,
  smartColumnsForSuite,
  tidyPositions,
} from "@zotoio/botz-mcp-swarm-engine/core/suite-graph.js";

function step(id: string, extra: Partial<SuiteNode> = {}): SuiteNode {
  return { id, type: "sampler", enabled: true, label: id, method: "ping", ...extra };
}

function ids(nodes: SuiteNode[]): string[] {
  return nodes.map((node) => node.id);
}

describe("suite graph", () => {
  it("chains siblings and enters the first step of a frame", () => {
    const nodes: SuiteNode[] = [
      {
        id: "group",
        type: "group",
        enabled: true,
        label: "Contract",
        children: [step("init"), step("ping")],
      },
    ];
    expect(deriveEdges(nodes)).toEqual([
      { kind: "entry", source: "group", target: "init" },
      { kind: "flow", source: "init", target: "ping" },
    ]);
    expect([...runOrder(nodes).entries()]).toEqual([["init", 1], ["ping", 2]]);
  });

  it("moves a step to run immediately after the source", () => {
    const next = connectFlow([step("a"), step("b"), step("c")], "a", "c");
    expect(next.applied).toBe(true);
    expect(ids(next.nodes)).toEqual(["a", "c", "b"]);
    expect(connectFlow(next.nodes, "a", "c").applied).toBe(false);
  });

  it("pulls a step into the source frame and refuses to nest a frame inside itself", () => {
    const group: SuiteNode = { id: "group", type: "group", enabled: true, label: "Group", children: [step("a")] };
    const nested = connectFlow([step("b"), group], "a", "b");
    expect(ids(nested.nodes)).toEqual(["group"]);
    expect(ids(nested.nodes[0]?.children ?? [])).toEqual(["a", "b"]);

    const cycle = connectFlow(nested.nodes, "a", "group");
    expect(cycle.applied).toBe(false);
    expect(cycle.error).toMatch(/frame/);
    expect(ids(cycle.nodes)).toEqual(["group"]);
  });

  it("makes the wired step the first one inside the frame", () => {
    const group: SuiteNode = { id: "group", type: "group", enabled: true, label: "Group", children: [step("a")] };
    const next = connectEntry([step("b"), group], "group", "b");
    expect(ids(next.nodes)).toEqual(["group"]);
    expect(ids(next.nodes[0]?.children ?? [])).toEqual(["b", "a"]);
  });

  it("drops a step into a frame and lifts it back out", () => {
    const group: SuiteNode = {
      id: "group",
      type: "group",
      enabled: true,
      label: "Group",
      children: [],
      layout: { x: 10, y: 10 },
    };
    const placed = step("call", { layout: { x: 400, y: 40 } });
    const nested = nestInFrame([placed, group], "group", "call");
    expect(nested.nodes[0]?.children?.[0]?.layout).toBeUndefined();
    const lifted = liftToRoot(nested.nodes, "call");
    expect(ids(lifted.nodes)).toEqual(["group", "call"]);
    expect(lifted.nodes[1]?.layout).toBeUndefined();
  });

  it("draws a data wire from an extractor and writes the placeholder into arguments", () => {
    const extractor: SuiteNode = {
      id: "extract",
      type: "extractor",
      enabled: true,
      label: "Token",
      variable: "token",
      path: "result.token",
    };
    const call = step("call", { method: "tools/call", tool: "echo", prompt: "send ${token}" });
    expect(deriveEdges([extractor, call]).filter((edge) => edge.kind === "data")).toEqual([
      { kind: "data", source: "extract", target: "call", variable: "token" },
    ]);

    const bound = connectData([extractor, step("other")], "extract", "other");
    expect(bound.nodes[1]?.args).toEqual({ token: "${token}" });
    const kept = disconnectData(bound.nodes, "extract", "call");
    expect(kept.applied).toBe(false);

    const removed = disconnectData(bound.nodes, "extract", "other");
    expect(removed.applied).toBe(true);
    expect(removed.nodes[1]?.args).toEqual({});
    expect(deriveEdges(removed.nodes).some((edge) => edge.kind === "data")).toBe(false);
  });

  it("keeps the data wire when the placeholder remains outside the argument binding", () => {
    const extractor: SuiteNode = {
      id: "extract",
      type: "extractor",
      enabled: true,
      variable: "token",
      path: "result.token",
    };
    const call = step("call", { prompt: "send ${token}", args: { token: "${token}" } });
    const next = disconnectData([extractor, call], "extract", "call");
    expect(next.applied).toBe(true);
    expect(next.error).toMatch(/still written/);
    expect(next.nodes[1]?.args).toEqual({});
    expect(deriveEdges(next.nodes).some((edge) => edge.kind === "data" && edge.target === "call")).toBe(true);
  });

  it("fills four downward lanes, then wraps the next batch", () => {
    const nodes = ["a", "b", "c", "d", "e", "f"].map((id) => step(id));
    const positions = resolvePositions(nodes);
    expect(positions.get("a")).toEqual({ x: 0, y: 0 });
    expect(positions.get("b")?.y).toBe(0);
    expect(positions.get("d")?.y).toBe(0);
    expect(positions.get("b")?.x).toBeGreaterThan(0);
    expect(positions.get("e")?.x).toBe(0);
    expect(positions.get("e")?.y).toBeGreaterThan(0);
    expect(positions.get("f")?.y).toBe(positions.get("e")?.y);
  });

  it("places untidy cards on a grid and keeps a stored position", () => {
    const nodes = [step("a"), step("b", { layout: { x: 12, y: 18 } })];
    const positions = resolvePositions(nodes);
    expect(positions.get("a")).toEqual({ x: 0, y: 0 });
    expect(positions.get("b")).toEqual({ x: 12, y: 18 });
    expect(nodes[0]?.layout).toBeUndefined();

    const tidy = tidyPositions(nodes);
    expect(tidy[1]?.layout).not.toEqual({ x: 12, y: 18 });
    expect(tidyPositions(tidy)).toEqual(tidy);
  });

  it("finds the frame under a canvas point and still compiles positioned steps", () => {
    const group: SuiteNode = { id: "group", type: "group", enabled: true, label: "Contract", children: [step("ping")] };
    const tidy = tidyPositions([group]);
    const hit = frameAtPoint(tidy, { x: 30, y: 60 });
    expect(hit?.id).toBe("group");

    const manifest = compileSuite({
      name: "smoke",
      target: { transport: "stdio", command: "mock-server/run.sh" },
      allowlist: ["stdio"],
      load: defaultLoadProfile(),
      nodes: tidyPositions(buildDefaultSuiteNodes([])),
    });
    expect(manifest.scenarios[0]?.steps.map((item) => item.method)).toContain("initialize");
    expect(manifest.scenarios[0]?.steps.map((item) => item.method)).toContain("teardown");
  });

  it("lays cards out in absolute coordinates with entry and run-order wires", () => {
    const laid = layoutSuite([
      {
        id: "group",
        type: "group",
        enabled: true,
        label: "Contract",
        children: [step("init"), step("pause", { type: "think", thinkMs: 250, label: "Dwell" })],
      },
    ]);
    const group = laid.cards.find((card) => card.id === "group");
    const init = laid.cards.find((card) => card.id === "init");
    const pause = laid.cards.find((card) => card.id === "pause");
    expect(group?.frame).toBe(true);
    expect(init && group && init.x).toBeGreaterThan(group?.x ?? 0);
    expect(init && group && init.y).toBeGreaterThan(group?.y ?? 0);
    expect(pause?.detail).toBe("250 ms pause");
    expect(laid.wires.some((wire) => wire.kind === "entry" && wire.d.startsWith("M"))).toBe(true);
    expect(laid.wires.some((wire) => wire.kind === "flow" && wire.source === "init" && wire.target === "pause")).toBe(true);
    expect(laid.width).toBeGreaterThan(group?.width ?? 0);
  });

  it("lays an introspected run downward in four lanes, with the same drawing on both views", () => {
    const nodes: SuiteNode[] = [
      {
        id: "group",
        type: "group",
        enabled: true,
        label: "Contract",
        children: [
          step("init", { method: "initialize", label: "Initialize" }),
          step("a", { method: "tools/call", tool: "a" }),
          step("b", { method: "tools/call", tool: "b" }),
          step("c", { method: "tools/call", tool: "c" }),
          step("end", { method: "teardown", label: "Teardown" }),
        ],
      },
    ];
    const laid = layoutSuite(nodes);
    const fan = layoutSuiteFan(nodes);
    expect(fan.cards.map((card) => [card.id, card.x, card.y])).toEqual(laid.cards.map((card) => [card.id, card.x, card.y]));
    expect(fan.wires.map((wire) => [wire.kind, wire.source, wire.target])).toEqual(
      laid.wires.map((wire) => [wire.kind, wire.source, wire.target]),
    );
    const init = laid.cards.find((card) => card.id === "init");
    const left = laid.cards.find((card) => card.id === "a");
    const right = laid.cards.find((card) => card.id === "c");
    const end = laid.cards.find((card) => card.id === "end");
    expect(left && init && left.y).toBeGreaterThan(init.y);
    expect(right && left && right.y).toBe(left.y);
    expect(right && left && right.x).toBeGreaterThan(left.x);
    expect(end && left && end.y).toBeGreaterThan(left.y);
    const flow = laid.wires.filter((wire) => wire.kind === "flow");
    expect(flow.some((wire) => wire.source === "a" && wire.target === "b")).toBe(false);
    expect(flow.filter((wire) => wire.source === "init").map((wire) => wire.target).sort()).toEqual(["a", "b", "c"]);
    expect(flow.filter((wire) => wire.target === "end").map((wire) => wire.source).sort()).toEqual(["a", "b", "c"]);
    expect(executionEdges(nodes).some((edge) => edge.kind === "entry" && edge.target === "init")).toBe(true);
  });

  it("stores that lane layout on a suite built from a tool catalogue", () => {
    const arranged = tidyPositions(buildDefaultSuiteNodes([
      { name: "echo", schemaHash: "a", writeLike: false },
      { name: "other", schemaHash: "b", writeLike: false },
    ]));
    const children = arranged[0]?.children ?? [];
    const init = children.find((node) => node.method === "initialize");
    const echo = children.find((node) => node.tool === "echo");
    const other = children.find((node) => node.tool === "other");
    const end = children.find((node) => node.method === "teardown");
    expect(echo?.layout?.y).toBe(other?.layout?.y);
    expect(echo?.layout && init?.layout && echo.layout.y).toBeGreaterThan(init.layout.y);
    expect(echo?.layout && other?.layout && echo.layout.x).not.toBe(other.layout.x);
    expect(end?.layout && echo?.layout && end.layout.y).toBeGreaterThan(echo.layout.y);
  });

  it("draws a frame stored above the origin, including a step that has no position", () => {
    const nodes: SuiteNode[] = [{
      id: "group",
      type: "group",
      enabled: true,
      label: "Contract",
      layout: { x: 40, y: -800 },
      children: [
        step("init", { layout: { x: 28, y: 112 } }),
        step("ping", { layout: { x: 28, y: 320 } }),
        step("extra"),
      ],
    }];
    const laid = layoutSuite(nodes, 1);
    for (const card of laid.cards) {
      expect(card.y).toBeGreaterThanOrEqual(0);
      expect(card.x).toBeGreaterThanOrEqual(0);
      expect(card.y + card.height).toBeLessThanOrEqual(laid.height);
      expect(card.x + card.width).toBeLessThanOrEqual(laid.width);
    }
    const extra = laid.cards.find((card) => card.id === "extra");
    const ping = laid.cards.find((card) => card.id === "ping");
    const init = laid.cards.find((card) => card.id === "init");
    expect(extra && ping && init).toBeTruthy();
    expect(extra!.y).toBeGreaterThanOrEqual(init!.y);
    expect(extra!.y - ping!.y).toBeLessThan(500);
  });

  it("computes balanced viewport-aware columns and resets custom dragged layout to default", () => {
    const tools = Array.from({ length: 12 }, (_, i) => ({ name: `tool_${i + 1}`, schemaHash: `h${i}`, writeLike: false }));
    const suiteNodes = buildDefaultSuiteNodes(tools);
    // When lanes is 1 (the default LoadProfile.lanes), smartColumnsForSuite chooses a multi-column grid (>= 3 columns)
    const cols = smartColumnsForSuite(suiteNodes, { lanes: 1, canvasWidth: 1280, canvasHeight: 720 });
    expect(cols).toBeGreaterThanOrEqual(3);
    expect(cols).toBeLessThanOrEqual(6);

    // Explicit lanes > 1 are respected
    expect(smartColumnsForSuite(suiteNodes, { lanes: 5 })).toBe(5);

    // Drag a node far off-canvas, verify hasCustomLayout, then resetSuiteLayout restores a compact grid
    const dragged = structuredClone(suiteNodes);
    dragged[0]!.children![2]!.layout = { x: 4200, y: 3100 };
    expect(hasCustomLayout(dragged)).toBe(true);

    const reset = resetSuiteLayout(dragged, { lanes: 1, canvasWidth: 1280, canvasHeight: 720 });
    expect(reset[0]!.children![2]!.layout?.x).toBeLessThan(1800);
    expect(reset[0]!.children![2]!.layout?.y).toBeLessThan(1200);
    // Multiple columns used in the reset layout
    const uniqueX = new Set((reset[0]!.children ?? []).map((c) => c.layout?.x));
    expect(uniqueX.size).toBeGreaterThanOrEqual(3);
  });
});
