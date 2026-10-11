import type { ElicitAutoReply } from "./base.js";

/** Values the MCP elicitation result schema accepts. */
export type ElicitPrimitive = string | number | boolean | string[];

export interface ElicitFieldSchema {
  type?: string;
  enum?: string[];
  oneOf?: Array<{ const?: string }>;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
  items?: {
    type?: string;
    enum?: string[];
    anyOf?: Array<{ const?: string }>;
  };
}

export interface ElicitRequestParams {
  mode?: string;
  requestedSchema?: {
    properties?: Record<string, ElicitFieldSchema>;
    required?: string[];
  };
}

export interface ScriptedElicitResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, ElicitPrimitive>;
}

function isPrimitive(value: unknown): value is ElicitPrimitive {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function matchesFormat(value: string, format: string | undefined): boolean {
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === "uri") return /^[a-z][a-z0-9+.-]*:/i.test(value);
  if (format === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (format === "date-time") return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
  return true;
}

/** True when a scripted value satisfies one elicitation field. */
export function valueMatchesField(schema: ElicitFieldSchema, value: unknown): value is ElicitPrimitive {
  if (!isPrimitive(value)) return false;
  if (schema.enum) return typeof value === "string" && schema.enum.includes(value);
  if (schema.oneOf?.length) {
    return typeof value === "string" && schema.oneOf.some((item) => item.const === value);
  }
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (schema.type === "integer" && !Number.isInteger(value)) return false;
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
    return true;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    const min = schema.minItems ?? 0;
    if (value.length < min) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    const allowed = schema.items?.enum ?? schema.items?.anyOf?.map((item) => item.const).filter((item): item is string => Boolean(item));
    if (allowed && value.some((item) => !allowed.includes(item))) return false;
    return true;
  }
  if (typeof value !== "string") return false;
  if (schema.minLength !== undefined && value.length < schema.minLength) return false;
  if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
  return matchesFormat(value, schema.format);
}

function fallbackFor(schema: ElicitFieldSchema): ElicitPrimitive {
  if (schema.default !== undefined && valueMatchesField(schema, schema.default)) return schema.default;
  if (schema.enum?.length) return schema.enum[0] ?? "swarm-auto";
  const choice = schema.oneOf?.find((item) => typeof item.const === "string")?.const;
  if (choice) return choice;
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") {
    let value = schema.minimum ?? 0;
    if (schema.maximum !== undefined && value > schema.maximum) value = schema.maximum;
    if (schema.type === "integer") value = Math.round(value);
    return value;
  }
  if (schema.type === "array") {
    const count = Math.min(schema.maxItems ?? Number.POSITIVE_INFINITY, Math.max(schema.minItems ?? 1, 1));
    const itemSchema: ElicitFieldSchema = schema.items?.enum
      ? { type: "string", enum: schema.items.enum }
      : schema.items?.anyOf
        ? { type: "string", oneOf: schema.items.anyOf }
        : { type: "string" };
    const item = fallbackFor(itemSchema);
    const text = typeof item === "string" ? item : "swarm-auto";
    return Array.from({ length: count }, () => text);
  }
  if (schema.format === "email") return "swarm@example.com";
  if (schema.format === "uri") return "https://example.invalid/swarm";
  if (schema.format === "date") return "2026-01-01";
  if (schema.format === "date-time") return "2026-01-01T00:00:00Z";
  let text = "swarm-auto";
  if (schema.minLength !== undefined && text.length < schema.minLength) text = text.padEnd(schema.minLength, "x");
  if (schema.maxLength !== undefined && text.length > schema.maxLength) text = text.slice(0, schema.maxLength);
  return text;
}

/**
 * Reply to elicitation/create.
 * Form accept fills a schema-valid content object. URL mode and decline/cancel are action only.
 */
export function scriptElicitResult(params: ElicitRequestParams, reply: ElicitAutoReply): ScriptedElicitResult {
  if (reply.action !== "accept" || params.mode === "url") return { action: reply.action };
  const properties = params.requestedSchema?.properties ?? {};
  const required = new Set(params.requestedSchema?.required ?? []);
  const content: Record<string, ElicitPrimitive> = {};
  for (const [key, schema] of Object.entries(properties)) {
    const scripted = reply.content?.[key];
    if (valueMatchesField(schema, scripted)) {
      content[key] = scripted;
      continue;
    }
    const hasDefault = schema.default !== undefined && valueMatchesField(schema, schema.default);
    if (!required.has(key) && !hasDefault) continue;
    content[key] = fallbackFor(schema);
  }
  return { action: "accept", content };
}
