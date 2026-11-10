import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunReport } from "../types/run.js";
import { swarmDataDir } from "../core/data-dirs.js";

export interface StoredRun extends RunReport {
  principal?: string;
  scheduleId?: string;
  storedAt: string;
}

const DEFAULT_DIR = join(swarmDataDir(), "runs");

export class RunStore {
  constructor(private readonly dir = DEFAULT_DIR) {}

  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async save(report: RunReport, meta?: { principal?: string; scheduleId?: string }): Promise<string> {
    await this.ensure();
    const stored: StoredRun = {
      ...report,
      principal: meta?.principal,
      scheduleId: meta?.scheduleId,
      storedAt: new Date().toISOString(),
    };
    const path = join(this.dir, `${report.id}.json`);
    await writeFile(path, JSON.stringify(stored, null, 2), "utf8");
    return path;
  }

  async get(id: string): Promise<StoredRun | null> {
    try {
      return JSON.parse(await readFile(join(this.dir, `${id}.json`), "utf8")) as StoredRun;
    } catch {
      return null;
    }
  }

  private readonly fileCache = new Map<string, { mtimeMs: number; size: number; run: StoredRun }>();

  async list(limit = 50): Promise<StoredRun[]> {
    await this.ensure();
    try {
      const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"));
      const loaded = await Promise.all(
        files.map(async (file): Promise<StoredRun | null> => {
          const full = join(this.dir, file);
          const st = await stat(full).catch(() => null);
          if (!st) {
            this.fileCache.delete(full);
            return null;
          }
          const cached = this.fileCache.get(full);
          if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
            return cached.run;
          }
          try {
            const run = JSON.parse(await readFile(full, "utf8")) as StoredRun;
            this.fileCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, run });
            return run;
          } catch {
            return null;
          }
        }),
      );
      return loaded
        .filter((r): r is StoredRun => r !== null)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  async latest(): Promise<StoredRun | null> {
    const runs = await this.list(1);
    return runs[0] ?? null;
  }
}

export const defaultRunStore = new RunStore();
