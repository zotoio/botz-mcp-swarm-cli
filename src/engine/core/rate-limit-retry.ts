import { z } from "zod";

/**
 * Retry-with-backoff for rate-limited MCP calls (HTTP 429, Retry-After, or a
 * JSON-RPC/tool error whose text says rate limit / too many requests / quota).
 * Other error classes are never retried.
 */
export const RETRY_DEFAULTS = {
  enabled: true,
  baseMs: 500,
  factor: 2,
  maxDelayMs: 30_000,
  maxRetries: 5,
} as const;

export const RetryPolicySchema = z.object({
  enabled: z.boolean().default(RETRY_DEFAULTS.enabled),
  baseMs: z.number().int().nonnegative().default(RETRY_DEFAULTS.baseMs),
  factor: z.number().min(1).default(RETRY_DEFAULTS.factor),
  maxDelayMs: z.number().int().nonnegative().default(RETRY_DEFAULTS.maxDelayMs),
  maxRetries: z.number().int().nonnegative().max(20).default(RETRY_DEFAULTS.maxRetries),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export function resolveRetryPolicy(input?: Partial<RetryPolicy> | null): RetryPolicy {
  return RetryPolicySchema.parse(input ?? {});
}

const RATE_LIMIT_PATTERNS = [
  /rate[\s_-]?limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota (?:exceeded|exhausted|reached)/i,
  /(?:exceeded|exhausted|reached|over) (?:your |the )?(?:\w+ )?quota/i,
  /insufficient_quota/i,
  /throttl/i,
];

export function isRateLimitMessage(text: string | undefined | null): boolean {
  if (!text) return false;
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/** Retry-After as delta-seconds or an HTTP date, in ms from `now`. */
export function parseRetryAfterMs(value: string | undefined, now = Date.now()): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

export interface RateLimitSignal {
  rateLimited: boolean;
  retryAfterMs?: number;
}

/** Detect rate limiting on a failed call result (success=false) or a thrown error. */
export function detectRateLimit(
  input: {
    success?: boolean;
    errorClass?: string;
    errorMessage?: string;
    responseHeaders?: Record<string, string>;
    status?: number;
    error?: unknown;
  },
  now = Date.now(),
): RateLimitSignal {
  if (input.success) return { rateLimited: false };
  const err = input.error as { message?: unknown; code?: unknown; status?: unknown; data?: unknown } | undefined;
  const retryAfterMs = parseRetryAfterMs(headerValue(input.responseHeaders, "retry-after"), now);
  const status = input.status ?? (typeof err?.status === "number" ? err.status : undefined) ??
    (typeof err?.code === "number" && err.code === 429 ? 429 : undefined);
  let dataText = "";
  if (err?.data !== undefined) {
    try {
      dataText = typeof err.data === "string" ? err.data : JSON.stringify(err.data);
    } catch {
      dataText = "";
    }
  }
  const rateLimited =
    input.errorClass === "rate_limit" ||
    status === 429 ||
    retryAfterMs !== undefined ||
    isRateLimitMessage(input.errorMessage) ||
    isRateLimitMessage(typeof err?.message === "string" ? err.message : undefined) ||
    isRateLimitMessage(dataText);
  return rateLimited ? { rateLimited, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } : { rateLimited: false };
}

/**
 * Delay before retry number `attempt` (0-based). Full jitter:
 * random() * min(maxDelay, base * factor^attempt). A Retry-After hint wins when
 * present; one longer than maxDelayMs means "give up" (returns undefined).
 */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
  retryAfterMs?: number,
): number | undefined {
  if (retryAfterMs !== undefined) {
    return retryAfterMs > policy.maxDelayMs ? undefined : Math.max(0, retryAfterMs);
  }
  const ceiling = Math.min(policy.maxDelayMs, policy.baseMs * policy.factor ** attempt);
  return Math.floor(random() * ceiling);
}

export interface RetryEvent {
  attempt: number;
  delayMs: number;
  reason: "rate_limit";
  retryAfterMs?: number;
  message?: string;
}

export interface RetryOptions<T> {
  policy: RetryPolicy;
  /** Classify a returned value. Thrown errors go through `classifyError`. */
  classify?: (value: T) => RateLimitSignal;
  classifyError?: (error: unknown) => RateLimitSignal;
  /** Epoch ms; never sleep past it (run deadline / ramp-down). */
  deadline?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (event: RetryEvent) => void;
  describe?: (valueOrError: unknown) => string | undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run `call`, retrying only rate-limited outcomes. Returns (or throws) the final outcome. */
export async function withRateLimitRetry<T>(call: () => Promise<T>, options: RetryOptions<T>): Promise<T> {
  const { policy } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const classifyError = options.classifyError ?? ((error: unknown) => detectRateLimit({ error }, now()));
  for (let attempt = 0; ; attempt++) {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await call() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const signal = outcome.ok
      ? options.classify?.(outcome.value) ?? { rateLimited: false }
      : classifyError(outcome.error);
    const finish = (): T => {
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    };
    if (!policy.enabled || !signal.rateLimited || attempt >= policy.maxRetries) return finish();
    const delayMs = backoffDelayMs(attempt, policy, options.random, signal.retryAfterMs);
    if (delayMs === undefined) return finish();
    if (options.deadline !== undefined && now() + delayMs >= options.deadline) return finish();
    const raw = outcome.ok ? outcome.value : outcome.error;
    options.onRetry?.({
      attempt: attempt + 1,
      delayMs,
      reason: "rate_limit",
      ...(signal.retryAfterMs !== undefined ? { retryAfterMs: signal.retryAfterMs } : {}),
      message: options.describe?.(raw) ?? (raw instanceof Error ? raw.message : undefined),
    });
    await sleep(delayMs);
    if (options.deadline !== undefined && now() >= options.deadline) return finish();
  }
}

/** Methods on McpSession that return McpCallResult and may be retried. */
const RETRYABLE_SESSION_METHODS = new Set([
  "listTools", "callTool", "ping", "listResources", "listResourceTemplates", "readResource",
  "listPrompts", "getPrompt", "setLoggingLevel", "complete", "listTasks", "getTask", "cancelTask",
]);

/** Wrap a session so each call-returning method retries on rate limiting. */
export function retryingSession<S extends object>(
  session: S,
  policy: RetryPolicy,
  opts: { deadline?: () => number | undefined; onRetry?: (method: string, event: RetryEvent) => void } = {},
): S {
  if (!policy.enabled || policy.maxRetries === 0) return session;
  return new Proxy(session, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function" || !RETRYABLE_SESSION_METHODS.has(prop)) {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]) =>
        withRateLimitRetry(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args), {
          policy,
          deadline: opts.deadline?.(),
          classify: (result) => detectRateLimit(result as Parameters<typeof detectRateLimit>[0]),
          describe: (raw) => (raw as { errorMessage?: string } | undefined)?.errorMessage,
          onRetry: (event) => opts.onRetry?.(prop, event),
        });
    },
  });
}
