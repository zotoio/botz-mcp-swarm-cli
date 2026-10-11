import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_MARKER = "pnpm-workspace.yaml";

export function findRepoRoot(startDir = process.cwd()): string {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir);
}

/** Repo root relative to this module (works when running from dist/). */
export function moduleRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return findRepoRoot(here);
}
