import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";

/** Readers see the old complete file or the new complete file, never a partial write. */
export async function atomicWrite(path: string, text: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx", mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Serialize read/modify/write across CLI processes. Fail clearly rather than steal a stale lock. */
export async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + 5_000;
  while (true) {
    try { await mkdir(path); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("storage is locked by another CLI process; retry, or remove the .lock directory after confirming that process has stopped");
      await setTimeout(25);
    }
  }
  try { return await operation(); }
  finally { await rm(path, { recursive: true, force: true }); }
}
