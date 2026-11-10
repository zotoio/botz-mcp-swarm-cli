import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolResultValidator } from "../engine/core/runner.js";
import type { McpCallResult } from "../engine/adapters/base.js";

type ValidateFn = (ctx: { tool?: string; method: string; result: McpCallResult }) => string | null | Promise<string | null>;

function pickValidate(mod: unknown): ValidateFn | undefined {
  if (!mod || typeof mod !== "object") return undefined;
  const record = mod as { validate?: unknown; default?: unknown };
  if (typeof record.validate === "function") return record.validate as ValidateFn;
  if (record.default && typeof record.default === "object" && typeof (record.default as { validate?: unknown }).validate === "function") {
    return (record.default as { validate: ValidateFn }).validate;
  }
  return undefined;
}

export async function loadToolResultValidator(modulePath: string, baseDir: string): Promise<ToolResultValidator> {
  const resolved = path.resolve(baseDir, modulePath);
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(resolved).href);
  } catch {
    throw new Error(`validator module not found or not loadable (${modulePath}); path is relative to the suite directory`);
  }
  const validate = pickValidate(mod);
  if (!validate) {
    throw new Error(`validator module must export validate({ tool, method, result }) => string | null (${modulePath})`);
  }
  return async (ctx) => {
    const message = await validate(ctx);
    if (message == null) return null;
    if (typeof message !== "string") {
      throw new Error("validator validate() must return string or null");
    }
    return message;
  };
}
