import { describe, it, expect } from "vitest";
import { sampleArgsForTool } from "@zotoio/botz-mcp-swarm-engine/core/tool-args.js";

describe("sampleArgsForTool", () => {
  it("provides message for echo tool", () => {
    const args = sampleArgsForTool({
      name: "echo",
      inputSchema: { properties: { message: { type: "string" } } },
    });
    expect(args.message).toBe("swarm-record-fixture");
  });

  it("provides a and b for add tool", () => {
    const args = sampleArgsForTool({
      name: "add",
      inputSchema: {
        properties: { a: { type: "number" }, b: { type: "number" } },
      },
    });
    expect(args).toEqual({ a: 1, b: 2 });
  });

  it("fills required arrays with one item when the schema sets no minItems (Parallel web_search)", () => {
    const args = sampleArgsForTool({
      name: "web_search",
      inputSchema: {
        type: "object",
        required: ["objective", "search_queries"],
        properties: {
          objective: { type: "string" },
          search_queries: { type: "array", items: { type: "string" } },
        },
      },
    });
    expect(args.search_queries).toEqual(["fixture"]);
  });

  it("honours minItems and a maxItems cap for arrays", () => {
    const sample = (items: Record<string, unknown>) =>
      sampleArgsForTool({ name: "t", inputSchema: { type: "object", required: ["xs"], properties: { xs: { type: "array", items: { type: "integer" }, ...items } } } }).xs;
    expect(sample({ minItems: 3 })).toEqual([0, 0, 0]);
    expect(sample({ maxItems: 0 })).toEqual([]);
  });
});
