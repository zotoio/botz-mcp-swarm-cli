import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

/**
 * Load gitignored env files into process.env.
 * A variable already set in the environment is left alone.
 * `.env.local` is applied before `.env`, so it wins when both define a key.
 */
export function loadLocalEnv(cwd = process.cwd()): void {
  for (const name of [".env.local", ".env"]) {
    const path = resolve(cwd, name);
    if (existsSync(path)) loadEnvFile(path);
  }
}
