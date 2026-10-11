import { existsSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { Target } from "../types/manifest.js";
import { findRepoRoot } from "./repo-root.js";

export class StdioPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StdioPathError";
  }
}

function rejectUnsafeCommandSegments(command: string): void {
  if (command.includes("\0")) {
    throw new StdioPathError("stdio_command_invalid");
  }
  const normalized = command.replace(/\\/g, "/");
  if (normalized.includes("..")) {
    throw new StdioPathError("stdio_command_traversal");
  }
}

export function assertPathWithinRoot(absolutePath: string, root: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(absolutePath);
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(prefix)) {
    throw new StdioPathError(`stdio_command_outside_repo: ${absolutePath}`);
  }
}

function resolveCommandPath(command: string, cwd: string, repoRoot: string): string {
  rejectUnsafeCommandSegments(command);
  let absolute = isAbsolute(command) ? command : resolve(cwd, command);
  if (!isAbsolute(command) && !existsSync(absolute) && !command.includes("/")) {
    return command;
  }
  assertPathWithinRoot(absolute, repoRoot);
  return absolute;
}

export function resolveStdioTarget(target: Target, baseDir?: string): Target {
  if (target.transport !== "stdio") return target;

  const root = findRepoRoot(baseDir ?? process.cwd());
  const cwd = target.cwd ? resolve(target.cwd) : root;
  assertPathWithinRoot(cwd, root);

  let command = target.command;
  rejectUnsafeCommandSegments(command);

  if (command.endsWith(".sh")) {
    const scriptPath = isAbsolute(command)
      ? command
      : resolveCommandPath(command, cwd, root);
    return { ...target, command: scriptPath, args: target.args ?? [], cwd };
  }
  if (!isAbsolute(command) && existsSync(join(cwd, command))) {
    command = resolveCommandPath(command, cwd, root);
  } else if (
    command === "bash" &&
    target.args?.length === 1 &&
    target.args[0].endsWith("run.sh")
  ) {
    const script = isAbsolute(target.args[0])
      ? target.args[0]
      : resolveCommandPath(target.args[0], cwd, root);
    return { ...target, command: script, args: [], cwd };
  } else if (command.endsWith("run.sh") && !isAbsolute(command)) {
    command = resolveCommandPath(command, cwd, root);
  }

  if (target.args) {
    for (const arg of target.args) {
      rejectUnsafeCommandSegments(arg);
    }
  }

  return { ...target, command, cwd };
}

export function buildStdioEnv(
  userEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = { ...process.env, ...userEnv } as Record<
    string,
    string
  >;
  delete env.NPM_CONFIG_PREFIX;
  return env;
}
