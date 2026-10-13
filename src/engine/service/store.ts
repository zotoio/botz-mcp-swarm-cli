import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { OptimizeSuggestion } from "../core/discovery.js";
import { defaultRunStore, type StoredRun } from "../store/run-store.js";
import type { RunReport } from "../types/run.js";
import type { OptimizeHistoryEntry } from "../core/llm-optimize.js";
import { loadOptimizeHistory, saveOptimizeHistory } from "../store/optimize-history.js";
import { normalizePolicy, type OrgPolicy } from "./policy.js";
import { swarmDataDir } from "../core/data-dirs.js";

export type { OrgPolicy } from "./policy.js";

export interface Schedule {
  id: string;
  cron: string;
  /** Checked-in example. Empty when projectId and suiteId name the run. */
  manifestRef: string;
  owner: string;
  enabled: boolean;
  description: string;
  projectId?: string;
  suiteId?: string;
  /** Missing uses the suite's field, then `local`. Applies to project suite schedules only. */
  dispatch?: "local" | "worker";
  lastRunAt?: string;
  nextRunAt?: string;
}

const DATA_DIR = swarmDataDir();

export async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

export async function loadPolicy(): Promise<OrgPolicy> {
  await ensureDataDir();
  try {
    const raw = await readFile(join(DATA_DIR, "policy.json"), "utf8");
    return normalizePolicy(JSON.parse(raw) as Partial<OrgPolicy>);
  } catch {
    return normalizePolicy({});
  }
}

export async function savePolicy(policy: OrgPolicy): Promise<void> {
  await ensureDataDir();
  const normalized = normalizePolicy(policy);
  await writeFile(join(DATA_DIR, "policy.json"), JSON.stringify(normalized, null, 2));
}

export async function loadSchedules(): Promise<Schedule[]> {
  await ensureDataDir();
  try {
    const raw = await readFile(join(DATA_DIR, "schedules.json"), "utf8");
    return JSON.parse(raw) as Schedule[];
  } catch {
    return [];
  }
}

export async function saveSchedules(schedules: Schedule[]): Promise<void> {
  await ensureDataDir();
  await writeFile(join(DATA_DIR, "schedules.json"), JSON.stringify(schedules, null, 2));
}

export async function persistRun(
  report: RunReport,
  meta?: { principal?: string; scheduleId?: string },
): Promise<void> {
  await defaultRunStore.save(report, meta);
}

export async function loadLatestRun(): Promise<StoredRun | null> {
  return defaultRunStore.latest();
}

export async function loadRecentRuns(limit = 20): Promise<StoredRun[]> {
  return defaultRunStore.list(limit);
}

export async function loadOptimizeDrafts(): Promise<OptimizeSuggestion[]> {
  await ensureDataDir();
  try {
    const raw = await readFile(join(DATA_DIR, "optimize-drafts.json"), "utf8");
    return JSON.parse(raw) as OptimizeSuggestion[];
  } catch {
    return [];
  }
}

export async function saveOptimizeDrafts(drafts: OptimizeSuggestion[]): Promise<void> {
  await ensureDataDir();
  await writeFile(join(DATA_DIR, "optimize-drafts.json"), JSON.stringify(drafts, null, 2));
}

export async function getOptimizeHistory(): Promise<OptimizeHistoryEntry[]> {
  return loadOptimizeHistory();
}

export async function addOptimizeHistory(entry: OptimizeHistoryEntry): Promise<void> {
  const history = await loadOptimizeHistory();
  history.unshift(entry);
  await saveOptimizeHistory(history.slice(0, 200));
}
