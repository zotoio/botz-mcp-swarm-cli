import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TargetSchema, type Target } from "../types/manifest.js";

export async function loadTargetFromOptions(opts: {
  target?: string;
  targetFile?: string;
}): Promise<Target> {
  if (opts.targetFile) {
    const raw = JSON.parse(await readFile(resolve(opts.targetFile), "utf8"));
    return TargetSchema.parse(raw);
  }
  if (opts.target) {
    return TargetSchema.parse(JSON.parse(opts.target));
  }
  throw new Error("Provide --target <json> or --target-file <path>");
}
