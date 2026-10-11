import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types";

const validator = new AjvJsonSchemaValidator();

export type ContractShape =
  | "initialize"
  | "ping"
  | "tools/list"
  | "tools/call"
  | "resources/list"
  | "resources/read"
  | "resource-templates"
  | "prompts/list"
  | "prompts/get"
  | "completion"
  | "logging";

export interface ContractExpect {
  resultShape: ContractShape;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export function schemaAccepts(schema: Record<string, unknown> | undefined, value: unknown): boolean {
  if (!schema) return true;
  return validateAgainstSchema(schema, value) === null;
}

export function validateAgainstSchema(schema: Record<string, unknown>, value: unknown): string | null {
  try {
    const check = validator.getValidator(schema as JsonSchemaType);
    const result = check(value);
    return result.valid ? null : result.errorMessage;
  } catch (error) {
    return error instanceof Error ? error.message : "schema_rejected";
  }
}

/** Returns a failure message when a live response breaks the MCP contract. */
export function contractFailure(expect: ContractExpect, result: unknown): string | null {
  switch (expect.resultShape) {
    case "initialize":
      return checkInitialize(result);
    case "ping":
    case "logging":
      return isObject(result) ? null : `${expect.resultShape} result must be an object`;
    case "tools/list":
      return checkToolsList(result);
    case "tools/call":
      return checkToolCall(result, expect.outputSchema);
    case "resources/list":
      return checkNamedList(result, "resources", ["uri", "name"]);
    case "resources/read":
      return checkResourceRead(result);
    case "resource-templates":
      return checkNamedList(result, "resourceTemplates", ["uriTemplate", "name"]);
    case "prompts/list":
      return checkPromptsList(result);
    case "prompts/get":
      return checkPromptGet(result);
    case "completion":
      return checkCompletion(result);
    default:
      return `unknown contract ${String(expect.resultShape)}`;
  }
}

function checkInitialize(result: unknown): string | null {
  if (!isObject(result)) return "initialize result must be an object";
  const info = isObject(result.serverInfo) ? result.serverInfo : result;
  if (typeof info.name !== "string" || info.name.length === 0) {
    return "initialize result is missing server name";
  }
  if (typeof info.version !== "string" || info.version.length === 0) {
    return "initialize result is missing server version";
  }
  if (!isObject(result.capabilities)) return "initialize result is missing capabilities";
  return null;
}

function checkToolsList(result: unknown): string | null {
  if (!isObject(result) || !Array.isArray(result.tools)) return "tools/list result is missing tools";
  for (const tool of result.tools) {
    if (!isObject(tool) || typeof tool.name !== "string" || tool.name.length === 0) {
      return "tools/list tool is missing name";
    }
    if (!isObject(tool.inputSchema)) return `tools/list ${tool.name} inputSchema must be an object`;
    if (tool.inputSchema.type !== "object") return `tools/list ${tool.name} inputSchema.type must be object`;
    if (tool.outputSchema !== undefined) {
      if (!isObject(tool.outputSchema) || tool.outputSchema.type !== "object") {
        return `tools/list ${tool.name} outputSchema.type must be object`;
      }
    }
  }
  return null;
}

function checkToolCall(result: unknown, outputSchema: Record<string, unknown> | undefined): string | null {
  if (!isObject(result)) return "tools/call result must be an object";
  if (result.content !== undefined) {
    if (!Array.isArray(result.content)) return "tools/call content must be an array";
    for (const item of result.content) {
      if (!isObject(item) || typeof item.type !== "string") return "tools/call content item is missing type";
    }
  }
  if (outputSchema) {
    if (!isObject(result.structuredContent)) {
      return "tools/call result is missing structuredContent required by outputSchema";
    }
    const error = validateAgainstSchema(outputSchema, result.structuredContent);
    if (error) return `structuredContent does not match outputSchema: ${error}`;
    return null;
  }
  if (result.content === undefined && result.structuredContent === undefined) {
    return "tools/call result has no content";
  }
  return null;
}

function checkResourceRead(result: unknown): string | null {
  if (!isObject(result) || !Array.isArray(result.contents)) return "resources/read result is missing contents";
  for (const item of result.contents) {
    if (!isObject(item) || typeof item.uri !== "string") return "resources/read content is missing uri";
    const hasText = typeof item.text === "string";
    const hasBlob = typeof item.blob === "string";
    if (hasText === hasBlob) return "resources/read content must include text or blob";
  }
  return null;
}

function checkPromptsList(result: unknown): string | null {
  if (!isObject(result) || !Array.isArray(result.prompts)) return "prompts/list result is missing prompts";
  for (const prompt of result.prompts) {
    if (!isObject(prompt) || typeof prompt.name !== "string" || prompt.name.length === 0) {
      return "prompts/list prompt is missing name";
    }
    if (prompt.arguments !== undefined) {
      if (!Array.isArray(prompt.arguments)) return `prompts/list ${prompt.name} arguments must be an array`;
      for (const argument of prompt.arguments) {
        if (!isObject(argument) || typeof argument.name !== "string") {
          return `prompts/list ${prompt.name} argument is missing name`;
        }
      }
    }
  }
  return null;
}

function checkPromptGet(result: unknown): string | null {
  if (!isObject(result) || !Array.isArray(result.messages)) return "prompts/get result is missing messages";
  for (const message of result.messages) {
    if (!isObject(message)) return "prompts/get message must be an object";
    if (message.role !== "user" && message.role !== "assistant") return "prompts/get message role is invalid";
    if (!isObject(message.content)) return "prompts/get message is missing content";
  }
  return null;
}

function checkCompletion(result: unknown): string | null {
  if (!isObject(result) || !isObject(result.completion)) return "completion result is missing completion";
  if (!Array.isArray(result.completion.values) || result.completion.values.some((value) => typeof value !== "string")) {
    return "completion.values must be an array of strings";
  }
  if (result.completion.total !== undefined && typeof result.completion.total !== "number") {
    return "completion.total must be a number";
  }
  if (result.completion.hasMore !== undefined && typeof result.completion.hasMore !== "boolean") {
    return "completion.hasMore must be a boolean";
  }
  return null;
}

function checkNamedList(result: unknown, key: string, fields: string[]): string | null {
  if (!isObject(result) || !Array.isArray(result[key])) return `${key} result is missing ${key}`;
  for (const item of result[key] as unknown[]) {
    if (!isObject(item)) return `${key} entry must be an object`;
    for (const field of fields) {
      if (typeof item[field] !== "string" || (item[field] as string).length === 0) {
        return `${key} entry is missing ${field}`;
      }
    }
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
