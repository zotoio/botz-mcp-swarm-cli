import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { TargetSchema, type Target } from "../engine/types/manifest.js";
import { collect } from "./suite-commands.js";

export interface TargetOptions { url?: string; targetFile?: string; target?: string[] }

const ServersFileSchema = z.object({ servers: z.record(z.string(), TargetSchema) }).strict();

export function addTargetOptions(command: Command): Command {
  return command.option("--url <url>", "Replace the default server's HTTP endpoint; supply its credentials explicitly")
    .option("--target <alias=url>", "Replace one server's HTTP endpoint; supply its credentials explicitly. Repeatable", collect, [])
    .option("--target-file <path>", "Replace a complete target, or several as { \"servers\": { alias: target } }; stdio paths resolve from cwd");
}

/** `--url`, `--target alias=url`, and `--target-file` as run options. Credentials never carry over to a replaced target. */
export async function targetOptions(opts: TargetOptions): Promise<{ url?: string; target?: Target; targets?: Record<string, Target | string> }> {
  if (opts.url && opts.targetFile) throw new Error("provide --url or --target-file, not both");
  const targets: Record<string, Target | string> = {};
  let target: Target | undefined;
  if (opts.targetFile) {
    const raw = JSON.parse(await readFile(resolve(opts.targetFile), "utf8")) as unknown;
    if (raw && typeof raw === "object" && "servers" in raw) Object.assign(targets, ServersFileSchema.parse(raw).servers);
    else target = TargetSchema.parse(raw);
  }
  for (const item of opts.target ?? []) {
    const eq = item.indexOf("=");
    if (eq <= 0) throw new Error(`--target must be alias=url: ${item}`);
    const alias = item.slice(0, eq);
    if (targets[alias]) throw new Error(`--target ${alias} is given more than once`);
    targets[alias] = item.slice(eq + 1);
  }
  return { url: opts.url, ...(target ? { target } : {}), ...(Object.keys(targets).length > 0 ? { targets } : {}) };
}
