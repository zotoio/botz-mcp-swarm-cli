import { z } from "zod";

/** Defaults for compiled suites (unchanged from the previous hard-coded values). */
export const DEFAULT_SUITE_LIMITS = { maxCallCount: 100_000, maxPayloadBytes: 1_048_576 } as const;
/** Safety ceilings: no suite, flag, or env var may exceed these. */
export const SUITE_LIMIT_CEILINGS = { maxCallCount: 10_000_000, maxPayloadBytes: 67_108_864 } as const;

export const SUITE_LIMIT_ENV = { maxCallCount: "SWARM_MAX_CALL_COUNT", maxPayloadBytes: "SWARM_MAX_PAYLOAD_BYTES" } as const;

export const SuiteLimitsSchema = z.object({
  maxCallCount: z.number().int().positive().max(SUITE_LIMIT_CEILINGS.maxCallCount).optional(),
  maxPayloadBytes: z.number().int().positive().max(SUITE_LIMIT_CEILINGS.maxPayloadBytes).optional(),
}).strict();

export type SuiteLimitsInput = z.infer<typeof SuiteLimitsSchema>;
export type SuiteLimits = { maxCallCount: number; maxPayloadBytes: number };
export type SuiteLimitSource = "suite" | "flag" | "env" | "default";
export type EffectiveSuiteLimits = SuiteLimits & {
  source: { maxCallCount: SuiteLimitSource; maxPayloadBytes: SuiteLimitSource };
};

type Key = keyof SuiteLimits;
const KEYS: Key[] = ["maxCallCount", "maxPayloadBytes"];
const LABEL: Record<Key, string> = { maxCallCount: "max-call-count", maxPayloadBytes: "max-payload-bytes" };

/** Parse a string (flag or env value) as a positive integer within the ceiling. */
export function parseSuiteLimit(key: Key, value: string | number | undefined, label: string = LABEL[key]): number | undefined {
  if (value === undefined || value === "") return undefined;
  const text = String(value).trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  const n = Number(text);
  if (n > SUITE_LIMIT_CEILINGS[key]) throw new Error(`${label} must be <= ${SUITE_LIMIT_CEILINGS[key]}`);
  return n;
}

/**
 * Effective limits. Precedence per field: CLI flags, then the suite definition, then env vars
 * (SWARM_MAX_CALL_COUNT, SWARM_MAX_PAYLOAD_BYTES), then defaults.
 */
export function resolveSuiteLimits(input: {
  suite?: SuiteLimitsInput;
  flags?: Partial<SuiteLimits>;
  env?: NodeJS.ProcessEnv;
  defaults?: SuiteLimits;
} = {}): EffectiveSuiteLimits {
  const suite = SuiteLimitsSchema.parse(input.suite ?? {});
  const defaults = input.defaults ?? DEFAULT_SUITE_LIMITS;
  const out = { source: {} } as EffectiveSuiteLimits;
  for (const key of KEYS) {
    const flag = input.flags?.[key] !== undefined ? parseSuiteLimit(key, input.flags[key]) : undefined;
    const env = input.env ? parseSuiteLimit(key, input.env[SUITE_LIMIT_ENV[key]], SUITE_LIMIT_ENV[key]) : undefined;
    const [value, source]: [number, SuiteLimitSource] = flag !== undefined ? [flag, "flag"]
      : suite[key] !== undefined ? [suite[key], "suite"] : env !== undefined ? [env, "env"] : [defaults[key], "default"];
    out[key] = value;
    out.source[key] = source;
  }
  return out;
}
