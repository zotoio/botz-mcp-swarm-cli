import { describe, expect, it } from "vitest";
import { exclusiveActiveNode } from "@zotoio/botz-mcp-swarm-engine/core/node-log.js";

describe("per-step server log", () => {
  it("gives a line to the one step that is running", () => {
    expect(exclusiveActiveNode(["echo"])).toBe("echo");
  });

  it("keeps a line off every card when two steps are in flight", () => {
    expect(exclusiveActiveNode(["echo", "ping"])).toBe("");
    expect(exclusiveActiveNode([])).toBe("");
  });
});
