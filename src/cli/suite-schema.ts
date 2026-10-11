import { z } from "zod";
import { SAMPLER_METHODS, type SuiteNode } from "../engine/core/suite-model.js";
import { ElicitAutoReplySchema, ScenarioStepSchema, TargetSchema } from "../engine/types/manifest.js";

const name = z.string().min(1);
const jsonObject = z.record(z.unknown());
const nonnegative = z.number().finite().int().nonnegative();
const positive = z.number().finite().int().positive();
const node: z.ZodType<SuiteNode, z.ZodTypeDef, unknown> = z.lazy(() => z.object({
  id: name, type: z.enum(["sampler", "think", "extractor", "loop", "group"]), enabled: z.boolean(),
  label: z.string().optional(), method: z.enum(SAMPLER_METHODS).optional(), tool: name.optional(),
  resourceUri: name.optional(), prompt: name.optional(), args: jsonObject.optional(),
  expect: ScenarioStepSchema.shape.expect, thinkMs: nonnegative.optional(),
  path: z.string().optional(), variable: name.optional(), iterations: positive.optional(),
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
    dwellMs: nonnegative.optional(), iterations: positive.optional(), lanes: positive.optional() });

/** Version 1 accepts legacy unversioned suites; later versions require an explicit migration. */
export const SuiteInputSchema = z.object({
  kind: z.literal("botz-suite"), schemaVersion: z.literal(1).optional(), id: z.string().uuid().optional(),
  cwdBase: z.literal("suite").optional(),
  capturedAt: z.string().optional(), name, target: TargetSchema,
  nodes: z.array(node), params: z.record(z.object({ example: z.string(), usedBy: z.array(z.string()) })),
  load: SuiteLoadSchema.optional(),
  surface: z.object({ serverName: z.string().optional(), serverVersion: z.string().optional(),
    capabilities: z.array(z.string()),
    tools: z.array(z.object({ name, description: z.string().optional(), schemaHash: z.string(), writeLike: z.boolean(),
      inputSchema: jsonObject.optional(), outputSchema: jsonObject.optional(),
      annotations: z.object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() }).optional() })),
    resources: z.array(z.object({ name, uri: name, mimeType: z.string().optional() })).optional(),
    resourceTemplates: z.array(z.object({ name, uriTemplate: name })).optional(),
    prompts: z.array(z.object({ name, description: z.string().optional(),
      arguments: z.array(z.object({ name, required: z.boolean().optional() })).optional() })).optional(),
  }),
}).superRefine((suite, context) => {
  const ids = new Set<string>();
  const visit = (nodes: SuiteNode[]) => { for (const n of nodes) {
    if (ids.has(n.id)) context.addIssue({ code: "custom", message: `duplicate node id: ${n.id}` });
    ids.add(n.id); visit(n.children ?? []);
  } };
  visit(suite.nodes);
});
