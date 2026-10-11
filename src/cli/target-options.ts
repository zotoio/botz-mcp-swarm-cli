import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import { TargetSchema } from "../engine/types/manifest.js";

export interface TargetOptions { url?: string; targetFile?: string }
export function addTargetOptions(command: Command): Command {
  return command.option("--url <url>", "Replace the HTTP endpoint; supply its credentials explicitly")
    .option("--target-file <path>", "Replace the complete target from JSON; stdio paths resolve from cwd");
}
export async function targetOptions(opts: TargetOptions) {
  if (opts.url && opts.targetFile) throw new Error("provide --url or --target-file, not both");
  return { url: opts.url, target: opts.targetFile ? TargetSchema.parse(JSON.parse(await readFile(resolve(opts.targetFile), "utf8"))) : undefined };
}
