import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createProject } from "../store/project-store.js";
import { generateKey } from "../store/keyring.js";
import { clearOAuthRefreshCache } from "./mcp-oauth.js";
import { followSuiteRun, startSuiteRun } from "./project-run.js";

process.env.SWARM_STORAGE_KEYS = `ktest:${generateKey()}`;

const STORED = ["stored", "access", "x9"].join("-");
const RENEWED = ["renewed", "access", "y8"].join("-");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  clearOAuthRefreshCache();
  await Promise.all(cleanups.splice(0).map((f) => f()));
});

async function authServer(): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    seen.push(String(req.headers.authorization ?? ""));
    res.writeHead(401, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen };
}

const introspect = async () => ({ protocolVersion: "2025-11-25", serverName: "x", serverVersion: "1", capabilities: ["tools"], tools: [], resources: [], resourceTemplates: [], prompts: [] });

async function project(url: string, expiresAt: string) {
  const dataDir = await mkdtemp(join(tmpdir(), "swarm-run-oauth-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const oauth = { status: "connected" as const, grantType: "authorization_code" as const, tokenEndpoint: "https://idp.example.com/token", clientId: "c1", accessToken: STORED, refreshToken: "rt-1", expiresAt };
  const p = await createProject({ name: "Botz", server: { transport: "streamable-http", url, auth: { type: "oauth", oauth }, oauth } }, { dataDir, introspect });
  return { dataDir, p };
}

async function run(dataDir: string, projectId: string, suiteId: string, oauthFetch?: typeof fetch, url = "") {
  const started = await startSuiteRun({ projectId, suiteId, principal: "cli", orgTargetAllowlist: [{ transport: "streamable-http", url }], orgGatewayAllowlist: [], dataDir, dispatch: "local", evals: false, oauthFetch });
  if (started.ok) await followSuiteRun(started.runId, () => undefined);
  else if (process.env.DEBUG_T558) console.log(started);
  return started;
}

describe("CLI project run uses the project's stored OAuth login (t558)", () => {
  it("sends the stored (sealed-at-rest) token as Bearer at warm-up", async () => {
    const srv = await authServer();
    const { dataDir, p } = await project(srv.url, new Date(Date.now() + 3600_000).toISOString());
    const raw = await readFile(join(dataDir, "projects", p.id, "project.json"), "utf8");
    expect(raw).not.toContain(STORED);
    await run(dataDir, p.id, p.suites[0]!.id, undefined, srv.url);
    expect(srv.seen.length).toBeGreaterThan(0);
    expect(srv.seen).toContain(`Bearer ${STORED}`);
  });

  it("renews an expired login with the refresh token before running and uses the new token", async () => {
    const srv = await authServer();
    const { dataDir, p } = await project(srv.url, new Date(Date.now() - 3600_000).toISOString());
    const tokenFetch = (async () => new Response(JSON.stringify({ access_token: RENEWED, refresh_token: "rt-2", expires_in: 3600, token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    await run(dataDir, p.id, p.suites[0]!.id, tokenFetch, srv.url);
    expect(srv.seen).toContain(`Bearer ${RENEWED}`);
    expect(srv.seen).not.toContain(`Bearer ${STORED}`);
    const raw = await readFile(join(dataDir, "projects", p.id, "project.json"), "utf8");
    expect(raw).not.toContain(RENEWED);
  });

  it("fails fast with a Login expired message when the login cannot be renewed", async () => {
    const srv = await authServer();
    const { dataDir, p } = await project(srv.url, new Date(Date.now() - 3600_000).toISOString());
    const deny = (async () => new Response("{}", { status: 400 })) as typeof fetch;
    const started = await run(dataDir, p.id, p.suites[0]!.id, deny, srv.url);
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error).toMatch(/Login expired/i);
    expect(srv.seen).toEqual([]);
  });
});
