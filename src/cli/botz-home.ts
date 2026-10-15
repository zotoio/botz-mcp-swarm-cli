import { atomicWrite, withFileLock } from "./file-store.js";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Where standalone suites, run reports, and CLI config live: `<repo>/.botz/mcp-swarm` inside a git
 * work tree, else `~/.botz/mcp-swarm`. Inside a repo, `~/.botz/mcp-swarm` is a read-only fallback:
 * repo settings, suites, and credentials take precedence over the home ones.
 */
export type BotzHome = {
  /** Absolute `.botz/mcp-swarm` directory that writes go to. Never printed. */
  dir: string;
  /** `.botz/mcp-swarm` inside a repo, `~/.botz/mcp-swarm` outside. */
  display: string;
  /** Absolute suites directory: repo `suitesDir`, else home `suitesDir`, else `<dir>/suites`. */
  suitesDir: string;
  /** Absolute run report directory: repo `runsDir`, else home `runsDir`, else `<dir>/runs`. */
  runsDir: string;
  /** Home layer read after the repo one, or null outside a repo. */
  user: { dir: string; suitesDir: string } | null;
  /** Git work tree root that contains the cwd, or null. */
  repoRoot: string | null;
  home: string;
  cwd: string;
};

export type CliConfig = {
  suites?: Record<string, { credentials?: Record<string, string> }>;
};

/** `<dir>/settings.json`. Relative paths resolve from the git root for the repo file, else from home. */
export type BotzSettings = {
  suitesDir?: string;
  runsDir?: string;
};

export const PLUGIN_DIR = "mcp-swarm";
export const SETTINGS_FILE = "settings.json";
const GITIGNORE_LINES = ["config.json", "config.json.*", "runs/", "data/", "otel/"];

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
  const userDir = join(home, ".botz", PLUGIN_DIR);
  const userSettings = readSettings(userDir, `~/.botz/${PLUGIN_DIR}`);
  const fromHome = (value: string | undefined) => value === undefined ? undefined : resolve(home, expandHome(value, home));
  const userSuites = fromHome(userSettings.suitesDir);
  const userRuns = fromHome(userSettings.runsDir);
  if (!repoRoot) {
    return {
      dir: userDir,
      display: `~/.botz/${PLUGIN_DIR}`,
      suitesDir: userSuites ?? join(userDir, "suites"),
      runsDir: userRuns ?? join(userDir, "runs"),
      user: null,
      repoRoot,
      home,
      cwd,
    };
  }
  const dir = join(repoRoot, ".botz", PLUGIN_DIR);
  const display = `.botz/${PLUGIN_DIR}`;
  const settings = readSettings(dir, display);
  const fromRepo = (value: string | undefined) => value === undefined ? undefined : resolve(repoRoot, expandHome(value, home));
  return {
    dir,
    display,
    suitesDir: fromRepo(settings.suitesDir) ?? userSuites ?? join(dir, "suites"),
    runsDir: fromRepo(settings.runsDir) ?? userRuns ?? join(dir, "runs"),
    user: { dir: userDir, suitesDir: userSuites ?? join(userDir, "suites") },
    repoRoot,
    home,
    cwd,
  };
}

function readSettings(dir: string, display: string): BotzSettings {
  const path = join(dir, SETTINGS_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const where = `${display}/${SETTINGS_FILE}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid ${where}; expected JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`invalid ${where}; expected an object`);
  const settings: BotzSettings = {};
  for (const key of ["suitesDir", "runsDir"] as const) {
    const value = (parsed as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim()) throw new Error(`invalid ${where}; ${key} must be a non-empty path`);
    settings[key] = value.trim();
  }
  return settings;
}

/** Config directories, highest precedence first: repo, its legacy `.botz`, then home and its legacy `.botz`. */
function configDirs(botz: BotzHome): string[] {
  const dirs = [botz.dir, dirname(botz.dir)];
  if (botz.user) dirs.push(botz.user.dir, dirname(botz.user.dir));
  return dirs;
}

/** Suite directories in lookup order; the legacy `.botz/suites` follows each layer. */
export function suiteSearchDirs(botz: BotzHome): string[] {
  const dirs = [botz.suitesDir, join(dirname(botz.dir), "suites")];
  if (botz.user) dirs.push(botz.user.suitesDir, join(dirname(botz.user.dir), "suites"));
  return [...new Set(dirs)];
}

/** A suite name as a single directory segment. */
export function suiteDirName(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|-+$/g, "");
  return cleaned || "suite";
}

export function defaultSuiteDir(botz: BotzHome, name: string): string {
  return join(botz.suitesDir, suiteDirName(name));
}

/**
 * `--suite` value to a directory. A path that holds `suite.json` wins; a bare name is looked up in
 * the repo suites, then the home suites (each followed by its legacy `.botz/suites`).
 */
export function resolveSuiteArg(value: string, botz: BotzHome): string {
  const asPath = resolve(botz.cwd, value);
  if (existsSync(join(asPath, "suite.json"))) return asPath;
  const bare = !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
  if (bare) {
    for (const dir of suiteSearchDirs(botz)) {
      const named = join(dir, suiteDirName(value));
      if (existsSync(join(named, "suite.json"))) return named;
    }
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

/**
 * Creates the `.botz/mcp-swarm` directory. Inside a repo, its `.gitignore` ignores `config.json`,
 * `runs/`, `data/`, and `otel/` and leaves `suites/` and `settings.json` tracked.
 */
export async function ensureBotzHome(botz: BotzHome): Promise<void> {
  await mkdir(botz.dir, { recursive: true });
  if (!botz.repoRoot) return;
  const path = join(botz.dir, ".gitignore");
  const existing = await readFile(path, "utf8").catch(() => null);
  if (existing === null) {
    await writeFile(path, `${GITIGNORE_LINES.join("\n")}\n`);
    return;
  }
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  const missing = GITIGNORE_LINES.filter((line) => !lines.includes(line));
  if (missing.length) await writeFile(path, `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}${missing.join("\n")}\n`);
}

async function readConfig(dir: string): Promise<CliConfig | null> {
  const raw = await readFile(join(dir, "config.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid CLI config; expected an object");
  return parsed as CliConfig;
}

/**
 * Merged credentials view. Each layer reads `config.json`, else its legacy `.botz/config.json`;
 * repo credentials override home ones key by key.
 */
export async function loadCliConfig(botz: BotzHome): Promise<CliConfig> {
  const dirs = configDirs(botz);
  const layers: CliConfig[] = [];
  for (let index = 0; index < dirs.length; index += 2) {
    const config = (await readConfig(dirs[index]!)) ?? (await readConfig(dirs[index + 1]!));
    if (config) layers.unshift(config);
  }
  const suites: NonNullable<CliConfig["suites"]> = {};
  for (const layer of layers) {
    for (const [name, entry] of Object.entries(layer.suites ?? {})) {
      suites[name] = { ...suites[name], ...entry, credentials: { ...suites[name]?.credentials, ...entry?.credentials } };
    }
  }
  return Object.assign({}, ...layers, { suites });
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
    const config = (await readConfig(botz.dir)) ?? (await readConfig(dirname(botz.dir))) ?? {};
    const suites = { ...(config.suites ?? {}) };
    suites[suiteName] = { ...suites[suiteName], credentials: { ...suites[suiteName]?.credentials, ...credentials } };
    const path = join(botz.dir, "config.json");
    await atomicWrite(path, `${JSON.stringify({ ...config, suites }, null, 2)}\n`);
  });
}

/** Renames saved credential names from one prefix to another, for a server whose alias changed. */
export async function renameSuiteCredentials(botz: BotzHome, suiteName: string, from: string, to: string): Promise<string[]> {
  const renamed: string[] = [];
  await withFileLock(join(botz.dir, "config.json.lock"), async () => {
    const config = await readConfig(botz.dir);
    const entry = config?.suites?.[suiteName];
    if (!config || !entry?.credentials) return;
    const credentials: Record<string, string> = {};
    for (const [name, value] of Object.entries(entry.credentials)) {
      const next = name.startsWith(from) ? `${to}${name.slice(from.length)}` : name;
      if (next !== name) renamed.push(next);
      credentials[next] = value;
    }
    if (renamed.length === 0) return;
    const suites = { ...config.suites, [suiteName]: { ...entry, credentials } };
    await atomicWrite(join(botz.dir, "config.json"), `${JSON.stringify({ ...config, suites }, null, 2)}\n`);
  });
  return renamed;
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
