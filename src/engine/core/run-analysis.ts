/**
 * "Analyse errors": ask an LLM to read a failed run and propose fixes to the suite.
 *
 * Suite bugs come back as JSON patches (RFC 6902 subset) addressed by step id. Server bugs and
 * environment problems (rate limits, auth, network, quota) are findings only and never patched.
 * Nothing here writes to disk: callers validate, then save a new suite version on accept.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { RunReport } from "../types/run.js";
import type { CallSlo } from "./call-slo.js";
import { asServerSurface, type LoadProfile, type SuiteNode, type ToolCatalogEntry } from "./suite-model.js";
import { compareSuiteToSurface, suiteEnablesDestructive } from "./suite-compatibility.js";
import { planErrors } from "./error-plan.js";
import { REDACTED, redactValue } from "./redaction.js";
import { inferenceLimits, inferenceSecretValues, resolveInferenceConfig } from "./inference-model.js";
import { requestInference } from "./tool-evals.js";

export const ANALYSIS_CATEGORIES = ["suite_bug", "server_bug", "environment"] as const;
export type AnalysisCategory = (typeof ANALYSIS_CATEGORIES)[number];
export const MAX_PATCH_OPS = 20;
export const MAX_LOG_LINES = 200;
const MAX_FIELD_CHARS = 2_000;

export type PatchOp =
  | { op: "add" | "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

export type ProposalStatus = "proposed" | "invalid" | "stale" | "accepted" | "rejected";

export interface FixProposal {
  id: string;
  title: string;
  category: AnalysisCategory;
  confidence: number;
  rationale: string;
  evidence: string[];
  nodeIds: string[];
  /** Only on suite_bug proposals. Paths use `/nodes/@<stepId>/...`. */
  patch?: PatchOp[];
  /** Plain report for server bugs and environment problems. */
  report?: string;
  status: ProposalStatus;
  /** Why validation refused the patch, or why it went stale. */
  reason?: string;
  decidedBy?: string;
  decidedAt?: string;
  /** Suite version created when this proposal was accepted. */
  acceptedVersion?: number;
}

export interface RunAnalysis {
  id: string;
  runId: string;
  projectId?: string;
  suiteId?: string;
  suiteVersion?: number;
  createdAt: string;
  principal?: string;
  model: string;
  provider: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Short summary the model gave for the whole run. */
  summary?: string;
  proposals: FixProposal[];
}

/** The editable part of a suite version. */
export interface SuiteDoc {
  nodes: SuiteNode[];
  load: LoadProfile;
  slo?: CallSlo;
}

// ---------- availability ----------

export interface AnalysisAvailability {
  enabled: boolean;
  reason?: "disabled" | "no_key" | "config_error";
  provider?: string;
  model?: string;
}

/** Analyse is on when inference has a key (or a fixture is configured) and SWARM_ANALYSE is not "off". */
export function analysisAvailability(env: NodeJS.ProcessEnv = process.env): AnalysisAvailability {
  if (env.SWARM_ANALYSE?.trim().toLowerCase() === "off") return { enabled: false, reason: "disabled" };
  if (env.SWARM_ANALYSE_FIXTURE?.trim()) return { enabled: true, provider: "fixture", model: "fixture" };
  try {
    const config = resolveInferenceConfig(env);
    const model = env.SWARM_ANALYSE_MODEL?.trim() || config.model;
    if (!config.apiKey) return { enabled: false, reason: "no_key", provider: config.provider, model };
    return { enabled: true, provider: config.provider, model };
  } catch {
    return { enabled: false, reason: "config_error" };
  }
}

// ---------- context ----------

function clipText(value: string, max = MAX_FIELD_CHARS): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Collect every string-ish secret we know about so it can be scrubbed from free text too. */
function knownSecrets(extra: string[], target?: unknown): string[] {
  const out = new Set<string>(extra.filter((s) => s && s.length >= 4));
  for (const s of inferenceSecretValues()) if (s && s.length >= 4) out.add(s);
  const walk = (value: unknown, key = ""): void => {
    if (!value || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if ((k === "headers" || k === "env") && v && typeof v === "object") {
        for (const hv of Object.values(v as Record<string, unknown>)) if (typeof hv === "string" && hv.length >= 4) out.add(hv);
      } else if (k === "url" && typeof v === "string") {
        try {
          const u = new URL(v);
          for (const qv of u.searchParams.values()) if (qv.length >= 4) out.add(qv);
          if (u.password) out.add(u.password);
        } catch { /* not a URL */ }
      } else walk(v, k);
    }
    void key;
  };
  walk(target);
  return [...out].sort((a, b) => b.length - a.length);
}

function scrub(value: unknown, secrets: string[]): unknown {
  const redacted = redactValue(value);
  const text = JSON.stringify(redacted ?? null);
  let out = text;
  for (const s of secrets) {
    const json = JSON.stringify(s).slice(1, -1);
    out = out.split(json).join(REDACTED);
  }
  return JSON.parse(out) as unknown;
}

function stripLayout(node: SuiteNode): SuiteNode {
  const { layout: _layout, children, ...rest } = node;
  return { ...rest, ...(children ? { children: children.map(stripLayout) } : {}) };
}

/** Walk nodes depth-first with their parent chain. */
function walkNodes(nodes: SuiteNode[], visit: (node: SuiteNode, parents: SuiteNode[]) => void, parents: SuiteNode[] = []): void {
  for (const node of nodes) {
    visit(node, parents);
    if (node.children) walkNodes(node.children, visit, [...parents, node]);
  }
}

export function findNode(nodes: SuiteNode[], id: string): SuiteNode | undefined {
  let found: SuiteNode | undefined;
  walkNodes(nodes, (n) => { if (!found && n.id === id) found = n; });
  return found;
}

/** Step ids with errors, failed evals, or named in fail reasons. */
export function involvedNodeIds(report: RunReport, nodes: SuiteNode[]): string[] {
  const ids = new Set<string>();
  for (const o of report.nodeOutcomes ?? []) if (o.errorCount > 0 || o.errorMessage) ids.add(o.nodeId);
  for (const e of report.toolEvals ?? []) if (!e.pass) ids.add(e.nodeId);
  const failedTools = new Set((report.toolSeries ?? []).filter((t) => t.errorRate > 0).map((t) => t.toolName));
  const text = report.failReasons.join("\n");
  walkNodes(nodes, (n) => {
    if (n.tool && failedTools.has(n.tool)) ids.add(n.id);
    if (text.includes(n.id) || (n.label && text.includes(`Step ${n.label}`))) ids.add(n.id);
  });
  return [...ids];
}

export interface AnalysisContextInput {
  report: RunReport;
  suite: SuiteDoc;
  catalog: ToolCatalogEntry[];
  /** Server target config. Only used to learn secret values to scrub; never sent. */
  target?: unknown;
  /** Extra values to scrub, e.g. run params. */
  secrets?: string[];
}

export function buildAnalysisContext(input: AnalysisContextInput): Record<string, unknown> {
  const { report, suite, catalog } = input;
  const secrets = knownSecrets([...(input.secrets ?? []), ...Object.values(report.params ?? {})], input.target);
  const ids = new Set(involvedNodeIds(report, suite.nodes));
  // Include parents (loops/groups) and extractors so variable flow is visible.
  const keep = new Set<string>(ids);
  walkNodes(suite.nodes, (n, parents) => {
    if (ids.has(n.id)) for (const p of parents) keep.add(p.id);
    if (n.type === "extractor") keep.add(n.id);
  });
  const steps: SuiteNode[] = [];
  walkNodes(suite.nodes, (n) => { if (keep.has(n.id)) steps.push({ ...stripLayout(n), children: undefined }); });
  const tools = new Set(steps.map((s) => s.tool).filter(Boolean) as string[]);
  const runHashes = new Map((report.catalog ?? []).map((c) => [c.name, c.schemaHash]));
  const toolSchemas = catalog.filter((t) => tools.has(t.name)).map((t) => ({
    name: t.name,
    description: t.description ? clipText(t.description, 500) : undefined,
    inputSchema: t.inputSchema,
    writeLike: t.writeLike,
    schemaChangedSinceRun: runHashes.has(t.name) && runHashes.get(t.name) !== t.schemaHash,
  }));
  const compat = compareSuiteToSurface(suite.nodes, catalog, asServerSurface(catalog));
  const context = {
    run: {
      id: report.id,
      verdict: report.verdict,
      suiteVersion: report.suiteVersion,
      failReasons: report.failReasons.slice(0, 50).map((r) => clipText(r)),
      nodeOutcomes: (report.nodeOutcomes ?? []).filter((o) => keep.has(o.nodeId) || o.errorCount > 0 || (o.retries ?? 0) > 0)
        .map((o) => ({ ...o, errorMessage: o.errorMessage ? clipText(o.errorMessage) : undefined })),
      toolErrors: (report.toolSeries ?? []).filter((t) => t.errorRate > 0).map((t) => ({
        tool: t.toolName, count: t.count, errorRate: t.errorRate, errorClass: t.errorClass,
      })),
      rateLimitRetries: report.retries
        ? { ...report.retries, note: "Rate-limit retries that later succeeded. Not failures; never a suite bug on their own." }
        : undefined,
      failedEvals: (report.toolEvals ?? []).filter((e) => !e.pass).slice(0, 20).map((e) => ({
        nodeId: e.nodeId, tool: e.tool, polarity: e.polarity, prompt: clipText(e.prompt, 500), reason: e.reason,
        failedAssertions: e.assertions.filter((a) => !a.pass).map((a) => ({ text: a.text, reason: clipText(a.reason, 500) })),
        calledTools: e.toolCalls.map((c) => c.name),
      })),
      sampleArgs: (report.redactedArgs ?? []).filter((a) => keep.has(a.nodeId)),
      ruleHints: planErrors({ failReasons: report.failReasons, log: report.log }).map((p) => ({ cause: p.cause, action: p.action })),
      logTail: (report.log ?? []).slice(-MAX_LOG_LINES).map((l) => clipText(l, 400)),
    },
    suite: { load: suite.load, slo: suite.slo, steps },
    toolSchemas,
    compatibility: compat,
  };
  return scrub(context, secrets) as Record<string, unknown>;
}

// ---------- prompt + parse ----------

const SYSTEM_PROMPT = `You review failed MCP load/contract test runs and propose fixes to the TEST SUITE.
Classify every finding:
- suite_bug: the suite is wrong (bad args vs inputSchema, wrong expectation, wrong extractor path, eval prompt/assertion wrong, timeout/SLO too tight for the tool). Provide a JSON patch.
- server_bug: the server misbehaves (crashes, wrong result shape, schema violation). Report only, no patch.
- environment: rate limits, quota, auth/credentials, network, DNS, allowlist. Report only, no patch.
Rate-limit retries are already retried and are not failures.
Patch rules: RFC 6902 ops "add" | "replace" | "remove" only, against {"nodes","load","slo"}.
Address steps by id: "/nodes/@<stepId>/args/limit" (works for nested steps). Never change "id", "layout", or the server target. At most ${MAX_PATCH_OPS} ops.
Reply with JSON only:
{"summary":"...","proposals":[{"title":"...","category":"suite_bug|server_bug|environment","confidence":0.0-1.0,"rationale":"...","evidence":["..."],"nodeIds":["..."],"patch":[...],"report":"..."}]}
Return an empty proposals list when nothing is wrong with the suite and nothing is worth reporting.`;

export function analysisMessages(context: Record<string, unknown>): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Run context (secrets redacted):\n${JSON.stringify(context)}` },
  ];
}

const PatchOpSchema = z.union([
  z.object({ op: z.enum(["add", "replace"]), path: z.string().startsWith("/"), value: z.unknown() }),
  z.object({ op: z.literal("remove"), path: z.string().startsWith("/") }),
]);

const RawProposalSchema = z.object({
  title: z.string().min(1).max(200),
  category: z.enum(ANALYSIS_CATEGORIES),
  confidence: z.coerce.number().min(0).max(1).catch(0.5),
  rationale: z.string().max(4_000).default(""),
  evidence: z.array(z.string().max(1_000)).max(20).default([]),
  nodeIds: z.array(z.string()).max(50).default([]),
  patch: z.array(PatchOpSchema).optional(),
  report: z.string().max(4_000).optional(),
});

const RawResponseSchema = z.object({
  summary: z.string().max(4_000).optional(),
  proposals: z.array(z.unknown()).max(20),
});

function extractJson(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced?.[1] ?? content).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("analysis_unparseable");
  return JSON.parse(text.slice(start, end + 1));
}

/** Parse model output. Malformed individual proposals are dropped, not fatal. */
export function parseAnalysisResponse(content: string): { summary?: string; proposals: FixProposal[] } {
  let raw: unknown;
  try {
    raw = extractJson(content);
  } catch {
    throw new Error("analysis_unparseable");
  }
  const top = RawResponseSchema.safeParse(raw);
  if (!top.success) throw new Error("analysis_invalid_shape");
  const proposals: FixProposal[] = [];
  for (const item of top.data.proposals) {
    const p = RawProposalSchema.safeParse(item);
    if (!p.success) continue;
    const isPatchable = p.data.category === "suite_bug";
    const proposal: FixProposal = {
      id: `fx_${randomUUID().slice(0, 8)}`,
      title: p.data.title,
      category: p.data.category,
      confidence: p.data.confidence,
      rationale: p.data.rationale,
      evidence: p.data.evidence,
      nodeIds: p.data.nodeIds,
      status: "proposed",
      ...(isPatchable && p.data.patch?.length ? { patch: p.data.patch as PatchOp[] } : {}),
      ...(p.data.report ? { report: p.data.report } : {}),
    };
    if (isPatchable && !proposal.patch) {
      proposal.status = "invalid";
      proposal.reason = "suite_bug proposal had no patch";
    }
    proposals.push(proposal);
  }
  return { summary: top.data.summary, proposals };
}

// ---------- patch application ----------

function decodeSegment(seg: string): string {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Index path (as segments) to a node id anywhere in the tree, e.g. ["nodes","2","children","0"]. */
function nodeIndexPath(nodes: SuiteNode[], id: string, prefix: string[] = ["nodes"]): string[] | null {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.id === id) return [...prefix, String(i)];
    if (node.children) {
      const hit = nodeIndexPath(node.children, id, [...prefix, String(i), "children"]);
      if (hit) return hit;
    }
  }
  return null;
}

/** Turn `/nodes/@id/args/x` into concrete index segments. Throws on unknown ids. */
export function resolvePatchPath(doc: SuiteDoc, path: string): string[] {
  const segs = path.split("/").slice(1).map(decodeSegment);
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (seg.startsWith("@")) {
      const prev = out[out.length - 1];
      if (prev !== "nodes" && prev !== "children") throw new Error(`step reference must follow nodes/children: ${path}`);
      const id = seg.slice(1);
      const full = nodeIndexPath(doc.nodes, id);
      if (!full) throw new Error(`unknown step id ${id}`);
      // Replace the whole prefix with the absolute path to the step.
      out.length = 0;
      out.push(...full);
    } else out.push(seg);
  }
  if (out[0] !== "nodes" && out[0] !== "load" && out[0] !== "slo") throw new Error(`patch path outside nodes/load/slo: ${path}`);
  return out;
}

const FORBIDDEN_KEYS = new Set(["id", "layout", "target", "serverId", "__proto__", "constructor", "prototype"]);

export function applyPatch(doc: SuiteDoc, ops: PatchOp[]): SuiteDoc {
  if (ops.length === 0) throw new Error("empty patch");
  if (ops.length > MAX_PATCH_OPS) throw new Error(`patch has more than ${MAX_PATCH_OPS} operations`);
  const next = structuredClone(doc) as SuiteDoc & Record<string, unknown>;
  for (const op of ops) {
    const segs = resolvePatchPath(next, op.path);
    if (segs.some((s) => FORBIDDEN_KEYS.has(s))) throw new Error(`patch may not change ${op.path}`);
    if ((op.op === "add" || op.op === "replace") && op.value && typeof op.value === "object") {
      const bad = JSON.stringify(op.value).match(/"(layout|target|serverId|__proto__)"\s*:/);
      if (bad) throw new Error(`patch value may not set ${bad[1]}`);
    }
    let parent: unknown = next;
    for (const seg of segs.slice(0, -1)) {
      if (parent === null || typeof parent !== "object") throw new Error(`path not found: ${op.path}`);
      const child = (parent as Record<string, unknown>)[seg];
      if (child === undefined && op.op === "add") (parent as Record<string, unknown>)[seg] = {};
      parent = (parent as Record<string, unknown>)[seg];
    }
    const last = segs[segs.length - 1]!;
    if (parent === null || typeof parent !== "object") throw new Error(`path not found: ${op.path}`);
    if (Array.isArray(parent)) {
      const idx = last === "-" ? parent.length : Number(last);
      if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) throw new Error(`bad index in ${op.path}`);
      if (op.op === "add") parent.splice(idx, 0, structuredClone(op.value));
      else if (idx >= parent.length) throw new Error(`path not found: ${op.path}`);
      else if (op.op === "replace") parent[idx] = structuredClone(op.value);
      else parent.splice(idx, 1);
    } else {
      const obj = parent as Record<string, unknown>;
      if (op.op !== "add" && !(last in obj)) throw new Error(`path not found: ${op.path}`);
      if (op.op === "remove") delete obj[last];
      else obj[last] = structuredClone(op.value);
    }
  }
  return next;
}

// ---------- validation ----------

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; enum?: unknown[]; items?: Schema };

function typeOk(value: unknown, type: string): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number";
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return !!value && typeof value === "object" && !Array.isArray(value);
    case "null": return value === null;
    default: return true;
  }
}

/** Light JSON-Schema check of step args: required keys, top-level and nested types, enums. Template strings pass. */
export function argsSchemaErrors(args: unknown, schema: Schema | undefined, path = "args"): string[] {
  if (!schema) return [];
  if (typeof args === "string" && /\$\{[^}]+\}/.test(args)) return [];
  const errors: string[] = [];
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  if (types.length && !types.some((t) => typeOk(args, t))) errors.push(`${path} should be ${types.join("|")}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(args))) errors.push(`${path} not in enum`);
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const obj = args as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${path}.${key} is required`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) errors.push(...argsSchemaErrors(obj[key], sub, `${path}.${key}`));
    }
  }
  if (Array.isArray(args) && schema.items) args.forEach((v, i) => errors.push(...argsSchemaErrors(v, schema.items, `${path}[${i}]`)));
  return errors;
}

function suiteSchemaErrors(nodes: SuiteNode[], catalog: ToolCatalogEntry[]): string[] {
  const tools = new Map(catalog.map((t) => [t.name, t]));
  const errors: string[] = [];
  walkNodes(nodes, (n) => {
    if (n.enabled && n.method === "tools/call" && n.tool) {
      const tool = tools.get(n.tool);
      if (!tool) errors.push(`step ${n.id}: tool ${n.tool} is not on the server`);
      else errors.push(...argsSchemaErrors(n.args ?? {}, tool.inputSchema as Schema).map((e) => `step ${n.id}: ${e}`));
    }
  });
  return errors;
}

export interface ValidateOptions {
  catalog: ToolCatalogEntry[];
  /** Whether the person accepting may enable destructive / write-like tools. */
  canRunDestructive: boolean;
  /** Full suite check (compileSuite etc.). Throw to reject. */
  compile?: (doc: SuiteDoc) => void;
}

export type ValidationResult = { ok: true; doc: SuiteDoc } | { ok: false; reason: string };

export function validateProposal(base: SuiteDoc, proposal: Pick<FixProposal, "category" | "patch">, opts: ValidateOptions): ValidationResult {
  if (proposal.category !== "suite_bug") return { ok: false, reason: "only suite_bug proposals can be applied" };
  if (!proposal.patch?.length) return { ok: false, reason: "no patch" };
  let doc: SuiteDoc;
  try {
    doc = applyPatch(base, proposal.patch);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "patch_failed" };
  }
  if (!Array.isArray(doc.nodes)) return { ok: false, reason: "nodes must stay a list" };
  const ids = new Set<string>();
  let dup = "";
  walkNodes(doc.nodes, (n) => {
    if (!n || typeof n !== "object" || typeof n.id !== "string" || !n.id) dup = dup || "every step needs an id";
    else if (ids.has(n.id)) dup = dup || `duplicate step id ${n.id}`;
    else ids.add(n.id);
  });
  if (dup) return { ok: false, reason: dup };
  // Only errors the patch introduces count: an existing problem elsewhere must not block an unrelated fix.
  const before = new Set(suiteSchemaErrors(base.nodes, opts.catalog));
  const schemaErrors = suiteSchemaErrors(doc.nodes, opts.catalog).filter((e) => !before.has(e));
  if (schemaErrors.length) return { ok: false, reason: schemaErrors.slice(0, 5).join("; ") };
  if (!opts.canRunDestructive && !suiteEnablesDestructive(base.nodes, opts.catalog) && suiteEnablesDestructive(doc.nodes, opts.catalog)) {
    return { ok: false, reason: "patch would enable a write-like or destructive tool" };
  }
  if (opts.compile) {
    try {
      opts.compile(doc);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "suite_invalid" };
    }
  }
  return { ok: true, doc };
}

/** Validate each patch proposal against the suite and mark invalid ones in place. */
export function validateProposals(base: SuiteDoc, proposals: FixProposal[], opts: ValidateOptions): FixProposal[] {
  return proposals.map((p) => {
    if (p.category !== "suite_bug" || p.status !== "proposed") return p;
    const result = validateProposal(base, p, opts);
    return result.ok ? p : { ...p, status: "invalid", reason: result.reason };
  });
}

export function patchHash(patch: PatchOp[] | undefined): string {
  return createHash("sha256").update(JSON.stringify(patch ?? [])).digest("hex").slice(0, 16);
}

// ---------- the call ----------

export type InferFn = (body: Record<string, unknown>) => Promise<unknown>;

export interface AnalyseRunInput extends AnalysisContextInput {
  principal?: string;
  projectId?: string;
  suiteId?: string;
  validate: Omit<ValidateOptions, "canRunDestructive"> & { canRunDestructive?: boolean };
  /** Override the model call (tests, CLI). Defaults to the configured provider or SWARM_ANALYSE_FIXTURE. */
  infer?: InferFn;
  env?: NodeJS.ProcessEnv;
}

async function defaultInfer(env: NodeJS.ProcessEnv): Promise<{ infer: InferFn; model: string; provider: string }> {
  const fixture = env.SWARM_ANALYSE_FIXTURE?.trim();
  if (fixture) {
    const content = await readFile(fixture, "utf8");
    return { infer: async () => ({ choices: [{ message: { content } }] }), model: "fixture", provider: "fixture" };
  }
  const config = resolveInferenceConfig(env);
  const model = env.SWARM_ANALYSE_MODEL?.trim() || config.model;
  return { infer: (body) => requestInference({ ...body, model }), model, provider: config.provider };
}

export async function analyseRun(input: AnalyseRunInput): Promise<RunAnalysis> {
  const env = input.env ?? process.env;
  const context = buildAnalysisContext(input);
  const resolved = input.infer
    ? { infer: input.infer, model: env.SWARM_ANALYSE_MODEL?.trim() || "custom", provider: "custom" }
    : await defaultInfer(env);
  const model = resolved.model;
  const data = (await resolved.infer({
    model,
    ...inferenceLimits(model, 2_000),
    messages: analysisMessages(context),
    response_format: { type: "json_object" },
  })) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } } | string;
  const content = typeof data === "string" ? data : data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("analysis_empty");
  const parsed = parseAnalysisResponse(content);
  const proposals = validateProposals(input.suite, parsed.proposals, {
    ...input.validate,
    canRunDestructive: input.validate.canRunDestructive ?? false,
  });
  const usage = typeof data === "object" && data?.usage
    ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
    : undefined;
  return {
    id: `an_${randomUUID()}`,
    runId: input.report.id,
    projectId: input.projectId,
    suiteId: input.suiteId,
    suiteVersion: input.report.suiteVersion,
    createdAt: new Date().toISOString(),
    principal: input.principal,
    model,
    provider: resolved.provider,
    ...(usage ? { usage } : {}),
    ...(parsed.summary ? { summary: parsed.summary } : {}),
    proposals,
  };
}

/**
 * Re-check a proposal against the suite as it is now. If the suite moved past the analysed version,
 * the patch must still apply and validate there; otherwise the proposal is stale.
 */
export function revalidateForAccept(
  current: SuiteDoc,
  currentVersion: number,
  analysedVersion: number | undefined,
  proposal: FixProposal,
  opts: ValidateOptions,
): ValidationResult & { stale?: boolean } {
  const result = validateProposal(current, proposal, opts);
  if (result.ok) return result;
  const moved = analysedVersion !== undefined && analysedVersion !== currentVersion;
  return moved
    ? { ok: false, stale: true, reason: `suite changed since this run (v${analysedVersion} → v${currentVersion}): ${result.reason}` }
    : result;
}
