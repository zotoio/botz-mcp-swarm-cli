import { describe, expect, it } from "vitest";
import { formatLoginStatus, remoteLoginStatus, remoteReconnect } from "./login-commands.js";

const FAKE_TOKEN = ["bzt", "Y".repeat(32)].join("_");

function fakeFetch(calls: Array<{ tool: string; args: Record<string, unknown> }>, payload: Record<string, unknown>): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { params?: { name?: string; arguments?: Record<string, unknown> } };
    calls.push({ tool: body.params?.name ?? "", args: body.params?.arguments ?? {} });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: payload } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("login-status / reconnect commands", () => {
  it("calls swarm_server_login_status and flags expired servers", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const status = await remoteLoginStatus("p_1", {
      token: FAKE_TOKEN,
      env: {},
      fetchFn: fakeFetch(calls, {
        project_id: "p_1",
        login_expired: true,
        servers: [{ server_id: "srv_a", server_name: "Botz", state: "error", expires_at: "2026-11-01T13:53:00Z", reconnect_required: true }],
      }),
    });
    expect(calls[0]).toEqual({ tool: "swarm_server_login_status", args: { project_id: "p_1" } });
    expect(formatLoginStatus(status)).toContain("Login expired — Reconnect");
    expect(formatLoginStatus({ servers: [] })).toMatch(/No OAuth servers/);
  });

  it("calls swarm_server_reconnect with the project and server ids", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const res = await remoteReconnect("p_1", "srv_a", {
      token: FAKE_TOKEN,
      env: {},
      fetchFn: fakeFetch(calls, { reconnected: false, authorize_url: "https://idp.example.com/authorize?state=x" }),
    });
    expect(calls[0]).toEqual({ tool: "swarm_server_reconnect", args: { project_id: "p_1", server_id: "srv_a" } });
    expect(res.authorize_url).toMatch(/^https:\/\/idp\.example\.com/);
  });
});
