/**
 * @octus/core — herramientas de tareas para el Coordinator Build (Etapa 3).
 * `plan_tasks` invoca al TaskPlanner interno (misma instancia/modelo/effort,
 * sin crear agentes); `record_review` registra veredictos estructurados.
 * La aprobación de planes sigue siendo exclusiva del usuario (ADR-022).
 */
import { z } from "zod";
import type { ToolDefinition } from "../tools/tool-definitions.js";
import { requireTasks } from "../tools/tool-services.js";

const planTasksSchema = z.object({
  runId: z.string().min(1).describe("Active run requesting the decomposition"),
  objective: z.string().min(1).max(2000).describe("Goal to decompose (must stay within the approved revision)"),
  brief: z.string().max(8000).optional().describe("Extra context for the planner"),
  planId: z.string().min(1).optional().describe("Explicit approved plan (required if the run is not pinned)"),
  revisionId: z.string().min(1).optional().describe("Exact approved revision (required if the run is not pinned)"),
  nonce: z.string().min(1).max(64).optional().describe("Explicit re-plan after a rejected planning"),
});

const reviewSchema = z.object({
  reviewerTaskId: z.string().min(1),
  targetTaskId: z.string().min(1),
  verdict: z.enum(["accept", "request-changes"]),
  detail: z.string().max(4000).optional().describe("Structured rationale for the verdict"),
});

function toJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const maybe = schema as unknown as { toJSONSchema?: () => Record<string, unknown> };
  return typeof maybe.toJSONSchema === "function" ? maybe.toJSONSchema() : { type: "object" };
}

export const planTasksTool: ToolDefinition = {
  manifest: {
    name: "plan_tasks",
    description: "Decompose the approved revision into an executable task DAG (internal planner; deterministic validation, no new agents).",
    inputJsonSchema: toJsonSchema(planTasksSchema),
    permissionAction: "plan_tasks",
  },
  schema: planTasksSchema,
  async run(args, ctx) {
    const parsed = args as { runId: string; objective: string; brief?: string; planId?: string; revisionId?: string; nonce?: string };
    const tasks = requireTasks(ctx.services);
    const result = await tasks.plan({ runId: parsed.runId, objective: parsed.objective, brief: parsed.brief, planId: parsed.planId, revisionId: parsed.revisionId, nonce: parsed.nonce, coordinatorInstanceId: ctx.instanceId });
    return { text: `Task DAG ${result.created ? "created" : "reused (idempotent)"}: planning ${result.planningId} with tasks ${result.taskIds.join(", ")}` };
  },
};

export const recordReviewTool: ToolDefinition = {
  manifest: {
    name: "record_review",
    description: "Record a structured review verdict for a completed review target (accept or request-changes).",
    inputJsonSchema: toJsonSchema(reviewSchema),
    permissionAction: "record_review",
  },
  schema: reviewSchema,
  async run(args, ctx) {
    const parsed = args as { reviewerTaskId: string; targetTaskId: string; verdict: "accept" | "request-changes"; detail?: string };
    const tasks = requireTasks(ctx.services);
    const detail = parsed.detail ? (() => { try { return JSON.parse(parsed.detail) as Record<string, unknown>; } catch { return { text: parsed.detail }; } })() : undefined;
    await tasks.review({ reviewerTaskId: parsed.reviewerTaskId, targetTaskId: parsed.targetTaskId, verdict: parsed.verdict, detail });
    return { text: `Review recorded (${parsed.verdict}) for ${parsed.targetTaskId} by ${parsed.reviewerTaskId}` };
  },
};

export const TASK_TOOLS: ToolDefinition[] = [planTasksTool, recordReviewTool];
