import { homedir, userInfo } from "node:os";
import { basename } from "node:path";
import { redactString, redactValue } from "../engine/core/redaction.js";
import { resolveStdioTarget } from "../engine/core/target-resolve.js";
import type { Target } from "../engine/types/manifest.js";
import type { RunReport } from "../engine/types/run.js";
import { findGitRoot } from "./botz-home.js";

export type ScrubContext = {
  /** Literal values removed wherever they appear: bearer tokens, header values, stdio env values. */
  secrets?: string[];
  /** Absolute stdio command paths, recorded as their basename. */
  commands?: string[];
  home?: string;
  repoRoot?: string | null;
  cwd?: string;
  username?: string;
};

/**
 * A path under a user or mount root. Directory names may hold single spaces, because a separator
 * follows them; the last segment may not.
 */
const PROFILE_POSIX_PATH = /(?<![\w./~>\]-])\/(?:home|Users|root|mnt|media|Volumes)\/(?:[\w.@+-]+(?: [\w.@+-]+)*\/)*([\w.@+-]+)/g;
/** A path that starts at `/` with at least two segments, not inside a URL or after a placeholder. */
const POSIX_PATH = /(?<![\w./~>\]-])\/(?:[\w.@+-]+\/)+([\w.@+-]+)/g;
/** `C:\a\b` or `C:/a/b`; directory names may hold single spaces. */
const WINDOWS_PATH = /(?<![\w])[A-Za-z]:[\\/](?:[^\\/\s"'<>|]+(?: [^\\/\s"'<>|]+)*[\\/])+([^\\/\s"'<>|]+)/g;
/** `\\server\share\...`; directory names may hold single spaces. */
const UNC_PATH = /(?<![\w\\])\\\\[^\\\s"'<>|]+(?:\\[^\\\s"'<>|]+(?: [^\\\s"'<>|]+)*(?=\\))*\\[^\\\s"'<>|]+/g;
const FILE_URL = /\bfile:\/\/[^\s"'<>]*/gi;
/** `scheme://user:pass@` or `scheme://user@`. */
const URL_USERINFO = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@?#"'<>]+@/g;
/** A `name=value` pair in a URL query or fragment. */
const QUERY_PARAM = /([?&;#])([^=&#\s"'<>?]+)=([^&#\s"'<>]*)/g;
/** Query parameters that carry an API key; the standalone CLI turns these into a bearer header. */
export const API_KEY_PARAMS: readonly string[] = [
  "api_key",
  "apikey",
  "api-key",
  "x-api-key",
  "subscription-key",
  "ocp-apim-subscription-key",
  "key",
  "token",
  "access_token",
];
/**
 * Credential-shaped names as whole segments (`token`, `session`, `code`, …), not substrings of
 * `tokenizer` / `secretary` / `max_tokens`.
 */
const SECRET_PARAM =
  /(?:^|[_-])(?:secret|password|passwd|pwd|signature|token|sig|credential|private[_-]?key|client[_-]?key|auth|session|sid|jwt|bearer|pass|hmac|code)(?:$|[_-])/i;
/** Pagination / limit / OAuth metadata names that look secret-shaped but are not credentials. */
const SAFE_PARAM =
  /^(?:max_tokens|page_token|next_page_token|nextpagetoken|tokenizer|secretary|token_type|auth_mode|author|keyword|page|client_id|state)$/i;
const MIN_SECRET = 4;
const MIN_USERNAME = 3;

export function defaultScrubContext(cwd: string = process.cwd()): ScrubContext {
  return { home: homedir(), cwd, repoRoot: findGitRoot(cwd), username: currentUsername() };
}

/**
 * Removes secrets, user paths, and the username from text that is saved or sent off this machine:
 * secrets become `[redacted]`, stdio commands their basename, the repo `<repo>`, the cwd `<cwd>`,
 * home `~`, any other absolute path its basename, and the username `<user>`.
 */
export function makeReportScrubber(context: ScrubContext): (text: string) => string {
  const secrets = unique(context.secrets ?? []).filter((value) => value.length >= MIN_SECRET).sort(byLength);
  const commands = unique(context.commands ?? []).filter((value) => value.includes("/") || value.includes("\\")).sort(byLength);
  const roots: Array<[string, string]> = [];
  if (context.repoRoot) roots.push([context.repoRoot, "<repo>"]);
  if (context.cwd) roots.push([context.cwd, "<cwd>"]);
  if (context.home) roots.push([context.home, "~"]);
  const rootPatterns = roots
    .filter(([path]) => path.length > 1)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([path, label]) => [new RegExp(`${escape(path)}(?=$|[/\\\\\\s"'),;:\\]])`, "g"), label] as const);
  const user = context.username && context.username.length >= MIN_USERNAME
    ? new RegExp(`(?<![A-Za-z0-9_])${escape(context.username)}(?![A-Za-z0-9_])`, "g")
    : null;
  return (text: string) => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join("[redacted]");
    out = scrubUrlCredentials(out);
    for (const command of commands) out = out.split(command).join(basename(command));
    for (const [pattern, label] of rootPatterns) out = out.replace(pattern, label);
    out = out
      .replace(FILE_URL, (match) => lastSegment(match.slice("file://".length), "/") || "file")
      .replace(UNC_PATH, (match) => lastSegment(match, "\\"))
      .replace(WINDOWS_PATH, (_match, name: string) => name)
      .replace(PROFILE_POSIX_PATH, (_match, name: string) => name)
      .replace(POSIX_PATH, (_match, name: string) => name);
    if (user) out = out.replace(user, "<user>");
    return redactString(out);
  };
}

/**
 * URL userinfo and the values of key, token, secret, password, and signature parameters in a
 * query or fragment become `[redacted]`.
 */
export function scrubUrlCredentials(text: string): string {
  return text
    .replace(URL_USERINFO, "$1[redacted]@")
    .replace(QUERY_PARAM, (match, sep: string, name: string, value: string) =>
      value && isSecretParam(name) ? `${sep}${name}=[redacted]` : match);
}

export function isApiKeyParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (API_KEY_PARAMS.includes(lower)) return true;
  // Vendor headers such as Ocp-Apim-Subscription-Key embed the subscription-key segment.
  return lower.includes("subscription-key");
}

export function isSecretParam(name: string): boolean {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // Keep the raw name.
  }
  if (SAFE_PARAM.test(decoded)) return false;
  return isApiKeyParam(decoded) || SECRET_PARAM.test(decoded);
}

/** Scrubs every string, including object keys. */
export function scrubDeep(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, scrub));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[scrub(key)] = scrubDeep(item, scrub);
    return out;
  }
  return value;
}

function lastSegment(path: string, separator: string): string {
  return path.split(separator).filter(Boolean).pop() ?? "";
}

/** Report safe to commit or send: sensitive keys redacted, then every string scrubbed. */
export function scrubReport(report: RunReport, scrub: (text: string) => string): RunReport {
  return scrubDeep(redactValue(report), scrub) as RunReport;
}

/** Header or stdio env values on a resolved target, plus the credential after an auth scheme. */
export function targetSecretValues(target: Target): string[] {
  const pairs = target.transport === "stdio" ? target.env : target.headers;
  return Object.values(pairs ?? {}).flatMap((value) => {
    const parts = [value];
    const scheme = /^[A-Za-z]+ (.+)$/.exec(value);
    if (scheme?.[1]) parts.push(scheme[1]);
    return parts;
  });
}

/** The stdio command as stored and as the runner resolves it, so either form is reduced to its basename. */
export function stdioCommandPaths(target: Target, baseDir: string): string[] {
  if (target.transport !== "stdio") return [];
  try {
    const resolved = resolveStdioTarget(target, baseDir);
    return resolved.transport === "stdio" ? [target.command, resolved.command] : [target.command];
  } catch {
    return [target.command];
  }
}

function currentUsername(): string | undefined {
  try {
    return userInfo().username || undefined;
  } catch {
    return process.env.USER || process.env.USERNAME || undefined;
  }
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function byLength(a: string, b: string): number {
  return b.length - a.length;
}
