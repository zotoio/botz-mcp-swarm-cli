import { describe, expect, it } from "vitest";
import { compareSuiteToSurface } from "@zotoio/botz-mcp-swarm-engine/core/suite-compatibility.js";
import { buildDefaultSuiteNodes, type ServerSurface, type SuiteNode } from "./suite-model.js";

const echo = { name: "echo", schemaHash: "h1", writeLike: false };

function surface(tools = [echo]): ServerSurface {
  return {
    capabilities: ["tools"],
    tools,
    resources: [],
    resourceTemplates: [],
    prompts: [],
  };
}

describe("suite compatibility", () => {
  it("accepts the suite introspection would generate", () => {
    const current = surface();
    const report = compareSuiteToSurface(buildDefaultSuiteNodes(current), [echo], current);
    expect(report).toEqual({ compatible: true, missing: [], extra: [], schemaChanged: [] });
  });

  it("reports an enabled tool the suite does not call", () => {
    const empty = buildDefaultSuiteNodes(surface([]));
    const report = compareSuiteToSurface(empty, [], surface());
    expect(report.compatible).toBe(false);
    expect(report.missing).toContain("tools/call:echo");
  });

  it("reports a call the server no longer advertises", () => {
    const nodes = buildDefaultSuiteNodes(surface());
    const extra: SuiteNode = {
      id: "extra",
      type: "sampler",
      enabled: true,
      label: "gone",
      method: "tools/call",
      tool: "gone",
    };
    nodes[0]?.children?.push(extra);
    const report = compareSuiteToSurface(nodes, [echo], surface());
    expect(report.extra).toContain("tools/call:gone");
    expect(report.compatible).toBe(false);
  });

  it("reports a schema hash change on a called tool", () => {
    const nodes = buildDefaultSuiteNodes(surface());
    const changed = surface([{ ...echo, schemaHash: "h2" }]);
    const report = compareSuiteToSurface(nodes, [echo], changed);
    expect(report.schemaChanged).toEqual(["echo"]);
    expect(report.compatible).toBe(false);
  });
});
