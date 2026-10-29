import { describe, expect, it } from "vitest";
import { resolveRemoteSwarmToken, runRemoteSuite, type RemoteRunPollStatus } from "./remote-run.js";
import { DEFAULT_SWARM_SERVER_URL, resolveSwarmServerUrl } from "./worker-transport.js";

const FAKE_TOKEN = ["bzt", "X".repeat(32)].join("_");

describe("resolveSwarmServerUrl & resolveRemoteSwarmToken", () => {
  it("defaults server URL to https://swarm.botz.ai and respects SWARM_SERVER_URL or --server", () => {
    expect(resolveSwarmServerUrl(undefined, {})).toBe(DEFAULT_SWARM_SERVER_URL);
    expect(resolveSwarmServerUrl(undefined, { SWARM_SERVER_URL: "https://custom-swarm.example.com/mcp" })).toBe(
      "https://custom-swarm.example.com",
    );
    expect(resolveSwarmServerUrl("https://flag-swarm.example.com/path", { SWARM_SERVER_URL: "https://env.example.com" })).toBe(
      "https://flag-swarm.example.com",
    );
  });

  it("resolves token from flag or SWARM_TOKEN / SWARM_WORKER_TOKEN / BOTZ_API_KEY", () => {
    expect(resolveRemoteSwarmToken("fake-flag-token", {})).toBe("fake-flag-token");
    expect(resolveRemoteSwarmToken(undefined, { SWARM_TOKEN: "fake-env-swarm-token" })).toBe("fake-env-swarm-token");
    expect(resolveRemoteSwarmToken(undefined, { SWARM_WORKER_TOKEN: "fake-env-worker-token" })).toBe("fake-env-worker-token");
    expect(() => resolveRemoteSwarmToken(undefined, {})).toThrow(/Swarm token missing/);
  });
});

describe("runRemoteSuite against central Swarm MCP server", () => {
  it("triggers swarm_suite_run, polls swarm_run_status, sends (mcp-tester) User-Agent, and synthesizes RunReport", async () => {
    const calls: Array<{ url: string; toolName: string; args: Record<string, unknown>; userAgent: string | null }> = [];
    let pollCount = 0;

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      const toolName = body.params?.name ?? "";
      const args = body.params?.arguments ?? {};
      calls.push({ url, toolName, args, userAgent: headers.get("user-agent") });

      if (toolName === "swarm_suite_describe") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { structuredContent: { ok: true, new_version: 2 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (toolName === "swarm_suite_run") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              structuredContent: {
                started: true,
                completed: false,
                project_id: "proj-botz-mcp",
                suite_id: "suite-main",
                run_id: "run-central-101",
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (toolName === "swarm_run_status") {
        pollCount += 1;
        if (pollCount === 1) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                structuredContent: {
                  status: "running",
                  project_id: "proj-botz-mcp",
                  run_id: "run-central-101",
                  buffered_events_count: 14,
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              structuredContent: {
                status: "completed",
                project_id: "proj-botz-mcp",
                run_id: "run-central-101",
                suite_id: "suite-main",
                suite_version: 2,
                verdict: "pass",
                duration_ms: 4200,
                per_tool: {
                  skill_search: { calls: 20, error_rate: 0, p50_ms: 18, p95_ms: 35, p99_ms: 42 },
                  skill_get_compressed: { calls: 20, error_rate: 0, p50_ms: 12, p95_ms: 24, p99_ms: 30 },
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ error: { message: "unexpected tool" } }), { status: 400 });
    };

    const progressStatuses: RemoteRunPollStatus[] = [];
    const out = await runRemoteSuite({
      projectId: "proj-botz-mcp",
      preset: "baseline",
      dispatch: "worker",
      token: FAKE_TOKEN,
      pollIntervalMs: 5,
      fetchFn: fakeFetch,
      env: {},
      onProgress: (st) => progressStatuses.push(st),
    });

    expect(out.serverOrigin).toBe("https://swarm.botz.ai");
    expect(out.report.id).toBe("run-central-101");
    expect(out.report.verdict).toBe("pass");
    expect(out.report.toolSeries).toHaveLength(2);
    expect(out.report.quotas.callCount).toBe(40);
    expect(progressStatuses.map((s) => s.status)).toEqual(["running", "completed"]);
    expect(calls[0]?.url).toBe("https://swarm.botz.ai/mcp");
    expect(calls[0]?.userAgent).toMatch(/\(mcp-tester\)$/);
    const runCall = calls.find((c) => c.toolName === "swarm_suite_run");
    expect(runCall?.args).toMatchObject({
      project_id: "proj-botz-mcp",
      preset: "baseline",
      dispatch: "worker",
    });
  });
});
