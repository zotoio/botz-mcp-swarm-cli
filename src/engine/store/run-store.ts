import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunReport } from "../types/run.js";

export interface StoredRun extends RunReport {
  principal?: string;
  scheduleId?: string;
  storedAt: string;
}

const DEFAULT_DIR = join(process.cwd(), ".swarm-data", "runs");

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

  async list(limit = 50): Promise<StoredRun[]> {
    await this.ensure();
    try {
      const files = await readdir(this.dir);
      const runs: StoredRun[] = [];
      for (const file of files.filter((f) => f.endsWith(".json"))) {
        runs.push(
          JSON.parse(await readFile(join(this.dir, file), "utf8")) as StoredRun,
        );
      }
      return runs
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
