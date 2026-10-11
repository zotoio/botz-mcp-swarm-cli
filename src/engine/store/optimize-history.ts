import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OptimizeHistoryEntry } from "../core/llm-optimize.js";

const PATH = join(process.cwd(), ".swarm-data", "optimize-history.json");

export async function loadOptimizeHistory(): Promise<OptimizeHistoryEntry[]> {
  try {
    return JSON.parse(await readFile(PATH, "utf8")) as OptimizeHistoryEntry[];
  } catch {
    return [];
  }
}

export async function saveOptimizeHistory(entries: OptimizeHistoryEntry[]): Promise<void> {
  await mkdir(join(process.cwd(), ".swarm-data"), { recursive: true });
  await writeFile(PATH, JSON.stringify(entries, null, 2), "utf8");
}

export async function appendOptimizeHistory(entry: OptimizeHistoryEntry): Promise<void> {
  const entries = await loadOptimizeHistory();
  entries.unshift(entry);
  await saveOptimizeHistory(entries.slice(0, 200));
}
