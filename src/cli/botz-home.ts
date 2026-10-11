import { atomicWrite, withFileLock } from "./file-store.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Where standalone suites and CLI config live: `<repo>/.botz` inside a git work tree, else `~/.botz`. */
export type BotzHome = {
  /** Absolute `.botz` directory. Never printed. */
  dir: string;
  /** `.botz` inside a repo, `~/.botz` outside. */
  display: string;
  /** Git work tree root that contains the cwd, or null. */
  repoRoot: string | null;
  home: string;
  cwd: string;
};

export type CliConfig = {
  suites?: Record<string, { credentials?: Record<string, string> }>;
};

const GITIGNORE_LINE = "config.json";

/** Nearest ancestor of `start` (inclusive) that holds a `.git` directory or worktree file. */
export function findGitRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveBotzHome(options: { cwd?: string; home?: string } = {}): BotzHome {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.home ?? homedir());
  const repoRoot = findGitRoot(cwd);
  if (repoRoot) return { dir: join(repoRoot, ".botz"), display: ".botz", repoRoot, home, cwd };
  return { dir: join(home, ".botz"), display: "~/.botz", repoRoot: null, home, cwd };
}

/** A suite name as a single directory segment. */
export function suiteDirName(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|-+$/g, "");
  return cleaned || "suite";
}

export function defaultSuiteDir(botz: BotzHome, name: string): string {
  return join(botz.dir, "suites", suiteDirName(name));
}

/**
 * `--suite` value to a directory. A path that holds `suite.json` wins; a bare name falls back to
 * `<botz>/suites/<name>`.
 */
export function resolveSuiteArg(value: string, botz: BotzHome): string {
  const asPath = resolve(botz.cwd, value);
  if (existsSync(join(asPath, "suite.json"))) return asPath;
  const bare = !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
  if (bare) {
    const named = defaultSuiteDir(botz, value);
    if (existsSync(join(named, "suite.json"))) return named;
  }
  return asPath;
}

/** `.botz/...` inside the repo, `~/...` under home, cwd-relative otherwise. Falls back to `fallback`. */
export function displayPath(absolute: string, botz: BotzHome, fallback: string): string {
  const target = resolve(absolute);
  if (botz.repoRoot && within(target, botz.repoRoot)) return relative(botz.repoRoot, target) || ".";
  if (within(target, botz.home)) return joinDisplay("~", relative(botz.home, target));
  if (within(target, botz.cwd)) return relative(botz.cwd, target) || ".";
  return fallback;
}

/** Creates the `.botz` directory. Inside a repo, `.botz/.gitignore` ignores `config.json` and leaves `suites/` tracked. */
export async function ensureBotzHome(botz: BotzHome): Promise<void> {
  await mkdir(botz.dir, { recursive: true });
  if (!botz.repoRoot) return;
  const path = join(botz.dir, ".gitignore");
  const existing = await readFile(path, "utf8").catch(() => null);
  if (existing === null) {
    await writeFile(path, `${GITIGNORE_LINE}\nconfig.json.*\n`);
    return;
  }
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  const missing = [GITIGNORE_LINE, "config.json.*"].filter((line) => !lines.includes(line));
  if (missing.length) await writeFile(path, `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}${missing.join("\n")}\n`);
}

export async function loadCliConfig(botz: BotzHome): Promise<CliConfig> {
  const raw = await readFile(join(botz.dir, "config.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid CLI config; expected an object");
  return parsed as CliConfig;
}

export async function suiteCredentials(botz: BotzHome, suiteName: string): Promise<Record<string, string>> {
  const config = await loadCliConfig(botz);
  return { ...(config.suites?.[suiteName]?.credentials ?? {}) };
}

/** Merges literal target credentials for one suite into `config.json` (owner read/write only). */
export async function saveSuiteCredentials(
  botz: BotzHome,
  suiteName: string,
  credentials: Record<string, string>,
): Promise<void> {
  if (Object.keys(credentials).length === 0) return;
  await ensureBotzHome(botz);
  await withFileLock(join(botz.dir, "config.json.lock"), async () => {
    const config = await loadCliConfig(botz);
    const suites = { ...(config.suites ?? {}) };
    suites[suiteName] = { ...suites[suiteName], credentials: { ...suites[suiteName]?.credentials, ...credentials } };
    const path = join(botz.dir, "config.json");
    await atomicWrite(path, `${JSON.stringify({ ...config, suites }, null, 2)}\n`);
  });
}

/** Expands a leading `~/` that a portable suite stores for a path under home. */
export function expandHome(value: string, home: string): string {
  return value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
}

export type PathRoots = { gitRoot: string | null; home: string; cwd: string };

/**
 * A stdio command or arg that names a file rather than a PATH lookup or a flag: absolute, `~/...`,
 * containing a separator, or an existing file under `dir`.
 */
export function isPathLike(value: string, dir: string, bareFiles: boolean): boolean {
  if (!value || value.startsWith("-")) return false;
  if (isAbsolute(value) || value === "~" || value.startsWith("~/")) return true;
  if (value.includes("/") || value.includes("\\")) return existsSync(resolve(dir, value)) || bareFiles;
  return bareFiles && existsSync(join(dir, value));
}

/**
 * Storage form of an absolute path: relative to the git root inside a repo, `~/...` under home,
 * cwd-relative under the cwd, else unchanged.
 */
export function portablePath(absolute: string, roots: PathRoots): string {
  if (roots.gitRoot && within(absolute, roots.gitRoot) && absolute !== roots.gitRoot) {
    return relative(roots.gitRoot, absolute).split(sep).join("/");
  }
  if (within(absolute, roots.home)) return joinDisplay("~", relative(roots.home, absolute));
  if (within(absolute, roots.cwd) && absolute !== roots.cwd) return relative(roots.cwd, absolute).split(sep).join("/");
  return absolute;
}

function within(path: string, root: string): boolean {
  const base = resolve(root);
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  return path === base || path.startsWith(prefix);
}

function joinDisplay(head: string, rest: string): string {
  return rest ? `${head}/${rest.split(sep).join("/")}` : head;
}
