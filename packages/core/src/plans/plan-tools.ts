/**
 * @octus/core — herramientas plan.* para modelos (crear/actualizar/consultar/solicitar).
 * Aprobar/rechazar/archivar/exportar NO son herramientas: solo la aplicación (ADR-022).
 */
import { z } from "zod";
import type { ToolDefinition } from "../tools/tool-definitions.js";
import { requirePlans } from "../tools/tool-services.js";

const structuredSchema = z.object({
  objective: z.string().min(1).max(2000),
  steps: z
    .array(
      z.object({
        title: z.string().min(1).max(500),
        detail: z.string().max(4000).optional(),
        files: z.array(z.string().max(500)).max(100).optional(),
        verification: z.string().max(2000).optional(),
      }),
    )
    .min(1)
    .max(60),
  acceptanceCriteria: z.array(z.string().min(1).max(1000)).min(1).max(60),
  dependencies: z.array(z.string().max(1000)).max(60).optional(),
  risks: z.array(z.string().max(1000)).max(60).optional(),
  alternatives: z.array(z.string().max(1000)).max(30).optional(),
  openQuestions: z.array(z.string().max(1000)).max(30).optional(),
});

function toJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const maybe = schema as unknown as { toJSONSchema?: () => Record<string, unknown> };
  return typeof maybe.toJSONSchema === "function" ? maybe.toJSONSchema() : { type: "object" };
}

const createSchema = z.object({
  objective: z.string().min(1).max(2000).describe("Goal of the new plan"),
  structured: structuredSchema.describe("Structured plan content (steps, criteria, risks)"),
});

const updateSchema = z.object({
  planId: z.string().min(1).describe("Existing plan id to revise"),
  structured: structuredSchema.describe("Full new structured content (creates a new immutable revision)"),
});

const getSchema = z.object({
  planId: z.string().min(1),
  revisionId: z.string().min(1).optional().describe("Defaults to the current presented revision"),
});

const requestApprovalSchema = z.object({
  planId: z.string().min(1),
  revisionId: z.string().min(1),
});

export const planCreateTool: ToolDefinition = {
  manifest: {
    name: "plan.create",
    description: "Create a new internal plan with its first revision. Plans live in Octus storage, never as files.",
    inputJsonSchema: toJsonSchema(createSchema),
    permissionAction: "plan.create",
  },
  schema: createSchema,
  async run(args, ctx) {
    const parsed = args as { objective: string; structured: unknown };
    const plans = requirePlans(ctx.services);
    const result = await plans.create({ sessionId: ctx.sessionId, objective: parsed.objective, structured: parsed.structured as never, runId: ctx.runId, createdBy: ctx.instanceId });
    return { text: `Plan created: ${result.planId} revision v${result.version} (${result.revisionId}). Present it conversationally; it becomes approvable once presented.` };
  },
};

export const planUpdateTool: ToolDefinition = {
  manifest: {
    name: "plan.update",
    description: "Add a new immutable revision to an existing plan. Previous revisions keep their history.",
    inputJsonSchema: toJsonSchema(updateSchema),
    permissionAction: "plan.update",
  },
  schema: updateSchema,
  async run(args, ctx) {
    const parsed = args as { planId: string; structured: unknown };
    const plans = requirePlans(ctx.services);
    const result = await plans.update({ planId: parsed.planId, structured: parsed.structured as never, runId: ctx.runId, createdBy: ctx.instanceId });
    return { text: `Plan ${parsed.planId} revised: v${result.version} (${result.revisionId}). Present the changes conversationally; approval is the user's decision.` };
  },
};

export const planGetTool: ToolDefinition = {
  manifest: {
    name: "plan.get",
    description: "Read a plan revision (defaults to current). Use the exact approved revision for implementation.",
    inputJsonSchema: toJsonSchema(getSchema),
    permissionAction: "plan.get",
  },
  schema: getSchema,
  async run(args, ctx) {
    const parsed = args as { planId: string; revisionId?: string };
    const plans = requirePlans(ctx.services);
    return { text: await plans.get(parsed.planId, parsed.revisionId) };
  },
};

const listSchema = z.object({});

export const planListTool: ToolDefinition = {
  manifest: {
    name: "plan.list",
    description: "List the session plans with revisions and approval state.",
    inputJsonSchema: toJsonSchema(listSchema),
    permissionAction: "plan.list",
  },
  schema: listSchema,
  async run(_args, ctx) {
    const plans = requirePlans(ctx.services);
    return { text: await plans.list(ctx.sessionId) };
  },
};

export const planRequestApprovalTool: ToolDefinition = {
  manifest: {
    name: "plan.request_approval",
    description: "Ask the user to approve an exact presented revision. You cannot approve it yourself.",
    inputJsonSchema: toJsonSchema(requestApprovalSchema),
    permissionAction: "plan.request_approval",
  },
  schema: requestApprovalSchema,
  async run(args, ctx) {
    const parsed = args as { planId: string; revisionId: string };
    const plans = requirePlans(ctx.services);
    const request = await plans.requestApproval(parsed.planId, parsed.revisionId, ctx.sessionId, ctx.runId);
    return { text: `Approval requested for plan ${parsed.planId} revision ${parsed.revisionId} (request ${request.id}). Tell the user exactly what you are asking to approve and wait for their explicit decision.` };
  },
};

export const PLAN_TOOLS: ToolDefinition[] = [planCreateTool, planUpdateTool, planGetTool, planListTool, planRequestApprovalTool];
