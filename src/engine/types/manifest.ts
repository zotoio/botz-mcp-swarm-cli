import { z } from "zod";

export const TransportTypeSchema = z.enum(["stdio", "sse", "streamable-http"]);
export type TransportType = z.infer<typeof TransportTypeSchema>;

export const SessionReuseSchema = z.enum(["cold", "warm"]);
export type SessionReuse = z.infer<typeof SessionReuseSchema>;

export const StdioTargetSchema = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
});

export const HttpTargetSchema = z.object({
  transport: z.enum(["sse", "streamable-http"]),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
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
  maxCallCount: z.number().int().positive().default(1000),
  maxPayloadBytes: z.number().int().positive().default(1_048_576),
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
]);

export const ElicitAutoReplySchema = z.object({
  action: z.enum(["accept", "decline", "cancel"]).default("accept"),
  /** Form-mode content matching requestedSchema properties. */
  content: z.record(z.unknown()).optional(),
});

export const ScenarioStepSchema = z.object({
  method: ScenarioMethodSchema,
  tool: z.string().optional(),
  resourceUri: z.string().optional(),
  prompt: z.string().optional(),
  args: z.record(z.unknown()).optional(),
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
      inputSchema: z.record(z.unknown()).optional(),
      outputSchema: z.record(z.unknown()).optional(),
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
    })
    .optional(),
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

export const AssertionsSchema = z.object({
  maxErrorRate: z.number().min(0).max(1).default(0),
  maxP95LatencyMs: z.number().positive().optional(),
  maxP99LatencyMs: z.number().positive().optional(),
  requireScenarioOutcomes: z.boolean().default(true),
  /** Fail if negotiated protocolVersion differs from this value. */
  requireProtocolVersion: z.string().optional(),
});

export const ProcessAssertionsSchema = z.object({
  maxWorkerRssBytes: z.number().int().positive().optional(),
  maxSutRssBytes: z.number().int().positive().optional(),
  maxWorkerCpuRatio: z.number().positive().optional(),
  maxSutCpuRatio: z.number().positive().optional(),
});

export const LoadProfileSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  rampUpMs: z.number().int().nonnegative().default(0),
  maxConcurrency: z.number().int().positive(),
  jitterMs: z.number().int().nonnegative().default(0),
  rampDownMs: z.number().int().nonnegative().default(0),
  dwellMs: z.number().int().nonnegative().default(0),
  iterations: z.number().int().positive().default(10),
  lanes: z.number().int().positive().max(16).default(4),
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
  target: TargetSchema,
  gateway: GatewayTargetSchema.optional(),
  allowlist: z.array(z.string()).min(1),
  sessionPool: SessionPoolSchema.default({}),
  quotas: QuotasSchema.default({}),
  scenarios: z.array(ScenarioSchema).min(1),
  assertions: AssertionsSchema.default({}),
  processAssertions: ProcessAssertionsSchema.optional(),
  soak: SoakSchema.optional(),
  load: LoadProfileSchema.optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;

export function parseManifest(data: unknown): Manifest {
  return ManifestSchema.parse(data);
}
