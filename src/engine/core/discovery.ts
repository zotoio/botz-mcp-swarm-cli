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
  before: string;
  after: string;
  rationale: string[];
  benchDelta?: { p95BeforeMs: number; p95AfterMs: number };
  status: "draft" | "accepted" | "rejected";
  target?: Target;
  allowlist?: string[];
  mutationResult?: {
    applied: boolean;
    reason: string;
    appliedAt?: string;
  };
}

export function suggestDescriptionOptimization(
  tool: ToolDescriptor,
): OptimizeSuggestion {
  const before = tool.name;
  const after = `${tool.name}: ${(tool.inputSchema?.required ?? []).join(", ") || "no required args"}`;
  return {
    toolName: tool.name,
    before,
    after,
    rationale: [
      "Adds required parameter names for clarity",
      "Bench delta requires explicit Accept before publish",
    ],
    status: "draft",
  };
}
