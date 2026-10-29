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

/**
 * CLI-03: variables inherited by stdio MCP servers. Everything else in the parent environment
 * (API keys, cloud credentials, tokens) is withheld unless configured on the target's `env`
 * or named in SWARM_STDIO_PASS_ENV (comma-separated).
 */
export const STDIO_ENV_ALLOWLIST: readonly string[] = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "COLORTERM",
  "TMPDIR", "TMP", "TEMP", "TZ", "PWD",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  // Windows essentials
  "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "PATHEXT", "WINDIR", "windir",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ProgramData", "PROGRAMFILES", "ProgramFiles", "Path",
];

export function buildStdioEnv(
  userEnv?: Record<string, string>,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const pass = new Set<string>(STDIO_ENV_ALLOWLIST);
  for (const name of (parentEnv.SWARM_STDIO_PASS_ENV ?? "").split(",")) {
    if (name.trim()) pass.add(name.trim());
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (pass.has(key) || key.startsWith("LC_")) env[key] = value;
  }
  return { ...env, ...userEnv };
}
