import { writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createSession } from "../adapters/index.js";
import type { Manifest, Target } from "../types/manifest.js";
import { assertTargetAllowlisted } from "./allowlist.js";
import { resolveStdioTarget } from "./target-resolve.js";
import { isWriteToolName } from "./suite-model.js";
import { sampleArgsForTool, type ToolDescriptor } from "./tool-args.js";

export interface DiscoveryDraft {
  id: string;
  createdAt: string;
  status: "draft" | "approved" | "rejected";
  target: Target;
  allowlist: string[];
  tools: ToolDescriptor[];
  proposedScenarios: {
    name: string;
    steps: Array<{
      method: string;
      tool?: string;
      args?: Record<string, unknown>;
    }>;
  }[];
  readOnly: boolean;
  allowlistedToolsOnly: boolean;
}

function isWriteTool(tool: ToolDescriptor): boolean {
  return isWriteToolName(tool.name);
}

export async function runDiscovery(
  target: Target,
  allowlist: string[],
  baseDir?: string,
  options?: { includeWriteTools?: boolean },
): Promise<DiscoveryDraft> {
  const resolved =
    target.transport === "stdio"
      ? resolveStdioTarget(target, baseDir)
      : target;
  assertTargetAllowlisted(resolved, allowlist);

  const session = await createSession(resolved, undefined, baseDir);
  let tools: ToolDescriptor[] = [];
  try {
    const result = await session.listTools();
    tools = (result.result as { tools?: ToolDescriptor[] })?.tools ?? [];
  } finally {
    await session.close();
  }

  const allowlistedTools = options?.includeWriteTools
    ? tools
    : tools.filter((t) => !isWriteTool(t));

  const proposedScenarios = allowlistedTools.map((tool) => ({
    name: `call-${tool.name}`,
    steps: [
      { method: "tools/list" },
      {
        method: "tools/call",
        tool: tool.name,
        args: sampleArgsForTool(tool),
      },
      { method: "teardown" },
    ],
  }));

  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: "draft",
    target: resolved,
    allowlist,
    tools: allowlistedTools,
    proposedScenarios,
    readOnly: true,
    allowlistedToolsOnly: !options?.includeWriteTools,
  };
}

export async function saveDiscoveryDraft(
  draft: DiscoveryDraft,
  outputPath: string,
): Promise<void> {
  await writeFile(outputPath, JSON.stringify(draft, null, 2), "utf8");
}

export async function loadDiscoveryDraft(path: string): Promise<DiscoveryDraft> {
  return JSON.parse(await readFile(path, "utf8")) as DiscoveryDraft;
}

export async function approveDiscoveryDraft(
  draftPath: string,
  outputManifestPath: string,
  approvedBy: string,
): Promise<Manifest> {
  const draft = await loadDiscoveryDraft(draftPath);
  if (draft.status !== "draft") {
    throw new Error(`Draft status is ${draft.status}; only draft can be approved`);
  }

  const manifest: Manifest = {
    name: `discovered-${draft.id.slice(0, 8)}`,
    description: `Human-approved discovery by ${approvedBy}`,
    target: draft.target,
    allowlist: draft.allowlist,
    sessionPool: { size: 1, reuse: "cold" },
    quotas: {
      maxConcurrency: 2,
      maxDurationMs: 60_000,
      maxCallCount: 100,
      maxPayloadBytes: 1_048_576,
    },
    scenarios: draft.proposedScenarios.map((s) => ({
      name: s.name,
      iterations: 1,
      steps: s.steps.map((step) => ({
        method: step.method as
          | "initialize"
          | "tools/list"
          | "tools/call"
          | "ping"
          | "teardown"
          | "resources/list"
          | "resources/read"
          | "prompts/list"
          | "prompts/get"
          | "tasks/list"
          | "tasks/get"
          | "tasks/cancel",
        tool: step.tool,
        args: step.args,
      })),
    })),
    assertions: { maxErrorRate: 0, requireScenarioOutcomes: true },
  };

  draft.status = "approved";
  await saveDiscoveryDraft(draft, draftPath);
  await writeFile(outputManifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

export interface OptimizeSuggestion {
  toolName: string;
  /** The tool description as served by the live MCP server ("" when it has none). */
  before: string;
  after: string;
  rationale: string[];
  status: "draft" | "accepted" | "rejected";
  target?: Target;
  allowlist?: string[];
  mutationResult?: {
    applied: boolean;
    reason: string;
    appliedAt?: string;
  };
}

export interface ToolParameterSummary {
  name: string;
  type?: string;
  required: boolean;
  description: string;
}

/** Descriptions shorter than this rarely say what a tool returns or when to use it. */
const SHORT_DESCRIPTION_CHARS = 40;

/** Top-level input parameters with their schema descriptions ("" when missing). */
export function summarizeToolParameters(tool: ToolDescriptor): ToolParameterSummary[] {
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  return Object.entries(props).map(([name, schema]) => ({
    name,
    type: Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type,
    required: required.has(name),
    description: typeof schema.description === "string" ? schema.description.trim() : "",
  }));
}

function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w])${escaped}($|[^\\w])`, "i").test(text);
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function draftFromSchema(tool: ToolDescriptor, before: string, params: ToolParameterSummary[]): string {
  const words = tool.name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  const lead = before || words.charAt(0).toUpperCase() + words.slice(1);
  if (params.length === 0) return sentence(lead);
  const inputs = params.map((param) => {
    const meta = [param.type, param.required ? "required" : "optional"].filter(Boolean).join(", ");
    return `${param.name} (${meta})${param.description ? `: ${param.description}` : ""}`;
  });
  return `${sentence(lead)} Inputs: ${inputs.join("; ")}.`;
}

/**
 * Offline review of a tool description. Reports concrete gaps and, when the description is
 * missing or very short, drafts one from the schema for a human to edit.
 */
export function suggestDescriptionOptimization(
  tool: ToolDescriptor,
): OptimizeSuggestion {
  const before = tool.description?.trim() ?? "";
  const params = summarizeToolParameters(tool);
  const tooShort = before.length < SHORT_DESCRIPTION_CHARS;
  const rationale: string[] = [];
  if (!before) rationale.push("No description: models see only the tool name");
  else if (tooShort) {
    rationale.push(`Description is ${before.length} characters; say what the tool does, what it returns, and when to use it`);
  }
  const undocumented = params.filter((param) => !param.description).map((param) => param.name);
  if (undocumented.length > 0) {
    rationale.push(`Parameters without schema descriptions: ${undocumented.join(", ")} (fix these in the input schema)`);
  }
  const unmentioned = params.filter((param) => param.required && !mentions(before, param.name)).map((param) => param.name);
  if (unmentioned.length > 0 && !tooShort) {
    rationale.push(`Required parameters not mentioned in the description: ${unmentioned.join(", ")}`);
  }
  if (tooShort) rationale.push("Draft built from the tool name and input schema; edit before accepting");
  if (rationale.length === 0) rationale.push("No heuristic issues found; configure an inference provider for a model rewrite");
  return {
    toolName: tool.name,
    before,
    after: tooShort ? draftFromSchema(tool, before, params) : before,
    rationale,
    status: "draft",
  };
}
