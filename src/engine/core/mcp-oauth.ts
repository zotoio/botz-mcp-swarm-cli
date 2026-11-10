import { createHash, randomBytes } from "node:crypto";
import type { McpServerAuth, McpServerOAuthConfig, Target } from "../types/manifest.js";
import { egressGuardedFetch } from "./egress-url.js";

export interface OAuthDiscoveryResult {
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  resourceMetadataUrl?: string;
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

export function generatePkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

/**
 * Derive HTTP headers from structured `auth` / `oauth` fields merged with explicit `headers`.
 */
export function resolveTargetAuthHeaders(
  target: {
    headers?: Record<string, string>;
    auth?: McpServerAuth;
    oauth?: McpServerOAuthConfig;
  },
): Record<string, string> {
  const out: Record<string, string> = { ...(target.headers ?? {}) };
  const hasAuthHeader = Object.keys(out).some((k) => k.toLowerCase() === "authorization");
  const auth = target.auth;
  if (auth?.type === "api_key" && auth.apiKey?.trim()) {
    const key = auth.apiKey.trim();
    const headerName = auth.headerName?.trim() || "Authorization";
    const scheme = auth.scheme !== undefined ? auth.scheme.trim() : headerName.toLowerCase() === "authorization" ? "Bearer" : "";
    const existingKey = Object.keys(out).find((k) => k.toLowerCase() === headerName.toLowerCase());
    if (!existingKey) {
      out[headerName] = scheme ? `${scheme} ${key}` : key;
    }
  } else if (auth?.type === "oauth" || target.oauth) {
    const oauth = (auth?.type === "oauth" ? auth.oauth : undefined) ?? target.oauth;
    if (oauth?.accessToken?.trim()) {
      // The stored OAuth token is the source of truth: a static `Authorization: Bearer …` header is
      // usually a stale copy of an earlier token, so replace it. A non-Bearer custom header is kept.
      const existing = Object.keys(out).find((k) => k.toLowerCase() === "authorization");
      if (!hasAuthHeader || (existing && /^bearer\s/i.test(out[existing] ?? ""))) {
        if (existing) delete out[existing];
        out.Authorization = `Bearer ${oauth.accessToken.trim()}`;
      }
    }
  }
  return out;
}

function parseWwwAuthenticateResourceMeta(headerVal: string | null): { resourceMetadata?: string; scope?: string } {
  if (!headerVal) return {};
  const rm = /resource_metadata="([^"]+)"/i.exec(headerVal)?.[1];
  const sc = /scope="([^"]+)"/i.exec(headerVal)?.[1];
  return {
    ...(rm ? { resourceMetadata: rm } : {}),
    ...(sc ? { scope: sc } : {}),
  };
}

async function fetchJsonSafe(url: string, fetchImpl: typeof fetch): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * RFC 9728 (.well-known/oauth-protected-resource) + RFC 8414 (.well-known/oauth-authorization-server)
 * + OpenID Connect Discovery (.well-known/openid-configuration) for an MCP server URL.
 */
export async function discoverMcpOAuth(
  serverUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthDiscoveryResult> {
  const parsed = new URL(serverUrl);
  const origin = parsed.origin;
  const pathSuffix = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname.replace(/\/+$/, "") : "";

  let resourceMetadataUrl: string | undefined;
  let discoveredScopes: string[] | undefined;
  let authServerIssuer: string | undefined;

  // 1. Probe the MCP endpoint itself for a WWW-Authenticate resource_metadata hint (if unauthenticated)
  try {
    const probe = await fetchImpl(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    if (probe.status === 401 || probe.status === 403) {
      const challenge = parseWwwAuthenticateResourceMeta(probe.headers.get("www-authenticate"));
      if (challenge.resourceMetadata) resourceMetadataUrl = challenge.resourceMetadata;
      if (challenge.scope) discoveredScopes = challenge.scope.split(/\s+/).filter(Boolean);
    }
  } catch {
    // Continue to well-known probes
  }

  // 2. Probe .well-known/oauth-protected-resource (RFC 9728)
  const prCandidates = [
    ...(resourceMetadataUrl ? [resourceMetadataUrl] : []),
    ...(pathSuffix ? [`${origin}/.well-known/oauth-protected-resource${pathSuffix}`] : []),
    `${origin}/.well-known/oauth-protected-resource`,
  ];
  for (const candidate of prCandidates) {
    const doc = await fetchJsonSafe(candidate, fetchImpl);
    if (doc) {
      resourceMetadataUrl = candidate;
      if (Array.isArray(doc.authorization_servers) && typeof doc.authorization_servers[0] === "string") {
        authServerIssuer = doc.authorization_servers[0];
      } else if (typeof doc.authorization_server === "string") {
        authServerIssuer = doc.authorization_server;
      }
      if (Array.isArray(doc.scopes_supported)) {
        discoveredScopes = doc.scopes_supported.filter((s): s is string => typeof s === "string");
      }
      break;
    }
  }

  // 3. Probe .well-known/oauth-authorization-server (RFC 8414) & .well-known/openid-configuration
  const issuerBase = authServerIssuer ? new URL(authServerIssuer).origin : origin;
  const issuerPath = authServerIssuer ? new URL(authServerIssuer).pathname.replace(/\/+$/, "") : "";
  const asCandidates = [
    ...(issuerPath
      ? [
          `${issuerBase}/.well-known/oauth-authorization-server${issuerPath}`,
          `${issuerBase}${issuerPath}/.well-known/oauth-authorization-server`,
          `${issuerBase}${issuerPath}/.well-known/openid-configuration`,
        ]
      : []),
    `${issuerBase}/.well-known/oauth-authorization-server`,
    `${issuerBase}/.well-known/openid-configuration`,
    ...(issuerBase !== origin
      ? [
          `${origin}/.well-known/oauth-authorization-server`,
          `${origin}/.well-known/openid-configuration`,
        ]
      : []),
  ];

  for (const candidate of asCandidates) {
    const meta = await fetchJsonSafe(candidate, fetchImpl);
    if (meta && (typeof meta.authorization_endpoint === "string" || typeof meta.token_endpoint === "string")) {
      const scopes = Array.isArray(meta.scopes_supported)
        ? meta.scopes_supported.filter((s): s is string => typeof s === "string")
        : discoveredScopes;
      return {
        issuer: typeof meta.issuer === "string" ? meta.issuer : authServerIssuer ?? issuerBase,
        authorizationEndpoint: typeof meta.authorization_endpoint === "string" ? meta.authorization_endpoint : undefined,
        tokenEndpoint: typeof meta.token_endpoint === "string" ? meta.token_endpoint : undefined,
        registrationEndpoint: typeof meta.registration_endpoint === "string" ? meta.registration_endpoint : undefined,
        ...(scopes?.length ? { scopesSupported: scopes } : {}),
        ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      };
    }
  }

  // Fallback conventional endpoints on the issuer / origin so OAuth UI can still pre-populate
  return {
    issuer: authServerIssuer ?? origin,
    authorizationEndpoint: `${issuerBase}/oauth/authorize`,
    tokenEndpoint: `${issuerBase}/oauth/token`,
    registrationEndpoint: `${issuerBase}/oauth/register`,
    ...(discoveredScopes?.length ? { scopesSupported: discoveredScopes } : {}),
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
  };
}

/**
 * Dynamic Client Registration (RFC 7591).
 */
export async function registerOAuthClient(
  registrationEndpoint: string,
  redirectUri: string,
  clientName = "botz-mcp-swarm",
  fetchImpl: typeof fetch = fetch,
): Promise<{ clientId: string; clientSecret?: string }> {
  const res = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token", "client_credentials"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) {
    throw new Error(`oauth_dcr_failed_${res.status}`);
  }
  const data = (await res.json()) as { client_id?: unknown; client_secret?: unknown };
  if (typeof data.client_id !== "string" || !data.client_id.trim()) {
    throw new Error("oauth_dcr_missing_client_id");
  }
  return {
    clientId: data.client_id.trim(),
    ...(typeof data.client_secret === "string" && data.client_secret.trim()
      ? { clientSecret: data.client_secret.trim() }
      : {}),
  };
}

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  tokenType?: string;
}

export async function exchangeAuthorizationCode(
  input: {
    tokenEndpoint: string;
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
    codeVerifier: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  const res = await fetchImpl(input.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`oauth_token_exchange_failed_${res.status}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data.access_token !== "string" || !data.access_token.trim()) {
    throw new Error("oauth_token_missing_access_token");
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : Number(data.expires_in);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : undefined;
  return {
    accessToken: data.access_token.trim(),
    ...(typeof data.refresh_token === "string" && data.refresh_token.trim()
      ? { refreshToken: data.refresh_token.trim() }
      : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(typeof data.scope === "string" && data.scope.trim() ? { scope: data.scope.trim() } : {}),
    ...(typeof data.token_type === "string" ? { tokenType: data.token_type } : {}),
  };
}

export async function requestClientCredentialsToken(
  input: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret: string;
    scope?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  if (input.scope?.trim()) body.set("scope", input.scope.trim());
  const res = await fetchImpl(input.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`oauth_client_credentials_failed_${res.status}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data.access_token !== "string" || !data.access_token.trim()) {
    throw new Error("oauth_token_missing_access_token");
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : Number(data.expires_in);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : undefined;
  return {
    accessToken: data.access_token.trim(),
    ...(typeof data.refresh_token === "string" && data.refresh_token.trim()
      ? { refreshToken: data.refresh_token.trim() }
      : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(typeof data.scope === "string" && data.scope.trim() ? { scope: data.scope.trim() } : {}),
  };
}

/** Seconds of slack: a token this close to expiry is treated as expired. */
const OAUTH_EXPIRY_SKEW_MS = 60_000;

export type OAuthLoginState = "none" | "ok" | "expiring" | "expired" | "error";

export interface OAuthLoginStatus {
  state: OAuthLoginState;
  expiresAt?: string;
  /** True when a refresh token is stored, so an expired token may still be renewed silently. */
  refreshable: boolean;
  /** Human message, never contains a token. */
  message?: string;
}

export function targetOAuthConfig(target: Target | { auth?: McpServerAuth; oauth?: McpServerOAuthConfig; transport?: string }): McpServerOAuthConfig | undefined {
  if ((target as { transport?: string }).transport === "stdio") return undefined;
  const t = target as { auth?: McpServerAuth; oauth?: McpServerOAuthConfig };
  return (t.auth?.type === "oauth" ? t.auth.oauth : undefined) ?? t.oauth;
}

/** Whether a server's stored OAuth login still works (by expiry and status); no network calls. */
export function oauthLoginStatus(
  target: Target | { auth?: McpServerAuth; oauth?: McpServerOAuthConfig; transport?: string },
  nowMs: number = Date.now(),
): OAuthLoginStatus {
  const oauth = targetOAuthConfig(target);
  if (!oauth || (!oauth.accessToken && !oauth.refreshToken && !oauth.expiresAt && oauth.status !== "error")) {
    return { state: "none", refreshable: false };
  }
  const refreshable = Boolean(oauth.refreshToken && oauth.tokenEndpoint);
  const base = { refreshable, ...(oauth.expiresAt ? { expiresAt: oauth.expiresAt } : {}) };
  if (oauth.status === "error") {
    return { ...base, state: "error", message: "Login expired — Reconnect. The stored OAuth login could not be renewed." };
  }
  const expMs = oauth.expiresAt ? Date.parse(oauth.expiresAt) : Number.NaN;
  if (Number.isFinite(expMs)) {
    if (expMs <= nowMs) {
      return {
        ...base,
        state: "expired",
        message: refreshable
          ? `Login expired at ${oauth.expiresAt}; Swarm will try to renew it before the next run. If that fails, Reconnect.`
          : `Login expired — Reconnect. The OAuth token expired at ${oauth.expiresAt} and no refresh token is stored.`,
      };
    }
    if (expMs - nowMs <= OAUTH_EXPIRY_SKEW_MS * 10) {
      return { ...base, state: "expiring", message: `Login expires at ${oauth.expiresAt}.` };
    }
  }
  return { ...base, state: "ok" };
}

export type OAuthRefreshResult =
  | { ok: true; oauth: McpServerOAuthConfig; refreshed: boolean }
  | { ok: false; reason: string };

/** In-flight and recent refreshes keyed by refresh token, so concurrent sessions share one rotation. */
const refreshCache = new Map<string, { at: number; promise: Promise<OAuthRefreshResult> }>();
const REFRESH_CACHE_TTL_MS = 5 * 60_000;

export function clearOAuthRefreshCache(): void {
  refreshCache.clear();
}

function oauthNeedsRefresh(oauth: McpServerOAuthConfig, nowMs: number): boolean {
  if (oauth.expiresAt) {
    const expMs = Date.parse(oauth.expiresAt);
    return !(Number.isFinite(expMs) && expMs - nowMs > OAUTH_EXPIRY_SKEW_MS);
  }
  return !oauth.accessToken;
}

/**
 * Renew an OAuth login with its refresh token when it is expired or about to expire.
 * Returns the (possibly unchanged) config; never throws and never includes tokens in `reason`.
 */
export async function refreshOAuthLogin(
  oauth: McpServerOAuthConfig,
  fetchImpl: typeof fetch = fetch,
  opts: { force?: boolean } = {},
): Promise<OAuthRefreshResult> {
  const nowMs = Date.now();
  if (!opts.force && !oauthNeedsRefresh(oauth, nowMs)) return { ok: true, oauth, refreshed: false };
  if (!oauth.refreshToken || !oauth.tokenEndpoint) return { ok: false, reason: "no_refresh_token" };
  const key = `${oauth.tokenEndpoint}\u0000${oauth.refreshToken}`;
  for (const [k, v] of refreshCache) if (nowMs - v.at > REFRESH_CACHE_TTL_MS) refreshCache.delete(k);
  const cached = refreshCache.get(key);
  if (cached) return cached.promise;
  const promise = (async (): Promise<OAuthRefreshResult> => {
    try {
      const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: oauth.refreshToken! });
      if (oauth.clientId) body.set("client_id", oauth.clientId);
      if (oauth.clientSecret) body.set("client_secret", oauth.clientSecret);
      const res = await fetchImpl(oauth.tokenEndpoint!, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
      });
      if (!res.ok) return { ok: false, reason: `refresh_http_${res.status}` };
      const data = (await res.json()) as Record<string, unknown>;
      if (typeof data.access_token !== "string" || !data.access_token.trim()) return { ok: false, reason: "refresh_no_access_token" };
      const expiresIn = typeof data.expires_in === "number" ? data.expires_in : Number(data.expires_in);
      const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : undefined;
      const next: McpServerOAuthConfig = {
        ...oauth,
        status: "connected",
        accessToken: data.access_token.trim(),
        ...(typeof data.refresh_token === "string" && data.refresh_token.trim() ? { refreshToken: data.refresh_token.trim() } : {}),
        ...(typeof data.scope === "string" && data.scope.trim() ? { scope: data.scope.trim() } : {}),
      };
      if (expiresAt) next.expiresAt = expiresAt;
      else delete next.expiresAt;
      return { ok: true, oauth: next, refreshed: true };
    } catch (error) {
      return { ok: false, reason: `refresh_failed:${error instanceof Error ? error.name : "error"}` };
    }
  })();
  refreshCache.set(key, { at: nowMs, promise });
  const result = await promise;
  if (!result.ok) refreshCache.delete(key);
  return result;
}

/** Apply an OAuth config to a target: structured fields plus the Authorization header. */
export function withOAuth<T extends Target>(target: T, oauth: McpServerOAuthConfig): T {
  if (target.transport === "stdio") return target;
  const headers = { ...(target.headers ?? {}) };
  if (oauth.accessToken) {
    const existing = Object.keys(headers).find((k) => k.toLowerCase() === "authorization");
    if (!existing || /^bearer\s/i.test(headers[existing] ?? "")) {
      if (existing) delete headers[existing];
      headers.Authorization = `Bearer ${oauth.accessToken}`;
    }
  }
  return {
    ...target,
    headers,
    oauth,
    ...(target.auth?.type === "oauth" || !target.auth ? { auth: { type: "oauth" as const, oauth } } : {}),
  };
}

export async function refreshOAuthTokenIfNeeded(
  target: Target,
  fetchImpl?: typeof fetch,
): Promise<Target> {
  if (target.transport === "stdio") return target;
  const oauth = targetOAuthConfig(target);
  if (!oauth?.refreshToken || !oauth.tokenEndpoint) return target;
  // SWARM-17: the refresh POST carries the refresh token and client secret, so it goes through the egress guard.
  const result = await refreshOAuthLogin(oauth, fetchImpl ?? egressGuardedFetch(fetch));
  if (!result.ok || !result.refreshed) return target;
  return withOAuth(target, result.oauth);
}
