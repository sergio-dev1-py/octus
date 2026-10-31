/**
 * @octus/core — TaskPlanner: servicio interno de orquestación (Etapa 3).
 * NO es un agente: no tiene AgentDefinition ni AgentInstance ni conversación.
 * El Coordinator Build lo invoca; ejecuta UNA generación con el mismo
 * proveedor/modelo/effort de la instancia coordinadora y devuelve una propuesta
 * que el núcleo valida (Zod + reglas) antes de crear el DAG.
 */
import { z } from "zod";
import { createId, type AgentKind } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import type { ModelRouter } from "../providers/model-router.js";
import type { PlanManager } from "../plans/plan-manager.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { DirectoryRegistry } from "../orchestration/directory-registry.js";
import type { TestRunner } from "../tools/test-runner.js";
import type { TaskManager } from "./task-manager.js";
import { requestHashOf } from "./task-manager.js";

const WORKER_ROLES = ["explorer", "researcher", "implementer", "reviewer"] as const;

const proposedTaskSchema = z.object({
  tempId: z.string().min(1).max(64),
  title: z.string().min(1).max(500),
  description: z.string().min(1).max(4000),
  agentRole: z.enum(WORKER_ROLES),
  priority: z.number().int().min(0).max(100),
  dependencies: z.array(z.string().min(1).max(64)).max(30).default([]),
  acceptanceCriteria: z.array(z.string().min(1).max(1000)).min(1).max(30),
  requiredTools: z.array(z.string().min(1).max(80)).max(40).default([]),
  writeScope: z.array(z.string().min(1).max(500)).max(40).default([]),
  validationCommands: z.array(z.string().min(1).max(200)).max(20).default([]),
  needsReview: z.boolean().default(false),
  reviewTargetTempId: z.string().min(1).max(64).optional(),
  estimatedComplexity: z.string().max(40).optional(),
});

const proposalSchema = z.object({
  tasks: z.array(proposedTaskSchema).min(1).max(40),
});

export interface PlanTasksInput {
  runId: string;
  objective: string;
  brief?: string;
  /** Anclaje exacto exigido; si se omite se usa runs.plan_revision_id (sin auto-selección). */
  planId?: string;
  revisionId?: string;
  /** Nonce para re-planificación explícita tras un rechazo (nuevo request_hash). */
  nonce?: string;
}

const PLANNER_SYSTEM = `You decompose the approved implementation plan into concrete executable tasks.
Rules:
- Output ONLY a JSON object: {"tasks":[{tempId,title,description,agentRole,priority,dependencies,acceptanceCriteria,requiredTools,writeScope,validationCommands,needsReview,reviewTargetTempId?,estimatedComplexity?}]}.
- agentRole is one of explorer|researcher|implementer|reviewer. implementer tasks MUST set needsReview=true; reviewer tasks MUST set reviewTargetTempId to the tempId of the task they review and needsReview=false.
- dependencies reference tempIds within this proposal only, with no cycles and no self-dependencies. Reviewer tasks must NOT declare dependencies at all: their ordering comes exclusively from reviewTargetTempId (a dependency on a task requiring review would deadlock the DAG and is rejected).
- requiredTools must be basic tools the role plausibly has (read, glob, grep, write, edit, shell, git_status, git_diff, git_stage, git_commit, websearch, webfetch, test_run, question). Never invent tools.
- writeScope lists workspace-relative directories the task writes; only for implementer tasks.
- validationCommands must name project test commands (leave empty when unknown).
- Every task needs concrete acceptance criteria with verifiable evidence.
- Do not include approvals, merges, branches or worktrees: those do not exist for workers.`;

export class TaskPlanner {
  constructor(
    private readonly db: PersistenceService,
    private readonly router: ModelRouter,
    private readonly registry: AgentRegistry,
    private readonly directories: DirectoryRegistry,
    private readonly tests: TestRunner,
    private readonly plans: PlanManager,
    private readonly tasks: TaskManager,
  ) {}

  /**
   * Propone (modelo) + valida (núcleo) + crea el DAG atómicamente.
   * Idempotente por (run, plan, revisión, request_hash): repetir devuelve el
   * DAG ya creado; tras un rechazo exige nonce explícito.
   */
  async planTasks(coordinatorInstanceId: string, input: PlanTasksInput): Promise<{ planningId: string; taskIds: string[]; created: boolean }> {
    const coord = await this.db.queryOne<Record<string, string | number | null>>(
      `SELECT i.*, s.project_id AS project_id, s.model AS session_model FROM agent_instances i
       JOIN sessions s ON s.id = i.session_id WHERE i.id = ?`,
      [coordinatorInstanceId],
    );
    if (!coord) throw new OctusError("not_found", `Coordinator instance not found: ${coordinatorInstanceId}`);
    const run = await this.db.queryOne<{ id: string; session_id: string; plan_revision_id: string | null }>("SELECT id, session_id, plan_revision_id FROM runs WHERE id = ?", [input.runId]);
    if (!run) throw new OctusError("not_found", `Run not found: ${input.runId}`);
    if (String(coord.session_id) !== run.session_id) {
      throw new OctusError("invalid_state", "Coordinator instance does not belong to the run session");
    }
    // Anclaje exacto a la revisión aprobada: explícito o el del run; jamás auto-selección.
    let planId = input.planId;
    let revisionId = input.revisionId;
    if ((!planId || !revisionId) && run.plan_revision_id) {
      const rev = await this.plans.getRevision(run.plan_revision_id);
      if (!rev) throw new OctusError("not_found", `Run revision not found: ${run.plan_revision_id}`);
      planId = rev.planId;
      revisionId = rev.id;
    }
    if (!planId || !revisionId) {
      throw new OctusError("plan_conflict", "No approved revision selected: pass planId+revisionId (user decision required)");
    }
    const revision = await this.plans.getRevision(revisionId);
    if (!revision || revision.planId !== planId) throw new OctusError("not_found", `Revision ${revisionId} not found in plan ${planId}`);
    if (revision.approval !== "approved") {
      throw new OctusError("invalid_state", "Cannot create executable tasks without an approved revision (needs-approval)");
    }
    const plan = await this.plans.getPlan(planId);
    if (plan.sessionId !== run.session_id) throw new OctusError("invalid_state", "Plan does not belong to the run session");

    const model = JSON.parse(String(coord.model)) as { providerId: string; modelId: string; effort?: string };
    const hash = requestHashOf({ runId: input.runId, planId, revisionId, objective: input.objective, brief: input.brief ?? "", nonce: input.nonce });
    const existing = await this.db.queryOne<{ id: string; status: string; reason: string | null }>(
      "SELECT id, status, reason FROM plannings WHERE run_id = ? AND plan_id = ? AND revision_id = ? AND request_hash = ?",
      [input.runId, planId, revisionId, hash],
    );
    if (existing) {
      if (existing.status === "valid") {
        const ids = (await this.db.query<{ id: string }>("SELECT id FROM tasks WHERE planning_id = ? ORDER BY created_at ASC, id ASC", [existing.id])).map((r) => r.id);
        return { planningId: existing.id, taskIds: ids, created: false };
      }
      throw new OctusError("invalid_state", `Planning was rejected: ${existing.reason ?? "no reason recorded"}. Re-plan explicitly with a nonce.`);
    }

    const proposal = await this.generateProposal(model, run.session_id, plan.objective, revision.contentMarkdown, input.objective, input.brief ?? "");
    try {
      return await this.tasks.createDag({ runId: input.runId, planId, revisionId, requestHash: hash, tasks: proposal });
    } catch (error) {
      if (error instanceof OctusError && (error.code === "invalid_tool_args" || error.code === "invalid_state" || error.code === "plan_conflict")) {
        await this.tasks.recordPlanningRejected({ runId: input.runId, planId, revisionId, requestHash: hash, reason: error.message });
      }
      throw error;
    }
  }

  private async generateProposal(
    model: { providerId: string; modelId: string; effort?: string },
    conversationId: string,
    planObjective: string,
    revisionMarkdown: string,
    objective: string,
    brief: string,
  ): Promise<Array<{
    tempId: string; title: string; description: string; agentRole: AgentKind; priority: number;
    dependencies: string[]; acceptanceCriteria: string[]; requiredTools: string[];
    writeScope: string[]; validationCommands: string[]; needsReview: boolean;
    reviewTargetTempId?: string; estimatedComplexity?: string;
  }>> {
    const resolution = this.router.resolve({ instance: { providerId: model.providerId, modelId: model.modelId, effort: model.effort }, globalDefault: { providerId: model.providerId, modelId: model.modelId, effort: model.effort } });
    const instructions = `${PLANNER_SYSTEM}\n\nApproved plan objective: ${planObjective}\n\nApproved revision (exact scope, do not exceed it):\n${revisionMarkdown.slice(0, 12000)}\n\nRequest objective: ${objective}${brief ? `\nBrief: ${brief.slice(0, 4000)}` : ""}`;
    const correlationId = createId("cor");
    let text = "";
    const stream = this.router.generateStream(
      resolution,
      { providerId: model.providerId, modelId: model.modelId, effort: model.effort as never, instructions, messages: [{ role: "user", blocks: [{ type: "text", text: "Propose the task DAG as JSON. Return ONLY the JSON object {\"tasks\": [...]} with the exact keys and roles from the instructions — no markdown, no preamble, no invented keys." }] }], maxOutputTokens: 4000, conversationId },
      { providerId: model.providerId, modelId: model.modelId, agentDefinitionId: "coordinator-build", agentInstanceId: "planner", runId: "planner", sessionId: "planner", correlationId },
      new AbortController().signal,
    );
    for await (const event of stream) {
      if (event.type === "text.delta") text += event.delta;
      if (event.type === "error") throw new OctusError("tool_failed", `TaskPlanner model call failed: ${event.error.message}`);
      if (event.type === "completed") break;
    }
    const jsonText = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new OctusError("tool_failed", `TaskPlanner did not return valid JSON: ${text.slice(0, 300)}`);
    }
    const result = proposalSchema.safeParse(parsed);
    if (!result.success) {
      throw new OctusError("tool_failed", `TaskPlanner returned an invalid proposal: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 5).join("; ")} (raw head: ${jsonText.slice(0, 200)})`);
    }
    return result.data.tasks;
  }
}
