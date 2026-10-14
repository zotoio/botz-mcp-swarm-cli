import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpCallResult } from "../adapters/base.js";
import type { ToolDescriptor } from "./tool-args.js";

const requestInference = vi.fn();
const resolveInferenceConfig = vi.fn();

vi.mock("./tool-evals.js", () => ({ requestInference: (body: unknown) => requestInference(body) }));
vi.mock("./inference-model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inference-model.js")>()),
  resolveInferenceConfig: () => resolveInferenceConfig(),
}));

const { suggestDescriptionOptimization } = await import("./discovery.js");
const { createOptimizeHistoryEntry, findToolDescriptor, generateDescriptionProposal } = await import("./llm-optimize.js");

const searchDocs: ToolDescriptor = {
  name: "search_docs",
  description: "search",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text to search for" },
      limit: { type: "integer" },
    },
    required: ["query"],
  },
};

function page(tools: ToolDescriptor[], nextCursor?: string): McpCallResult {
  return { success: true, latencyMs: 1, result: { tools, nextCursor } } as McpCallResult;
}

describe("suggestDescriptionOptimization", () => {
  it("uses the tool description, not the tool name, as before", () => {
    const suggestion = suggestDescriptionOptimization(searchDocs);
    expect(suggestion.before).toBe("search");
    expect(suggestion.rationale.join("\n")).toContain("Description is 6 characters");
    expect(suggestion.rationale.join("\n")).toContain("Parameters without schema descriptions: limit");
  });

  it("drafts from the description and parameter descriptions when the description is short", () => {
    expect(suggestDescriptionOptimization(searchDocs).after).toBe(
      "search. Inputs: query (string, required): Text to search for; limit (integer, optional).",
    );
  });

  it("reports a missing description and drafts from the tool name", () => {
    const suggestion = suggestDescriptionOptimization({ name: "listOpenIssues" });
    expect(suggestion.before).toBe("");
    expect(suggestion.after).toBe("List open issues.");
    expect(suggestion.rationale[0]).toContain("No description");
  });

  it("keeps an adequate description and flags required parameters it does not mention", () => {
    const description = "Searches the product documentation and returns the top matching pages with titles and URLs.";
    const suggestion = suggestDescriptionOptimization({ ...searchDocs, description });
    expect(suggestion.after).toBe(description);
    expect(suggestion.rationale).toContain("Required parameters not mentioned in the description: query");
  });

  it("reports no issues for a well-documented tool", () => {
    const suggestion = suggestDescriptionOptimization({
      name: "search_docs",
      description: "Searches the documentation for query and returns matching pages with titles and URLs.",
      inputSchema: { properties: { query: { type: "string", description: "Text to search for" } }, required: ["query"] },
    });
    expect(suggestion.rationale).toEqual(["No heuristic issues found; configure an inference provider for a model rewrite"]);
  });
});

describe("generateDescriptionProposal", () => {
  beforeEach(() => {
    requestInference.mockReset();
    resolveInferenceConfig.mockReset();
  });

  it("falls back to the heuristic without an inference key", async () => {
    resolveInferenceConfig.mockReturnValue({ apiKey: "", model: "m" });
    const proposal = await generateDescriptionProposal(searchDocs);
    expect(proposal.source).toBe("heuristic");
    expect(proposal.before).toBe("search");
    expect(requestInference).not.toHaveBeenCalled();
  });

  it("sends the current description and property descriptions to the model", async () => {
    resolveInferenceConfig.mockReturnValue({ apiKey: "k", model: "m" });
    requestInference.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ description: "Search the docs by query.", rationale: ["clearer"] }) } }],
    });
    const proposal = await generateDescriptionProposal(searchDocs);
    expect(proposal).toMatchObject({ source: "llm", before: "search", after: "Search the docs by query.", rationale: ["clearer"] });
    const body = requestInference.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    const input = JSON.parse(body.messages[1].content) as { name: string; description: string; inputSchema: unknown };
    expect(input).toMatchObject({ name: "search_docs", description: "search", inputSchema: searchDocs.inputSchema });
  });

  it("falls back to the heuristic when the model returns no description", async () => {
    resolveInferenceConfig.mockReturnValue({ apiKey: "k", model: "m" });
    requestInference.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ description: " " }) } }] });
    expect((await generateDescriptionProposal(searchDocs)).source).toBe("heuristic");
  });
});

describe("findToolDescriptor", () => {
  it("follows pagination and never calls tools", async () => {
    const callTool = vi.fn();
    const listTools = vi.fn(async (cursor?: string) =>
      cursor === "p2" ? page([searchDocs]) : page([{ name: "delete_record" }], "p2"),
    );
    const found = await findToolDescriptor({ listTools, callTool } as never, "search_docs");
    expect(found.tool).toEqual(searchDocs);
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("returns the available names when the tool is missing", async () => {
    const found = await findToolDescriptor({ listTools: async () => page([searchDocs]) }, "echo");
    expect(found).toEqual({ tool: undefined, names: ["search_docs"] });
  });

  it("throws when tools/list fails", async () => {
    const listTools = async () => ({ success: false, latencyMs: 1, errorMessage: "boom" }) as McpCallResult;
    await expect(findToolDescriptor({ listTools }, "x")).rejects.toThrow("tools/list failed: boom");
  });
});

describe("createOptimizeHistoryEntry", () => {
  it("records no latency bench", () => {
    const entry = createOptimizeHistoryEntry({ ...suggestDescriptionOptimization(searchDocs), source: "heuristic" }, "me");
    expect(entry).toMatchObject({ toolName: "search_docs", before: "search", source: "heuristic", principal: "me" });
    expect(entry).not.toHaveProperty("benchDelta");
  });
});
