import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import type { RunReport } from "../engine/types/run.js";
import {
  applyWorkerVuSlice,
  backoffDelay,
  exportWorkerOtelToServer,
  makeScrubber,
  resolveWorkerMaxVus,
  missingRequiredEnv,
  parseTransportChoice,
  resolveWorkerToken,
  runnerLimitViolation,
  runWorker,
  STDIO_NOT_ALLOWED,
  type SuiteRunner,
  type WorkerSuite,
} from "./worker.js";
import {
  WorkerAuthError,
  WorkerProtocolError,
  type CloseReason,
  type ServerFrame,
  type SuiteResult,
  type TransportKind,
  type WorkerFrame,
  type WorkerTransport,
} from "./worker-transport.js";

const TOKEN = ["bzw", "T".repeat(43)].join("_");

/** Scripted transport: frames are fed by the test, sent frames are recorded. */
function fakeTransport(kind: TransportKind, suite?: (executionId: string) => SuiteResult) {
  const sent: WorkerFrame[] = [];
  const pending: ServerFrame[] = [];
  let wake: (() => void) | null = null;
  let reason: CloseReason | null = null;
  const transport: WorkerTransport = {
    kind,
    async *frames() {
      for (;;) {
        const next = pending.shift();
        if (next) {
          yield next;
          continue;
        }
        if (reason) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
    async send(frame) {
      sent.push(frame);
      return { ok: true };
    },
    async fetchSuite(executionId) {
      return suite ? suite(executionId) : { ok: false, status: 404, error: "suite_not_found" };
    },
    closeReason: () => reason,
    close() {
      end({ kind: "stopped" });
    },
  };
  const end = (next: CloseReason) => {
    reason ??= next;
    wake?.();
  };
  return {
    transport,
    sent,
    push(frame: ServerFrame) {
      pending.push(frame);
      wake?.();
    },
    end,
  };
}

function payload(executionId: string, overrides: Partial<WorkerSuite> = {}): WorkerSuite {
  return {
    executionId,
    projectId: "p_1",
    projectName: "Demo",
    suiteId: "s_1",
    suiteName: "Smoke",
    version: 1,
    destructive: false,
    principal: "octo",
    suite: { name: "Smoke", nodes: [], load: { durationMs: 0, rampUpMs: 0, maxConcurrency: 1, jitterMs: 0, rampDownMs: 0, dwellMs: 0, iterations: 1, lanes: 1 } },
    target: { transport: "streamable-http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${env:API_TOKEN}" } },
    allowlist: ["mcp.example.com"],
    catalog: [],
    policy: { targetAllowlist: ["mcp.example.com"], gatewayAllowlist: [] },
    limits: {
      runnerConstrained: false,
      runner: { maxDurationMs: 300_000, maxConcurrency: 10, maxIterations: 100, maxDwellMs: 30_000 },
      executionDeadlineMs: 420_000,
    },
    requiredEnv: [{ name: "API_TOKEN", source: "header", key: "Authorization", mapped: false }],
    ...overrides,
  };
}

function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("condition not met"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const passReport = (secret: string) => ({ verdict: "pass", failReasons: [], note: `called with ${secret}` }) as unknown as RunReport;

describe("worker token and options", () => {
  it("prefers --token over SWARM_WORKER_TOKEN and refuses a missing token", () => {
    expect(resolveWorkerToken("fake-flag-token-value", { SWARM_WORKER_TOKEN: "fake-env-token-value" })).toBe("fake-flag-token-value");
    expect(resolveWorkerToken(undefined, { SWARM_WORKER_TOKEN: "fake-env-token-value" })).toBe("fake-env-token-value");
    expect(resolveWorkerToken("  ", { SWARM_WORKER_TOKEN: "fake-env-token-value" })).toBe("fake-env-token-value");
    expect(() => resolveWorkerToken(undefined, {})).toThrow(/worker token missing: pass --token or set SWARM_WORKER_TOKEN/);
  });

  it("parses the transport choice", () => {
    expect(parseTransportChoice(undefined)).toBe("auto");
    expect(parseTransportChoice("SSE")).toBe("sse");
    expect(() => parseTransportChoice("websocket")).toThrow(/--transport/);
  });

  it("backs off exponentially with a cap", () => {
    expect([0, 1, 2, 3].map((n) => backoffDelay(n, 100, 1_000, () => 0))).toEqual([100, 200, 400, 800]);
    expect(backoffDelay(10, 100, 1_000, () => 1)).toBe(1_000);
    expect(backoffDelay(1, 100, 10_000, () => 1)).toBe(250);
  });

  it("lists only missing env names and checks runner ceilings", () => {
    const suite = payload("e1", {
      requiredEnv: [
        { name: "A", source: "header", key: "X-A", mapped: true },
        { name: "B", source: "header", key: "X-B", mapped: false },
      ],
    });
    expect(missingRequiredEnv(suite, { A: "set" })).toEqual(["B"]);
    const limited = payload("e1", {
      limits: { ...payload("e1").limits, runnerConstrained: true },
      suite: { ...payload("e1").suite, load: { ...payload("e1").suite.load, maxConcurrency: 50 } },
    });
    expect(runnerLimitViolation(limited)).toMatch(/concurrency 50 exceeds 10/);
    expect(runnerLimitViolation(payload("e1"))).toBeNull();
  });

  it("scrubs secrets and the home directory", () => {
    const scrub = makeScrubber([TOKEN, "s3cret-value"]);
    expect(scrub(`token ${TOKEN} and s3cret-value`)).toBe("token [redacted] and [redacted]");
  });
});

describe("worker loop", () => {
  it("reconnects with backoff after connect failures and logs the selected transport", async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    const attempts: TransportKind[] = [];
    const fake = fakeTransport("sse");
    const exit = runWorker({
      server: "http://127.0.0.1:1",
      token: TOKEN,
      env: {},
      log: (line) => lines.push(line),
      signal: controller.signal,
      backoff: { initialMs: 1, maxMs: 5 },
      connect: async (kind) => {
        attempts.push(kind);
        if (attempts.length <= 2) throw new Error("ECONNREFUSED");
        if (kind === "http2") throw new WorkerProtocolError("HTTP/2 unavailable: no h2");
        return fake.transport;
      },
    });
    fake.push({ type: "ready", label: "w1", transport: "sse", channelId: "c" });
    await until(() => lines.some((line) => line.includes("connected via SSE")));
    controller.abort();
    expect(await exit).toEqual({ code: 0, reason: "stopped" });
    expect(attempts).toEqual(["http2", "sse", "http2", "sse"]);
    expect(lines.some((line) => /retrying in \d+ms/.test(line))).toBe(true);
    expect(lines.some((line) => line.includes("falling back to SSE"))).toBe(true);
  });

  it("reconnects after a transient disconnect", async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    const first = fakeTransport("http2");
    const second = fakeTransport("http2");
    const queue = [first, second];
    const exit = runWorker({
      server: "http://127.0.0.1:1",
      token: TOKEN,
      transport: "http2",
      env: {},
      log: (line) => lines.push(line),
      signal: controller.signal,
      backoff: { initialMs: 1, maxMs: 2 },
      connect: async () => queue.shift()!.transport,
    });
    first.push({ type: "ready", label: "w1" });
    await until(() => lines.some((line) => line.includes("connected via HTTP/2")));
    first.end({ kind: "disconnected", error: "stream ended" });
    second.push({ type: "ready", label: "w1" });
    await until(() => lines.filter((line) => line.includes("connected via HTTP/2")).length === 2);
    controller.abort();
    expect((await exit).code).toBe(0);
    expect(lines.some((line) => line.includes("reconnecting in"))).toBe(true);
  });

  it("stops with a non-zero exit on token_revoked and on 401", async () => {
    const fake = fakeTransport("http2");
    const exit = runWorker({ server: "http://127.0.0.1:1", token: TOKEN, transport: "http2", env: {}, log: () => undefined, connect: async () => fake.transport });
    fake.push({ type: "ready", label: "w1" });
    fake.push({ type: "error", error: "token_revoked" });
    fake.end({ kind: "revoked" });
    expect(await exit).toMatchObject({ code: 1, reason: expect.stringContaining("token_revoked") });

    const unauthorized = await runWorker({
      server: "http://127.0.0.1:1",
      token: TOKEN,
      env: {},
      log: () => undefined,
      connect: async () => {
        throw new WorkerAuthError("worker token was rejected (401 unauthorized)");
      },
    });
    expect(unauthorized.code).toBe(1);
  });

  it("rejects a bad assignment and keeps waiting for the next one", async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    const fake = fakeTransport("http2", (id) => (id === "bad-suite" ? { ok: false, status: 404, error: "suite_not_found" } : { ok: true, payload: payload(id) }));
    const runSuite: SuiteRunner = async () => passReport("x");
    const exit = runWorker({
      server: "http://127.0.0.1:1",
      token: TOKEN,
      transport: "http2",
      env: { API_TOKEN: "fake-api-token-value" },
      log: (line) => lines.push(line),
      signal: controller.signal,
      connect: async () => fake.transport,
      runSuite,
    });
    fake.push({ type: "ready", label: "w1" });
    fake.push({ type: "assign", projectId: "p_1", suiteId: "s_1", version: 1 });
    await until(() => fake.sent.some((frame) => frame.type === "reject" && frame.reason === "assign_missing_execution_id"));
    fake.push({ type: "assign", executionId: "bad-suite", projectId: "p_1", suiteId: "s_1", version: 1 });
    await until(() => fake.sent.some((frame) => frame.type === "reject" && frame.executionId === "bad-suite"));
    expect(fake.sent.find((frame) => frame.executionId === "bad-suite" && frame.type === "reject")).toMatchObject({
      reason: "suite_unavailable: 404 suite_not_found",
    });
    fake.push({ type: "assign", executionId: "good", projectId: "p_1", suiteId: "s_1", version: 1 });
    await until(() => fake.sent.some((frame) => frame.type === "complete"));
    expect(fake.sent.filter((frame) => frame.executionId === "good").map((frame) => frame.type)).toEqual(["accept", "complete"]);
    expect(fake.sent.find((frame) => frame.type === "complete")).toMatchObject({ verdict: "pass" });
    expect(lines).toContain("Execution good finished: PASS");
    controller.abort();
    expect((await exit).code).toBe(0);
  });

  it("rejects with the missing env names only and never sends the token or resolved secrets", async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    const fake = fakeTransport("sse", (id) => ({
      ok: true,
      payload: payload(id, {
        requiredEnv: [
          { name: "API_TOKEN", source: "header", key: "Authorization", mapped: false },
          { name: "SWARM_TARGET_HEADER_X_CUSTOM", source: "header", key: "X-Custom", mapped: true },
        ],
        target: {
          transport: "streamable-http",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer ${env:API_TOKEN}", "X-Custom": "${env:SWARM_TARGET_HEADER_X_CUSTOM}" },
        },
      }),
    }));
    let ran = 0;
    const exit = runWorker({
      server: "http://127.0.0.1:1",
      token: TOKEN,
      transport: "sse",
      env: { API_TOKEN: "fake-resolved-api-value" },
      log: (line) => lines.push(line),
      signal: controller.signal,
      connect: async () => fake.transport,
      runSuite: async () => {
        ran += 1;
        return passReport("fake-resolved-api-value");
      },
    });
    fake.push({ type: "ready", label: "w1" });
    fake.push({ type: "assign", executionId: "e1", projectId: "p_1", suiteId: "s_1", version: 1 });
    await until(() => fake.sent.some((frame) => frame.type === "reject"));
    expect(fake.sent.find((frame) => frame.type === "reject")).toEqual({
      type: "reject",
      executionId: "e1",
      reason: "missing credential: SWARM_TARGET_HEADER_X_CUSTOM",
    });
    expect(ran).toBe(0);
    controller.abort();
    await exit;
    const everything = JSON.stringify(fake.sent) + lines.join("\n");
    expect(everything).not.toContain("fake-resolved-api-value");
    expect(everything).not.toContain(TOKEN);
  });

  it("redacts resolved secrets and the token from the report and progress", async () => {
    const controller = new AbortController();
    const fake = fakeTransport("http2", (id) => ({ ok: true, payload: payload(id) }));
    const exit = runWorker({
      server: "http://127.0.0.1:1",
      token: TOKEN,
      transport: "http2",
      env: { API_TOKEN: "fake-resolved-api-value" },
      log: () => undefined,
      signal: controller.signal,
      connect: async () => fake.transport,
      runSuite: async ({ target, onProgress }) => {
        const auth = target.transport === "stdio" ? "" : target.headers?.Authorization ?? "";
        expect(auth).toBe("Bearer fake-resolved-api-value");
        onProgress({ ts: "t", runId: "e2", name: "mcp.step", attributes: { detail: `${auth} ${TOKEN}` } });
        onProgress({ ts: "t", runId: "e2", name: "run.finished", attributes: { ok: true } });
        return passReport(`${auth} ${TOKEN} ${homedir()}/cache ${process.cwd()}/state.json`);
      },
    });
    fake.push({ type: "ready", label: "w1" });
    fake.push({ type: "assign", executionId: "e2", projectId: "p_1", suiteId: "s_1", version: 1 });
    await until(() => fake.sent.some((frame) => frame.type === "complete"));
    controller.abort();
    await exit;
    expect(fake.sent.map((frame) => frame.type)).toEqual(["accept", "progress", "complete"]);
    const text = JSON.stringify(fake.sent);
    expect(text).not.toContain("fake-resolved-api-value");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(homedir());
    expect(text).not.toContain(process.cwd());
  });

  it("stays busy until a withdrawn run settles, then accepts the next assignment", async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    const fake = fakeTransport("http2", (id) => ({ ok: true, payload: payload(id) }));
    const releases = new Map<string, () => void>();
    const signals = new Map<string, AbortSignal>();
    const exit = runWorker({
      server: "http://127.0.0.1:1",
      token: TOKEN,
      transport: "http2",
      env: { API_TOKEN: "x-value" },
      log: (line) => lines.push(line),
      signal: controller.signal,
      connect: async () => fake.transport,
      runSuite: ({ suite, signal, onProgress }) =>
        new Promise<RunReport>((resolve) => {
          signals.set(suite.executionId, signal);
          releases.set(suite.executionId, () => {
            onProgress({ ts: "t", runId: suite.executionId, name: "mcp.step", attributes: { late: true } });
            resolve(passReport("x"));
          });
        }),
    });
    fake.push({ type: "ready", label: "w1" });
    fake.push({ type: "assign", executionId: "old", projectId: "p_1", suiteId: "s_1", version: 1 });
    await until(() => releases.has("old"));
    fake.push({ type: "withdraw", executionId: "old", reason: "execution_timeout" });
    await until(() => lines.some((line) => line.startsWith("Execution old abandoned")));
    expect(signals.get("old")?.aborted).toBe(true);

    fake.push({ type: "assign", executionId: "next-1", projectId: "p_1", suiteId: "s_1", version: 1 });
    await until(() => fake.sent.some((frame) => frame.executionId === "next-1"));
    expect(fake.sent.filter((frame) => frame.executionId === "next-1")).toEqual([
      { type: "reject", executionId: "next-1", reason: "worker_busy" },
    ]);

    releases.get("old")!();
    await until(() => lines.includes("Execution old stopped; its result was dropped"));
    expect(fake.sent.filter((frame) => frame.executionId === "old").map((frame) => frame.type)).toEqual(["accept"]);

    fake.push({ type: "assign", executionId: "next-2", projectId: "p_1", suiteId: "s_1", version: 1 });
    await until(() => releases.has("next-2"));
    expect(fake.sent.filter((frame) => frame.executionId === "next-2").map((frame) => frame.type)).toEqual(["accept"]);
    releases.get("next-2")!();
    await until(() => fake.sent.some((frame) => frame.type === "complete" && frame.executionId === "next-2"));
    controller.abort();
    expect((await exit).code).toBe(0);
  });

  it("aborts the run on disconnect and waits for it before reconnecting work or stopping", async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    const first = fakeTransport("http2", (id) => ({ ok: true, payload: payload(id) }));
    const second = fakeTransport("http2", (id) => ({ ok: true, payload: payload(id) }));
    const queue = [first, second];
    let release: () => void = () => undefined;
    let runSignal: AbortSignal | undefined;
    const exit = runWorker({
      server: "http://127.0.0.1:1",
      token: TOKEN,
      transport: "http2",
      env: { API_TOKEN: "x-value" },
      log: (line) => lines.push(line),
      signal: controller.signal,
      backoff: { initialMs: 1, maxMs: 2 },
      connect: async () => queue.shift()!.transport,
      runSuite: ({ signal }) =>
        new Promise<RunReport>((resolve) => {
          runSignal = signal;
          release = () => resolve(passReport("x"));
        }),
    });
    first.push({ type: "ready", label: "w1" });
    first.push({ type: "assign", executionId: "d1", projectId: "p_1", suiteId: "s_1", version: 1 });
    await until(() => runSignal !== undefined);
    first.end({ kind: "disconnected", error: "stream ended" });
    second.push({ type: "ready", label: "w1" });
    await until(() => lines.filter((line) => line.includes("connected via HTTP/2")).length === 2);
    expect(runSignal?.aborted).toBe(true);
    second.push({ type: "assign", executionId: "d2", projectId: "p_1", suiteId: "s_1", version: 1 });
    await until(() => second.sent.some((frame) => frame.executionId === "d2"));
    expect(second.sent.find((frame) => frame.executionId === "d2")).toMatchObject({ type: "reject", reason: "worker_busy" });
    controller.abort();
    let stopped = false;
    void exit.then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    release();
    expect((await exit).code).toBe(0);
    expect(lines).toContain("Waiting for the current run to stop");
  });

  it("refuses stdio targets unless allowStdio is set", async () => {
    const stdioPayload = (id: string) => ({
      ok: true as const,
      payload: payload(id, { target: { transport: "stdio", command: "mock-server/run.sh" }, requiredEnv: [], policy: { targetAllowlist: ["stdio"], gatewayAllowlist: [] } }),
    });
    const controller = new AbortController();
    const lines: string[] = [];
    const fake = fakeTransport("http2", stdioPayload);
    let ran = 0;
    const exit = runWorker({
      server: "http://127.0.0.1:1",
      token: TOKEN,
      transport: "http2",
      env: {},
      log: (line) => lines.push(line),
      signal: controller.signal,
      connect: async () => fake.transport,
      runSuite: async () => {
        ran += 1;
        return passReport("x");
      },
    });
    fake.push({ type: "ready", label: "w1" });
    fake.push({ type: "assign", executionId: "s1", projectId: "p_1", suiteId: "s_1", version: 1 });
    await until(() => fake.sent.some((frame) => frame.type === "reject"));
    expect(fake.sent).toEqual([
      { type: "accept", executionId: "s1" },
      { type: "reject", executionId: "s1", reason: STDIO_NOT_ALLOWED },
    ]);
    expect(ran).toBe(0);
    expect(lines[0]).toMatch(/Stdio targets: refused/);
    controller.abort();
    await exit;

    const allowed = fakeTransport("http2", stdioPayload);
    const second = new AbortController();
    const allowedLines: string[] = [];
    const exit2 = runWorker({
      server: "http://127.0.0.1:1",
      token: TOKEN,
      transport: "http2",
      allowStdio: true,
      env: {},
      log: (line) => allowedLines.push(line),
      signal: second.signal,
      connect: async () => allowed.transport,
      runSuite: async () => passReport("x"),
    });
    allowed.push({ type: "ready", label: "w1" });
    allowed.push({ type: "assign", executionId: "s2", projectId: "p_1", suiteId: "s_1", version: 1 });
    await until(() => allowed.sent.some((frame) => frame.type === "complete"));
    expect(allowedLines[0]).toMatch(/Stdio targets: allowed/);
    second.abort();
    await exit2;
  });

  it("abandons the run on withdraw without sending complete", async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    const fake = fakeTransport("http2", (id) => ({ ok: true, payload: payload(id) }));
    let release: (report: RunReport) => void = () => undefined;
    const exit = runWorker({
      server: "http://127.0.0.1:1",
      token: TOKEN,
      transport: "http2",
      env: { API_TOKEN: "x-value" },
      log: (line) => lines.push(line),
      signal: controller.signal,
      connect: async () => fake.transport,
      runSuite: () => new Promise<RunReport>((resolve) => (release = resolve)),
    });
    fake.push({ type: "ready", label: "w1" });
    fake.push({ type: "assign", executionId: "e3", projectId: "p_1", suiteId: "s_1", version: 1 });
    await until(() => lines.some((line) => line.startsWith("Running ")));
    fake.push({ type: "withdraw", executionId: "e3", reason: "execution_timeout" });
    await until(() => lines.some((line) => line.startsWith("Execution e3 abandoned")));
    release(passReport("x"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.sent.some((frame) => frame.type === "complete")).toBe(false);
    controller.abort();
    await exit;
  });

  it("applies distributed VU slice assignments and exports OTLP metrics/traces to the central Swarm server", async () => {
    expect(resolveWorkerMaxVus("25", {})).toBe(25);
    expect(resolveWorkerMaxVus(undefined, { SWARM_WORKER_MAX_VUS: "40" })).toBe(40);
    const sliced = applyWorkerVuSlice(payload("e-slice"), { shardIndex: 1, totalShards: 4, assignedVus: 15 }, 10);
    expect(sliced.suite.load.maxConcurrency).toBe(10);
    expect(sliced.vuSlice).toEqual({ shardIndex: 1, totalShards: 4, assignedVus: 15 });

    const otlpPosts: Array<{ url: string; headers: Record<string, string> }> = [];
    const fakeOtlpFetch: typeof fetch = async (input, init) => {
      const h: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (h[k.toLowerCase()] = v));
      otlpPosts.push({ url: String(input), headers: h });
      return new Response("{}", { status: 200 });
    };

    const sampleReport = {
      id: "e-slice",
      startedAt: new Date().toISOString(),
      verdict: "pass",
      failReasons: [],
      toolSeries: [
        { toolName: "skill_search", count: 5, errorCount: 0, errorRate: 0, latencyMs: { min: 5, max: 20, mean: 10, p50: 10, p90: 18, p95: 20, p99: 20 } },
      ],
    } as unknown as RunReport;

    const exported = await exportWorkerOtelToServer({
      server: "https://swarm.botz.ai",
      token: TOKEN,
      executionId: "e-slice",
      report: sampleReport,
      scrub: (s) => s,
      fetchFn: fakeOtlpFetch,
    });
    expect(exported).toEqual({ metricsOk: true, tracesOk: true });
    expect(otlpPosts.map((p) => p.url)).toEqual([
      "https://swarm.botz.ai/otlp/v1/metrics",
      "https://swarm.botz.ai/otlp/v1/traces",
    ]);
    expect(otlpPosts[0]?.headers["x-swarm-run-id"]).toBe("e-slice");
    expect(otlpPosts[0]?.headers["user-agent"]).toMatch(/\(mcp-tester\)$/);
  });
});
