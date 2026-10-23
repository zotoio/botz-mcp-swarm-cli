import { z } from "zod";
import { SuiteLimitsSchema } from "../engine/core/suite-limits.js";
import { SAMPLER_METHODS, type SuiteNode } from "../engine/core/suite-model.js";
import { ElicitAutoReplySchema, ScenarioStepSchema, ServerSloSchema, TargetSchema } from "../engine/types/manifest.js";
import { isServerAlias, MAX_SERVERS } from "../engine/core/servers.js";

const name = z.string().min(1);
const alias = z.string().refine(isServerAlias, { message: "use 1-32 characters of a-z, 0-9 and -" });
const jsonObject = z.record(z.unknown());
const nonnegative = z.number().finite().int().nonnegative();
const positive = z.number().finite().int().positive();
const node: z.ZodType<SuiteNode, z.ZodTypeDef, unknown> = z.lazy(() => z.object({
  id: name, type: z.enum(["sampler", "think", "extractor", "loop", "group"]), enabled: z.boolean(),
  label: z.string().optional(), method: z.enum(SAMPLER_METHODS).optional(), tool: name.optional(),
  resourceUri: name.optional(), prompt: name.optional(), args: jsonObject.optional(),
  expect: ScenarioStepSchema.shape.expect, thinkMs: nonnegative.optional(),
  path: z.string().optional(), variable: name.optional(), iterations: positive.optional(),
  required: z.boolean().optional(), server: alias.optional(),
  children: z.array(node).optional(), elicit: ElicitAutoReplySchema.optional(),
  evals: z.array(z.object({ id: name, polarity: z.enum(["positive", "negative"]), prompt: name,
    assertions: z.array(z.object({ id: name, text: name })) })).optional(),
  slo: z.object({ maxP95Ms: z.number().positive().optional(), maxP99Ms: z.number().positive().optional(),
    maxErrorRate: z.number().min(0).max(1).optional() }).optional(),
  layout: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
}).strict().superRefine((value, context) => {
  if (value.type === "sampler" && !value.method) context.addIssue({ code: "custom", message: "sampler method is required" });
  if (value.method === "tools/call" && !value.tool) context.addIssue({ code: "custom", message: "tool is required" });
}));

export const SuiteLoadSchema = z.object({ durationMs: nonnegative.optional(), rampUpMs: nonnegative.optional(),
    maxConcurrency: positive.optional(), jitterMs: nonnegative.optional(), rampDownMs: nonnegative.optional(),
    dwellMs: nonnegative.optional(), iterations: positive.optional(), lanes: positive.optional(),
    rampDown: z.object({ strategy: z.enum(["graceful", "immediate"]).optional(), drainTimeoutMs: nonnegative.optional(),
      passEstimateMs: nonnegative.optional() }).strict().optional() });

const SurfaceSchema = z.object({ serverName: z.string().optional(), serverVersion: z.string().optional(),
  capabilities: z.array(z.string()),
  tools: z.array(z.object({ name, description: z.string().optional(), schemaHash: z.string(), writeLike: z.boolean(),
    inputSchema: jsonObject.optional(), outputSchema: jsonObject.optional(),
    annotations: z.object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() }).optional() })),
  resources: z.array(z.object({ name, uri: name, mimeType: z.string().optional() })).optional(),
  resourceTemplates: z.array(z.object({ name, uriTemplate: name })).optional(),
  prompts: z.array(z.object({ name, description: z.string().optional(),
    arguments: z.array(z.object({ name, required: z.boolean().optional() })).optional() })).optional(),
});

/** Version 1 accepts legacy unversioned suites; later versions require an explicit migration. */
export const SuiteInputSchema = z.object({
  kind: z.literal("botz-suite"), schemaVersion: z.literal(1).optional(), id: z.string().uuid().optional(),
  cwdBase: z.literal("suite").optional(),
  capturedAt: z.string().optional(), name, target: TargetSchema,
  nodes: z.array(node), params: z.record(z.object({ example: z.string(), usedBy: z.array(z.string()) })),
  load: SuiteLoadSchema.optional(),
  limits: SuiteLimitsSchema.optional(),
  surface: SurfaceSchema,
}).superRefine((suite, context) => uniqueIds(suite.nodes, context));

/** One server of a v2 suite. */
export const SuiteServerSchema = z.object({
  target: TargetSchema,
  surface: SurfaceSchema,
  capturedAt: z.string().optional(),
  /** Objectives over every tool call on this server. */
  slo: ServerSloSchema.optional(),
}).strict();

/** Version 2: the servers a suite uses, by alias, and the alias that steps without `server` call. */
export const SuiteV2Schema = z.object({
  kind: z.literal("botz-suite"), schemaVersion: z.literal(2), id: z.string().uuid().optional(),
  cwdBase: z.literal("suite").optional(),
  capturedAt: z.string().optional(), name,
  defaultServer: alias,
  servers: z.record(z.string(), SuiteServerSchema),
  nodes: z.array(node), params: z.record(z.object({ example: z.string(), usedBy: z.array(z.string()) })),
  load: SuiteLoadSchema.optional(),
  limits: SuiteLimitsSchema.optional(),
}).superRefine((suite, context) => {
  uniqueIds(suite.nodes, context);
  const aliases = Object.keys(suite.servers);
  if (aliases.length === 0) context.addIssue({ code: "custom", path: ["servers"], message: "at least one server is required" });
  if (aliases.length > MAX_SERVERS) context.addIssue({ code: "custom", path: ["servers"], message: `a suite may use at most ${MAX_SERVERS} servers` });
  for (const key of aliases) {
    if (!isServerAlias(key)) context.addIssue({ code: "custom", path: ["servers", key], message: `"${key}" is not a valid alias` });
  }
  if (!suite.servers[suite.defaultServer]) context.addIssue({ code: "custom", path: ["defaultServer"], message: `"${suite.defaultServer}" is not a server` });
});

function uniqueIds(nodes: SuiteNode[], context: z.RefinementCtx): void {
  const ids = new Set<string>();
  const visit = (list: SuiteNode[]) => { for (const n of list) {
    if (ids.has(n.id)) context.addIssue({ code: "custom", message: `duplicate node id: ${n.id}` });
    ids.add(n.id); visit(n.children ?? []);
  } };
  visit(nodes);
}
