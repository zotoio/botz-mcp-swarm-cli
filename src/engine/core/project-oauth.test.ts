import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, getProject, updateProjectServerOAuth } from "../store/project-store.js";
import {
  clearOAuthRefreshCache,
  oauthLoginStatus,
  refreshOAuthLogin,
  refreshOAuthTokenIfNeeded,
  resolveTargetAuthHeaders,
} from "./mcp-oauth.js";
import { loginExpiredMessage, preflightProjectOAuth, projectLoginStatus } from "./project-oauth.js";
import type { McpServerOAuthConfig, Target } from "../types/manifest.js";
import { generateKey } from "../store/keyring.js";

process.env.SWARM_STORAGE_KEYS = `ktest:${generateKey()}`;

const OLD = ["old", "access", "a1"].join("-");
const NEW = ["new", "access", "b2"].join("-");
const RT1 = ["refresh", "one"].join("-");
const RT2 = ["refresh", "two"].join("-");
const past = () => new Date(Date.now() - 3600_000).toISOString();
const future = () => new Date(Date.now() + 3600_000).toISOString();

const dirs: string[] = [];
beforeEach(() => clearOAuthRefreshCache());
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tokenFetch(status: number, body: Record<string, unknown>, calls: { n: number } = { n: 0 }): typeof fetch {
  return (async () => {
    calls.n += 1;
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function oauth(extra: Partial<McpServerOAuthConfig> = {}): McpServerOAuthConfig {
  return { status: "connected", grantType: "authorization_code", tokenEndpoint: "https://idp.example.com/token", clientId: "c1", accessToken: OLD, refreshToken: RT1, expiresAt: past(), ...extra };
}

async function setup(o: McpServerOAuthConfig) {
  const dataDir = await mkdtemp(join(tmpdir(), "swarm-oauth-"));
  dirs.push(dataDir);
  const project = await createProject(
    { name: "Botz", server: { transport: "streamable-http", url: "https://mcp.example.com/mcp", headers: { Authorization: `Bearer ${OLD}` }, auth: { type: "oauth", oauth: o }, oauth: o } },
    { dataDir, introspect: async () => ({ protocolVersion: "2025-11-25", serverName: "x", serverVersion: "1", capabilities: ["tools"], tools: [], resources: [], resourceTemplates: [], prompts: [] }) },
  );
  return { dataDir, projectId: project.id, serverId: project.servers![0]!.id };
}

describe("resolveTargetAuthHeaders", () => {
  it("prefers the stored OAuth token over a stale static Bearer header", () => {
    const h = resolveTargetAuthHeaders({ headers: { authorization: `Bearer ${OLD}` }, oauth: { accessToken: NEW } });
    expect(h).toEqual({ Authorization: `Bearer ${NEW}` });
  });
  it("keeps a non-Bearer custom Authorization header", () => {
    const h = resolveTargetAuthHeaders({ headers: { Authorization: "Basic abc" }, oauth: { accessToken: NEW } });
    expect(h.Authorization).toBe("Basic abc");
  });
});

describe("refreshOAuthLogin", () => {
  it("shares one refresh between concurrent sessions (rotating refresh tokens)", async () => {
    const calls = { n: 0 };
    const f = tokenFetch(200, { access_token: NEW, refresh_token: RT2, expires_in: 3600 }, calls);
    const [a, b] = await Promise.all([refreshOAuthLogin(oauth(), f), refreshOAuthLogin(oauth(), f)]);
    expect(calls.n).toBe(1);
    expect(a.ok && a.oauth.accessToken).toBe(NEW);
    expect(b.ok && b.oauth.refreshToken).toBe(RT2);
  });
  it("reports a failure reason without tokens", async () => {
    const r = await refreshOAuthLogin(oauth(), tokenFetch(400, { error: "invalid_grant" }));
    expect(r).toEqual({ ok: false, reason: "refresh_http_400" });
  });
  it("refreshOAuthTokenIfNeeded replaces the Authorization header", async () => {
    const t: Target = { transport: "streamable-http", url: "https://mcp.example.com/mcp", headers: { Authorization: `Bearer ${OLD}` }, oauth: oauth() };
    const next = await refreshOAuthTokenIfNeeded(t, tokenFetch(200, { access_token: NEW, expires_in: 60 }));
    expect(next.transport !== "stdio" && next.headers?.Authorization).toBe(`Bearer ${NEW}`);
  });
});

describe("oauthLoginStatus", () => {
  it("classifies ok / expired / error", () => {
    expect(oauthLoginStatus({ oauth: oauth({ expiresAt: future() }) }).state).toBe("ok");
    expect(oauthLoginStatus({ oauth: oauth({ refreshToken: undefined }) })).toMatchObject({ state: "expired", refreshable: false });
    expect(oauthLoginStatus({ oauth: oauth({ status: "error" }) }).state).toBe("error");
    expect(oauthLoginStatus({ headers: {} }).state).toBe("none");
  });
});

describe("preflightProjectOAuth", () => {
  it("persists refreshed tokens and drops the stale plaintext Bearer header", async () => {
    const { dataDir, projectId, serverId } = await setup(oauth());
    const res = await preflightProjectOAuth({ projectId, store: { dataDir }, fetchImpl: tokenFetch(200, { access_token: NEW, refresh_token: RT2, expires_in: 3600 }) });
    expect(res).toEqual({ refreshed: [serverId], failures: [] });
    const p = await getProject(projectId, { dataDir });
    const t = p!.servers![0]!.target;
    expect(t.transport !== "stdio" && t.headers?.Authorization).toBeUndefined();
    expect(resolveTargetAuthHeaders(t as never).Authorization).toBe(`Bearer ${NEW}`);
    expect(t.transport !== "stdio" && t.oauth?.refreshToken).toBe(RT2);
    const raw = await readFile(join(dataDir, "projects", projectId, "project.json"), "utf8").catch(async () => "");
    expect(raw).toContain("refreshToken");
    expect(raw).not.toContain(NEW);
    expect((await projectLoginStatus(projectId, { dataDir }))![0]!.state).toBe("ok");
  });

  it("fails fast with a Reconnect message and marks the login as error when refresh fails", async () => {
    const { dataDir, projectId } = await setup(oauth());
    const res = await preflightProjectOAuth({ projectId, store: { dataDir }, fetchImpl: tokenFetch(400, { error: "invalid_grant" }) });
    expect(res.failures).toHaveLength(1);
    const msg = loginExpiredMessage(res.failures);
    expect(msg).toMatch(/^login_expired: Login expired — Reconnect/);
    expect(msg).not.toContain(OLD);
    const status = await projectLoginStatus(projectId, { dataDir });
    expect(status![0]).toMatchObject({ state: "error", reconnectRequired: true });
  });

  it("leaves valid logins alone", async () => {
    const { dataDir, projectId } = await setup(oauth({ expiresAt: future() }));
    const calls = { n: 0 };
    const res = await preflightProjectOAuth({ projectId, store: { dataDir }, fetchImpl: tokenFetch(200, {}, calls) });
    expect(res).toEqual({ refreshed: [], failures: [] });
    expect(calls.n).toBe(0);
  });

  it("updateProjectServerOAuth keeps the catalog and suite versions (no re-introspection)", async () => {
    const { dataDir, projectId, serverId } = await setup(oauth());
    const before = await getProject(projectId, { dataDir });
    await updateProjectServerOAuth(projectId, serverId, oauth({ accessToken: NEW, expiresAt: future() }), { dataDir });
    const after = await getProject(projectId, { dataDir });
    expect(after!.suites.map((s) => s.currentVersion)).toEqual(before!.suites.map((s) => s.currentVersion));
  });
});
