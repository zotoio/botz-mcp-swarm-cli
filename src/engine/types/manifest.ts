import { DEFAULT_LOAD_PROFILE } from "../core/load-defaults.js";
import { z } from "zod";
import { SUITE_LIMIT_CEILINGS } from "../core/suite-limits.js";
import { RetryPolicySchema } from "../core/rate-limit-retry.js";

export const TransportTypeSchema = z.enum(["stdio", "sse", "streamable-http"]);
export type TransportType = z.infer<typeof TransportTypeSchema>;

export const SessionReuseSchema = z.enum(["cold", "warm"]);
export type SessionReuse = z.infer<typeof SessionReuseSchema>;

export const StdioTargetSchema = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

export const HttpTargetSchema = z.object({
  transport: z.enum(["sse", "streamable-http"]),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const TargetSchema = z.union([StdioTargetSchema, HttpTargetSchema]);
export type Target = z.infer<typeof TargetSchema>;

export const SessionPoolSchema = z.object({
  size: z.number().int().positive().default(1),
  reuse: SessionReuseSchema.default("warm"),
});

export const QuotasSchema = z.object({
  maxConcurrency: z.number().int().positive().default(10),
  maxDurationMs: z.number().int().positive().default(60_000),
  maxCallCount: z.number().int().positive().max(SUITE_LIMIT_CEILINGS.maxCallCount).default(1000),
  maxPayloadBytes: z.number().int().positive().max(SUITE_LIMIT_CEILINGS.maxPayloadBytes).default(1_048_576),
});

export const AuthScenarioSchema = z.enum([
  "anon",
  "expired",
  "wrong-scope",
  "happy",
  "oidc-discovery",
  "cimd-register",
  "www-authenticate-scope",
]);
export type AuthScenario = z.infer<typeof AuthScenarioSchema>;

/** MCP JSON-RPC methods exercisable as scenario steps (2025-11-25 surface). */
export const ScenarioMethodSchema = z.enum([
  "initialize",
  "tools/list",
  "tools/call",
  "ping",
  "teardown",
  "resources/list",
  "resources/read",
  "resources/templates/list",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "logging/setLevel",
  "think",
  "extract",
  /** @experimental SDK tasks/* */
  "tasks/list",
  "tasks/get",
  "tasks/cancel",
]);
export type ScenarioMethod = z.infer<typeof ScenarioMethodSchema>;

export const ErrorClassSchema = z.enum([
  "none",
  "protocol",
  "application",
  "timeout",
  "transport",
  "quota",
  "allowlist",
  "auth",
  "rate_limit",
]);

export const ElicitAutoReplySchema = z.object({
  action: z.enum(["accept", "decline", "cancel"]).default("accept"),
  /** Form-mode content matching requestedSchema properties. */
  content: z.record(z.string(), z.unknown()).optional(),
});

export const ScenarioStepSchema = z.object({
  method: ScenarioMethodSchema,
  tool: z.string().optional(),
  resourceUri: z.string().optional(),
  prompt: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  expect: z
    .object({
      resultShape: z.enum([
        "initialize",
        "ping",
        "tools/list",
        "tools/call",
        "resources/list",
        "resources/read",
        "resource-templates",
        "prompts/list",
        "prompts/get",
        "completion",
        "logging",
      ]),
      inputSchema: z.record(z.string(), z.unknown()).optional(),
      outputSchema: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  auth: AuthScenarioSchema.optional(),
  /** URI for resources/read. */
  uri: z.string().optional(),
  /** Name for prompts/get. */
  name: z.string().optional(),
  /** Task id for tasks/get and tasks/cancel. */
  taskId: z.string().optional(),
  /**
   * Server capability keys required for this step (e.g. "resources", "prompts",
   * "tasks", "elicitation"). Missing capability = Fail (never silent skip).
   */
  requireCapabilities: z.array(z.string()).optional(),
  /** When set, step Passes only if the call's errorClass matches. */
  expectErrorClass: ErrorClassSchema.optional(),
  /** Auto-reply used when the SUT elicits during this step / session. */
  elicit: ElicitAutoReplySchema.optional(),
  /** Assert tool inputSchema advertises JSON Schema 2020-12 dialect when listing. */
  assertJsonSchema202012: z.boolean().optional(),
  thinkMs: z.number().int().nonnegative().optional(),
  extract: z
    .object({
      variable: z.string().min(1),
      path: z.string(),
      /** A missing or empty value fails the step; steps that wait on it are skipped for that pass. */
      required: z.boolean().optional(),
    })
    .optional(),
  /** Alias of the server this step calls: a key of `targets`. Absent means the default `target`. */
  server: z.string().optional(),
  nodeId: z.string().optional(),
  label: z.string().optional(),
  /** Per-call wait. Set on suite steps that run an LLM eval. */
  timeoutMs: z.number().int().positive().optional(),
  /** Tool-call objectives. Set fields replace the suite objective. */
  slo: z
    .object({
      maxP95Ms: z.number().positive().optional(),
      maxP99Ms: z.number().positive().optional(),
      maxErrorRate: z.number().min(0).max(1).optional(),
    })
    .optional(),
  /** Indexes of steps that must finish before this one. Absent means the legacy chain. */
  waitFor: z.array(z.number().int().nonnegative()).optional(),
  loopIndex: z.number().int().nonnegative().optional(),
});

export const ScenarioSchema = z.object({
  name: z.string().min(1),
  steps: z.array(ScenarioStepSchema).min(1),
  iterations: z.number().int().positive().default(1),
});

export const ServerSloSchema = z.object({
  maxP95Ms: z.number().positive().optional(),
  maxP99Ms: z.number().positive().optional(),
  maxErrorRate: z.number().min(0).max(1).optional(),
});

export const AssertionsSchema = z.object({
  maxErrorRate: z.number().min(0).max(1).default(0),
  maxP95LatencyMs: z.number().positive().optional(),
  maxP99LatencyMs: z.number().positive().optional(),
  requireScenarioOutcomes: z.boolean().default(true),
  /** Fail if negotiated protocolVersion differs from this value. */
  requireProtocolVersion: z.string().optional(),
  /** Objectives judged over all tool calls on one server, by alias. */
  servers: z.record(z.string(), ServerSloSchema).optional(),
});

export const ProcessAssertionsSchema = z.object({
  maxWorkerRssBytes: z.number().int().positive().optional(),
  maxSutRssBytes: z.number().int().positive().optional(),
  maxWorkerCpuRatio: z.number().positive().optional(),
  maxSutCpuRatio: z.number().positive().optional(),
});

export const RampDownSchema = z.object({
  strategy: z.enum(["graceful", "immediate"]).optional(),
  drainTimeoutMs: z.number().int().nonnegative().optional(),
  /** Pass duration to assume before any pass has finished. */
  passEstimateMs: z.number().int().nonnegative().optional(),
}).strict();

export const LoadProfileSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  rampUpMs: z.number().int().nonnegative().default(DEFAULT_LOAD_PROFILE.rampUpMs),
  maxConcurrency: z.number().int().positive(),
  jitterMs: z.number().int().nonnegative().default(DEFAULT_LOAD_PROFILE.jitterMs),
  rampDownMs: z.number().int().nonnegative().default(DEFAULT_LOAD_PROFILE.rampDownMs),
  dwellMs: z.number().int().nonnegative().default(DEFAULT_LOAD_PROFILE.dwellMs),
  iterations: z.number().int().positive().default(DEFAULT_LOAD_PROFILE.iterations),
  lanes: z.number().int().positive().max(16).default(DEFAULT_LOAD_PROFILE.lanes),
  /** How VUs scale down after the hold. Defaults to graceful. */
  rampDown: RampDownSchema.optional(),
  /** Rate-limit retry policy for this suite. Defaults on; set enabled=false to turn off. */
  retry: RetryPolicySchema.partial().optional(),
});

export const SoakSchema = z.object({
  durationMs: z.number().int().positive().optional(),
  maxIterations: z.number().int().positive().optional(),
  intervalMs: z.number().int().positive().default(500),
  sampleIntervalMs: z.number().int().positive().default(1000),
});

export const GatewayTargetSchema = z.object({
  mode: z.enum(["direct", "gateway"]).default("direct"),
  gatewayId: z.string().optional(),
});

export const ManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /**
   * Protocol revision this manifest targets. Labelled in reports; when set to
   * 2025-11-25, capability-mismatch Fail honesty is on for required methods.
   */
  protocolVersion: z.string().optional(),
  /** The default server. Steps without `server` call it. */
  target: TargetSchema,
  /** Other servers, by alias. Each must pass the allowlist like `target`. */
  targets: z.record(z.string(), TargetSchema).optional(),
  /** Alias that `target` stands for in reports and on steps. Defaults to `default`. */
  defaultTarget: z.string().optional(),
  gateway: GatewayTargetSchema.optional(),
  allowlist: z.array(z.string()).min(1),
  sessionPool: SessionPoolSchema.prefault({}),
  quotas: QuotasSchema.prefault({}),
  scenarios: z.array(ScenarioSchema).min(1),
  assertions: AssertionsSchema.prefault({}),
  processAssertions: ProcessAssertionsSchema.optional(),
  soak: SoakSchema.optional(),
  load: LoadProfileSchema.optional(),
  /** Rate-limit retry policy for the target server; load.retry (suite) overrides it. */
  retry: RetryPolicySchema.partial().optional(),
}).superRefine((manifest, context) => {
  const alias = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
  const defaultTarget = manifest.defaultTarget ?? "default";
  if (!alias.test(defaultTarget)) context.addIssue({ code: "custom", path: ["defaultTarget"], message: `"${defaultTarget}" is not a valid alias` });
  const known = new Set([defaultTarget, ...Object.keys(manifest.targets ?? {})]);
  for (const name of Object.keys(manifest.targets ?? {})) {
    if (!alias.test(name)) context.addIssue({ code: "custom", path: ["targets", name], message: `"${name}" is not a valid alias` });
    if (name === defaultTarget) context.addIssue({ code: "custom", path: ["targets", name], message: `"${name}" is the default target; set it in target` });
  }
  if (known.size > 8) context.addIssue({ code: "custom", path: ["targets"], message: "a manifest may use at most 8 servers" });
  manifest.scenarios.forEach((scenario, s) => scenario.steps.forEach((step, i) => {
    if (step.server !== undefined && !known.has(step.server)) {
      context.addIssue({ code: "custom", path: ["scenarios", s, "steps", i, "server"], message: `"${step.server}" is not a server` });
    }
  }));
  for (const name of Object.keys(manifest.assertions.servers ?? {})) {
    if (!known.has(name)) context.addIssue({ code: "custom", path: ["assertions", "servers", name], message: `"${name}" is not a server` });
  }
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;

export function parseManifest(data: unknown): Manifest {
  return ManifestSchema.parse(data);
}
