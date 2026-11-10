import { afterEach, describe, expect, it, vi } from "vitest";
import * as adapters from "@zotoio/botz-mcp-swarm-engine/adapters/index.js";
import type { McpSession } from "@zotoio/botz-mcp-swarm-engine/adapters/base.js";
import { introspectServer } from "@zotoio/botz-mcp-swarm-engine/core/suite-introspect.js";
import { buildDefaultSuiteNodes } from "./suite-model.js";

const success = (result: unknown) => ({ success: true, result, latencyMs: 0, errorClass: "none" as const, bytesIn: 0, bytesOut: 0 });
const failure = () => ({ ...success({}), success: false, errorMessage: "fixture failure" });
function session(capabilities = { tools: {} } as Record<string, unknown>) {
  const s = { serverInfo: () => ({ capabilities }), close: vi.fn(async () => {}),
    listTools: vi.fn(async (_cursor?: string) => success({ tools: [] })),
    listResources: vi.fn(async () => success({ resources: [] })),
    listResourceTemplates: vi.fn(async () => success({ resourceTemplates: [] })),
    listPrompts: vi.fn(async () => success({ prompts: [] })) };
  vi.spyOn(adapters, "createSession").mockResolvedValue(s as unknown as McpSession);
  return s;
}
const capture = () => introspectServer({ transport: "stdio", command: "fixture" });
afterEach(() => vi.restoreAllMocks());
describe("complete discovery", () => {
  it("rejects failure after a successful first page and closes the session", async () => {
    const s = session();
    s.listTools.mockResolvedValueOnce(success({ tools: [{ name: "echo" }], nextCursor: "next" })).mockResolvedValueOnce(failure());
    await expect(capture()).rejects.toThrow("tools_list_failed");
    expect(s.close).toHaveBeenCalledOnce();
  });
  it("rejects cycles and the pagination limit", async () => {
    const s = session();
    s.listTools.mockResolvedValue(success({ tools: [], nextCursor: "repeat" }));
    await expect(capture()).rejects.toThrow("pagination_cycle");
    let n = 0;
    s.listTools.mockImplementation(async () => success({ tools: [], nextCursor: String(++n) }));
    await expect(capture()).rejects.toThrow("pagination_limit");
  });
  it("fails an advertised resource list instead of returning a partial surface", async () => {
    const s = session({ resources: {} });
    s.listResources.mockResolvedValue(failure());
    await expect(capture()).rejects.toThrow("resources_list_failed");
    expect(s.listTools).not.toHaveBeenCalled();
  });
  it("treats -32601 on an advertised optional list as unsupported and keeps the tools (swarm.botz.ai/mcp regression)", async () => {
    const s = session({ tools: {}, resources: {}, prompts: {} });
    s.listTools.mockResolvedValue(success({ tools: [{ name: "swarm_project_list" }] }));
    s.listResourceTemplates.mockResolvedValue({ ...failure(), errorMessage: "MCP error -32601: Method not found: resources/templates/list" });
    const surface = await capture();
    expect(surface.tools.map((t) => t.name)).toEqual(["swarm_project_list"]);
    expect(surface.resourceTemplates).toEqual([]);
    expect(surface.unsupportedMethods).toEqual(["resourceTemplates"]);
    expect(s.listPrompts).toHaveBeenCalled();
  });
  it("supports resource-only servers without a tools/list step", async () => {
    const s = session({ resources: {} });
    const surface = await capture();
    expect(s.listTools).not.toHaveBeenCalled();
    expect(JSON.stringify(buildDefaultSuiteNodes(surface))).not.toContain("tools/list");
  });
});
