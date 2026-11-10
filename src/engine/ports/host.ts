/**
 * Host ports: platform and CLI extend the engine without forking core modules.
 */
import type { RetryPolicy } from "../core/rate-limit-retry.js";

export type { RetryPolicy };

export interface StoragePort {
  readonly kind: "file" | "duckdb" | (string & {});
}

export interface TelemetrySink {
  onSpan?(payload: unknown): void | Promise<void>;
  onMetric?(payload: unknown): void | Promise<void>;
}

export interface InferencePort {
  infer(input: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    signal?: AbortSignal;
  }): Promise<{ text: string; usage?: Record<string, number> }>;
}

export interface PolicyPort {
  readonly principalLabel?: string;
}

export interface AuditSink {
  append(event: Record<string, unknown>): void | Promise<void>;
}

export interface SecretsPort {
  get(name: string): Promise<string | undefined>;
}

export interface RunHooks {
  beforeRun?(ctx: { runId: string }): void | Promise<void>;
  onStep?(ctx: { runId: string; step: string }): void | Promise<void>;
  onRetry?(ctx: { runId: string; attempt: number; reason: string }): void | Promise<void>;
  onEvent?(ctx: { runId: string; name: string; attributes?: Record<string, unknown> }): void | Promise<void>;
  afterRun?(ctx: { runId: string; verdict: string }): void | Promise<void>;
}

export interface EngineHost {
  storage?: StoragePort;
  telemetry?: TelemetrySink;
  inference?: InferencePort;
  policy?: PolicyPort;
  audit?: AuditSink;
  secrets?: SecretsPort;
  hooks?: RunHooks;
  retry?: Partial<RetryPolicy> & {
    unavailableBudgetMs?: number;
    classify?: (err: unknown) => "rate_limit" | "unavailable" | "fatal" | null;
  };
}

let activeHost: EngineHost | undefined;

export function setEngineHost(host: EngineHost | undefined): void {
  activeHost = host;
}

export function getEngineHost(): EngineHost | undefined {
  return activeHost;
}

export function resolveUnavailableBudgetMs(): number {
  const fromHost = activeHost?.retry?.unavailableBudgetMs;
  if (typeof fromHost === "number" && fromHost >= 0) return fromHost;
  return 90_000;
}
