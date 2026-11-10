import { schemaAccepts } from "./contract.js";

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchema;
  [key: string]: unknown;
}

export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** Arguments that satisfy the tool input schema, with a few readable fixtures when they still validate. */
export function sampleArgsForTool(tool: ToolDescriptor, references?: ReferenceValues): Record<string, unknown> {
  const schema = tool.inputSchema ?? { type: "object" };
  const special = specialCase(tool);
  if (special && schemaAccepts(schema, special)) return special;
  const generated = applyReferenceValues(tool, sampleObject(schema, 0), references);
  if (schemaAccepts(schema, generated)) return generated;
  // Never save args the declared inputSchema rejects: retry each required key with every schema branch.
  const props = schema.properties ?? {};
  const repaired: Record<string, unknown> = { ...generated };
  for (const key of Object.keys(repaired)) {
    const prop = props[key];
    if (!prop || schemaAccepts(prop as Record<string, unknown>, repaired[key])) continue;
    const fit = candidateValues(prop, 1).find((v) => schemaAccepts(prop as Record<string, unknown>, v));
    if (fit !== undefined) repaired[key] = fit;
  }
  return repaired;
}

/** Real identifiers discovered on the server, by reference domain (e.g. `{ agent: "fixture-agent" }`). */
export type ReferenceValues = Record<string, string>;

export interface ReferenceParam {
  param: string;
  /** Lower-case domain noun the parameter refers to, e.g. "agent", "skill", "repo". */
  domain: string;
}

const GENERIC_DOMAINS = new Set(["a", "an", "the", "object", "resource", "item", "entity", "artifact", "uri", "url", "file", "or"]);

/**
 * String parameters that name an existing server-side entity, read from the schema intent only (works for any
 * server): a description like "Agent reference: slug ..." / "agent slug" / "id of the agent", or a parameter
 * named `<domain>_name|_id|_slug`. The domain lets the generator fetch a real value from a discovery tool.
 */
export function referenceParams(tool: ToolDescriptor): ReferenceParam[] {
  const props = tool.inputSchema?.properties ?? {};
  const out: ReferenceParam[] = [];
  const prefix = tool.name.split(/[_.\-]/)[0]?.toLowerCase() ?? "";
  for (const [param, schema] of Object.entries(props)) {
    if (!schemaAllowsString(schema)) continue;
    const desc = typeof schema.description === "string" ? schema.description : "";
    let domain: string | undefined;
    const m = /\b([A-Za-z]+)\s+(?:reference|ref|slug|identifier)\b/i.exec(desc) ?? /\b(?:id|slug|name) of (?:an?|the) ([A-Za-z]+)\b/i.exec(desc);
    if (m?.[1]) domain = m[1].toLowerCase();
    // "Skill or agent ref" on a skill_* tool: the tool's own noun wins over the last one before "ref".
    if (m && prefix && domain !== prefix && new RegExp(`\\b${prefix}\\b`, "i").test(desc.slice(0, m.index + m[0].length))) domain = prefix;
    const named = /^([a-z]+)_(?:name|id|slug)$/i.exec(param);
    if (!domain && named?.[1]) domain = named[1].toLowerCase();
    if (!domain && (param === "name" || param === "slug") && prefix && /reference|slug/i.test(desc)) domain = prefix;
    if (!domain || GENERIC_DOMAINS.has(domain)) continue;
    out.push({ param, domain });
  }
  return out;
}

/** Values the sampler invents (`fixture`, `fixturexx`, `agent-fixture`): placeholders, never real identifiers. */
export function isPlaceholderValue(value: unknown): boolean {
  return typeof value === "string" && /^(?:[a-z0-9]+-)?fixturex*$/i.test(value.trim());
}

/** Replace placeholder values of reference params with real identifiers discovered on the server. */
export function applyReferenceValues(tool: ToolDescriptor, args: Record<string, unknown>, references?: ReferenceValues): Record<string, unknown> {
  if (!references || !Object.keys(references).length) return args;
  const out = { ...args };
  for (const { param, domain } of referenceParams(tool)) {
    const real = references[domain];
    if (real && (!(param in out) || isPlaceholderValue(out[param]))) {
      if (param in out || (tool.inputSchema?.required ?? []).includes(param)) out[param] = real;
    }
  }
  return out;
}

function schemaAllowsString(schema: JsonSchema | undefined): boolean {
  if (!schema) return false;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.includes("string")) return true;
  const branches = [...((schema.anyOf as JsonSchema[] | undefined) ?? []), ...((schema.oneOf as JsonSchema[] | undefined) ?? [])];
  return branches.some((b) => schemaAllowsString(b));
}

/** One sample per schema branch (anyOf/oneOf), first branch first. */
function candidateValues(schema: JsonSchema, depth: number): unknown[] {
  const branches = [...((schema.anyOf as JsonSchema[] | undefined) ?? []), ...((schema.oneOf as JsonSchema[] | undefined) ?? [])];
  const out = branches.length ? branches.map((b) => sampleValue(b, depth)) : [sampleValue(schema, depth)];
  return [...out, [], {}];
}

function specialCase(tool: ToolDescriptor): Record<string, unknown> | null {
  const props = tool.inputSchema?.properties ?? {};
  if (tool.name === "echo" || "message" in props) return { message: "swarm-record-fixture" };
  if ("a" in props && "b" in props) return { a: 1, b: 2 };
  if ("delayMs" in props) return { delayMs: 10 };
  return null;
}

function sampleObject(schema: JsonSchema, depth: number): Record<string, unknown> {
  const props = schema.properties ?? {};
  const required = schema.required ?? [];
  const keys = required.length > 0 ? required : Object.keys(props).slice(0, 8);
  const args: Record<string, unknown> = {};
  for (const key of keys) {
    args[key] = sampleValue(props[key] ?? { type: "string" }, depth + 1);
  }
  return args;
}

function sampleValue(schema: JsonSchema | undefined, depth: number): unknown {
  if (!schema || depth > 5) return "fixture";
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ("default" in schema && schema.default !== undefined && schema.default !== null) return schema.default;
  // anyOf / oneOf / allOf: sample the first non-null branch (e.g. `manifest: array | object` -> []), never a bare string.
  const branches = [...((schema.anyOf as JsonSchema[] | undefined) ?? []), ...((schema.oneOf as JsonSchema[] | undefined) ?? [])].filter((b) => b && b.type !== "null");
  if (!schema.type && branches.length) return sampleValue(branches[0], depth);
  if (!schema.type && Array.isArray(schema.allOf) && schema.allOf.length) return sampleValue(Object.assign({}, ...(schema.allOf as JsonSchema[])), depth);
  const rawType = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (rawType === "integer" || rawType === "number") {
    const min = typeof schema.minimum === "number" ? schema.minimum : 0;
    const max = typeof schema.maximum === "number" ? schema.maximum : min;
    const value = Math.min(Math.max(min, 0), max);
    return rawType === "integer" ? Math.ceil(value) : value;
  }
  if (rawType === "boolean") return false;
  if (rawType === "array") {
    // Many servers reject an empty list even when the schema has no minItems
    // (e.g. Parallel's web_search: "search_queries must be a non-empty list").
    // Default to one item; honour minItems and a maxItems cap.
    // An item schema with no declared fields (`{type: object, additionalProperties: true}`) has nothing concrete to
    // generate: `[]` is the only value guaranteed valid, unless minItems forces items.
    const opaque = !!schema.items && (schema.items.type === "object" || !schema.items.type) && !schema.items.properties && !(schema.items.required?.length);
    const min = typeof schema.minItems === "number" ? schema.minItems : opaque ? 0 : 1;
    const count = typeof schema.maxItems === "number" ? Math.min(min, schema.maxItems) : min;
    return Array.from({ length: Math.max(count, 0) }, () => sampleValue(schema.items, depth + 1));
  }
  if (rawType === "object" || schema.properties) return sampleObject(schema, depth);
  if (schema.format === "uri" || schema.format === "uri-reference") return "https://example.com/fixture";
  const length = typeof schema.minLength === "number" ? schema.minLength : 7;
  return "fixture".padEnd(length, "x").slice(0, Math.max(length, 7));
}
