#!/usr/bin/env node
/**
 * CI guard: fail if committed text contains developer-machine absolute paths or
 * secret values.
 *
 * Rules (see LEAKAGE_RULES):
 * - Absolute user paths: POSIX home directories, macOS user profiles, and Windows
 *   drive-letter user profiles (backslash or forward-slash form).
 * - Secret values: private key blocks, well-known provider token prefixes, and
 *   secret-named assignments (env style, JSON/YAML/JS literal) with a real value.
 *
 * Allowlist (never reported):
 * - Placeholders: `<repo>`, `<sut-pid>`, `<user>` and similar angle-bracket tokens,
 *   `${VAR}` / `$VAR` expansions, `...`, `your_*`, `changeme`, `example`, `placeholder`,
 *   `redacted`, `xxx…`, `***`.
 * - Loopback hosts such as `127.0.0.1` and `localhost` (no rule matches them).
 * - Empty assignments such as `GITHUB_CLIENT_SECRET=` in `.env.example`.
 * - Path segments of URLs with a network host (`https://host/home/…`). `file://`
 *   URLs, colon-joined lists (`PATH=…:/home/…`), and scp-style `host:/home/…`
 *   are still reported.
 * - Lockfile integrity hashes (`integrity:` / `sha512-` lines).
 *
 * Exclusions (see EXCLUDED_PATH_RE):
 * - node_modules/, dist/, .runs/, .swarm-data/, coverage/, binary archives.
 * - This script itself (its docs and rules describe the patterns it hunts).
 *
 * Failure output prints `file:line [rule]` only. Matched values are never printed.
 * Exit codes: 0 clean, 1 findings, 2 the file list could not be built (fails closed).
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

/**
 * @typedef {{ name: string; re: RegExp; hint: string; secret?: boolean; urlPath?: boolean; pathRule?: boolean }} LeakageRule
 * `urlPath` and `pathRule` rules use a global regex and check every match on a line; a user
 * segment of only dots is a placeholder. `urlPath` rules also ignore matches that sit in the
 * path of a URL with a network host (see isNetworkUrlPath).
 */

const PATH_START = String.raw`(?<![\w.\-~])`;
const USER_SEGMENT = String.raw`([A-Za-z0-9._-]+)`;
const ELLIPSIS_SEGMENT_RE = /^\.{3,}$/;
/** A `/Users/` that follows a drive letter (`C:/Users/`) belongs to the Windows rule. */
const NOT_AFTER_DRIVE = String.raw`(?<!(?:^|[^\w])[A-Za-z]:)`;

/** @type {LeakageRule[]} */
export const LEAKAGE_RULES = [
  {
    name: "posix-home-path",
    re: new RegExp(String.raw`${PATH_START}\/home\/${USER_SEGMENT}`, "g"),
    hint: "absolute POSIX home directory path",
    urlPath: true,
  },
  {
    name: "macos-user-path",
    re: new RegExp(String.raw`${PATH_START}${NOT_AFTER_DRIVE}\/Users\/${USER_SEGMENT}`, "g"),
    hint: "absolute macOS user profile path",
    urlPath: true,
  },
  {
    name: "windows-user-path",
    re: new RegExp(String.raw`(?<![\w])[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)${USER_SEGMENT}`, "gi"),
    hint: "absolute Windows user profile path",
    pathRule: true,
  },
  {
    name: "private-key-block",
    re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
    hint: "PEM private key block",
    secret: true,
  },
  {
    name: "provider-token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/,
    hint: "well-known provider token or API key",
    secret: true,
  },
  {
    name: "env-secret-assignment",
    re: /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|PASSWORD|PASSWD|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*["']?([^\s"'#]+)/,
    hint: "secret-named env assignment with a value",
    secret: true,
  },
  {
    name: "literal-secret-assignment",
    re: /["']?\b[A-Za-z0-9_]*(?:secret|token|api_?key|password|passwd|private_?key)\b["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i,
    hint: "secret-named key assigned a literal value",
    secret: true,
  },
];

const PLACEHOLDER_RE =
  /^(?:<[^>]*>.*|\$\{?[A-Za-z_][\w]*\}?.*|\.{3,}.*|your[_-].*|changeme.*|change[_-]me.*|example.*|placeholder.*|redacted.*|x{3,}.*|\*{3,}.*|dummy.*|fake.*|test[_-].*)$/i;

/** Token text before the match is `scheme://host[:port]/…` with a non-empty host. */
const NETWORK_URL_PREFIX_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s/"'`<>()[\]]+(?:\/[^\s"'`<>()[\]]*)?$/i;

/**
 * @param {string} line
 * @param {number} index start of the path match
 */
function isNetworkUrlPath(line, index) {
  const before = line.slice(0, index);
  const tokenStart = Math.max(
    ...[" ", "\t", '"', "'", "`", "(", "<", "=", ","].map((c) => before.lastIndexOf(c)),
  );
  return NETWORK_URL_PREFIX_RE.test(before.slice(tokenStart + 1));
}

const LOCKFILE_INTEGRITY_RE = /\bintegrity:|\bsha(?:1|256|384|512)-[A-Za-z0-9+/=]{20,}/;

/** Paths never scanned: generated output, local runtime data, binaries, this script. */
const EXCLUDED_PATH_RE =
  /(?:^|\/)(?:node_modules|dist|coverage|\.runs|\.swarm-data)\/|^scripts\/check-leakage\.mjs$|\.(?:tgz|tar\.gz|gz|zip|bundle|png|jpe?g|gif|ico|webp|woff2?|ttf|eot|pdf)$/i;

/**
 * @param {string} normalized repo-relative path with forward slashes
 */
export function isExcluded(normalized) {
  return EXCLUDED_PATH_RE.test(normalized);
}

/**
 * @param {string} content
 * @param {string} file label used in findings
 * @returns {{ file: string; line: number; rule: string; hint: string }[]}
 */
export function scanContent(content, file) {
  const findings = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (LOCKFILE_INTEGRITY_RE.test(line)) continue;
    for (const rule of LEAKAGE_RULES) {
      if (rule.urlPath || rule.pathRule) {
        const leaked = [...line.matchAll(rule.re)].some(
          (m) => !ELLIPSIS_SEGMENT_RE.test(m[1]) && !(rule.urlPath && isNetworkUrlPath(line, m.index)),
        );
        if (leaked) findings.push({ file, line: i + 1, rule: rule.name, hint: rule.hint });
        continue;
      }
      const match = rule.re.exec(line);
      if (!match) continue;
      if (rule.secret && match[1] !== undefined && PLACEHOLDER_RE.test(match[1])) continue;
      findings.push({ file, line: i + 1, rule: rule.name, hint: rule.hint });
    }
  }
  return findings;
}

/**
 * @param {string} repoRoot
 * @param {string[]} [explicitFiles] relative or absolute paths; when set, only these files are scanned
 */
export function scanForLeakage(repoRoot, explicitFiles) {
  const root = path.resolve(repoRoot);
  const explicit = Boolean(explicitFiles?.length);
  const relFiles = explicit
    ? explicitFiles.map((f) => (path.isAbsolute(f) ? path.relative(root, f) : f))
    : listCandidateFiles(root);
  if (relFiles.length === 0) {
    throw new LeakageScanError("no files to scan (git ls-files returned an empty list)");
  }

  const findings = [];
  for (const rel of relFiles) {
    const normalized = rel.replace(/\\/g, "/");
    if (!explicit && isExcluded(normalized)) continue;
    let content;
    try {
      content = readFileSync(path.join(root, normalized), "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;
    findings.push(...scanContent(content, normalized));
  }
  return findings;
}

/** Raised when the scan cannot enumerate files; the check must fail closed. */
export class LeakageScanError extends Error {}

/** Tracked files plus untracked files that are not gitignored. */
function listCandidateFiles(repoRoot) {
  let out;
  try {
    out = execSync("git ls-files -z --cached --others --exclude-standard", {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new LeakageScanError("git ls-files failed (run from inside the git checkout)");
  }
  return [...new Set(out.split("\0").filter(Boolean))];
}

function main() {
  const args = process.argv.slice(2);
  const fileFlagIdx = args.indexOf("--files");
  const explicit =
    fileFlagIdx >= 0 ? args.slice(fileFlagIdx + 1).filter((a) => !a.startsWith("--")) : undefined;
  let findings;
  try {
    findings = scanForLeakage(process.cwd(), explicit);
  } catch (err) {
    if (!(err instanceof LeakageScanError)) throw err;
    console.error(`check-leakage: ERROR — ${err.message}; refusing to report OK`);
    process.exit(2);
  }

  if (findings.length === 0) {
    console.log("check-leakage: OK (no absolute user paths or secret values found)");
    process.exit(0);
  }

  console.error("check-leakage: FAILED — machine paths or secrets must not be committed\n");
  for (const f of findings) {
    console.error(`${f.file}:${f.line}: [${f.rule}] ${f.hint}`);
  }
  console.error(
    "\nUse placeholders such as <repo> or <user>, and keep real secrets in gitignored .env.local files.",
  );
  process.exit(1);
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("check-leakage.mjs") || process.argv[1].endsWith("check-leakage"));

if (isMain) {
  main();
}
