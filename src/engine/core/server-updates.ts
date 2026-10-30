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
import { sampleArgsForTool, type JsonSchema } from "./tool-args.js";

export type PrimitiveKind = "tool" | "resource" | "resourceTemplate" | "prompt";

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

export type SuiteChangeAction = "disable-step" | "refresh-args" | "acknowledge";

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
  nodes: SuiteNode[];
  /** True when a step (by its own or inherited server alias) calls the server being updated. */
  callsServer: (alias: string | undefined) => boolean;
}

/**
 * Proposals for one suite. Only steps that reference a removed or changed primitive are touched;
 * added primitives never rewrite existing suites.
 */
export function proposeSuiteChanges(input: ImpactInput, diff: SurfaceDiff, next: SurfaceSnapshot): SuiteChangeProposal[] {
  const out: SuiteChangeProposal[] = [];
  const relevant = diff.primitives.filter((p) => p.change !== "added");
  if (!relevant.length) return out;
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
      const afterArgs = refreshedArgs(node, hit, next);
      if (afterArgs && stableJson(afterArgs) !== stableJson(node.args ?? {})) {
        out.push({ ...base, id, action: "refresh-args", reason: `${KIND_LABEL[hit.kind]} '${hit.key}' changed (${(hit.fields ?? []).join(", ")}); align step arguments with the new schema.`, beforeArgs: node.args ?? {}, afterArgs });
      } else {
        out.push({ ...base, id, action: "acknowledge", reason: `${KIND_LABEL[hit.kind]} '${hit.key}' changed (${(hit.fields ?? []).join(", ")}); step arguments still fit, re-pin the suite to the new catalog.` });
      }
    }
  };
  walk(input.nodes, undefined);
  return out;
}

function refreshedArgs(node: SuiteNode, change: PrimitiveChange, next: SurfaceSnapshot): Record<string, unknown> | null {
  const current = { ...(node.args ?? {}) };
  if (change.kind === "tool" && change.fields?.includes("inputSchema")) {
    const tool = next.tools.find((t) => t.name === change.key);
    if (!tool) return null;
    const schema = (tool.inputSchema ?? { type: "object" }) as JsonSchema;
    const props = schema.properties ?? {};
    const kept = Object.keys(props).length ? Object.fromEntries(Object.entries(current).filter(([k]) => k in props)) : current;
    const sample = sampleArgsForTool({ name: tool.name, inputSchema: schema });
    for (const key of schema.required ?? []) if (!(key in kept)) kept[key] = sample[key] ?? "fixture";
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
export function applySuiteChanges(nodes: SuiteNode[], accepted: SuiteChangeProposal[]): { nodes: SuiteNode[]; applied: SuiteChangeProposal[] } {
  const byNode = new Map<string, SuiteChangeProposal[]>();
  for (const p of accepted) byNode.set(p.nodeId, [...(byNode.get(p.nodeId) ?? []), p]);
  const applied: SuiteChangeProposal[] = [];
  const walk = (list: SuiteNode[]): SuiteNode[] => list.map((node) => {
    const copy: SuiteNode = { ...node, ...(node.children ? { children: walk(node.children) } : {}) };
    for (const p of byNode.get(node.id) ?? []) {
      if (p.action === "disable-step") copy.enabled = false;
      else if (p.action === "refresh-args" && p.afterArgs) copy.args = { ...p.afterArgs };
      applied.push(p);
    }
    return copy;
  });
  return { nodes: walk(nodes), applied };
}

export function suiteUpdateChangelog(applied: SuiteChangeProposal[], serverLabel: string): string {
  if (!applied.length) return `Re-pinned to the updated catalog of ${serverLabel}.`;
  return [`Server update from ${serverLabel}:`, ...applied.map((p) => `- ${p.action} ${p.nodeLabel ?? p.nodeId}${p.scenarioName ? ` [${p.scenarioName}]` : ""}: ${p.reason}`)].join("\n");
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
}
