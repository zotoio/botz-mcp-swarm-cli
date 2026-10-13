import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Command } from "commander";
import { atomicWrite } from "./file-store.js";
import { displayPath, ensureBotzHome, resolveBotzHome, type BotzHome, type CliConfig } from "./botz-home.js";
import { otelStoreDir, swarmDataDir } from "../engine/core/data-dirs.js";

/** One file or directory an upgrade moves or merges. Paths are display forms, never absolute. */
export type UpgradeAction = {
  step: string;
  since: string;
  kind: "move" | "merge";
  from: string;
  to: string;
  state: "pending" | "applied" | "conflict";
  reason?: string;
};

type Planned = UpgradeAction & { source: string; target: string };

type Context = {
  botz: BotzHome;
  /** Git root (else home) for legacy `.botz` files. */
  base: string;
  /** Git root (else the cwd) and the cwd, for legacy reports and service state. Never home itself. */
  roots: string[];
};

type Migration = {
  id: string;
  /** CLI version that changed the layout. */
  since: string;
  plan(ctx: Context): Promise<Planned[]>;
};

const REPORT_NAME = /^botz-run-.+\.(json|md)$/;

/**
 * Layout migrations in release order. Add a step when a release moves or renames a file the CLI
 * or service owns; keep old steps so consumers can upgrade across several releases at once.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: "legacy-suites",
    since: "0.6.0",
    async plan({ botz, base }) {
      const legacy = join(base, ".botz", "suites");
      const names = await dirNames(legacy);
      return names
        .filter((name) => existsSync(join(legacy, name, "suite.json")))
        .map((name) => move(this, botz, join(legacy, name), join(botz.suitesDir, name)));
    },
  },
  {
    id: "legacy-credentials",
    since: "0.6.0",
    async plan({ botz, base }) {
      const legacy = join(base, ".botz", "config.json");
      if (!existsSync(legacy)) return [];
      const { reason: _exists, ...merge } = move(this, botz, legacy, join(botz.dir, "config.json"));
      return [{ ...merge, kind: "merge", state: "pending" }];
    },
  },
  {
    id: "legacy-skill-registry",
    since: "0.6.0",
    async plan({ botz, base }) {
      const legacy = join(base, ".botz", "skill-installations.json");
      return existsSync(legacy) ? [move(this, botz, legacy, join(botz.dir, "skill-installations.json"))] : [];
    },
  },
  {
    id: "legacy-reports",
    since: "0.6.0",
    async plan({ botz, roots }) {
      const planned: Planned[] = [];
      for (const root of roots) {
        for (const name of await entryNames(join(root, ".runs"))) {
          planned.push(move(this, botz, join(root, ".runs", name), join(botz.runsDir, name)));
        }
        for (const name of (await entryNames(root)).filter((entry) => REPORT_NAME.test(entry))) {
          planned.push(move(this, botz, join(root, name), join(botz.runsDir, name)));
        }
      }
      return planned;
    },
  },
  {
    id: "service-state",
    since: "0.6.1",
    async plan({ botz, roots }) {
      return roots.flatMap((root) => [
        [join(root, ".swarm-data"), swarmDataDir(root)],
        [join(root, ".otel"), otelStoreDir(root)],
      ]
        .filter(([from]) => existsSync(from!))
        .map(([from, to]) => move(this, botz, from!, to!)));
    },
  },
];

function move(step: Migration, botz: BotzHome, source: string, target: string): Planned {
  const exists = existsSync(target);
  return {
    step: step.id,
    since: step.since,
    kind: "move",
    from: displayPath(source, botz, basename(source)),
    to: displayPath(target, botz, basename(target)),
    state: exists ? "conflict" : "pending",
    ...(exists ? { reason: "target already exists; merge or remove one copy by hand" } : {}),
    source,
    target,
  };
}

async function entryNames(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [])).sort();
}

async function dirNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function readConfigFile(path: string): Promise<CliConfig> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid CLI config; expected an object");
  return parsed as CliConfig;
}

/** Legacy credentials fill gaps; values already in the new file win key by key. */
async function mergeCredentials(source: string, target: string): Promise<void> {
  const older = await readConfigFile(source);
  const newer = await readConfigFile(target);
  const suites: NonNullable<CliConfig["suites"]> = {};
  for (const layer of [older, newer]) {
    for (const [name, entry] of Object.entries(layer.suites ?? {})) {
      suites[name] = { ...suites[name], ...entry, credentials: { ...suites[name]?.credentials, ...entry?.credentials } };
    }
  }
  await mkdir(dirname(target), { recursive: true });
  await atomicWrite(target, `${JSON.stringify({ ...older, ...newer, suites }, null, 2)}\n`);
  await rm(source);
}

async function relocate(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(source, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await rm(source, { recursive: true });
  }
}

export async function planUpgrade(botz: BotzHome): Promise<Planned[]> {
  const base = botz.repoRoot ?? botz.home;
  const ctx: Context = { botz, base, roots: [...new Set([botz.repoRoot ?? botz.cwd, botz.cwd])] };
  const planned: Planned[] = [];
  for (const migration of MIGRATIONS) planned.push(...(await migration.plan(ctx)));
  return planned;
}

/** Applies pending moves in order. Conflicts are left in place and reported. */
export async function applyUpgrade(botz: BotzHome, planned: Planned[]): Promise<Planned[]> {
  if (planned.some((action) => action.state === "pending")) await ensureBotzHome(botz);
  for (const action of planned) {
    if (action.state !== "pending") continue;
    if (action.kind === "merge") await mergeCredentials(action.source, action.target);
    else await relocate(action.source, action.target);
    action.state = "applied";
  }
  const base = botz.repoRoot ?? botz.home;
  for (const dir of [join(base, ".botz", "suites"), ...new Set([botz.repoRoot ?? botz.cwd, botz.cwd].map((root) => join(root, ".runs")))]) {
    await rmdir(dir).catch(() => undefined);
  }
  return planned;
}

const publicAction = ({ source: _source, target: _target, ...action }: Planned): UpgradeAction => action;

export function registerUpgradeCommand(program: Command): void {
  program
    .command("upgrade")
    .description("Move files from earlier CLI layouts into .botz/mcp-swarm (preview unless --apply)")
    .option("--apply", "Move and merge the listed files", false)
    .option("--json", "Print structured results")
    .action(async (opts: { apply?: boolean; json?: boolean }) => {
      try {
        const botz = resolveBotzHome();
        let planned = await planUpgrade(botz);
        if (opts.apply) planned = await applyUpgrade(botz, planned);
        const actions = planned.map(publicAction);
        const pending = actions.filter((action) => action.state === "pending").length;
        const conflicts = actions.filter((action) => action.state === "conflict").length;
        if (opts.json) {
          console.log(JSON.stringify({ home: botz.display, applied: Boolean(opts.apply), actions }, null, 2));
        } else if (!actions.length) {
          console.log(`Up to date: nothing to move into ${botz.display}.`);
        } else {
          for (const action of actions) {
            console.log(`${action.state.padEnd(8)} ${action.since.padEnd(6)} ${action.step.padEnd(22)} ${action.from} -> ${action.to}${action.reason ? ` (${action.reason})` : ""}`);
          }
          if (pending) console.log(`${pending} pending. Run upgrade --apply to move them.`);
          if (opts.apply && botz.repoRoot) console.log("Review git status, then stage moved suites with: git add -A .botz");
        }
        if (conflicts) process.exitCode = 1;
      } catch (error) {
        if (opts.json) console.log(JSON.stringify({ error: { message: error instanceof Error ? error.message : "upgrade failed" } }));
        else console.error(`Error: ${error instanceof Error ? error.message : "upgrade failed"}`);
        process.exitCode = 2;
      }
    });
}
