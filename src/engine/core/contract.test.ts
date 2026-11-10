import { describe, expect, it } from "vitest";
import { contractFailure, schemaAccepts } from "@zotoio/botz-mcp-swarm-engine/core/contract.js";
import { sampleArgsForTool } from "@zotoio/botz-mcp-swarm-engine/core/tool-args.js";

describe("MCP contract checks", () => {
  it("rejects a tool list entry whose input schema is not an object", () => {
    expect(contractFailure({ resultShape: "tools/list" }, {
      tools: [{ name: "echo", inputSchema: { type: "string" } }],
    })).toMatch(/inputSchema.type must be object/);
    expect(contractFailure({ resultShape: "tools/list" }, {
      tools: [{ name: "echo", inputSchema: { type: "object" } }],
    })).toBeNull();
  });

  it("requires structuredContent when a tool declares an output schema", () => {
    const outputSchema = {
      type: "object",
      properties: { total: { type: "number" } },
      required: ["total"],
    };
    expect(contractFailure(
      { resultShape: "tools/call", outputSchema },
      { content: [{ type: "text", text: "3" }] },
    )).toMatch(/structuredContent/);
    expect(contractFailure(
      { resultShape: "tools/call", outputSchema },
      { content: [{ type: "text", text: "3" }], structuredContent: { total: 3 } },
    )).toBeNull();
    expect(contractFailure(
      { resultShape: "tools/call", outputSchema },
      { structuredContent: { total: "nope" } },
    )).toMatch(/outputSchema/);
  });

  it("checks resource, prompt, and completion result shapes", () => {
    expect(contractFailure({ resultShape: "resources/read" }, {
      contents: [{ uri: "file:///a", text: "hi" }],
    })).toBeNull();
    expect(contractFailure({ resultShape: "resources/read" }, {
      contents: [{ uri: "file:///a", text: "hi", blob: "aa" }],
    })).toMatch(/text or blob/);
    expect(contractFailure({ resultShape: "prompts/get" }, {
      messages: [{ role: "user", content: { type: "text", text: "hi" } }],
    })).toBeNull();
    expect(contractFailure({ resultShape: "completion" }, {
      completion: { values: ["alpha"], hasMore: false },
    })).toBeNull();
    expect(contractFailure({ resultShape: "initialize" }, {
      name: "demo",
      version: "1",
      capabilities: { tools: {} },
    })).toBeNull();
    expect(contractFailure({ resultShape: "initialize" }, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "botz-mcp", version: "2.14.7" },
    })).toBeNull();
    expect(contractFailure({ resultShape: "initialize" }, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "", version: "1" },
    })).toMatch(/server name/);
    // Parallel Search MCP sends version "" (schema-valid string); a missing version still fails.
    expect(contractFailure({ resultShape: "initialize" }, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "Parallel Web Search MCP Server", version: "" },
    })).toBeNull();
    expect(contractFailure({ resultShape: "initialize" }, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "demo" },
    })).toMatch(/server version/);
  });

  it("samples arguments that satisfy required enums and minimums", () => {
    const args = sampleArgsForTool({
      name: "search",
      inputSchema: {
        type: "object",
        required: ["kind", "limit"],
        properties: {
          kind: { type: "string", enum: ["skill", "agent"] },
          limit: { type: "integer", minimum: 2, maximum: 5 },
        },
      },
    });
    expect(args).toEqual({ kind: "skill", limit: 2 });
    expect(schemaAccepts({
      type: "object",
      required: ["kind", "limit"],
      properties: {
        kind: { type: "string", enum: ["skill", "agent"] },
        limit: { type: "integer", minimum: 2, maximum: 5 },
      },
    }, args)).toBe(true);
  });
});
