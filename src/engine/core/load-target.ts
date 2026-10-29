import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TargetSchema, type Target } from "../types/manifest.js";

export async function loadTargetFromOptions(opts: {
  target?: string;
  targetFile?: string;
  /** --protocol-era: legacy | auto | modern (overrides the target's own setting). */
  protocolEra?: string;
}): Promise<Target> {
  const era = opts.protocolEra ? { protocolEra: opts.protocolEra } : {};
  if (opts.targetFile) {
    const raw = JSON.parse(await readFile(resolve(opts.targetFile), "utf8"));
    return TargetSchema.parse({ ...raw, ...era });
  }
  if (opts.target) {
    return TargetSchema.parse({ ...JSON.parse(opts.target), ...era });
  }
  throw new Error("Provide --target <json> or --target-file <path>");
}
