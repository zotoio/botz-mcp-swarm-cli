import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "../adapters/base.js";
import {
  RETRY_DEFAULTS,
  backoffDelayMs,
  detectRateLimit,
  isRateLimitMessage,
  parseRetryAfterMs,
  resolveRetryPolicy,
  retryingSession,
  withRateLimitRetry,
} from "./rate-limit-retry.js";

const PARALLEL_FREE_TIER =
  "MCP error -32000: You've hit the free-tier rate limit for this MCP server. Add your own API key with the Authorization: Bearer header.";

const fail = (over: Record<string, unknown> = {}) => ({
  success: false,
  latencyMs: 1,
  errorClass: "application",
  bytesIn: 0,
  bytesOut: 0,
  ...over,
});
const ok = { success: true, latencyMs: 1, errorClass: "none", bytesIn: 0, bytesOut: 0 };

describe("rate limit detection", () => {
  it("matches rate limit / too many requests / quota patterns", () => {
    expect(isRateLimitMessage(PARALLEL_FREE_TIER)).toBe(true);
    expect(isRateLimitMessage("Too Many Requests")).toBe(true);
    expect(isRateLimitMessage("Error POSTing to endpoint (HTTP 429): slow down")).toBe(true);
    expect(isRateLimitMessage("monthly quota exceeded")).toBe(true);
    expect(isRateLimitMessage("You have exceeded your quota")).toBe(true);
    expect(isRateLimitMessage("search_queries must be a non-empty list")).toBe(false);
    expect(isRateLimitMessage("401 Unauthorized")).toBe(false);
  });

  it("classifies Parallel's -32000 free-tier error as rate_limit, not auth", () => {
    expect(classifyError(new Error(PARALLEL_FREE_TIER))).toBe("rate_limit");
    expect(classifyError(new Error("401 Unauthorized"))).toBe("auth");
  });

  it("detects HTTP 429, Retry-After and JSON-RPC data", () => {
    expect(detectRateLimit({ error: Object.assign(new Error("boom"), { code: 429 }) }).rateLimited).toBe(true);
    expect(detectRateLimit({ status: 429 }).rateLimited).toBe(true);
    expect(detectRateLimit(fail({ responseHeaders: { "retry-after": "3" } }))).toEqual({ rateLimited: true, retryAfterMs: 3000 });
    expect(detectRateLimit({ error: Object.assign(new Error("MCP error -32000"), { data: { reason: "rate_limited" } }) }).rateLimited).toBe(true);
    expect(detectRateLimit(fail({ errorMessage: "invalid params" })).rateLimited).toBe(false);
    expect(detectRateLimit({ ...ok, responseHeaders: { "retry-after": "3" } }).rateLimited).toBe(false);
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-22T00:00:00Z");
    expect(parseRetryAfterMs("2", now)).toBe(2000);
    expect(parseRetryAfterMs("Thu, 22 Oct 2026 00:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfterMs("garbage", now)).toBeUndefined();
  });
});

describe("backoff maths", () => {
  const policy = resolveRetryPolicy();
  it("uses the documented defaults", () => {
    expect(policy).toEqual({ enabled: true, baseMs: 500, factor: 2, maxDelayMs: 30_000, maxRetries: 5 });
    expect(RETRY_DEFAULTS.maxRetries).toBe(5);
  });
  it("full jitter within base*factor^n capped at maxDelay", () => {
    expect(backoffDelayMs(0, policy, () => 0.999)).toBe(499);
    expect(backoffDelayMs(3, policy, () => 0.5)).toBe(2000);
    expect(backoffDelayMs(10, policy, () => 0.5)).toBe(15_000);
    expect(backoffDelayMs(2, policy, () => 0)).toBe(0);
  });
  it("honours Retry-After, and gives up when it exceeds maxDelay", () => {
    expect(backoffDelayMs(0, policy, () => 0.1, 7000)).toBe(7000);
    expect(backoffDelayMs(0, policy, () => 0.1, 60_000)).toBeUndefined();
  });
});

describe("withRateLimitRetry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries rate-limited results then returns the final success", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce(fail({ errorClass: "rate_limit", errorMessage: PARALLEL_FREE_TIER }))
      .mockResolvedValueOnce(fail({ responseHeaders: { "retry-after": "2" } }))
      .mockResolvedValueOnce(ok);
    const events: number[] = [];
    const promise = withRateLimitRetry(call, {
      policy: resolveRetryPolicy(),
      classify: (r) => detectRateLimit(r),
      random: () => 0.5,
      onRetry: (e) => events.push(e.delayMs),
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(call).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBe(ok);
    expect(call).toHaveBeenCalledTimes(3);
    expect(events).toEqual([250, 2000]);
  });

  it("does not retry other error classes", async () => {
    const call = vi.fn().mockResolvedValue(fail({ errorClass: "protocol", errorMessage: "-32602 invalid params" }));
    const thrown = vi.fn().mockRejectedValue(new Error("401 Unauthorized"));
    const policy = resolveRetryPolicy();
    await expect(withRateLimitRetry(call, { policy, classify: (r) => detectRateLimit(r) })).resolves.toMatchObject({ errorClass: "protocol" });
    await expect(withRateLimitRetry(thrown, { policy })).rejects.toThrow("401");
    expect(call).toHaveBeenCalledTimes(1);
    expect(thrown).toHaveBeenCalledTimes(1);
  });

  it("stops after maxRetries and returns the last rate-limited outcome", async () => {
    const call = vi.fn().mockResolvedValue(fail({ errorClass: "rate_limit" }));
    const promise = withRateLimitRetry(call, { policy: resolveRetryPolicy({ maxRetries: 2 }), classify: (r) => detectRateLimit(r), random: () => 1 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ errorClass: "rate_limit" });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("is off when enabled=false", async () => {
    const call = vi.fn().mockResolvedValue(fail({ errorClass: "rate_limit" }));
    await withRateLimitRetry(call, { policy: resolveRetryPolicy({ enabled: false }), classify: (r) => detectRateLimit(r) });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("respects the run deadline: no sleep that would cross it", async () => {
    const call = vi.fn().mockResolvedValue(fail({ responseHeaders: { "retry-after": "5" } }));
    const onRetry = vi.fn();
    const result = await withRateLimitRetry(call, {
      policy: resolveRetryPolicy(),
      classify: (r) => detectRateLimit(r),
      deadline: Date.now() + 3000,
      onRetry,
    });
    expect(result).toMatchObject({ success: false });
    expect(call).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries thrown rate-limit errors during session setup", async () => {
    const connect = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("Error POSTing to endpoint (HTTP 429)"), { code: 429 }))
      .mockResolvedValueOnce("session");
    const promise = withRateLimitRetry(connect, { policy: resolveRetryPolicy(), random: () => 0 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("session");
  });

  it("retryingSession wraps call methods only", async () => {
    const session = {
      id: "s1",
      callTool: vi.fn().mockResolvedValueOnce(fail({ errorClass: "rate_limit" })).mockResolvedValueOnce(ok),
    };
    const seen: string[] = [];
    const wrapped = retryingSession(session, resolveRetryPolicy(), { onRetry: (m) => seen.push(m) });
    expect(wrapped.id).toBe("s1");
    const promise = wrapped.callTool("web_search", {});
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe(ok);
    expect(seen).toEqual(["callTool"]);
  });
});
