import { afterEach, describe, expect, it, vi } from "vitest";
import { parseManifest, type Target } from "../types/manifest.js";
import { runManifest } from "./runner.js";
import * as adapters from "../adapters/index.js";

// #18 ramp-down accounting on #6's per-server session pools: cut-offs and partial passes on any server
// are ramp-down, never errors against that server.

afterEach(() => vi.restoreAllMocks());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hostOf = (target: Target) => ("url" in target && target.url ? new URL(target.url).hostname : "stdio");

function fakeServers(opts: {
  call: (host: string, startedAt: number) => Promise<boolean>;
  open?: (host: string) => Promise<void>;
}) {
  const opened: string[] = [];
  vi.spyOn(adapters, "createSession").mockImplementation(async (target: Target) => {
    const host = hostOf(target);
    await opts.open?.(host);
    opened.push(host);
    return {
      id: host, close: async () => {}, getServerMeta: () => ({ capabilities: { tools: {} } }), serverInfo: () => ({}),
      setElicitAutoReply: () => {},
      callTool: async () => {
        const ok = await opts.call(host, Date.now());
        return ok
          ? { success: true, latencyMs: 100, bytesIn: 1, bytesOut: 1, errorClass: "none", result: { content: [{ type: "text", text: "ok" }] } }
          : { success: false, latencyMs: 100, bytesIn: 1, bytesOut: 0, errorClass: "timeout", errorMessage: "timed out" };
      },
    } as unknown as adapters.McpSession;
  });
  return opened;
}

/** Each pass: a, b, a, b. b is a second server with its own pool. */
function manifest(load: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return parseManifest({
    name: "two-servers",
    target: { transport: "streamable-http", url: "https://a.example/mcp" },
    defaultTarget: "a",
    targets: { b: { transport: "streamable-http", url: "https://b.example/mcp" } },
    allowlist: ["a.example", "b.example"],
    load: { rampUpMs: 0, dwellMs: 0, jitterMs: 0, iterations: 1, ...load },
    ...extra,
    scenarios: [{
      name: "flow",
      steps: [
        { method: "tools/call", tool: "search" },
        { method: "tools/call", tool: "create", server: "b" },
        { method: "tools/call", tool: "search" },
        { method: "tools/call", tool: "create", server: "b" },
      ],
    }],
  });
}

const serverRow = (report: Awaited<ReturnType<typeof runManifest>>, alias: string) => report.servers?.find((s) => s.alias === alias);

describe("multi-server ramp-down", () => {
  it("calls on the second server cut off by the drain deadline are cancelled, not errors on that server", async () => {
    const t0 = Date.now();
    fakeServers({ call: async (_host, startedAt) => { await sleep(100); return startedAt < t0 + 550; } });
    const report = await runManifest({ manifest: manifest({ maxConcurrency: 3, durationMs: 500, rampDownMs: 150, rampDown: { strategy: "immediate" } }) });
    expect(report.failReasons).toEqual([]);
    expect(report.verdict).toBe("pass");
    expect(report.rampDown).toMatchObject({ incompletePasses: 3 });
    expect(report.rampDown!.cancelledByRampDown).toBeGreaterThan(0);
    expect(serverRow(report, "a")?.errorRate).toBe(0);
    expect(serverRow(report, "b")?.errorRate).toBe(0);
  });

  it("a server whose session open fails across the drain deadline is ramp-down, not unreachable", async () => {
    const t0 = Date.now();
    let bOpens = 0;
    fakeServers({
      // Cold sessions: b opens in every pass. The second pass's open starts before the ≈650ms deadline
      // and fails after it, as a server would when the client is shutting down.
      open: async (host) => {
        if (host !== "b.example") return;
        bOpens += 1;
        if (Date.now() > t0 + 450) { await sleep(250); throw new Error("connection refused"); }
      },
      call: async () => { await sleep(100); return true; },
    });
    const report = await runManifest({
      manifest: manifest({ maxConcurrency: 1, durationMs: 500, rampDownMs: 150, rampDown: { strategy: "immediate" } }, { sessionPool: { reuse: "cold" } }),
    });
    expect(bOpens).toBeGreaterThanOrEqual(2);
    expect(report.failReasons).toEqual([]);
    expect(report.verdict).toBe("pass");
    expect(report.rampDown!.cancelledByRampDown).toBeGreaterThan(0);
    expect(serverRow(report, "b")?.errorRate ?? 0).toBe(0);
    expect(JSON.stringify(report)).not.toContain("session failed on b");
  });

  it("a real failure on the second server before ramp-down still fails the run and is counted on that server", async () => {
    fakeServers({ call: async (host) => { await sleep(5); return host !== "b.example"; } });
    const report = await runManifest({ manifest: manifest({ maxConcurrency: 1, durationMs: 10, rampDownMs: 1000 }) });
    expect(report.verdict).toBe("fail");
    expect(serverRow(report, "a")?.errorRate).toBe(0);
    expect(serverRow(report, "b")?.errorRate).toBe(1);
    expect(report.rampDown!.cancelledByRampDown).toBe(0);
  });
});
