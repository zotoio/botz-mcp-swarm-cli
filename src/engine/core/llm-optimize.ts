import { requestInference } from "./tool-evals.js";
import { randomUUID } from "node:crypto";
import type { ToolDescriptor } from "./tool-args.js";
import { suggestDescriptionOptimization, type OptimizeSuggestion } from "./discovery.js";
import { inferenceLimits, resolveInferenceConfig } from "./inference-model.js";

export interface OptimizeHistoryEntry {
  id: string;
  createdAt: string;
  toolName: string;
  before: string;
  after: string;
  rationale: string[];
  benchDelta: { p95BeforeMs: number; p95AfterMs: number; errorRateBefore: number; errorRateAfter: number };
  status: "draft" | "accepted" | "rejected";
  source: "llm" | "heuristic";
  principal?: string;
  mutationResult?: {
    applied: boolean;
    reason: string;
    appliedAt?: string;
  };
}

export async function generateDescriptionProposal(
  tool: ToolDescriptor,
): Promise<OptimizeSuggestion & { source: "llm" | "heuristic" }> {
  const heuristic = suggestDescriptionOptimization(tool);
  try {
    const config = resolveInferenceConfig();
    if (!config.apiKey) return { ...heuristic, source: "heuristic" };
    const schemaHint = JSON.stringify(tool.inputSchema?.properties ?? {});
    const model = config.model;
    const data = (await requestInference({
        model,
        ...inferenceLimits(model, 300),
        messages: [
          {
            role: "system",
            content:
              "Rewrite MCP tool descriptions for clarity and bench stability. Output JSON: {\"description\":\"...\",\"rationale\":[\"...\"]}",
          },
          {
            role: "user",
            content: `Tool: ${tool.name}\nSchema: ${schemaHint}\nCurrent: ${tool.name}`,
          },
        ],
        response_format: { type: "json_object" },
    })) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { ...heuristic, source: "heuristic" };
    const parsed = JSON.parse(content) as { description?: string; rationale?: string[] };
    return {
      toolName: tool.name,
      before: tool.name,
      after: parsed.description ?? heuristic.after,
      rationale: parsed.rationale ?? heuristic.rationale,
      status: "draft",
      source: "llm",
    };
  } catch {
    return { ...heuristic, source: "heuristic" };
  }
}

export async function runAbBench(
  _toolName: string,
  p95Before: number,
  p95After: number,
  errBefore = 0,
  errAfter = 0,
): Promise<OptimizeHistoryEntry["benchDelta"]> {
  return {
    p95BeforeMs: p95Before,
    p95AfterMs: p95After,
    errorRateBefore: errBefore,
    errorRateAfter: errAfter,
  };
}

export function createOptimizeHistoryEntry(
  suggestion: OptimizeSuggestion & { source?: "llm" | "heuristic" },
  benchDelta: OptimizeHistoryEntry["benchDelta"],
  principal?: string,
): OptimizeHistoryEntry {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    toolName: suggestion.toolName,
    before: suggestion.before,
    after: suggestion.after,
    rationale: suggestion.rationale,
    benchDelta,
    status: suggestion.status,
    source: suggestion.source ?? "heuristic",
    principal,
  };
}
