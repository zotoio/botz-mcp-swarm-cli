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
export function sampleArgsForTool(tool: ToolDescriptor): Record<string, unknown> {
  const schema = tool.inputSchema ?? { type: "object" };
  const generated = sampleObject(schema, 0);
  const special = specialCase(tool);
  if (special && schemaAccepts(schema, special)) return special;
  return generated;
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
  if ("default" in schema && schema.default !== undefined) return schema.default;
  const rawType = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (rawType === "integer" || rawType === "number") {
    const min = typeof schema.minimum === "number" ? schema.minimum : 0;
    const max = typeof schema.maximum === "number" ? schema.maximum : min;
    const value = Math.min(Math.max(min, 0), max);
    return rawType === "integer" ? Math.ceil(value) : value;
  }
  if (rawType === "boolean") return false;
  if (rawType === "array") {
    const count = typeof schema.minItems === "number" ? schema.minItems : 0;
    return Array.from({ length: count }, () => sampleValue(schema.items, depth + 1));
  }
  if (rawType === "object" || schema.properties) return sampleObject(schema, depth);
  if (schema.format === "uri" || schema.format === "uri-reference") return "https://example.com/fixture";
  const length = typeof schema.minLength === "number" ? schema.minLength : 7;
  return "fixture".padEnd(length, "x").slice(0, Math.max(length, 7));
}
