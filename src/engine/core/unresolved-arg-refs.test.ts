import { describe, expect, it } from "vitest";
import { unresolvedArgRefs, normalizeVariableRefs } from "./server-updates.js";
import type { SuiteNode } from "./suite-model.js";

describe("unresolvedArgRefs (Smoke v88)", () => {
  const extractor = { id: "x", type: "extractor", enabled: true, variable: "agent_name", path: "matches.0.name||security-pr-reviewer@56f02c69" } as unknown as SuiteNode;
  const step = (args: Record<string, unknown>, enabled = true) => ({ id: "s", type: "sampler", enabled, label: "agent_install", method: "tools/call", tool: "agent_install", args }) as unknown as SuiteNode;

  it("flags Mustache refs and undefined ${vars}", () => {
    const refs = unresolvedArgRefs([step({ name: "{{agent_name}}", other: "${missing}" })]);
    expect(refs.map((r) => r.reason)).toEqual(["mustache", "undefined-variable"]);
  });
  it("accepts extractor-defined vars, built-ins and disabled steps", () => {
    expect(unresolvedArgRefs([extractor, step({ name: "${agent_name}", id: "${__uuid}" })])).toEqual([]);
    expect(unresolvedArgRefs([step({ name: "{{agent_name}}" }, false)])).toEqual([]);
  });
  it("normalized Mustache refs resolve once an extractor defines them", () => {
    expect(unresolvedArgRefs([extractor, step(normalizeVariableRefs({ name: "{{agent_name}}" }))])).toEqual([]);
  });
});
