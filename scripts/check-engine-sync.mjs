#!/usr/bin/env node
/**
 * CI guard: vendored `src/engine/` must match `ENGINE_SOURCE.json` from botz-mcp-swarm.
 *
 * - Recomputes the engine tree hash and compares it to the manifest.
 * - Ensures CLI `package.json` runtime dependency versions satisfy the ranges recorded
 *   in the manifest (tsdown uses `neverBundle: true`).
 *
 * Do not edit files under `src/engine/` by hand; sync from the private platform repo:
 *   https://github.com/zotoio/botz-mcp-swarm — `scripts/export-engine.mjs` on `packages/engine`.
 *
 * Exit codes: 0 clean, 1 findings, 2 misconfiguration (missing tree, unreadable manifest).
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeEngineTreeHash } from "./compute-engine-tree-hash.mjs";

const PLATFORM_SYNC_DOC =
  "https://github.com/zotoio/botz-mcp-swarm/blob/main/packages/engine/README.md";
const EXPORT_HINT =
  "Run botz-mcp-swarm `scripts/export-engine.mjs` (engine PR merge / engine-sync workflow) to refresh `src/engine/` and ENGINE_SOURCE.json.";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineRoot = path.join(repoRoot, "src", "engine");
const manifestPath = path.join(engineRoot, "ENGINE_SOURCE.json");
const cliPackagePath = path.join(repoRoot, "package.json");

/** @param {string} message */
function fail(message) {
  console.error(`check-engine-sync: ${message}`);
  console.error(EXPORT_HINT);
  console.error(`Platform engine: ${PLATFORM_SYNC_DOC}`);
  process.exit(1);
}

/** @param {string} message */
function fatal(message) {
  console.error(`check-engine-sync: ${message}`);
  process.exit(2);
}

if (!existsSync(engineRoot)) fatal("src/engine is missing");

if (!existsSync(manifestPath)) {
  fail(
    "ENGINE_SOURCE.json is missing under src/engine/. The vendored snapshot must include the manifest produced by export-engine.mjs.",
  );
}

/** @type {unknown} */
let manifestRaw;
try {
  manifestRaw = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  fatal(`ENGINE_SOURCE.json is not valid JSON: ${error instanceof Error ? error.message : error}`);
}

const manifest = validateManifest(manifestRaw);

const actualHash = computeEngineTreeHash(engineRoot);
const recordedHash = pickTreeHash(manifest);

if (recordedHash !== actualHash) {
  fail(
    `engine tree hash mismatch (manifest ${recordedHash ?? "?"}, working tree ${actualHash}). ` +
      "Direct edits to src/engine/ are not allowed without re-exporting from botz-mcp-swarm.",
  );
}

const cliPkg = JSON.parse(readFileSync(cliPackagePath, "utf8"));

const rangeErrors = [];
for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
  if (typeof range !== "string") continue;
  const installed = cliPkg.dependencies?.[name];
  if (installed === undefined) {
    rangeErrors.push(`CLI package.json is missing runtime dependency ${name} (engine requires ${range})`);
    continue;
  }
  if (!versionSatisfies(extractVersion(installed), range)) {
    rangeErrors.push(`${name}: CLI has ${installed} but engine manifest requires ${range}`);
  }
}

if (rangeErrors.length > 0) {
  for (const line of rangeErrors) console.error(`check-engine-sync: ${line}`);
  console.error(EXPORT_HINT);
  process.exit(1);
}

console.log(
  `OK engine tree ${actualHash.slice(0, 12)}… sync ${manifest.sourceCommit?.slice?.(0, 7) ?? manifest.commit?.slice?.(0, 7) ?? "?"}`,
);

/**
 * @param {unknown} value
 */
function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fatal("ENGINE_SOURCE.json must be an object");
  const m = /** @type {Record<string, unknown>} */ (value);
  const hasCommit = typeof m.sourceCommit === "string" || typeof m.commit === "string";
  const hasHash = typeof m.engineTreeHash === "string" || typeof m.treeHash === "string";
  if (!hasCommit || !hasHash) {
    fatal("ENGINE_SOURCE.json must include sourceCommit (or commit) and engineTreeHash (or treeHash)");
  }
  if (m.dependencies !== undefined && (typeof m.dependencies !== "object" || m.dependencies === null || Array.isArray(m.dependencies))) {
    fatal("ENGINE_SOURCE.json dependencies must be an object when present");
  }
  return m;
}

/**
 * @param {Record<string, unknown>} manifest
 */
function pickTreeHash(manifest) {
  if (typeof manifest.engineTreeHash === "string") return manifest.engineTreeHash;
  if (typeof manifest.treeHash === "string") return manifest.treeHash;
  return undefined;
}

/**
 * @param {string} installed bare semver from package.json (no range prefix)
 * @param {string} range npm semver range from engine manifest
 */
function versionSatisfies(installed, range) {
  if (installed === range) return true;
  if (range.startsWith("workspace:") || range.startsWith("file:") || range.startsWith("git+")) return false;
  return satisfiesSemver(installed, range);
}

/**
 * Minimal semver satisfaction for engine manifest ranges (^, >=, exact, *).
 * @param {string} version
 * @param {string} range
 */
function satisfiesSemver(version, range) {
  const v = parseSemver(version);
  if (!v) return false;
  const trimmed = range.trim();
  if (trimmed === "*" || trimmed === "") return true;

  const parts = trimmed.split("||").map((s) => s.trim());
  return parts.some((clause) => satisfiesClause(v, clause));
}

/**
 * @param {{ major: number; minor: number; patch: number; prerelease: string | null }} v
 * @param {string} clause
 */
function satisfiesClause(v, clause) {
  if (clause.startsWith(">=")) return compareSemver(v, parseSemver(clause.slice(2).trim())) >= 0;
  if (clause.startsWith("^")) {
    const want = parseSemver(clause.slice(1).trim());
    if (!want) return false;
    if (v.major !== want.major) return false;
    if (want.major > 0) return compareSemver(v, want) >= 0;
    if (want.minor > 0) return v.minor === want.minor && compareSemver(v, want) >= 0;
    return v.patch === want.patch && compareSemver(v, want) >= 0;
  }
  const exact = parseSemver(clause);
  return exact !== null && compareSemver(v, exact) === 0;
}

/**
 * @param {string} text
 */
function parseSemver(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(text.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

/**
 * @param {{ major: number; minor: number; patch: number; prerelease: string | null }} a
 * @param {{ major: number; minor: number; patch: number; prerelease: string | null }} b
 */
function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

/**
 * @param {string} spec package.json dependency value
 */
function extractVersion(spec) {
  const trimmed = spec.trim();
  if (/^\d/.test(trimmed)) return trimmed.replace(/^(\d+\.\d+\.\d+).*$/, "$1") === trimmed ? trimmed : trimmed.split("+")[0];
  return trimmed;
}
