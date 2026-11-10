#!/usr/bin/env node
/**
 * Refresh vendored `src/engine/` from a local checkout of botz-mcp-swarm.
 *
 * Usage:
 *   BOTZ_MCP_SWARM_ROOT=/path/to/botz-mcp-swarm node scripts/vendor-engine-from-platform.mjs
 *
 * Runs `scripts/export-engine.mjs` in the platform repo (branch with packages/engine) and
 * writes into this repo's `src/engine/` including ENGINE_SOURCE.json.
 *
 * This script is for maintainers and CI overlays; the public CLI repo does not store platform credentials.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineRoot = path.join(repoRoot, "src", "engine");

const platformRoot = process.env.BOTZ_MCP_SWARM_ROOT?.trim();
if (!platformRoot) {
  console.error("Set BOTZ_MCP_SWARM_ROOT to a checkout of https://github.com/zotoio/botz-mcp-swarm");
  process.exit(2);
}

const exportScript = path.join(platformRoot, "scripts", "export-engine.mjs");
if (!existsSync(exportScript)) {
  console.error(`Missing ${exportScript}. Checkout branch cursor/engine-architecture-1a0b (or main with packages/engine).`);
  process.exit(2);
}

const args = [exportScript, "--target", engineRoot];
if (process.env.ENGINE_SYNC_COMMIT?.trim()) args.push("--commit", process.env.ENGINE_SYNC_COMMIT.trim());

execFileSync(process.execPath, args, { stdio: "inherit", cwd: platformRoot, env: { ...process.env, ENGINE_EXPORT_TARGET: engineRoot } });
console.log(`Vendored engine written to ${engineRoot}`);
