/**
 * Server update checks: snapshot an MCP server's advertised surface, diff it against the
 * stored snapshot, and work out the smallest set of suite edits that keeps suites in step.
 *
 * Pure functions only. Storage lives in `store/server-updates-store.ts`.
 */
import type {
  PromptCatalogEntry,
  ResourceCatalogEntry,
  ResourceTemplateEntry,
  ServerSurface,
  SuiteNode,
  ToolCatalogEntry,
} from "./suite-model.js";
import { defaultToolEvals, insertBeforeTeardown, newNodeId, toolEvalsNeedRefresh, toolIsCalledByDefault } from "./suite-model.js";
import { schemaAccepts } from "./contract.js";
import { applyReferenceValues, isPlaceholderValue, referenceParams, sampleArgsForTool, type JsonSchema, type ReferenceValues } from "./tool-args.js";

/** `method` is a JSON-RPC method the server's protocol era no longer offers (e.g. `ping` on 2026-07-28). */
export type PrimitiveKind = "tool" | "resource" | "resourceTemplate" | "prompt" | "method";

/** Everything a server advertised at one probe, kept so later probes can be diffed against it. */
export interface SurfaceSnapshot {
  takenAt: string;
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
  capabilities: string[];
  tools: ToolCatalogEntry[];
  resources: ResourceCatalogEntry[];
  resourceTemplates: ResourceTemplateEntry[];
  prompts: PromptCatalogEntry[];
}

export interface MetaChange {
  field: "protocolVersion" | "serverName" | "serverVersion";
  before?: string;
  after?: string;
}

export interface PrimitiveChange {
  kind: PrimitiveKind;
  /** Tool or prompt name, resource uri, or template uriTemplate. */
  key: string;
  change: "added" | "removed" | "changed";
  /** Fields that differ, for `changed`. */
  fields?: string[];
}

export interface SurfaceDiff {
  changed: boolean;
  meta: MetaChange[];
  capabilities: { added: string[]; removed: string[] };
  primitives: PrimitiveChange[];
  summary: string;
}

/**
 * `add-step`: generate a contract step for a newly advertised tool/prompt/resource.
 * `disable-step`: retire a step whose primitive is gone (kept, disabled and marked `retired`, never deleted).
 */
export type SuiteChangeAction = "add-step" | "disable-step" | "refresh-args" | "acknowledge";

/** One proposed edit to one step of one suite, accepted or rejected on its own. */
export interface SuiteChangeProposal {
  id: string;
  suiteId: string;
  suiteName?: string;
  nodeId: string;
  nodeLabel?: string;
  scenarioId?: string;
  scenarioName?: string;
  primitive: PrimitiveChange;
  action: SuiteChangeAction;
  reason: string;
  beforeArgs?: Record<string, unknown>;
  afterArgs?: Record<string, unknown>;
  /**
   * Contract expectations pinned on the step (`expect.inputSchema` / `expect.outputSchema`) that must move
   * with the accepted catalog. `null` clears a pinned schema the server no longer declares.
   */
  afterExpect?: { inputSchema?: unknown; outputSchema?: unknown };
  /** Regenerated tool evals (prompt states the concrete arg values; assertions check them). */
  afterEvals?: SuiteNode["evals"];
  /** `add-step` only: the generated step inserted (before teardown) when accepted. */
  newNode?: SuiteNode;
  /** Suite version the proposal was computed against; accept re-checks it so later edits are not clobbered. */
  suiteVersion?: number;
  /** `diff`: the server changed since the stored snapshot. `drift`: the suite expects something the server no longer offers. */
  source?: "diff" | "drift" | "coverage" | "regenerate";
}

export function snapshotFromSurface(surface: ServerSurface & { protocolVersion?: string }, takenAt = new Date().toISOString()): SurfaceSnapshot {
  return {
    takenAt,
    ...(surface.protocolVersion ? { protocolVersion: surface.protocolVersion } : {}),
    ...(surface.serverName ? { serverName: surface.serverName } : {}),
    ...(surface.serverVersion ? { serverVersion: surface.serverVersion } : {}),
    capabilities: [...(surface.capabilities ?? [])].sort(),
    tools: [...(surface.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    resources: [...(surface.resources ?? [])].sort((a, b) => a.uri.localeCompare(b.uri)),
    resourceTemplates: [...(surface.resourceTemplates ?? [])].sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate)),
    prompts: [...(surface.prompts ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Key-order independent JSON, so `{a,b}` and `{b,a}` compare equal. */
export function stableJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(norm(value ?? null));
}

function diffKeyed<T>(kind: PrimitiveKind, before: T[], after: T[], key: (item: T) => string, fields: Array<[string, (item: T) => unknown]>): PrimitiveChange[] {
  const out: PrimitiveChange[] = [];
  const prev = new Map(before.map((item) => [key(item), item]));
  const next = new Map(after.map((item) => [key(item), item]));
  for (const [k, item] of next) {
    const old = prev.get(k);
    if (!old) {
      out.push({ kind, key: k, change: "added" });
      continue;
    }
    const changedFields = fields.filter(([, read]) => stableJson(read(old)) !== stableJson(read(item))).map(([name]) => name);
    if (changedFields.length) out.push({ kind, key: k, change: "changed", fields: changedFields });
  }
  for (const k of prev.keys()) if (!next.has(k)) out.push({ kind, key: k, change: "removed" });
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

export function diffSnapshots(before: SurfaceSnapshot, after: SurfaceSnapshot): SurfaceDiff {
  const meta: MetaChange[] = [];
  for (const field of ["protocolVersion", "serverName", "serverVersion"] as const) {
    if ((before[field] ?? "") !== (after[field] ?? "")) meta.push({ field, before: before[field], after: after[field] });
  }
  const capsBefore = new Set(before.capabilities);
  const capsAfter = new Set(after.capabilities);
  const capabilities = {
    added: [...capsAfter].filter((c) => !capsBefore.has(c)).sort(),
    removed: [...capsBefore].filter((c) => !capsAfter.has(c)).sort(),
  };
  const primitives = [
    ...diffKeyed<ToolCatalogEntry>("tool", before.tools, after.tools, (t) => t.name, [
      ["description", (t) => t.description ?? ""],
      ["inputSchema", (t) => t.inputSchema ?? null],
      ["outputSchema", (t) => t.outputSchema ?? null],
      ["annotations", (t) => t.annotations ?? null],
    ]),
    ...diffKeyed<ResourceCatalogEntry>("resource", before.resources, after.resources, (r) => r.uri, [
      ["name", (r) => r.name],
      ["mimeType", (r) => r.mimeType ?? ""],
    ]),
    ...diffKeyed<ResourceTemplateEntry>("resourceTemplate", before.resourceTemplates, after.resourceTemplates, (r) => r.uriTemplate, [
      ["name", (r) => r.name],
    ]),
    ...diffKeyed<PromptCatalogEntry>("prompt", before.prompts, after.prompts, (p) => p.name, [
      ["description", (p) => p.description ?? ""],
      ["arguments", (p) => p.arguments ?? []],
    ]),
  ];
  const changed = meta.length > 0 || capabilities.added.length > 0 || capabilities.removed.length > 0 || primitives.length > 0;
  const diff: SurfaceDiff = { changed, meta, capabilities, primitives, summary: "" };
  diff.summary = summariseDiff(diff);
  return diff;
}

const KIND_LABEL: Record<PrimitiveKind, string> = {
  method: "method",
  tool: "tool",
  resource: "resource",
  resourceTemplate: "resource template",
  prompt: "prompt",
};

/** One readable paragraph per diff; the auto-summary half of a changelog entry. */
export function summariseDiff(diff: Pick<SurfaceDiff, "meta" | "capabilities" | "primitives">): string {
  const lines: string[] = [];
  for (const m of diff.meta) lines.push(`${m.field}: ${m.before ?? "(none)"} → ${m.after ?? "(none)"}`);
  if (diff.capabilities.added.length) lines.push(`capabilities added: ${diff.capabilities.added.join(", ")}`);
  if (diff.capabilities.removed.length) lines.push(`capabilities removed: ${diff.capabilities.removed.join(", ")}`);
  for (const change of ["added", "removed", "changed"] as const) {
    const items = diff.primitives.filter((p) => p.change === change);
    if (!items.length) continue;
    lines.push(`${change}: ${items.map((p) => `${KIND_LABEL[p.kind]} ${p.key}${p.fields?.length ? ` (${p.fields.join(", ")})` : ""}`).join("; ")}`);
  }
  return lines.length ? lines.join("\n") : "No changes.";
}

function stepPrimitive(node: SuiteNode): { kind: PrimitiveKind; key: string } | null {
  if (node.type !== "sampler") return null;
  if (node.method === "tools/call" && node.tool) return { kind: "tool", key: node.tool };
  if (node.method === "prompts/get" && node.prompt) return { kind: "prompt", key: node.prompt };
  if (node.method === "resources/read" && node.resourceUri) return { kind: "resource", key: node.resourceUri };
  return null;
}

/** Does a concrete resource uri come from this template? (`{var}` matches one non-empty segment run.) */
export function uriMatchesTemplate(uri: string, template: string): boolean {
  const pattern = template.split(/\{[^}]+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^?#]+");
  return new RegExp(`^${pattern}$`).test(uri);
}

export interface ImpactInput {
  suiteId: string;
  suiteName?: string;
  suiteVersion?: number;
  nodes: SuiteNode[];
  /** True when a step (by its own or inherited server alias) calls the server being updated. */
  callsServer: (alias: string | undefined) => boolean;
}

/**
 * Proposals for one suite. Only steps that reference a removed or changed primitive are touched;
 * added primitives never rewrite existing suites.
 */
export function proposeSuiteChanges(input: ImpactInput, diff: SurfaceDiff, next: SurfaceSnapshot, references?: ReferenceValues): SuiteChangeProposal[] {
  const out: SuiteChangeProposal[] = [];
  const relevant = diff.primitives.filter((p) => p.change !== "added");
  if (!relevant.length) return [...out, ...proposeAddedSteps(input, diff, next, references)];
  const walk = (list: SuiteNode[], alias: string | undefined, scenario?: { id: string; name: string }) => {
    for (const node of list) {
      const ownAlias = node.server ?? alias;
      const nodeScenario = node.scenarioMeta ? { id: node.scenarioMeta.id, name: node.scenarioMeta.name } : scenario;
      if (node.children?.length) walk(node.children, ownAlias, nodeScenario);
      const ref = stepPrimitive(node);
      if (!ref || !input.callsServer(ownAlias)) continue;
      let hit = relevant.find((p) => p.kind === ref.kind && p.key === ref.key);
      if (!hit && ref.kind === "resource") {
        hit = relevant.find((p) => p.kind === "resourceTemplate" && uriMatchesTemplate(ref.key, p.key));
        // A templated read keeps working while its own concrete uri is still listed or the template survives.
        if (hit && next.resources.some((r) => r.uri === ref.key)) hit = undefined;
      }
      if (!hit) continue;
      const base = {
        suiteId: input.suiteId,
        ...(input.suiteName ? { suiteName: input.suiteName } : {}),
        ...(input.suiteVersion !== undefined ? { suiteVersion: input.suiteVersion } : {}),
        source: "diff" as const,
        nodeId: node.id,
        ...(node.label ? { nodeLabel: node.label } : {}),
        ...(nodeScenario ? { scenarioId: nodeScenario.id, scenarioName: nodeScenario.name } : {}),
        primitive: hit,
      };
      const id = `${input.suiteId}:${node.id}:${hit.kind}:${hit.key}`;
      if (hit.change === "removed") {
        if (!node.enabled) continue;
        out.push({ ...base, id, action: "disable-step", reason: `${KIND_LABEL[hit.kind]} '${hit.key}' is no longer advertised; disable the step (kept for history).` });
        continue;
      }
      out.push(changedProposal(node, hit, next, base, id));
    }
  };
  walk(input.nodes, undefined);
  return [...out, ...proposeAddedSteps(input, diff, next, references)];
}

/** Slots (`tools/call:name`, ...) the suite already calls on this server, and the explicit alias its steps use for it. */
function serverSlots(input: ImpactInput): { slots: Set<string>; alias?: string } {
  const slots = new Set<string>();
  let alias: string | undefined;
  const walk = (list: SuiteNode[], inherited: string | undefined) => {
    for (const node of list) {
      const own = node.server ?? inherited;
      if (node.children?.length) walk(node.children, own);
      const ref = stepPrimitive(node);
      if (ref && input.callsServer(own)) {
        slots.add(`${ref.kind}:${ref.key}`);
        if (own && !alias) alias = own;
      }
    }
  };
  walk(input.nodes, undefined);
  return { slots, alias };
}

/** A generated contract step for one newly advertised primitive (same shape as a freshly generated suite). */
export function stepForAddedPrimitive(change: PrimitiveChange, next: SurfaceSnapshot, serverAlias?: string, references?: ReferenceValues): SuiteNode | null {
  const server = serverAlias ? { server: serverAlias } : {};
  if (change.kind === "tool") {
    const tool = next.tools.find((t) => t.name === change.key);
    if (!tool) return null;
    const args = sampleArgsForTool({ name: tool.name, inputSchema: tool.inputSchema }, references);
    return {
      id: newNodeId(),
      type: "sampler",
      enabled: toolIsCalledByDefault(tool),
      label: tool.name,
      method: "tools/call",
      tool: tool.name,
      args,
      expect: {
        resultShape: "tools/call",
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        // Output contract check: structuredContent must validate against the advertised outputSchema.
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      },
      evals: defaultToolEvals(tool, args),
      ...server,
    } as SuiteNode;
  }
  if (change.kind === "prompt") {
    const prompt = next.prompts.find((p) => p.name === change.key);
    if (!prompt) return null;
    const args: Record<string, unknown> = {};
    for (const a of prompt.arguments ?? []) if (a.required) args[a.name] = "fixture";
    return { id: newNodeId(), type: "sampler", enabled: true, label: prompt.name, method: "prompts/get", prompt: prompt.name, args, expect: { resultShape: "prompts/get" }, ...server } as SuiteNode;
  }
  if (change.kind === "resource") {
    const resource = next.resources.find((r) => r.uri === change.key);
    if (!resource) return null;
    return { id: newNodeId(), type: "sampler", enabled: true, label: resource.name || resource.uri, method: "resources/read", resourceUri: resource.uri, expect: { resultShape: "resources/read" }, ...server } as SuiteNode;
  }
  return null;
}

/**
 * `add-step` proposals for primitives added since the snapshot. A suite whose default server is the updated
 * server gets untagged steps; a multi-server suite that calls it through an alias gets steps tagged with that
 * `server` alias. Suites that never call the server get nothing, and a primitive is never added twice.
 */
export function proposeAddedSteps(input: ImpactInput, diff: SurfaceDiff, next: SurfaceSnapshot, references?: ReferenceValues): SuiteChangeProposal[] {
  const isDefault = input.callsServer(undefined);
  const { slots: present, alias } = serverSlots(input);
  if (!isDefault && !alias) return [];
  const tag = isDefault ? undefined : alias;
  const out: SuiteChangeProposal[] = [];
  for (const change of diff.primitives) {
    if (change.change !== "added" || present.has(`${change.kind}:${change.key}`)) continue;
    const node = stepForAddedPrimitive(change, next, tag, references);
    if (!node) continue;
    const contract = node.expect?.outputSchema ? " with input + outputSchema contract checks" : node.expect?.inputSchema ? " with an inputSchema contract check" : "";
    out.push({
      id: `${input.suiteId}:add:${change.kind}:${change.key}`,
      suiteId: input.suiteId,
      ...(input.suiteName ? { suiteName: input.suiteName } : {}),
      ...(input.suiteVersion !== undefined ? { suiteVersion: input.suiteVersion } : {}),
      source: "diff",
      nodeId: node.id,
      nodeLabel: node.label,
      primitive: change,
      action: "add-step",
      reason: `${KIND_LABEL[change.kind]} '${change.key}' is newly advertised; add a generated step${tag ? ` (server '${tag}')` : ""}${contract}${node.enabled ? "" : " (disabled by default: destructive/expensive)"}.`,
      ...(node.args ? { afterArgs: node.args } : {}),
      newNode: node,
    });
  }
  return out;
}

type ProposalBase = Omit<SuiteChangeProposal, "id" | "action" | "reason">;

/** One proposal for a step whose primitive changed: new args and/or new pinned expectations, else acknowledge. */
function changedProposal(node: SuiteNode, hit: PrimitiveChange, next: SurfaceSnapshot, base: ProposalBase, id: string): SuiteChangeProposal {
  const afterArgs = refreshedArgs(node, hit, next);
  const afterExpect = refreshedExpect(node, hit, next);
  const argsMove = Boolean(afterArgs && stableJson(afterArgs) !== stableJson(node.args ?? {}));
  const fields = (hit.fields ?? []).join(", ");
  if (argsMove || afterExpect) {
    const what = [argsMove ? "step arguments" : "", afterExpect ? "contract expectations (expect.inputSchema/outputSchema)" : ""].filter(Boolean).join(" and ");
    return {
      ...base,
      id,
      action: "refresh-args",
      reason: `${KIND_LABEL[hit.kind]} '${hit.key}' changed (${fields}); align ${what} with the new schema.`,
      beforeArgs: node.args ?? {},
      afterArgs: argsMove && afterArgs ? afterArgs : { ...(node.args ?? {}) },
      ...(afterExpect ? { afterExpect } : {}),
    };
  }
  return { ...base, id, action: "acknowledge", reason: `${KIND_LABEL[hit.kind]} '${hit.key}' changed (${fields}); step arguments still fit, re-pin the suite to the new catalog.` };
}

/** Pinned contract schemas that differ from the tool's new schemas (only keys the step actually pins). */
function refreshedExpect(node: SuiteNode, change: PrimitiveChange, next: SurfaceSnapshot): SuiteChangeProposal["afterExpect"] | undefined {
  if (change.kind !== "tool") return undefined;
  const tool = next.tools.find((t) => t.name === change.key);
  if (!tool) return undefined;
  const expect = (node.expect ?? {}) as { inputSchema?: unknown; outputSchema?: unknown };
  const out: { inputSchema?: unknown; outputSchema?: unknown } = {};
  for (const key of ["inputSchema", "outputSchema"] as const) {
    if (!(key in expect) || expect[key] === undefined) continue;
    const now = tool[key] ?? null;
    if (stableJson(expect[key]) !== stableJson(now)) out[key] = now;
  }
  return Object.keys(out).length ? out : undefined;
}

function isVariableRef(value: unknown): boolean {
  return typeof value === "string" && /\$\{[^}]+\}|\{\{[^}]+\}\}/.test(value);
}

/** Does a retained value still satisfy the property's type/enum/const? Variable references always fit. */
export function valueFitsSchema(value: unknown, schema: JsonSchema | undefined): boolean {
  if (!schema || typeof schema !== "object" || isVariableRef(value)) return true;
  const s = schema as JsonSchema & { const?: unknown; enum?: unknown[]; type?: string | string[] };
  if ("const" in s && s.const !== undefined && stableJson(s.const) !== stableJson(value)) return false;
  if (Array.isArray(s.enum) && s.enum.length && !s.enum.some((e) => stableJson(e) === stableJson(value))) return false;
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (!types.length) return true;
  return types.some((t) => {
    switch (t) {
      case "string": return typeof value === "string";
      case "integer": return typeof value === "number" && Number.isInteger(value);
      case "number": return typeof value === "number" && Number.isFinite(value);
      case "boolean": return typeof value === "boolean";
      case "array": return Array.isArray(value);
      case "object": return Boolean(value) && typeof value === "object" && !Array.isArray(value);
      case "null": return value === null;
      default: return true;
    }
  });
}

function refreshedArgs(node: SuiteNode, change: PrimitiveChange, next: SurfaceSnapshot): Record<string, unknown> | null {
  const current = { ...(node.args ?? {}) };
  if (change.kind === "tool" && change.fields?.includes("inputSchema")) {
    const tool = next.tools.find((t) => t.name === change.key);
    if (!tool) return null;
    const schema = (tool.inputSchema ?? { type: "object" }) as JsonSchema;
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const kept = Object.keys(props).length ? Object.fromEntries(Object.entries(current).filter(([k]) => k in props)) : current;
    const sample = sampleArgsForTool({ name: tool.name, inputSchema: schema });
    const required = new Set(schema.required ?? []);
    // A kept value whose type/enum changed is replaced by a schema-compatible sample (or dropped when optional).
    for (const [key, value] of Object.entries(kept)) {
      if (valueFitsSchema(value, props[key])) continue;
      if (key in sample) kept[key] = sample[key];
      else if (required.has(key)) kept[key] = "fixture";
      else delete kept[key];
    }
    for (const key of required) if (!(key in kept)) kept[key] = sample[key] ?? "fixture";
    return kept;
  }
  if (change.kind === "prompt" && change.fields?.includes("arguments")) {
    const prompt = next.prompts.find((p) => p.name === change.key);
    if (!prompt) return null;
    const names = new Set((prompt.arguments ?? []).map((a) => a.name));
    const kept = Object.fromEntries(Object.entries(current).filter(([k]) => names.has(k)));
    for (const arg of prompt.arguments ?? []) if (arg.required && !(arg.name in kept)) kept[arg.name] = "fixture";
    return kept;
  }
  return null;
}

/** Apply accepted proposals to one suite's nodes. Untouched steps keep their identity and position. */
export function applySuiteChanges(
  nodes: SuiteNode[],
  accepted: SuiteChangeProposal[],
  opts: { now?: string } = {},
): { nodes: SuiteNode[]; applied: SuiteChangeProposal[] } {
  const now = opts.now ?? new Date().toISOString();
  const byNode = new Map<string, SuiteChangeProposal[]>();
  for (const p of accepted) if (p.action !== "add-step") byNode.set(p.nodeId, [...(byNode.get(p.nodeId) ?? []), p]);
  const applied: SuiteChangeProposal[] = [];
  const walk = (list: SuiteNode[]): SuiteNode[] => list.map((node) => {
    const copy: SuiteNode = { ...node, ...(node.children ? { children: walk(node.children) } : {}) };
    for (const p of byNode.get(node.id) ?? []) {
      if (p.action === "disable-step") {
        copy.enabled = false;
        copy.retired = { at: now, reason: p.reason, primitive: `${p.primitive.kind}:${p.primitive.key}` };
      }
      else if (p.action === "refresh-args" && p.afterArgs) copy.args = { ...p.afterArgs };
      if (p.action === "refresh-args" && p.afterEvals) copy.evals = structuredClone(p.afterEvals);
      if (p.action !== "disable-step" && p.afterExpect) {
        const expect: Record<string, unknown> = { ...((copy.expect ?? {}) as Record<string, unknown>) };
        for (const [key, value] of Object.entries(p.afterExpect)) {
          if (value === null || value === undefined) delete expect[key];
          else expect[key] = value;
        }
        copy.expect = expect as unknown as SuiteNode["expect"];
      }
      applied.push(p);
    }
    return copy;
  });
  let out = walk(nodes);
  const additions = accepted.filter((p) => p.action === "add-step" && p.newNode);
  if (additions.length) {
    out = insertBeforeTeardown(out, additions.map((p) => structuredClone(p.newNode!)));
    applied.push(...additions);
  }
  return { nodes: out, applied };
}

export function suiteUpdateChangelog(applied: SuiteChangeProposal[], serverLabel: string, versions?: { serverVersion?: string; previousServerVersion?: string }): string {
  const ver = versions?.serverVersion && versions.serverVersion !== versions.previousServerVersion
    ? ` (${versions.previousServerVersion ?? "?"} → ${versions.serverVersion})` : "";
  if (!applied.length) return `Re-pinned to the updated catalog of ${serverLabel}${ver}.`;
  const count = (a: SuiteChangeAction) => applied.filter((p) => p.action === a).length;
  const head = `Server update from ${serverLabel}${ver}: ${count("add-step")} added, ${count("refresh-args")} updated, ${count("disable-step")} retired, ${count("acknowledge")} acknowledged.`;
  const verb: Record<SuiteChangeAction, string> = { "add-step": "added", "refresh-args": "updated", "disable-step": "retired", acknowledge: "acknowledged" };
  return [head, ...applied.map((p) => `- ${verb[p.action]} ${p.nodeLabel ?? p.nodeId}${p.scenarioName ? ` [${p.scenarioName}]` : ""}: ${p.reason}`)].join("\n");
}

/**
 * Drift between what a suite expects and a fresh snapshot, independent of the stored baseline:
 * steps calling a method the server's era removed, tools/prompts no longer advertised, and pinned
 * contract schemas that no longer match. Proposals use the same ids as `proposeSuiteChanges`, so
 * they merge into one review. Nothing here is applied; it only feeds the review flow.
 */
export function suiteDriftProposals(input: ImpactInput, next: SurfaceSnapshot, opts: { modern?: boolean; removedMethods?: ReadonlySet<string> } = {}): SuiteChangeProposal[] {
  const out: SuiteChangeProposal[] = [];
  const removedMethods = opts.removedMethods ?? new Set<string>();
  const tools = new Map(next.tools.map((t) => [t.name, t]));
  const prompts = new Set(next.prompts.map((p) => p.name));
  const walk = (list: SuiteNode[], alias: string | undefined, scenario?: { id: string; name: string }) => {
    for (const node of list) {
      const ownAlias = node.server ?? alias;
      const nodeScenario = node.scenarioMeta ? { id: node.scenarioMeta.id, name: node.scenarioMeta.name } : scenario;
      if (node.children?.length) walk(node.children, ownAlias, nodeScenario);
      if (node.type !== "sampler" || !node.enabled || !input.callsServer(ownAlias)) continue;
      const base = {
        suiteId: input.suiteId,
        ...(input.suiteName ? { suiteName: input.suiteName } : {}),
        ...(input.suiteVersion !== undefined ? { suiteVersion: input.suiteVersion } : {}),
        source: "drift" as const,
        nodeId: node.id,
        ...(node.label ? { nodeLabel: node.label } : {}),
        ...(nodeScenario ? { scenarioId: nodeScenario.id, scenarioName: nodeScenario.name } : {}),
      };
      if (opts.modern && node.method && removedMethods.has(node.method)) {
        const primitive: PrimitiveChange = { kind: "method", key: node.method, change: "removed" };
        out.push({ ...base, primitive, id: `${input.suiteId}:${node.id}:method:${node.method}`, action: "disable-step", reason: `method '${node.method}' was removed in the modern MCP era (${next.protocolVersion ?? "2026-07-28+"}); disable the step (kept for history).` });
        continue;
      }
      if (node.method === "tools/call" && node.tool) {
        const tool = tools.get(node.tool);
        if (!tool) {
          const primitive: PrimitiveChange = { kind: "tool", key: node.tool, change: "removed" };
          out.push({ ...base, primitive, id: `${input.suiteId}:${node.id}:tool:${node.tool}`, action: "disable-step", reason: `tool '${node.tool}' is not advertised by the server (tools/list); disable the step or fix the suite.` });
          continue;
        }
        const expect = (node.expect ?? {}) as { inputSchema?: unknown; outputSchema?: unknown };
        const fields = (["inputSchema", "outputSchema"] as const).filter((k) => expect[k] !== undefined && stableJson(expect[k]) !== stableJson(tool[k] ?? null));
        if (fields.length) {
          const primitive: PrimitiveChange = { kind: "tool", key: node.tool, change: "changed", fields: [...fields] };
          out.push(changedProposal(node, primitive, next, { ...base, primitive }, `${input.suiteId}:${node.id}:tool:${node.tool}`));
        }
        continue;
      }
      if (node.method === "prompts/get" && node.prompt && !prompts.has(node.prompt)) {
        const primitive: PrimitiveChange = { kind: "prompt", key: node.prompt, change: "removed" };
        out.push({ ...base, primitive, id: `${input.suiteId}:${node.id}:prompt:${node.prompt}`, action: "disable-step", reason: `prompt '${node.prompt}' is not advertised by the server; disable the step or fix the suite.` });
      }
    }
  };
  walk(input.nodes, undefined);
  return out;
}

/** Union by proposal id; a `diff` proposal wins over a `drift` one for the same step and primitive. */
export function mergeProposals(primary: SuiteChangeProposal[], extra: SuiteChangeProposal[]): SuiteChangeProposal[] {
  const seen = new Set(primary.map((p) => p.id));
  return [...primary, ...extra.filter((p) => !seen.has(p.id))];
}

// ---- update suite from server (always available) ----------------------------

export interface CoverageItem {
  kind: "tool" | "prompt" | "resource";
  key: string;
  /** `covered`: an enabled step calls it. `disabled`: only disabled/retired steps. `missing`: no step in this suite. */
  status: "covered" | "disabled" | "missing";
  nodeIds: string[];
}

function suiteSteps(input: ImpactInput): Array<{ node: SuiteNode; alias?: string; scenario?: { id: string; name: string } }> {
  const out: Array<{ node: SuiteNode; alias?: string; scenario?: { id: string; name: string } }> = [];
  const walk = (list: SuiteNode[], alias: string | undefined, scenario?: { id: string; name: string }) => {
    for (const node of list) {
      const own = node.server ?? alias;
      const sc = node.scenarioMeta ? { id: node.scenarioMeta.id, name: node.scenarioMeta.name } : scenario;
      if (node.children?.length) walk(node.children, own, sc);
      if (stepPrimitive(node) && input.callsServer(own)) out.push({ node, alias: own, ...(sc ? { scenario: sc } : {}) });
    }
  };
  walk(input.nodes, undefined);
  return out;
}

/** Every tool, prompt and resource the server advertises, and whether THIS suite has a step for it. */
export function suiteCoverage(input: ImpactInput, next: SurfaceSnapshot): CoverageItem[] {
  const steps = suiteSteps(input);
  const items: Array<Pick<CoverageItem, "kind" | "key">> = [
    ...next.tools.map((t) => ({ kind: "tool" as const, key: t.name })),
    ...next.prompts.map((p) => ({ kind: "prompt" as const, key: p.name })),
    ...next.resources.map((r) => ({ kind: "resource" as const, key: r.uri })),
  ];
  return items.map((item) => {
    const hits = steps.filter(({ node }) => {
      const ref = stepPrimitive(node);
      return ref?.kind === item.kind && ref.key === item.key;
    });
    const status: CoverageItem["status"] = !hits.length ? "missing" : hits.some(({ node }) => node.enabled && !node.retired) ? "covered" : "disabled";
    return { ...item, status, nodeIds: hits.map(({ node }) => node.id) };
  });
}

/** `add-step` proposals for every advertised primitive this suite has no step for (compares suite contents, not the snapshot). */
export function proposeMissingSteps(input: ImpactInput, next: SurfaceSnapshot, references?: ReferenceValues): SuiteChangeProposal[] {
  const missing = suiteCoverage(input, next).filter((c) => c.status === "missing");
  const diff: SurfaceDiff = { changed: true, meta: [], capabilities: { added: [], removed: [] }, primitives: missing.map((m) => ({ kind: m.kind, key: m.key, change: "added" as const })), summary: "" };
  return proposeAddedSteps(input, diff, next, references).map((p) => ({
    ...p,
    id: `${input.suiteId}:cover:${p.primitive.kind}:${p.primitive.key}`,
    source: "coverage" as const,
    reason: p.reason.replace("is newly advertised", "is advertised but this suite has no step for it"),
  }));
}

/**
 * Re-sync existing steps to the live definitions: args that no longer fit the input schema, pinned
 * input/outputSchema contracts, and an outputSchema contract check for tools that now declare one.
 * With `regenerateAll`, every enabled tool/prompt step gets freshly generated args and contracts.
 */
export function proposeStepResync(input: ImpactInput, next: SurfaceSnapshot, opts: { regenerateAll?: boolean; references?: ReferenceValues } = {}): SuiteChangeProposal[] {
  const out: SuiteChangeProposal[] = [];
  const tools = new Map(next.tools.map((t) => [t.name, t]));
  const prompts = new Map(next.prompts.map((p) => [p.name, p]));
  for (const { node, scenario } of suiteSteps(input)) {
    if (node.type !== "sampler" || !node.enabled || node.retired) continue;
    const base = {
      suiteId: input.suiteId,
      ...(input.suiteName ? { suiteName: input.suiteName } : {}),
      ...(input.suiteVersion !== undefined ? { suiteVersion: input.suiteVersion } : {}),
      source: (opts.regenerateAll ? "regenerate" : "coverage") as "regenerate" | "coverage",
      nodeId: node.id,
      ...(node.label ? { nodeLabel: node.label } : {}),
      ...(scenario ? { scenarioId: scenario.id, scenarioName: scenario.name } : {}),
    };
    if (node.method === "tools/call" && node.tool && tools.has(node.tool)) {
      const tool = tools.get(node.tool)!;
      const primitive: PrimitiveChange = { kind: "tool", key: tool.name, change: "changed", fields: ["inputSchema", "outputSchema"] };
      const id = `${input.suiteId}:${node.id}:tool:${tool.name}`;
      const expect = (node.expect ?? {}) as { inputSchema?: unknown; outputSchema?: unknown };
      const afterExpect: { inputSchema?: unknown; outputSchema?: unknown } = {};
      for (const key of ["inputSchema", "outputSchema"] as const) {
        const now = tool[key];
        const pinned = expect[key] !== undefined;
        // Pinned contracts follow the server; a newly declared outputSchema gets a contract check; regenerate pins both.
        if (pinned && stableJson(expect[key]) !== stableJson(now ?? null)) afterExpect[key] = now ?? null;
        else if (!pinned && now && (key === "outputSchema" || opts.regenerateAll)) afterExpect[key] = now;
      }
      const resynced = refreshedArgs(node, primitive, next) ?? { ...(node.args ?? {}) };
      const descriptor = { name: tool.name, inputSchema: tool.inputSchema as JsonSchema | undefined };
      let afterArgs = opts.regenerateAll ? sampleArgsForTool(descriptor, opts.references) : repairArgs(descriptor, resynced, opts.references);
      const argsMove = stableJson(afterArgs) !== stableJson(node.args ?? {});
      const required = ((tool.inputSchema as JsonSchema | undefined)?.required ?? []) as string[];
      const evalsStale = (argsMove && hasAutoEvals(node.evals)) || toolEvalsNeedRefresh(node.evals, afterArgs, required);
      const afterEvals = evalsStale ? mergeAutoEvals(node.evals, defaultToolEvals(tool, afterArgs)) : undefined;
      if (!argsMove && !Object.keys(afterExpect).length && !afterEvals) continue;
      if (!argsMove) afterArgs = { ...(node.args ?? {}) };
      const what = [argsMove ? "args" : "", ...Object.keys(afterExpect).map((k) => `expect.${k}`), afterEvals ? "evals (concrete values)" : ""].filter(Boolean).join(", ");
      out.push({ ...base, primitive, id, action: "refresh-args", reason: `${opts.regenerateAll ? "Regenerate" : "Re-sync"} tool '${tool.name}' step to the live definition (${what}).`, beforeArgs: node.args ?? {}, afterArgs, ...(Object.keys(afterExpect).length ? { afterExpect } : {}), ...(afterEvals ? { afterEvals } : {}) });
      continue;
    }
    if (node.method === "prompts/get" && node.prompt && prompts.has(node.prompt)) {
      const primitive: PrimitiveChange = { kind: "prompt", key: node.prompt, change: "changed", fields: ["arguments"] };
      const resynced = refreshedArgs(node, primitive, next) ?? { ...(node.args ?? {}) };
      const afterArgs = opts.regenerateAll
        ? Object.fromEntries((prompts.get(node.prompt)!.arguments ?? []).filter((a) => a.required).map((a) => [a.name, (node.args ?? {})[a.name] ?? "fixture"]))
        : resynced;
      if (stableJson(afterArgs) === stableJson(node.args ?? {})) continue;
      out.push({ ...base, primitive, id: `${input.suiteId}:${node.id}:prompt:${node.prompt}`, action: "refresh-args", reason: `${opts.regenerateAll ? "Regenerate" : "Re-sync"} prompt '${node.prompt}' step arguments to the live definition.`, beforeArgs: node.args ?? {}, afterArgs });
    }
  }
  return out;
}

/** Everything "Update suite from server" would do to one suite, independent of the stored snapshot. */
export function suiteRefreshProposals(input: ImpactInput, next: SurfaceSnapshot, opts: { regenerateAll?: boolean; modern?: boolean; removedMethods?: ReadonlySet<string>; references?: ReferenceValues } = {}): SuiteChangeProposal[] {
  const drift = suiteDriftProposals(input, next, opts);
  return mergeProposals(mergeProposals(drift, proposeStepResync(input, next, opts)), proposeMissingSteps(input, next, opts.references));
}

function hasVariableRef(args: Record<string, unknown>): boolean {
  return /\$\{[^}]+\}|\{\{[^}]+\}\}/.test(JSON.stringify(args));
}

/**
 * Args a step keeps must validate against the live inputSchema (e.g. `manifest: "fixture"` against
 * `array | object` is replaced by a schema-valid sample), and placeholder values of entity-reference params
 * (`name: "fixture"` on an agent tool) are replaced by a real identifier discovered on the server.
 */
export function repairArgs(tool: { name: string; inputSchema?: JsonSchema }, args: Record<string, unknown>, references?: ReferenceValues): Record<string, unknown> {
  let out = applyReferenceValues(tool, { ...args }, references);
  const schema = tool.inputSchema as Record<string, unknown> | undefined;
  if (schema && !hasVariableRef(out) && !schemaAccepts(schema, out)) {
    const sample = sampleArgsForTool(tool, references);
    const props = (tool.inputSchema?.properties ?? {}) as Record<string, JsonSchema>;
    const fixed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(out)) {
      if (props[key] && !schemaAccepts(props[key] as Record<string, unknown>, value)) {
        if (key in sample) fixed[key] = sample[key];
      } else fixed[key] = value;
    }
    for (const key of tool.inputSchema?.required ?? []) if (!(key in fixed) && key in sample) fixed[key] = sample[key];
    out = schemaAccepts(schema, fixed) ? fixed : sample;
  }
  return out;
}

/** Placeholder values left on reference params (for reporting; the store resolves real ones). */
export function placeholderReferenceDomains(tools: Array<{ name: string; inputSchema?: unknown }>, nodes: SuiteNode[]): string[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const out = new Set<string>();
  const walk = (list: SuiteNode[]) => {
    for (const node of list) {
      if (node.children?.length) walk(node.children);
      const tool = node.method === "tools/call" && node.tool ? byName.get(node.tool) : undefined;
      if (!tool) continue;
      for (const { param, domain } of referenceParams({ name: tool.name, inputSchema: tool.inputSchema as JsonSchema })) {
        const v = (node.args ?? {})[param];
        if (v === undefined || isPlaceholderValue(v)) out.add(domain);
      }
    }
  };
  walk(nodes);
  return [...out];
}

function hasAutoEvals(evals: SuiteNode["evals"]): boolean {
  return Boolean(evals?.some((e) => /^auto-/.test(e.id)));
}

/** Replace the auto-generated eval cases, keep hand-written ones. */
function mergeAutoEvals(current: SuiteNode["evals"], fresh: NonNullable<SuiteNode["evals"]>): NonNullable<SuiteNode["evals"]> {
  const ids = new Set(fresh.map((e) => e.id));
  const kept = (current ?? []).filter((e) => !ids.has(e.id) && !/^auto-/.test(e.id));
  return [...fresh, ...kept];
}

// ---- tags -----------------------------------------------------------------

/** Lower-case, trimmed, unique, sorted; `[a-z0-9:_.-]`, at most 32 chars each and 20 per item. */
export function normalizeTags(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tag = item.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9:_.-]/g, "").slice(0, 32);
    if (tag) out.add(tag);
    if (out.size >= 20) break;
  }
  return [...out].sort();
}

/** Every wanted tag must be present (AND). An empty filter matches everything. */
export function matchesTags(tags: string[] | undefined, filter: string[] | undefined): boolean {
  if (!filter?.length) return true;
  const have = new Set(tags ?? []);
  return filter.every((tag) => have.has(tag));
}

export function normalizeDescription(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim().slice(0, 4000);
  return trimmed || undefined;
}

// ---- stored records -------------------------------------------------------

/** A probe that differed from the stored snapshot, held until it is reviewed and accepted or discarded. */
export interface PendingServerUpdate {
  checkedAt: string;
  snapshot: SurfaceSnapshot;
  diff: SurfaceDiff;
  proposals: SuiteChangeProposal[];
}

/** Changelog entry recorded on the server when an update is accepted (the version annotation). */
export interface ServerVersionAnnotation {
  id: string;
  recordedAt: string;
  serverVersion?: string;
  protocolVersion?: string;
  previousServerVersion?: string;
  previousProtocolVersion?: string;
  /** Auto-generated from the diff. */
  summary: string;
  /** Free-form notes; editable after the fact. */
  notes?: string;
  principal?: string;
  acceptedChangeIds: string[];
  rejectedChangeIds: string[];
  suiteVersions: Array<{ suiteId: string; version: number }>;
  /** Accepted proposals dropped because the suite changed after the check and they no longer applied. */
  staleChangeIds?: string[];
}
