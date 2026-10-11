#!/usr/bin/env node
/**
 * CI guard: pack `@zotoio/botz-mcp-swarm-cli` (without publishing) and fail if the
 * tarball is not a self-contained CLI.
 *
 * Fails when:
 * - a file sits outside `package.json`, `dist/`, README, LICENSE, or CHANGELOG;
 * - a path mentions `admin-ui`, `sidecar`, `packages/service`, `.env`, or a
 *   service server module (`server`, `admin-*`, `dashboard`, `scheduler`, `worker-hub`, ...);
 * - file contents carry an absolute home path or secret (rules from check-leakage.mjs),
 *   or service-only markers (admin server factory, admin UI dist, OAuth client secret);
 * - `dist/cli.js` or a `bin` target is missing, lacks the node shebang, or is not executable;
 * - the packed manifest is private, keeps a `workspace:` range, or lists
 *   `@zotoio/botz-mcp-swarm-core` / `@zotoio/botz-mcp-swarm` in any dependency field
 *   (including `devDependencies`);
 * - the bundle imports a package that is not a declared runtime dependency.
 *
 * Usage: node scripts/check-cli-pack.mjs [--no-build] [--tarball <file.tgz>]
 * Exit codes: 0 clean, 1 findings, 2 the tarball could not be produced or read.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { scanContent } from "./check-leakage.mjs";

export const CLI_PACKAGE = "@zotoio/botz-mcp-swarm-cli";
export const PRIVATE_PACKAGES = ["@zotoio/botz-mcp-swarm-core", "@zotoio/botz-mcp-swarm"];

const DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];
const ALL_DEP_FIELDS = [...DEP_FIELDS, "devDependencies"];
const BUNDLED_FIELDS = ["bundleDependencies", "bundledDependencies"];

const ALLOWED_PATH_RE = /^(?:package\.json|(?:README|LICENSE|LICENCE|CHANGELOG)(?:\.md|\.txt)?|dist\/.+)$/i;

/** @type {{ name: string; re: RegExp }[]} */
const FORBIDDEN_PATH_RULES = [
  { name: "admin-ui", re: /(?:^|\/)admin-ui(?:\/|$)/i },
  { name: "sidecar", re: /(?:^|\/)sidecar(?:\/|$)/i },
  { name: "service-package", re: /(?:^|\/)packages\/service(?:\/|$)/i },
  { name: "env-file", re: /(?:^|\/)\.env(?:\.|$)/i },
  {
    name: "service-server-module",
    re: /(?:^|\/)(?:server|admin|admin-[\w-]+|dashboard|scheduler|listener|webhook|project-routes|worker-hub|worker-routes|worker-tokens|role-grants|rbac)\.(?:[cm]?js|[cm]?ts|map)$/i,
  },
];

/** Strings that only appear in service / admin UI code. */
const SERVICE_MARKERS = [
  "createSwarmServer",
  "botz-mcp-swarm-dashboard",
  "GITHUB_CLIENT_SECRET",
  "ADMIN_UI_DIST",
  "packages/service",
  "admin-ui",
  "sidecar/",
];

const TEXT_EXT_RE = /\.(?:[cm]?js|[cm]?ts|json|map|md|txt|ya?ml)$|(?:^|\/)(?:LICENSE|LICENCE)$/i;
const SPEC = String.raw`["']([@\w.:/-]+)["']`;
const IMPORT_RE = new RegExp(
  String.raw`^\s*(?:import|export)\b[^;"'\x60]*?\bfrom\s*${SPEC}|\bimport\s*\(\s*${SPEC}\s*\)|\brequire\s*\(\s*${SPEC}\s*\)|^\s*import\s*${SPEC}`,
  "gm",
);

/**
 * Minimal gzip+tar reader (ustar with pax extended headers), enough for npm/pnpm tarballs.
 * @param {Buffer} tgz
 * @returns {{ path: string; mode: number; content: Buffer }[]}
 */
export function readTarball(tgz) {
  const buf = gunzipSync(tgz);
  const entries = [];
  let offset = 0;
  /** @type {string | undefined} */
  let paxPath;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const str = (start, len) => header.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
    const name = str(0, 100);
    const mode = Number.parseInt(str(100, 8).trim() || "0", 8);
    const size = Number.parseInt(str(124, 12).trim() || "0", 8);
    const type = str(156, 1) || "0";
    const prefix = header.subarray(257, 263).toString("latin1").startsWith("ustar") ? str(345, 155) : "";
    const body = buf.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const match = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      paxPath = match?.[1];
      continue;
    }
    if (type === "g") continue;
    const fullPath = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = undefined;
    if (type === "0" || type === "\0") entries.push({ path: fullPath, mode, content: Buffer.from(body) });
    else entries.push({ path: fullPath, mode, content: Buffer.alloc(0), type });
  }
  return entries;
}

/** Package name for a bare specifier, or undefined for relative / builtin imports. */
function packageNameOf(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return undefined;
  if (builtinModules.includes(specifier) || builtinModules.includes(specifier.split("/")[0])) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Inspect packed entries (paths relative to the tarball root, usually `package/...`).
 * @param {{ path: string; mode: number; content: Buffer; type?: string }[]} entries
 * @returns {{ findings: { file: string; rule: string; detail: string }[]; manifest: any }}
 */
export function inspectPackEntries(entries) {
  /** @type {{ file: string; rule: string; detail: string }[]} */
  const findings = [];
  const add = (file, rule, detail) => findings.push({ file, rule, detail });
  const files = new Map();

  for (const entry of entries) {
    const rel = entry.path.replace(/\\/g, "/").replace(/^package\//, "");
    if (entry.type && entry.type !== "0") {
      add(rel, "non-file-entry", `tar entry type ${JSON.stringify(entry.type)} is not allowed`);
      continue;
    }
    files.set(rel, entry);
    if (!ALLOWED_PATH_RE.test(rel)) add(rel, "unexpected-file", "only package.json, dist/, README, LICENSE are published");
    for (const rule of FORBIDDEN_PATH_RULES) {
      if (rule.re.test(rel)) add(rel, rule.name, "forbidden path in CLI tarball");
    }
    if (!TEXT_EXT_RE.test(rel)) continue;
    const text = entry.content.toString("utf8");
    for (const leak of scanContent(text, rel)) add(rel, leak.rule, `line ${leak.line}: ${leak.hint}`);
    if (rel === "package.json") continue;
    for (const marker of SERVICE_MARKERS) {
      if (text.includes(marker)) add(rel, "service-marker", `contains service-only marker ${JSON.stringify(marker)}`);
    }
  }

  const manifestEntry = files.get("package.json");
  if (!manifestEntry) {
    add("package.json", "missing-manifest", "packed package.json not found");
    return { findings, manifest: undefined };
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.content.toString("utf8"));
  } catch {
    add("package.json", "invalid-manifest", "packed package.json is not valid JSON");
    return { findings, manifest: undefined };
  }

  if (manifest.name !== CLI_PACKAGE) add("package.json", "wrong-package", `expected ${CLI_PACKAGE}`);
  if (manifest.private) add("package.json", "private-manifest", "packed CLI must not be private");
  for (const field of DEP_FIELDS) {
    for (const name of PRIVATE_PACKAGES) {
      if (manifest[field]?.[name] !== undefined) add("package.json", "private-dependency", `${field} lists ${name}`);
    }
  }
  for (const name of PRIVATE_PACKAGES) {
    if (manifest.devDependencies?.[name] !== undefined) {
      add("package.json", "private-dev-dependency", `devDependencies lists ${name} (the .pnpmfile.cjs beforePacking hook should strip it)`);
    }
  }
  for (const field of BUNDLED_FIELDS) {
    const list = Array.isArray(manifest[field]) ? manifest[field] : [];
    for (const name of PRIVATE_PACKAGES) {
      if (list.includes(name)) add("package.json", "private-dependency", `${field} lists ${name}`);
    }
  }
  for (const field of ALL_DEP_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (String(range).startsWith("workspace:")) {
        add("package.json", "workspace-range", `${field}.${name} keeps ${range}`);
      }
    }
  }

  if (![...files.keys()].some((name) => /^LICEN[CS]E(?:\.md|\.txt)?$/i.test(name))) {
    add("LICENSE", "missing-license", "the CLI tarball must include its license text");
  }
  const cli = files.get("dist/cli.js");
  if (!cli) add("dist/cli.js", "missing-cli", "dist/cli.js is not in the tarball");
  const bins = typeof manifest.bin === "string" ? { [manifest.name]: manifest.bin } : (manifest.bin ?? {});
  if (Object.keys(bins).length === 0) add("package.json", "missing-bin", "manifest declares no bin");
  for (const [binName, target] of Object.entries(bins)) {
    const rel = String(target).replace(/^\.\//, "");
    const entry = files.get(rel);
    if (!entry) {
      add(rel, "missing-bin", `bin ${binName} points at a file that is not packed`);
      continue;
    }
    if (!entry.content.toString("utf8", 0, 64).startsWith("#!/usr/bin/env node")) {
      add(rel, "missing-shebang", `bin ${binName} must start with #!/usr/bin/env node`);
    }
    if ((entry.mode & 0o111) === 0) add(rel, "not-executable", `bin ${binName} is not executable in the tarball`);
  }

  const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }));
  for (const [rel, entry] of files) {
    if (!/^dist\/.+\.[cm]?js$/.test(rel)) continue;
    const text = entry.content.toString("utf8");
    for (const m of text.matchAll(IMPORT_RE)) {
      const name = packageNameOf(m[1] ?? m[2] ?? m[3] ?? m[4]);
      if (!name) continue;
      if (PRIVATE_PACKAGES.includes(name)) add(rel, "private-import", `imports ${name} at runtime (must be bundled)`);
      else if (!declared.has(name)) add(rel, "undeclared-import", `imports ${name}, which is not a runtime dependency`);
    }
  }

  return { findings, manifest };
}

/** Build core + CLI (unless skipped) and pack the CLI into a fresh temp dir. */
function packCli(repoRoot, { build }) {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const run = (args) =>
    execFileSync(pnpm, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", shell: process.platform === "win32" });
  if (build) {
    run(["run", "build"]);
  }
  const dest = mkdtempSync(path.join(tmpdir(), "cli-pack-"));
  run(["pack", "--pack-destination", dest]);
  const tgz = readdirSync(dest).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("pnpm pack produced no tarball");
  return { file: path.join(dest, tgz), cleanup: () => rmSync(dest, { recursive: true, force: true }) };
}

function main() {
  const args = process.argv.slice(2);
  const tarballIdx = args.indexOf("--tarball");
  const explicit = tarballIdx >= 0 ? args[tarballIdx + 1] : undefined;
  let tgzPath;
  let cleanup = () => {};
  let entries;
  try {
    if (explicit) tgzPath = path.resolve(explicit);
    else ({ file: tgzPath, cleanup } = packCli(process.cwd(), { build: !args.includes("--no-build") }));
    entries = readTarball(readFileSync(tgzPath));
  } catch (err) {
    cleanup();
    console.error(`check-cli-pack: ERROR — could not pack or read the CLI tarball: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
  cleanup();

  const { findings, manifest } = inspectPackEntries(entries);
  console.log(`check-cli-pack: ${path.basename(tgzPath)} (${entries.length} entries)`);
  for (const e of entries) console.log(`  ${String(e.content.length).padStart(9)}  ${e.path}`);
  if (manifest) {
    const deps = Object.keys(manifest.dependencies ?? {});
    console.log(`  dependencies: ${deps.length ? deps.join(", ") : "(none)"}`);
  }

  if (findings.length === 0) {
    console.log("check-cli-pack: OK (self-contained CLI; no service, admin UI, sidecar, or machine paths)");
    process.exit(0);
  }
  console.error("\ncheck-cli-pack: FAILED\n");
  for (const f of findings) console.error(`${f.file}: [${f.rule}] ${f.detail}`);
  process.exit(1);
}

const isMain =
  process.argv[1] && (process.argv[1].endsWith("check-cli-pack.mjs") || process.argv[1].endsWith("check-cli-pack"));

if (isMain) {
  main();
}
