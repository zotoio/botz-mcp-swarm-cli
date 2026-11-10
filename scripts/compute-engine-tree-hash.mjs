#!/usr/bin/env node
/**
 * Stable content hash for vendored `src/engine/` (excluding ENGINE_SOURCE.json).
 * Must stay aligned with botz-mcp-swarm `scripts/export-engine.mjs`.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = "ENGINE_SOURCE.json";

/**
 * @param {string} engineRoot absolute path to `src/engine`
 * @returns {string} hex sha256
 */
export function computeEngineTreeHash(engineRoot) {
  const files = listFiles(engineRoot).filter((rel) => rel !== MANIFEST && !rel.endsWith(`/${MANIFEST}`));
  files.sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    const abs = path.join(engineRoot, rel);
    const body = readFileSync(abs);
    hash.update(rel.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(body);
  }
  return hash.digest("hex");
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function listFiles(root) {
  /** @type {string[]} */
  const out = [];
  walk(root, root, out);
  return out;
}

/**
 * @param {string} root
 * @param {string} dir
 * @param {string[]} out
 */
function walk(root, dir, out) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(root, abs, out);
    else if (st.isFile()) out.push(path.relative(root, abs));
  }
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const engineRoot = path.resolve(
    process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "engine"),
  );
  console.log(computeEngineTreeHash(engineRoot));
}
