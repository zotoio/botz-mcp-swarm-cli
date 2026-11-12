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
  /** Wall time to keep retrying 502/503/504 per step (default 90s). */
  unavailableBudgetMs: z.number().int().nonnegative().default(90_000),
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

/** The reverse proxy's 503 body (zoto-sites nginx @unavailable) and common gateway texts. */
export const UNAVAILABLE_MESSAGE = "Service temporarily unavailable. Please retry shortly.";
const UNAVAILABLE_PATTERNS = [
  /service temporarily unavailable/i,
  /\bservice unavailable\b/i,
  /\bbad gateway\b/i,
  /\bgateway time-?out\b/i,
  /\b(?:http|status(?: code)?)[\s:=(]*50[234]\b/i,
  /\(HTTP 50[234]\)/i,
  /"code"\s*:\s*-32003\b[^}]*"transient"\s*:\s*true/i,
];

/** HTTP status that means "the environment is unavailable", not an application failure. */
export function isUnavailableStatus(status: number | undefined): boolean {
  return status === 502 || status === 503 || status === 504;
}

export function isUnavailableMessage(text: string | undefined | null): boolean {
  if (!text) return false;
  return UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Max wall time one step keeps retrying an unavailable target before giving up. */
export const UNAVAILABLE_BUDGET_MS = 90_000;
const UNAVAILABLE_BASE_MS = 1_000;
const UNAVAILABLE_MAX_DELAY_MS = 15_000;

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

/**
 * Where the signal came from, low cardinality so it is safe as a metric attribute:
 * - `http_429`: HTTP 429, or a Retry-After header / explicit 429 in the response.
 * - `mcp_protocol`: an MCP/JSON-RPC error — errorClass `rate_limit`, or rate-limit text in the
 *   error message or `error.data`.
 * - `unavailable`: 502/503/504 or the reverse proxy's unavailable body.
 */
export type RateLimitSource = "http_429" | "mcp_protocol" | "unavailable";

/** An explicit 429 in free text (e.g. "Error POSTing to endpoint (HTTP 429)"). */
const HTTP_429_TEXT = /\b429\b/;

export interface RateLimitSignal {
  rateLimited: boolean;
  /** 502/503/504 or the proxy unavailable body: retried for UNAVAILABLE_BUDGET_MS per step. */
  unavailable?: boolean;
  retryAfterMs?: number;
  /** Set whenever `rateLimited` or `unavailable` is true. */
  source?: RateLimitSource;
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
  const errText = typeof err?.message === "string" ? err.message : undefined;
  const unavailable =
    input.errorClass === "unavailable" ||
    isUnavailableStatus(status) ||
    isUnavailableMessage(input.errorMessage) ||
    isUnavailableMessage(errText) ||
    isUnavailableMessage(dataText);
  if (unavailable && input.errorClass !== "rate_limit" && status !== 429) {
    return {
      rateLimited: false,
      unavailable: true,
      source: "unavailable",
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }
  const rateLimited =
    input.errorClass === "rate_limit" ||
    status === 429 ||
    retryAfterMs !== undefined ||
    isRateLimitMessage(input.errorMessage) ||
    isRateLimitMessage(typeof err?.message === "string" ? err.message : undefined) ||
    isRateLimitMessage(dataText);
  if (!rateLimited) return { rateLimited: false };
  // 429 or Retry-After means the transport said so; anything else was only visible in the protocol error.
  const http429 =
    status === 429 ||
    retryAfterMs !== undefined ||
    HTTP_429_TEXT.test(input.errorMessage ?? "") ||
    HTTP_429_TEXT.test(errText ?? "") ||
    HTTP_429_TEXT.test(dataText);
  return {
    rateLimited,
    source: http429 ? "http_429" : "mcp_protocol",
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
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

export type RetryReason = "rate_limit" | "unavailable";

export interface RetryEvent {
  attempt: number;
  delayMs: number;
  reason: RetryReason;
  source: RateLimitSource;
  retryAfterMs?: number;
  /** True when `delayMs` came from the server's Retry-After rather than the backoff curve. */
  retryAfterHonoured: boolean;
  message?: string;
}

/**
 * Why a retry loop stopped while the outcome was still rate-limited:
 * - `max_retries`: the policy's attempt budget ran out.
 * - `retry_after_too_long`: Retry-After was longer than `maxDelayMs`.
 * - `deadline`: the sleep would cross the run deadline or ramp-down drain.
 * - `budget`: the unavailable wall-time budget for this call ran out.
 */
export type RetryGiveUpCause = "max_retries" | "retry_after_too_long" | "deadline" | "budget";

export interface RetryGiveUpEvent {
  reason: RetryReason;
  source: RateLimitSource;
  /** Calls made before giving up, including the first. */
  attempts: number;
  cause: RetryGiveUpCause;
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
  /** Called once when the loop gives up on a signal it would otherwise have retried. */
  onGiveUp?: (event: RetryGiveUpEvent) => void;
  describe?: (valueOrError: unknown) => string | undefined;
  /** Per-call budget for retrying an unavailable target (default UNAVAILABLE_BUDGET_MS). */
  unavailableBudgetMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run `call`, retrying only rate-limited outcomes. Returns (or throws) the final outcome. */
export async function withRateLimitRetry<T>(call: () => Promise<T>, options: RetryOptions<T>): Promise<T> {
  const { policy } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const classifyError = options.classifyError ?? ((error: unknown) => detectRateLimit({ error }, now()));
  const startedAt = now();
  let unavailableAttempts = 0;
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
    const raw = outcome.ok ? outcome.value : outcome.error;
    const describe = () => options.describe?.(raw) ?? (raw instanceof Error ? raw.message : undefined);
    const reason: RetryReason = signal.unavailable ? "unavailable" : "rate_limit";
    const giveUp = (cause: RetryGiveUpCause): T => {
      options.onGiveUp?.({
        reason,
        source: signal.source ?? (signal.unavailable ? "unavailable" : "mcp_protocol"),
        attempts: attempt + 1,
        cause,
        ...(signal.retryAfterMs !== undefined ? { retryAfterMs: signal.retryAfterMs } : {}),
        message: describe(),
      });
      return finish();
    };
    if (!policy.enabled) return finish();
    let delayMs: number | undefined;
    let retryAfterHonoured = false;
    if (signal.unavailable) {
      // Environment unavailable (deploy, proxy 503): keep trying for the per-step budget,
      // honouring Retry-After, independent of the rate-limit retry count.
      const budget = options.unavailableBudgetMs ?? UNAVAILABLE_BUDGET_MS;
      const elapsed = now() - startedAt;
      if (elapsed >= budget) return giveUp("budget");
      const backoff = Math.min(UNAVAILABLE_MAX_DELAY_MS, UNAVAILABLE_BASE_MS * 2 ** unavailableAttempts);
      delayMs = Math.min(signal.retryAfterMs ?? backoff, UNAVAILABLE_MAX_DELAY_MS, budget - elapsed);
      retryAfterHonoured = signal.retryAfterMs !== undefined && delayMs === signal.retryAfterMs;
      unavailableAttempts++;
    } else {
      if (!signal.rateLimited) return finish();
      if (attempt >= policy.maxRetries) return giveUp("max_retries");
      delayMs = backoffDelayMs(attempt, policy, options.random, signal.retryAfterMs);
      if (delayMs === undefined) return giveUp("retry_after_too_long");
      retryAfterHonoured = signal.retryAfterMs !== undefined;
    }
    if (options.deadline !== undefined && now() + delayMs >= options.deadline) return giveUp("deadline");
    options.onRetry?.({
      attempt: attempt + 1,
      delayMs,
      reason,
      source: signal.source ?? (signal.unavailable ? "unavailable" : "mcp_protocol"),
      ...(signal.retryAfterMs !== undefined ? { retryAfterMs: signal.retryAfterMs } : {}),
      retryAfterHonoured,
      message: describe(),
    });
    await sleep(delayMs);
    if (options.deadline !== undefined && now() >= options.deadline) return giveUp("deadline");
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
  opts: {
    deadline?: () => number | undefined;
    onRetry?: (method: string, event: RetryEvent) => void;
    onGiveUp?: (method: string, event: RetryGiveUpEvent) => void;
  } = {},
): S {
  if (!policy.enabled) return session;
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
          unavailableBudgetMs: policy.unavailableBudgetMs,
          classify: (result) => detectRateLimit(result as Parameters<typeof detectRateLimit>[0]),
          describe: (raw) => (raw as { errorMessage?: string } | undefined)?.errorMessage,
          onRetry: (event) => opts.onRetry?.(prop, event),
          onGiveUp: (event) => opts.onGiveUp?.(prop, event),
        });
    },
  });
}
