/**
 * @octus/core — herramientas de tareas para el Coordinator Build (Etapa 3).
 * `plan_tasks` invoca al TaskPlanner interno (misma instancia/modelo/effort,
 * sin crear agentes); `record_review` registra veredictos estructurados.
 * No hay ventana de aprobación: el plan se ejecuta al pedirlo en build.
 */
import { z } from "zod";
import type { ToolDefinition } from "../tools/tool-definitions.js";
import { requireTasks } from "../tools/tool-services.js";

const planTasksSchema = z.object({
  runId: z.string().min(1).optional().describe("Active run id. Omit it: defaults to the current run."),
  objective: z.string().min(1).max(2000).optional().describe("Goal to decompose. Omit it: defaults to the plan objective."),
  brief: z.string().max(8000).optional().describe("Extra context for the planner"),
  planId: z.string().min(1).optional().describe("Plan id. Omit it: resolved from the run anchor."),
  revisionId: z.string().min(1).optional().describe("Exact plan revision (id, 'vN' or number). Omit it: resolved from the run anchor."),
  nonce: z.string().min(1).max(64).optional().describe("Explicit re-plan after a rejected planning"),
  replan: z.boolean().optional().describe("Force a new DAG and cancel open tasks of this run (requires explicit user approval)"),
  replanApprovedByUser: z.boolean().optional().describe("Set true only after the user explicitly approved the replan"),
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
    description: "Decompose the plan revision into an executable task DAG (internal planner; deterministic validation, no new agents).",
    inputJsonSchema: toJsonSchema(planTasksSchema),
    permissionAction: "plan_tasks",
  },
  schema: planTasksSchema,
  async run(args, ctx) {
    const parsed = args as { runId?: string; objective?: string; brief?: string; planId?: string; revisionId?: string; nonce?: string; replan?: boolean; replanApprovedByUser?: boolean };
    const tasks = requireTasks(ctx.services);
    const result = await tasks.plan({
      runId: parsed.runId ?? ctx.runId,
      objective: parsed.objective,
      brief: parsed.brief,
      planId: parsed.planId,
      revisionId: parsed.revisionId,
      nonce: parsed.nonce,
      replan: parsed.replan,
      replanApprovedByUser: parsed.replanApprovedByUser,
      coordinatorInstanceId: ctx.instanceId,
    });
    return { text: `Task DAG ${result.created ? "created" : "reused (idempotent)"}${result.fallback ? " with deterministic fallback (planner unavailable)" : ""}: planning ${result.planningId} with tasks ${result.taskIds.join(", ")}. The scheduler provisions the workspaces and spawns the workers. Call agent_wait with {all:true} to wait for every worker and collect deliveries; agent_status without instanceId lists them. Task/planning ids are NOT agent instance ids.` };
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
