import { DEFAULT_LOAD_PROFILE } from "./load-defaults.js";
import type { CallSlo } from "./call-slo.js";
import { normalizeCallSlo } from "./call-slo.js";
import type { ContractExpect } from "./contract.js";
import { assignWaitFor, dagPredecessors } from "./execution-dag.js";
import { LLM_STEP_TIMEOUT_MS } from "./inference-model.js";
import type { ElicitAutoReply } from "../adapters/base.js";
import { sampleArgsForTool, type JsonSchema, type ToolDescriptor } from "./tool-args.js";

/** Same write-like rule as discovery: these tools are recorded but not called. */
const WRITE_TOOL_PATTERNS = [
  /delete/i, /write/i, /mutate/i, /destroy/i,
  /^(?:create|update|push|fork|merge|add|set|remove|close|reopen|submit|approve)[_-]/i,
  /^(?:create|update|push|fork|merge|add|set|remove|close|reopen|submit|approve)[A-Z]/,
];

export function isWriteToolName(name: string): boolean {
  return WRITE_TOOL_PATTERNS.some((pattern) => pattern.test(name));
}

/** Destructive or write-like tools are recorded in the suite and left disabled. */
export function toolIsCalledByDefault(tool: {
  name: string;
  writeLike?: boolean;
  annotations?: ToolAnnotations;
}): boolean {
  if (tool.annotations?.readOnlyHint === true) return true;
  if (tool.annotations?.destructiveHint === true) return false;
  if (tool.writeLike) return false;
  return !isWriteToolName(tool.name);
}

export function asServerSurface(input: ToolCatalogEntry[] | ServerSurface): ServerSurface {
  if (Array.isArray(input)) {
    return {
      capabilities: input.length > 0 ? ["tools"] : [],
      tools: input,
      resources: [],
      resourceTemplates: [],
      prompts: [],
    };
  }
  return input;
}

export interface LoadProfile {
  durationMs: number;
  rampUpMs: number;
  maxConcurrency: number;
  jitterMs: number;
  rampDownMs: number;
  /** Fixed pause inserted between every pair of steps. */
  dwellMs: number;
  /** Minimum full passes of the suite for each virtual user. */
  iterations: number;
  /** Ready steps that run together in one Promise.all. The graph draws this many lanes. */
  lanes: number;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface ToolCatalogEntry {
  name: string;
  description?: string;
  schemaHash: string;
  writeLike: boolean;
  inputSchema?: ToolDescriptor["inputSchema"];
  outputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
}

export interface ResourceCatalogEntry {
  uri: string;
  name: string;
  mimeType?: string;
}

export interface ResourceTemplateEntry {
  uriTemplate: string;
  name: string;
}

export interface PromptCatalogEntry {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; required?: boolean }>;
}

/** Live picture of one MCP server, used to build the default contract suite. */
export interface ServerSurface {
  serverName?: string;
  serverVersion?: string;
  capabilities: string[];
  tools: ToolCatalogEntry[];
  resources: ResourceCatalogEntry[];
  resourceTemplates: ResourceTemplateEntry[];
  prompts: PromptCatalogEntry[];
}

export const SAMPLER_METHODS = [
  "initialize",
  "tools/list",
  "tools/call",
  "ping",
  "resources/list",
  "resources/read",
  "resources/templates/list",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "logging/setLevel",
  "teardown",
] as const;

export type SamplerMethod = (typeof SAMPLER_METHODS)[number];

const READ_CAP = 100;

export type SuiteNodeType = "sampler" | "think" | "extractor" | "loop" | "group";

/** A claim about the model transcript, judged by Jev or an LLM. */
export interface ToolEvalAssertion {
  id: string;
  text: string;
}

/**
 * One prompt offered to a model that can see the server's tools.
 * Positive expects a call to this tool. Negative expects no call to it.
 */
export interface ToolEvalCase {
  id: string;
  polarity: "positive" | "negative";
  prompt: string;
  assertions: ToolEvalAssertion[];
}

export interface SuiteNode {
  id: string;
  type: SuiteNodeType;
  enabled: boolean;
  label?: string;
  method?: SamplerMethod;
  tool?: string;
  resourceUri?: string;
  prompt?: string;
  args?: Record<string, unknown>;
  expect?: ContractExpect;
  thinkMs?: number;
  /** Dot or JSONPath-like path into the previous JSON-RPC result. */
  path?: string;
  variable?: string;
  iterations?: number;
  children?: SuiteNode[];
  /** Prompts that check whether a model calls this tool, and with what inputs. */
  evals?: ToolEvalCase[];
  /** Reply used when this step triggers elicitation/create. */
  elicit?: ElicitAutoReply;
  /**
   * Tool-call objectives. A set field replaces the same suite objective.
   * Blank fields use the suite objective.
   */
  slo?: CallSlo;
  /**
   * Where this step sits on the suite graph.
   * Relative to its group or loop when nested; otherwise the canvas origin.
   * The runner ignores it.
   */
  layout?: { x: number; y: number };
}

/** Enabled tool steps that carry at least one eval prompt. Loops are not unrolled. */
export interface ScheduledToolEval {
  nodeId: string;
  tool: string;
  label: string;
  cases: ToolEvalCase[];
}

export function collectToolEvals(nodes: SuiteNode[]): ScheduledToolEval[] {
  const found: ScheduledToolEval[] = [];
  const walk = (list: SuiteNode[]) => {
    for (const node of list) {
      if (!node.enabled) continue;
      if (node.children?.length) walk(node.children);
      if (node.type !== "sampler" || node.method !== "tools/call") continue;
      const tool = node.tool?.trim();
      const cases = node.evals ?? [];
      if (!tool || cases.length === 0) continue;
      found.push({ nodeId: node.id, tool, label: node.label ?? tool, cases });
    }
  };
  walk(nodes);
  return found;
}

export interface CompiledStep {
  method: SamplerMethod | "think" | "extract";
  tool?: string;
  resourceUri?: string;
  prompt?: string;
  args?: Record<string, unknown>;
  expect?: ContractExpect;
  thinkMs?: number;
  extract?: { variable: string; path: string };
  nodeId?: string;
  label?: string;
  loopIndex?: number;
  /** Predecessor indexes in the compiled step list. Empty means the step can start immediately. */
  waitFor?: number[];
  /** Loop iteration keys used while wiring the DAG. Removed before the suite is returned. */
  barriers?: string[];
  /** Set when this step carries an LLM eval. The runner waits this long for the tool call. */
  timeoutMs?: number;
  /** Reply used when this step triggers elicitation/create. */
  elicit?: ElicitAutoReply;
  /** Tool-call objectives that replace the suite objective for this step. */
  slo?: CallSlo;
}

export interface CompiledManifest {
  name: string;
  description: string;
  target: {
    transport: "stdio" | "sse" | "streamable-http";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
  };
  allowlist: string[];
  sessionPool: { size: number; reuse: "warm" | "cold" };
  quotas: {
    maxConcurrency: number;
    maxDurationMs: number;
    maxCallCount: number;
    maxPayloadBytes: number;
  };
  scenarios: Array<{
    name: string;
    iterations: number;
    steps: CompiledStep[];
  }>;
  assertions: {
    maxErrorRate: number;
    maxP95LatencyMs?: number;
    maxP99LatencyMs?: number;
    requireScenarioOutcomes: boolean;
  };
  load: LoadProfile;
}

export interface VarContext {
  thread: number;
  iter: number;
  loop: number;
  vars: Record<string, string>;
  /** When set, a ${name} that is not a built-in and not in vars fails substitution. */
  strict?: boolean;
}

export class UnresolvedParamError extends Error {
  readonly param: string;

  constructor(param: string) {
    super(`missing parameter: ${param}`);
    this.name = "UnresolvedParamError";
    this.param = param;
  }
}

let nodeSeq = 0;

export function newNodeId(): string {
  nodeSeq += 1;
  return `n${Date.now().toString(36)}${nodeSeq.toString(36)}`;
}

export function defaultLoadProfile(): LoadProfile {
  return { ...DEFAULT_LOAD_PROFILE };
}

/** Fill a stored profile so older suites pick up dwell and the iteration floor. */
export function normalizeLoadProfile(load?: Partial<LoadProfile> | null): LoadProfile {
  const base = defaultLoadProfile();
  return {
    durationMs: nonnegative(load?.durationMs, base.durationMs),
    rampUpMs: nonnegative(load?.rampUpMs, base.rampUpMs),
    maxConcurrency: Math.max(1, Math.round(load?.maxConcurrency ?? base.maxConcurrency)),
    jitterMs: nonnegative(load?.jitterMs, base.jitterMs),
    rampDownMs: nonnegative(load?.rampDownMs, base.rampDownMs),
    dwellMs: nonnegative(load?.dwellMs, base.dwellMs),
    iterations: Math.max(1, Math.round(load?.iterations ?? base.iterations)),
    lanes: Math.min(16, Math.max(1, Math.round(load?.lanes ?? base.lanes))),
  };
}

function nonnegative(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.round(value));
}

export function catalogFingerprint(
  catalog: Array<{ name: string; schemaHash: string }>,
): string {
  return [...catalog]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => `${entry.name}:${entry.schemaHash}`)
    .join("|");
}

export function vuStartOffsetMs(index: number, count: number, rampUpMs: number): number {
  if (count <= 1 || rampUpMs <= 0) return 0;
  const clamped = Math.min(Math.max(index, 0), count - 1);
  return Math.round((rampUpMs * clamped) / (count - 1));
}

/** True while new iterations may start (ramp-up plus hold). Ramp-down only drains in-flight work. */
export function mayStartIteration(
  nowMs: number,
  originMs: number,
  load: Pick<LoadProfile, "rampUpMs" | "durationMs">,
): boolean {
  return nowMs < originMs + load.rampUpMs + load.durationMs;
}

export function drainDeadlineMs(
  originMs: number,
  load: Pick<LoadProfile, "rampUpMs" | "durationMs" | "rampDownMs">,
): number {
  return originMs + load.rampUpMs + load.durationMs + load.rampDownMs;
}

function evalId(name: string, suffix: string): string {
  const slug = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "tool";
  return `auto-${slug}-${suffix}`;
}

/** Positive and negative prompts, each with assertions a Jev or LLM judge can score. */
export function defaultToolEvals(tool: {
  name: string;
  description?: string;
  inputSchema?: { required?: string[] };
}): ToolEvalCase[] {
  const name = tool.name.trim() || "tool";
  const description = tool.description?.trim();
  const required = (tool.inputSchema?.required ?? []).map((item) => item.trim()).filter(Boolean);
  const about = description ? `${name}: ${description}` : name;
  const needs = required.length > 0 ? ` Include ${required.join(", ")}.` : "";
  return [
    {
      id: evalId(name, "pos"),
      polarity: "positive",
      prompt: `Please use ${name} for this request. ${about}.${needs}`.replace(/\s+/g, " ").trim(),
      assertions: [
        { id: evalId(name, "pos-called"), text: `The assistant called ${name}.` },
        {
          id: evalId(name, "pos-args"),
          text: `The arguments passed to ${name} fit the user request${required.length ? ` and include ${required.join(", ")}` : ""}.`,
        },
      ],
    },
    {
      id: evalId(name, "neg"),
      polarity: "negative",
      prompt: `Answer in one sentence and do not call ${name}. The request is unrelated to ${about}.`,
      assertions: [{ id: evalId(name, "neg-absent"), text: `The assistant did not call ${name}.` }],
    },
  ];
}

export function blankSuiteNode(type: SuiteNodeType): SuiteNode {
  const id = newNodeId();
  if (type === "group") return { id, type, enabled: true, label: "Group", children: [] };
  if (type === "loop") return { id, type, enabled: true, label: "Loop", iterations: 2, children: [] };
  if (type === "think") return { id, type, enabled: true, label: "Think", thinkMs: 100 };
  if (type === "extractor") {
    return { id, type, enabled: true, label: "Extract", variable: "extracted", path: "tools.0.name" };
  }
  return { id, type: "sampler", enabled: true, label: "List tools", method: "tools/list" };
}

function sampler(
  method: SamplerMethod,
  label: string,
  extra?: Partial<SuiteNode>,
): SuiteNode {
  return {
    id: newNodeId(),
    type: "sampler",
    enabled: true,
    label,
    method,
    ...extra,
  };
}

export function buildDefaultSuiteNodes(input: ToolCatalogEntry[] | ServerSurface): SuiteNode[] {
  const surface = asServerSurface(input);
  const children: SuiteNode[] = [
    sampler("initialize", "Initialize", { expect: { resultShape: "initialize" } }),
    sampler("ping", "Ping", { expect: { resultShape: "ping" } }),
    ...(surface.capabilities.includes("tools") || surface.tools.length > 0
      ? [sampler("tools/list", "List tools", { expect: { resultShape: "tools/list" } })] : []),
  ];
  for (const tool of surface.tools) {
    children.push({
      id: newNodeId(),
      type: "sampler",
      enabled: toolIsCalledByDefault(tool),
      label: tool.name,
      method: "tools/call",
      tool: tool.name,
      args: sampleArgsForTool({ name: tool.name, inputSchema: tool.inputSchema }),
      expect: {
        resultShape: "tools/call",
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      },
      evals: defaultToolEvals(tool),
    });
  }
  if (surface.capabilities.includes("resources") || surface.resources.length > 0 || surface.resourceTemplates.length > 0) {
    children.push(sampler("resources/list", "List resources", { expect: { resultShape: "resources/list" } }));
    for (const resource of surface.resources.slice(0, READ_CAP)) {
      children.push(sampler("resources/read", resource.name || resource.uri, {
        resourceUri: resource.uri,
        expect: { resultShape: "resources/read" },
      }));
    }
    children.push(sampler("resources/templates/list", "List resource templates", { expect: { resultShape: "resource-templates" } }));
  }
  if (surface.capabilities.includes("prompts") || surface.prompts.length > 0) {
    children.push(sampler("prompts/list", "List prompts", { expect: { resultShape: "prompts/list" } }));
    for (const prompt of surface.prompts.slice(0, READ_CAP)) {
      const args: Record<string, unknown> = {};
      for (const argument of prompt.arguments ?? []) {
        if (argument.required) args[argument.name] = "fixture";
      }
      children.push(sampler("prompts/get", prompt.name, {
        prompt: prompt.name,
        args,
        expect: { resultShape: "prompts/get" },
      }));
    }
  }
  const completion = completionNode(surface);
  if (completion) children.push(completion);
  if (surface.capabilities.includes("logging")) {
    children.push(sampler("logging/setLevel", "Set log level", {
      args: { level: "info" },
      expect: { resultShape: "logging" },
    }));
  }
  children.push(sampler("teardown", "Teardown"));
  return [
    {
      id: newNodeId(),
      type: "group",
      enabled: true,
      label: "Contract",
      children,
    },
  ];
}

function suiteSlot(node: SuiteNode): string | null {
  if (node.type !== "sampler" || !node.method) return null;
  if (node.method === "tools/call") return `tools/call:${node.tool ?? ""}`;
  if (node.method === "resources/read") return `resources/read:${node.resourceUri ?? ""}`;
  if (node.method === "prompts/get") return `prompts/get:${node.prompt ?? ""}`;
  if (node.method === "completion/complete") return `completion/complete:${node.prompt ?? node.resourceUri ?? ""}`;
  return node.method;
}

function collectSlots(nodes: SuiteNode[], slots: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    const slot = suiteSlot(node);
    if (slot) slots.add(slot);
    if (node.children?.length) collectSlots(node.children, slots);
  }
  return slots;
}

function surfaceOffers(node: SuiteNode, surface: ServerSurface): boolean {
  if (node.method === "tools/call") return Boolean(node.tool && surface.tools.some((tool) => tool.name === node.tool));
  if (node.method === "resources/read") {
    return Boolean(node.resourceUri && surface.resources.some((resource) => resource.uri === node.resourceUri));
  }
  if (node.method === "prompts/get") return Boolean(node.prompt && surface.prompts.some((prompt) => prompt.name === node.prompt));
  const resources = surface.capabilities.includes("resources") || surface.resources.length > 0 || surface.resourceTemplates.length > 0;
  const prompts = surface.capabilities.includes("prompts") || surface.prompts.length > 0;
  if (node.method === "resources/list" || node.method === "resources/templates/list") {
    return resources;
  }
  if (node.method === "prompts/list") return prompts;
  if (node.method === "completion/complete") return surface.capabilities.includes("completions");
  if (node.method === "logging/setLevel") return surface.capabilities.includes("logging");
  return true;
}

function withCurrentToolContract(node: SuiteNode, surface: ServerSurface): SuiteNode {
  if (node.method !== "tools/call" || !node.tool) return node;
  const tool = surface.tools.find((item) => item.name === node.tool);
  if (!tool) return node;
  return {
    ...node,
    expect: {
      resultShape: node.expect?.resultShape ?? "tools/call",
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    },
  };
}

function dropRetiredSteps(nodes: SuiteNode[], surface: ServerSurface): SuiteNode[] {
  const next: SuiteNode[] = [];
  for (const node of nodes) {
    if (node.type === "group" || node.type === "loop") {
      next.push({ ...node, children: dropRetiredSteps(node.children ?? [], surface) });
      continue;
    }
    if (node.type === "sampler" && !surfaceOffers(node, surface)) continue;
    next.push(withCurrentToolContract(node, surface));
  }
  return next;
}

function insertBeforeTeardown(nodes: SuiteNode[], additions: SuiteNode[]): SuiteNode[] {
  if (additions.length === 0) return nodes;
  const place = (list: SuiteNode[]): boolean => {
    for (const node of list) {
      if (node.type !== "group" && node.type !== "loop") continue;
      const children = node.children ?? [];
      const index = children.findIndex((child) => child.method === "teardown");
      if (index >= 0) {
        node.children = [...children.slice(0, index), ...additions, ...children.slice(index)];
        return true;
      }
      if (place(children)) return true;
    }
    return false;
  };
  if (place(nodes)) return nodes;
  const group = nodes.find((node) => node.type === "group");
  if (group) {
    group.children = [...(group.children ?? []), ...additions];
    return nodes;
  }
  return [...nodes, ...additions];
}

/**
 * Keep suite steps that the server still advertises, including evals and arguments,
 * and add steps for tools, resources, and prompts the suite does not call yet.
 */
export function reconcileSuiteNodes(nodes: SuiteNode[], input: ToolCatalogEntry[] | ServerSurface): SuiteNode[] {
  const surface = asServerSurface(input);
  const kept = dropRetiredSteps(structuredClone(nodes), surface);
  const present = collectSlots(kept);
  const additions = (buildDefaultSuiteNodes(surface)[0]?.children ?? []).filter((node) => {
    const slot = suiteSlot(node);
    return Boolean(slot && !present.has(slot));
  });
  return insertBeforeTeardown(kept, additions);
}

function completionNode(surface: ServerSurface): SuiteNode | null {
  if (!surface.capabilities.includes("completions")) return null;
  const prompt = surface.prompts.find((item) => (item.arguments ?? []).length > 0);
  const argument = prompt?.arguments?.[0];
  if (prompt && argument) {
    return sampler("completion/complete", `Complete ${prompt.name}`, {
      prompt: prompt.name,
      args: { ref: "prompt", argument: argument.name, value: "fi" },
      expect: { resultShape: "completion" },
    });
  }
  const template = surface.resourceTemplates[0];
  if (!template) return null;
  return sampler("completion/complete", `Complete ${template.name}`, {
    resourceUri: template.uriTemplate,
    args: { ref: "resource", argument: "id", value: "fi" },
    expect: { resultShape: "completion" },
  });
}

const LOOP_EXPAND_CAP = 50;

function compileInto(nodes: SuiteNode[], into: CompiledStep[]): void {
  for (const node of nodes) {
    if (!node.enabled) continue;
    if (node.type === "group") {
      compileInto(node.children ?? [], into);
      continue;
    }
    if (node.type === "loop") {
      const times = Math.min(Math.max(node.iterations ?? 1, 1), LOOP_EXPAND_CAP);
      for (let i = 0; i < times; i++) {
        const before = into.length;
        compileInto(node.children ?? [], into);
        const key = `${node.id}#${i}`;
        for (let j = before; j < into.length; j++) {
          const step = into[j];
          if (!step) continue;
          if (step.loopIndex === undefined) step.loopIndex = i;
          step.barriers = [...(step.barriers ?? []), key];
        }
      }
      continue;
    }
    if (node.type === "think") {
      into.push({
        method: "think",
        thinkMs: node.thinkMs ?? 0,
        nodeId: node.id,
        label: node.label ?? "Think",
      });
      continue;
    }
    if (node.type === "extractor") {
      into.push({
        method: "extract",
        extract: { variable: node.variable ?? "extracted", path: node.path ?? "" },
        nodeId: node.id,
        label: node.label ?? node.variable ?? "Extract",
      });
      continue;
    }
    if (node.type === "sampler" && node.method) {
      const stepSlo = node.method === "tools/call" ? normalizeCallSlo(node.slo) : undefined;
      into.push({
        method: node.method,
        tool: node.tool,
        resourceUri: node.resourceUri,
        prompt: node.prompt,
        args: node.args,
        expect: node.expect,
        nodeId: node.id,
        label: node.label ?? node.tool ?? node.prompt ?? node.resourceUri ?? node.method,
        ...(node.method === "tools/call" && (node.evals?.length ?? 0) > 0
          ? { timeoutMs: LLM_STEP_TIMEOUT_MS }
          : {}),
        ...(node.elicit ? { elicit: node.elicit } : {}),
        ...(stepSlo ? { slo: stepSlo } : {}),
      });
    }
  }
}

export function compileSuite(input: {
  name: string;
  description?: string;
  target: CompiledManifest["target"];
  allowlist: string[];
  nodes: SuiteNode[];
  load: Partial<LoadProfile>;
  slo?: CallSlo;
}): CompiledManifest {
  const steps: CompiledStep[] = [];
  compileInto(input.nodes, steps);
  assignWaitFor(steps, dagPredecessors(input.nodes));
  if (steps.length === 0) {
    throw new Error("suite_has_no_enabled_steps");
  }
  const load = normalizeLoadProfile(input.load);
  const slo = normalizeCallSlo(input.slo);
  const concurrency = load.maxConcurrency;
  const passes = load.iterations;
  const gaps = Math.max(0, steps.length - 1);
  const windowMs = load.rampUpMs + load.durationMs + load.rampDownMs + 30_000;
  const passBudget =
    steps.reduce((sum, step) => sum + (step.timeoutMs ?? 10_000), 0) + gaps * load.dwellMs;
  return {
    name: input.name,
    description: input.description ?? "Project suite",
    target: input.target,
    allowlist: input.allowlist,
    sessionPool: { size: concurrency, reuse: "warm" },
    quotas: {
      maxConcurrency: concurrency,
      maxDurationMs: Math.max(windowMs, passBudget * passes + 30_000, 1_000),
      maxCallCount: 100_000,
      maxPayloadBytes: 1_048_576,
    },
    scenarios: [{ name: input.name, iterations: passes, steps }],
    assertions: {
      maxErrorRate: slo?.maxErrorRate ?? 0,
      ...(slo?.maxP95Ms !== undefined ? { maxP95LatencyMs: slo.maxP95Ms } : {}),
      ...(slo?.maxP99Ms !== undefined ? { maxP99LatencyMs: slo.maxP99Ms } : {}),
      requireScenarioOutcomes: true,
    },
    load,
  };
}

const VAR_PATTERN = /\$\{(__uuid|__ts|__thread|__iter|__loop|[A-Za-z_][A-Za-z0-9_]*)\}/g;

export function substituteString(
  input: string,
  ctx: VarContext,
  uuid: () => string = () => `u${Date.now().toString(36)}${nodeSeq.toString(36)}`,
): string {
  return input.replace(VAR_PATTERN, (_match, name: string) => {
    if (name === "__uuid") return uuid();
    if (name === "__ts") return String(Date.now());
    if (name === "__thread") return String(ctx.thread);
    if (name === "__iter") return String(ctx.iter);
    if (name === "__loop") return String(ctx.loop);
    if (Object.prototype.hasOwnProperty.call(ctx.vars, name)) return ctx.vars[name] ?? "";
    if (ctx.strict) throw new UnresolvedParamError(name);
    return "";
  });
}

export function substituteValue(value: unknown, ctx: VarContext, uuid?: () => string): unknown {
  if (typeof value === "string") return substituteString(value, ctx, uuid);
  if (Array.isArray(value)) return value.map((item) => substituteValue(item, ctx, uuid));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = substituteValue(item, ctx, uuid);
    }
    return out;
  }
  return value;
}

export function readPath(root: unknown, path: string): unknown {
  const trimmed = path.trim().replace(/^\$\.?/, "");
  if (!trimmed) return root;
  const parts = trimmed.split(/\.|\[|\]/).filter((part) => part.length > 0);
  let current: unknown = root;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

interface NodeLocation {
  siblings: SuiteNode[];
  index: number;
}

function findLocation(nodes: SuiteNode[], id: string): NodeLocation | null {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (!node) continue;
    if (node.id === id) return { siblings: nodes, index };
    if (node.children) {
      const nested = findLocation(node.children, id);
      if (nested) return nested;
    }
  }
  return null;
}

function findNode(nodes: SuiteNode[], id: string): SuiteNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const nested = findNode(node.children, id);
      if (nested) return nested;
    }
  }
  return null;
}

function containsNode(node: SuiteNode, id: string): boolean {
  if (node.id === id) return true;
  return (node.children ?? []).some((child) => containsNode(child, id));
}

/** Reorder among siblings, or drop onto a group/loop to nest as its last child. */
export function moveNode(nodes: SuiteNode[], activeId: string, overId: string): SuiteNode[] {
  if (activeId === overId) return nodes;
  const tree = structuredClone(nodes);
  const from = findLocation(tree, activeId);
  const over = findNode(tree, overId);
  if (!from || !over) return nodes;
  const removed = from.siblings.splice(from.index, 1)[0];
  if (!removed) return nodes;
  if (containsNode(removed, overId)) {
    from.siblings.splice(from.index, 0, removed);
    return nodes;
  }
  if (over.type === "group" || over.type === "loop") {
    const target = findNode(tree, overId);
    if (!target) return nodes;
    target.children = target.children ?? [];
    target.children.push(removed);
    return tree;
  }
  const dest = findLocation(tree, overId);
  if (!dest) return nodes;
  dest.siblings.splice(dest.index, 0, removed);
  return tree;
}

/** New ids, same labels. Used when a project adopts a server's master suite. */
export function adoptSuiteNodes(nodes: SuiteNode[]): SuiteNode[] {
  const copy = structuredClone(nodes);
  const refresh = (current: SuiteNode) => {
    current.id = newNodeId();
    for (const child of current.children ?? []) refresh(child);
  };
  for (const node of copy) refresh(node);
  return copy;
}

export function cloneNode(node: SuiteNode): SuiteNode {
  const copy = structuredClone(node);
  const refresh = (current: SuiteNode) => {
    current.id = newNodeId();
    for (const child of current.children ?? []) refresh(child);
  };
  refresh(copy);
  copy.label = `${copy.label ?? copy.type} copy`;
  return copy;
}

export function insertNode(nodes: SuiteNode[], node: SuiteNode, parentId?: string): SuiteNode[] {
  const tree = structuredClone(nodes);
  if (!parentId) return [...tree, node];
  const parent = findNode(tree, parentId);
  if (!parent || (parent.type !== "group" && parent.type !== "loop")) return [...tree, node];
  parent.children = [...(parent.children ?? []), node];
  return tree;
}

export function updateNode(
  nodes: SuiteNode[],
  id: string,
  patch: Partial<SuiteNode>,
): SuiteNode[] {
  const tree = structuredClone(nodes);
  const node = findNode(tree, id);
  if (!node) return nodes;
  Object.assign(node, patch, { id: node.id, children: patch.children ?? node.children });
  return tree;
}

export function deleteNode(nodes: SuiteNode[], id: string): SuiteNode[] {
  const tree = structuredClone(nodes);
  const location = findLocation(tree, id);
  if (!location) return nodes;
  location.siblings.splice(location.index, 1);
  return tree;
}
