import { mergeHeaders } from "../engine/adapters/headers.js";
import { redactHeaders } from "../engine/core/redaction.js";
import { envRefName, isEnvReference } from "../engine/core/target-env-ref.js";
import { isApiKeyParam, isSecretParam } from "./report-scrub.js";
import type { Target } from "../engine/types/manifest.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const BEARER_LITERAL = /^Bearer\s+(\S+)$/i;

export interface AuthFlags {
  urlKeyAsBearer?: boolean;
  header?: string[];
  headerEnv?: string[];
  /** One value, or one per server when values carry an `alias=` prefix. */
  bearerEnv?: string | string[];
  env?: string[];
  envFrom?: string[];
}

function hasAuth(flags: AuthFlags): boolean {
  const bearer = Array.isArray(flags.bearerEnv) ? flags.bearerEnv.length > 0 : Boolean(flags.bearerEnv);
  return bearer || (flags.header?.length ?? 0) > 0 || (flags.headerEnv?.length ?? 0) > 0
    || (flags.env?.length ?? 0) > 0 || (flags.envFrom?.length ?? 0) > 0;
}

/**
 * Splits credential flags by server. A value for another server starts with its alias:
 * `--bearer-env jira=JIRA_TOKEN`, `--header jira:X-Api-Key: value`, `--header-env jira:X-Api-Key=ENV`,
 * `--env slack:KEY=value`, `--env-from slack:KEY=ENV`. Unprefixed values are for the default server.
 * Only aliases in `aliases` are recognised, so a header that happens to be named like a server is not taken.
 */
export function splitAuthFlags(flags: AuthFlags = {}, aliases: string[] = []): { main: AuthFlags; byServer: Record<string, AuthFlags> } {
  const known = new Set(aliases);
  const byServer: Record<string, AuthFlags> = {};
  const main: AuthFlags = { urlKeyAsBearer: flags.urlKeyAsBearer };
  const take = (raw: string, separator: "=" | ":"): { alias?: string; rest: string } => {
    const at = raw.indexOf(separator);
    if (at > 0) {
      const alias = raw.slice(0, at);
      if (known.has(alias)) return { alias, rest: raw.slice(at + 1).trimStart() };
    }
    return { rest: raw };
  };
  const push = (alias: string | undefined, key: "header" | "headerEnv" | "env" | "envFrom", value: string) => {
    const into = alias ? (byServer[alias] ??= {}) : main;
    (into[key] ??= []).push(value);
  };
  for (const raw of flags.header ?? []) { const item = take(raw, ":"); push(item.alias, "header", item.rest); }
  for (const raw of flags.headerEnv ?? []) { const item = take(raw, ":"); push(item.alias, "headerEnv", item.rest); }
  for (const raw of flags.env ?? []) { const item = take(raw, ":"); push(item.alias, "env", item.rest); }
  for (const raw of flags.envFrom ?? []) { const item = take(raw, ":"); push(item.alias, "envFrom", item.rest); }
  const bearers = flags.bearerEnv === undefined ? [] : Array.isArray(flags.bearerEnv) ? flags.bearerEnv : [flags.bearerEnv];
  for (const raw of bearers) {
    const item = take(raw, "=");
    const into = item.alias ? (byServer[item.alias] ??= {}) : main;
    if (into.bearerEnv) throw new Error(`provide one --bearer-env${item.alias ? ` for ${item.alias}` : " for the default server"}`);
    into.bearerEnv = item.rest;
  }
  return { main, byServer };
}

/** True when any credential flag was given, for any server. */
export function anyAuthFlags(flags: AuthFlags = {}): boolean {
  return hasAuth(flags);
}

/** Merge CLI credentials onto a target. Env-backed values stay as ${env:NAME} until connect time. */
export function applyAuthFlags(target: Target, flags: AuthFlags = {}): Target {
  const bearerFlag = Array.isArray(flags.bearerEnv) ? flags.bearerEnv.length > 0 : Boolean(flags.bearerEnv);
  const headerFlags = (flags.header?.length ?? 0) > 0 || (flags.headerEnv?.length ?? 0) > 0 || bearerFlag;
  const envFlags = (flags.env?.length ?? 0) > 0 || (flags.envFrom?.length ?? 0) > 0;
  if (target.transport === "stdio") {
    if (headerFlags) throw new Error("headers apply to an HTTP target");
    const env = { ...(target.env ?? {}) };
    for (const raw of flags.env ?? []) {
      const parsed = parseAssignment(raw, "env");
      env[parsed.name] = parsed.value;
    }
    for (const raw of flags.envFrom ?? []) {
      const parsed = parseAssignment(raw, "env-from");
      assertEnvName(parsed.value);
      env[parsed.name] = `\${env:${parsed.value}}`;
    }
    return Object.keys(env).length > 0 ? { ...target, env } : target;
  }
  if (envFlags) throw new Error("env applies to a stdio target");
  let headers = mergeHeaders(target.headers);
  for (const raw of flags.header ?? []) {
    const parsed = parseHeader(raw);
    headers = mergeHeaders(headers, { [parsed.name]: parsed.value });
  }
  for (const raw of flags.headerEnv ?? []) {
    const parsed = parseAssignment(raw, "header-env");
    assertEnvName(parsed.value);
    headers = mergeHeaders(headers, { [parsed.name]: `\${env:${parsed.value}}` });
  }
  const bearer = Array.isArray(flags.bearerEnv) ? flags.bearerEnv : flags.bearerEnv ? [flags.bearerEnv] : [];
  if (bearer.length > 1) throw new Error("provide one --bearer-env per server");
  if (bearer[0]) {
    assertEnvName(bearer[0]);
    headers = mergeHeaders(headers, { Authorization: `Bearer \${env:${bearer[0]}}` });
  }
  return Object.keys(headers).length > 0 ? { ...target, headers } : target;
}

/** Replace ${env:NAME} in header and stdio env values. Throws before a connection when a variable is missing. */
export function resolveTargetSecrets(target: Target, env: NodeJS.ProcessEnv = process.env): Target {
  if (target.transport === "stdio") {
    if (!target.env) return target;
    return { ...target, env: resolveMap(target.env, env) };
  }
  if (!target.headers) return target;
  return { ...target, headers: resolveMap(target.headers, env) };
}

export function formatAuth(target: Target): string[] {
  const pairs = target.transport === "stdio" ? target.env : target.headers;
  if (!pairs || Object.keys(pairs).length === 0) return [];
  return Object.keys(pairs).sort().map((key) => {
    const value = pairs[key] ?? "";
    const shown = value.includes("${env:") ? value : (redactHeaders({ [key]: value })[key] ?? "[REDACTED]");
    return `  ${key}: ${shown}`;
  });
}

/**
 * Refuses URL userinfo and turns an API-key query parameter (`api_key`, `apikey`, `api-key`, `x-api-key`,
 * `subscription-key`, `key`, `token`, `access_token`) into `Authorization: Bearer <value>`, removing it from
 * the raw query so the other parameters keep their encoding. Fails when an Authorization header is already
 * set, so the two never compete.
 */
export function moveUrlCredentials(target: Target, asBearer = false): { target: Target; movedParam?: string } {
  if (target.transport === "stdio") return { target };
  const url = new URL(target.url);
  if (url.username || url.password) {
    throw new Error(
      "credentials in the URL (user:password@) are not saved; remove them and pass the credential with --bearer-env or --header",
    );
  }
  const params = rawParams(url.search.slice(1));
  const keys = params.filter((param) => isApiKeyParam(param.name));
  if (keys.length === 0) return { target };
  if (!asBearer) throw new Error("query credentials are not saved or converted automatically; use --url-key-as-bearer only if the server accepts bearer authentication, or use --header / --bearer-env");
  if (keys.length > 1) {
    throw new Error(
      `the URL has more than one API key query parameter (${[...new Set(keys.map((key) => key.name))].join(", ")}); keep one`,
    );
  }
  const { name: param, value } = keys[0]!;
  if (Object.keys(target.headers ?? {}).some((key) => key.toLowerCase() === "authorization")) {
    throw new Error(
      `the URL has an API key query parameter (${param}) and an Authorization header is also set; pass the key one way only`,
    );
  }
  if (!value) throw new Error(`the URL query parameter ${param} is empty`);
  const rest = params.filter((entry) => entry !== keys[0]).map((entry) => entry.raw);
  url.search = rest.length > 0 ? `?${rest.join("&")}` : "";
  return {
    target: { ...target, url: url.toString(), headers: { ...target.headers, Authorization: `Bearer ${value}` } },
    movedParam: param,
  };
}

/**
 * Refuses a URL that would put a credential in `suite.json`: a secret-looking query parameter that is not
 * moved to a bearer header (`private_key`, `client_secret`, `auth`, `pwd`, ...), or any credential in the
 * fragment (`#access_token=...`). Call after moveUrlCredentials. Messages name the parameter, never the value.
 */
export function assertNoUrlCredentials(target: Target): void {
  if (target.transport === "stdio") return;
  const url = new URL(target.url);
  const query = rawParams(url.search.slice(1)).find((param) => isSecretParam(param.name));
  if (query) {
    throw new Error(
      `the URL query parameter ${query.name} looks like a credential and would be saved in suite.json; remove it and pass the credential with --header or --bearer-env`,
    );
  }
  const fragment = rawParams(url.hash.slice(1)).find((param) => isSecretParam(param.name));
  if (fragment) {
    throw new Error(
      `the URL fragment holds a credential (${fragment.name}); remove it and pass the credential with --bearer-env or --header`,
    );
  }
}

type RawParam = { raw: string; name: string; value: string };

/** `a=1&b=2` split on `&` without re-encoding; names and values decoded as URLSearchParams does. */
function rawParams(text: string): RawParam[] {
  if (!text) return [];
  return text.split("&").filter(Boolean).map((raw) => {
    const at = raw.indexOf("=");
    return {
      raw,
      name: decodeFormComponent(at < 0 ? raw : raw.slice(0, at)),
      value: at < 0 ? "" : decodeFormComponent(raw.slice(at + 1)),
    };
  });
}

function decodeFormComponent(text: string): string {
  const spaced = text.replace(/\+/g, " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

/**
 * Moves every literal header or stdio env value out of the target. A literal `Bearer <token>` header keeps
 * `Bearer ${env:NAME}` and only the token is moved. The target keeps `${env:NAME}`
 * (`SWARM_TARGET_HEADER_<KEY>` / `SWARM_TARGET_ENV_<KEY>`); the literal goes to `credentials[NAME]`.
 * Only an exact `${env:NAME}` or `<scheme> ${env:NAME}` value stays as stored.
 */
export function splitLiteralCredentials(target: Target, alias?: string): { target: Target; credentials: Record<string, string> } {
  const source = target.transport === "stdio" ? "env" : "header";
  const pairs = target.transport === "stdio" ? target.env : target.headers;
  const credentials: Record<string, string> = {};
  if (!pairs) return { target, credentials };
  const used = new Set<string>();
  for (const value of Object.values(pairs)) for (const match of value.matchAll(ENV_REF)) used.add(match[1]!);
  const out: Record<string, string> = {};
  for (const key of Object.keys(pairs).sort()) {
    const value = pairs[key] ?? "";
    if (isEnvReference(value)) {
      out[key] = value;
      continue;
    }
    const base = envRefName(source, key, alias);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    const bearer = source === "header" ? BEARER_LITERAL.exec(value) : null;
    if (bearer?.[1] && !bearer[1].includes("${env:")) {
      out[key] = `Bearer \${env:${name}}`;
      credentials[name] = bearer[1];
      continue;
    }
    out[key] = `\${env:${name}}`;
    credentials[name] = value;
  }
  const stored: Target = target.transport === "stdio" ? { ...target, env: out } : { ...target, headers: out };
  return { target: stored, credentials };
}

/** Header or env names whose literal secret would be written into the suite file. */
export function storedSecretNames(target: Target): string[] {
  const pairs = target.transport === "stdio" ? target.env : target.headers;
  if (!pairs) return [];
  return Object.entries(pairs)
    .filter(([, value]) => !value.includes("${env:"))
    .filter(([key, value]) => redactHeaders({ [key]: value })[key] !== value)
    .map(([key]) => key);
}

function resolveMap(values: Record<string, string>, env: NodeJS.ProcessEnv): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) resolved[key] = resolveSecrets(value, env);
  return resolved;
}

function resolveSecrets(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(ENV_REF, (_match, name: string) => {
    const found = env[name];
    if (!found) throw new Error(`missing credential: ${name}`);
    return found;
  });
}

function parseHeader(raw: string): { name: string; value: string } {
  const colon = raw.indexOf(":");
  if (colon <= 0) throw new Error(`header must be Name: value: ${raw}`);
  const name = raw.slice(0, colon).trim();
  const value = raw.slice(colon + 1).trim();
  if (!name || !value) throw new Error(`header must be Name: value: ${raw}`);
  return { name, value };
}

function parseAssignment(raw: string, label: string): { name: string; value: string } {
  const eq = raw.indexOf("=");
  if (eq <= 0) throw new Error(`${label} must be Name=value: ${raw}`);
  const name = raw.slice(0, eq).trim();
  const value = raw.slice(eq + 1);
  if (!name || value.length === 0) throw new Error(`${label} must be Name=value: ${raw}`);
  return { name, value };
}

function assertEnvName(name: string): void {
  if (!IDENT.test(name)) throw new Error(`env name is invalid: ${name}`);
}
