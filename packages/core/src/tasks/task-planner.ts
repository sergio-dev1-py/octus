/**
 * @octus/core — TaskPlanner: servicio interno de orquestación (Etapa 3).
 * NO es un agente: no tiene AgentDefinition ni AgentInstance ni conversación.
 * El Coordinator Build lo invoca; ejecuta UNA generación con el mismo
 * proveedor/modelo/effort de la instancia coordinadora y devuelve una propuesta
 * que el núcleo valida (Zod + reglas) antes de crear el DAG.
 */
import { z } from "zod";
import { createId, type AgentKind, type PlanRevision } from "@octus/shared";
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

/** Los modelos a veces mandan la prioridad como texto ("5", "high", "alta"). */
const prioritySchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return 5;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;
    const key = trimmed.toLowerCase();
    if (["high", "alta", "alto", "urgent", "urgente", "critical", "critica", "crítica"].includes(key)) return 8;
    if (["low", "baja", "bajo"].includes(key)) return 3;
    if (["medium", "media", "medio", "normal"].includes(key)) return 5;
  }
  return value;
}, z.number().int().min(0).max(100));

const nullableStringArray = (max: number) =>
  z.preprocess((value) => (value === null || value === undefined ? [] : value), z.array(z.string().min(1).max(max)).max(60));

const needsReviewSchema = z.preprocess((value) => {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") {
    const key = value.trim().toLowerCase();
    if (key === "true" || key === "si" || key === "sí") return true;
    if (key === "false" || key === "no") return false;
  }
  return value;
}, z.boolean());

const proposedTaskSchema = z.object({
  tempId: z.string().min(1).max(64),
  title: z.string().min(1).max(500),
  description: z.string().min(1).max(4000),
  agentRole: z.enum(WORKER_ROLES),
  priority: prioritySchema,
  dependencies: nullableStringArray(64).pipe(z.array(z.string().min(1).max(64)).max(30)),
  acceptanceCriteria: nullableStringArray(1000).pipe(z.array(z.string().min(1).max(1000)).min(1).max(30)),
  requiredTools: nullableStringArray(80).pipe(z.array(z.string().min(1).max(80)).max(40)),
  writeScope: nullableStringArray(500).pipe(z.array(z.string().min(1).max(500)).max(40)),
  validationCommands: nullableStringArray(200).pipe(z.array(z.string().min(1).max(200)).max(20)),
  needsReview: needsReviewSchema,
  // Distintos modelos serializan los opcionales ausentes como null explícito
  // (detectado en live con GLM); null se normaliza a ausente, no es error.
  reviewTargetTempId: z.string().min(1).max(64).nullish(),
  estimatedComplexity: z.string().max(40).nullish(),
});

const proposalSchema = z.object({
  tasks: z.array(proposedTaskSchema).min(1).max(40),
});

export interface PlanTasksInput {
  runId: string;
  /** Opcional: por defecto el objetivo del plan aprobado. */
  objective?: string;
  brief?: string;
  /** Anclaje exacto exigido; si se omite se usa runs.plan_revision_id (sin auto-selección). */
  planId?: string;
  revisionId?: string;
  /** Nonce para re-planificación explícita tras un rechazo (nuevo request_hash). */
  nonce?: string;
  /** Fuerza un DAG nuevo y cancela las tasks abiertas del run. */
  replan?: boolean;
}

const PLANNER_SYSTEM = `You decompose an implementation plan into concrete executable tasks.
Rules:
- Output ONLY a JSON object: {"tasks":[{tempId,title,description,agentRole,priority,dependencies,acceptanceCriteria,requiredTools,writeScope,validationCommands,needsReview,reviewTargetTempId?,estimatedComplexity?}]}.
- agentRole is one of explorer|researcher|implementer|reviewer. implementer tasks MUST set needsReview=true; reviewer tasks MUST set reviewTargetTempId to the tempId of the task they review and needsReview=false.
- dependencies reference tempIds within this proposal only, with no cycles and no self-dependencies. Reviewer tasks must NOT declare dependencies at all: their ordering comes exclusively from reviewTargetTempId (a dependency on a task requiring review would deadlock the DAG and is rejected).
- requiredTools must be basic tools the role plausibly has (read, glob, grep, write, edit, shell, git_status, git_diff, git_stage, git_commit, websearch, webfetch, test_run, question, memory_propose). Never invent tools. memory_propose lets any worker propose a provisional memory entry (governance decides the rest).
- writeScope lists workspace-relative directories the task writes; only for implementer tasks.
- validationCommands must name project test commands (leave empty when unknown).
- Every task needs concrete acceptance criteria with verifiable evidence.
- Keep descriptions and acceptance criteria concise (max 2 sentences / 3 criteria per task) so the JSON stays complete.
- Maximize parallelism: only add a dependency when the task truly consumes another task's output. After a base scaffold, independent feature areas (DB/schema, API, UI components/pages) must be siblings, not a chain. Aim for 2-4 parallel implementer tasks with disjoint writeScope.
- For a greenfield/empty repository or an unfamiliar existing codebase, include exactly one read-only explorer task first (agentRole=explorer, writeScope=[], needsReview=false, no dependencies) to inspect the current files and conventions; implementers that need that context depend on it.
- Never propose more than one explorer task in the same DAG: one explorer can inspect several areas; multiple explorers duplicate context.
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
  async planTasks(coordinatorInstanceId: string, input: PlanTasksInput): Promise<{ planningId: string; taskIds: string[]; created: boolean; fallback?: boolean }> {
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
    // Anclaje exacto a la revisión elegida: explícito o el del run; jamás auto-selección.
    let planId = input.planId;
    let revisionId = input.revisionId;
    if ((!planId || !revisionId) && run.plan_revision_id) {
      const rev = await this.plans.getRevision(run.plan_revision_id);
      if (!rev) throw new OctusError("not_found", `Run revision not found: ${run.plan_revision_id}`);
      planId = rev.planId;
      revisionId = rev.id;
    }
    if (!planId || !revisionId) {
      throw new OctusError("plan_conflict", "No plan revision selected: pass planId+revisionId (user decision required)");
    }
    const revision = await this.plans.resolveRevision(planId, revisionId);
    if (revision.planId !== planId) throw new OctusError("not_found", `Revision ${revisionId} not found in plan ${planId}`);
    revisionId = revision.id;
    // Sin ventana de aprobación: cualquier revisión viva (presentada o recién
    // creada en este run) puede ejecutarse. Solo se rechazan las rechazadas
    // o huérfanas.
    if (revision.approval === "rejected") {
      throw new OctusError("invalid_state", "This plan revision was rejected: create or present a new revision before executing it");
    }
    if (revision.lifecycle === "orphaned") {
      throw new OctusError("invalid_state", "This plan revision is orphaned: create a new revision before executing it");
    }
    const plan = await this.plans.getPlan(planId);
    if (plan.sessionId !== run.session_id) throw new OctusError("invalid_state", "Plan does not belong to the run session");
    // Sin objetivo explícito se usa el del plan aprobado (llamada sin fricción).
    const objective = input.objective?.trim() || plan.objective;

    // Idempotencia por revisión: un DAG viejo de otra revisión no bloquea el
    // plan actual. `replan` fuerza un DAG nuevo y cancela las tasks abiertas.
    const existingTasks = await this.db.query<{ id: string; planning_id: string; revision_id: string; status: string }>(
      "SELECT id, planning_id, revision_id, status FROM tasks WHERE run_id = ? ORDER BY created_at ASC, id ASC",
      [input.runId],
    );
    const activeChildren = await this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agent_instances WHERE run_id = ? AND parent_instance_id IS NOT NULL AND status IN ('created','running','waiting_permission','waiting_input')`,
      [input.runId],
    );
    if (input.replan && Number(activeChildren?.n ?? 0) > 0) {
      throw new OctusError("invalid_state", "Cannot replan while worker subagents are active; cancel them first");
    }
    const terminalTask = ["completed", "reviewed", "integrated", "failed", "cancelled", "interrupted"];
    const supersedeIds = existingTasks.filter((task) => !terminalTask.includes(task.status)).map((task) => task.id);
    if (!input.replan && existingTasks.length > 0 && existingTasks.every((task) => task.revision_id === revisionId)) {
      return { planningId: existingTasks[0]!.planning_id, taskIds: existingTasks.map((task) => task.id), created: false };
    }

    const model = JSON.parse(String(coord.model)) as { providerId: string; modelId: string; effort?: string };
    const hash = requestHashOf({ runId: input.runId, planId, revisionId, objective, brief: input.brief ?? "", nonce: input.nonce });
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

    let proposal: Awaited<ReturnType<TaskPlanner["generateProposal"]>>;
    let fallbackUsed = false;
    try {
      proposal = await this.generateProposal(model, run.session_id, plan.objective, revision.contentMarkdown, objective, input.brief ?? "", plan.projectId);
    } catch {
      proposal = this.fallbackProposal(revision, objective);
      fallbackUsed = true;
    }
    // El planner propone tools y comandos con conocimiento limitado: no dejamos
    // que un detalle accesorio tumbe todo el DAG. Se recortan a lo que el
    // proyecto y cada rol permiten de verdad.
    const allowlist = new Set((await this.tests.listAllowlist(plan.projectId)).map((entry) => entry.id));
    const roleTools = new Map<string, string[]>();
    for (const role of WORKER_ROLES) {
      const def = await this.registry.get(role);
      if (def) roleTools.set(role, def.tools.filter((tool) => !def.deniedTools.includes(tool)));
    }
    const normalized = proposal.map((task) => ({
      ...task,
      requiredTools: task.requiredTools.filter((tool) => roleTools.get(task.agentRole)?.includes(tool) ?? false),
      validationCommands: task.validationCommands.filter((cmd) => allowlist.has(cmd)),
    }));
    try {
      const result = await this.tasks.createDag({ runId: input.runId, planId, revisionId, requestHash: hash, tasks: normalized });
      if (supersedeIds.length > 0) {
        const marks = supersedeIds.map(() => "?").join(", ");
        const timestamp = Date.now();
        await this.db.batch([
          { sql: `UPDATE tasks SET status = 'cancelled', error = 'superseded by replan', updated_at = ? WHERE id IN (${marks})`, params: [timestamp, ...supersedeIds] },
          {
            sql: `UPDATE task_attempts SET status = 'cancelled', completed_at = ? WHERE task_id IN (${marks}) AND status IN ('pending','running')`,
            params: [timestamp, ...supersedeIds],
          },
          { sql: `DELETE FROM scheduler_reservations WHERE task_id IN (${marks})`, params: supersedeIds },
        ]);
      }
      return { ...result, ...(fallbackUsed ? { fallback: true } : {}) };
    } catch (error) {
      if (error instanceof OctusError && (error.code === "invalid_tool_args" || error.code === "invalid_state" || error.code === "plan_conflict")) {
        await this.tasks.recordPlanningRejected({ runId: input.runId, planId, revisionId, requestHash: hash, reason: error.message });
      }
      throw error;
    }
  }

  /**
   * Último recurso si el planner no devuelve JSON válido: un DAG mínimo y
   * seguro (un implementer + su reviewer). Evita que un fallo del modelo deje
   * el run bloqueado sin tareas. El scheduler puede paralelizar en runs futuros.
   */
  private fallbackProposal(revision: PlanRevision, objective: string): Array<{
    tempId: string; title: string; description: string; agentRole: AgentKind; priority: number;
    dependencies: string[]; acceptanceCriteria: string[]; requiredTools: string[];
    writeScope: string[]; validationCommands: string[]; needsReview: boolean;
    reviewTargetTempId?: string; estimatedComplexity?: string;
  }> {
    const steps = revision.structuredContent?.steps ?? [];
    const stepText = steps.map((step) => `- ${step.title}${step.detail ? `: ${step.detail}` : ""}`).join("\n");
    const acceptance = (revision.structuredContent?.acceptanceCriteria ?? []).filter((criterion) => criterion.trim().length >= 5).slice(0, 3);
    const description = `Implementar el plan "${objective}" de principio a fin.\n${stepText}`.slice(0, 4000);
    return [
      {
        tempId: "impl-fallback",
        title: `Implementar ${objective}`.slice(0, 500),
        description: description.length >= 20 ? description : `Implementar el plan "${objective}" completo y verificar el resultado.`,
        agentRole: "implementer",
        priority: 5,
        dependencies: [],
        acceptanceCriteria: acceptance.length > 0 ? acceptance : ["implementation completed and verified"],
        requiredTools: ["read", "write", "edit", "shell", "git_status", "git_diff", "git_stage", "git_commit"],
        writeScope: ["."],
        validationCommands: [],
        needsReview: true,
      },
      {
        tempId: "review-fallback",
        title: `Revisar ${objective}`.slice(0, 500),
        description: `Revisar la implementación del plan "${objective}" contra sus criterios de aceptación y emitir veredicto.`,
        agentRole: "reviewer",
        priority: 5,
        dependencies: [],
        acceptanceCriteria: ["review report with findings and verdict"],
        requiredTools: ["read", "glob", "grep"],
        writeScope: [],
        validationCommands: [],
        needsReview: false,
        reviewTargetTempId: "impl-fallback",
      },
    ];
  }

  private async generateProposal(
    model: { providerId: string; modelId: string; effort?: string },
    conversationId: string,
    planObjective: string,
    revisionMarkdown: string,
    objective: string,
    brief: string,
    projectId: string,
  ): Promise<Array<{
    tempId: string; title: string; description: string; agentRole: AgentKind; priority: number;
    dependencies: string[]; acceptanceCriteria: string[]; requiredTools: string[];
    writeScope: string[]; validationCommands: string[]; needsReview: boolean;
    reviewTargetTempId?: string; estimatedComplexity?: string;
  }>> {
    const resolution = this.router.resolve({ instance: { providerId: model.providerId, modelId: model.modelId, effort: model.effort }, globalDefault: { providerId: model.providerId, modelId: model.modelId, effort: model.effort } });
    const allowedCommands = (await this.tests.listAllowlist(projectId)).map((entry) => entry.id);
    const roleLines: string[] = [];
    for (const role of WORKER_ROLES) {
      const def = await this.registry.get(role);
      if (def) roleLines.push(`- ${role}: ${def.tools.filter((tool) => !def.deniedTools.includes(tool)).join(", ") || "(no tools)"}`);
    }
    const commandLine = allowedCommands.length
      ? `Allowed validationCommands (use ONLY these): ${allowedCommands.join(", ")}`
      : "No validation commands are configured for this project: leave validationCommands empty. Never invent commands like npm run build.";
    const instructions = `${PLANNER_SYSTEM}\n\n${commandLine}\nRole tools (requiredTools may only contain these):\n${roleLines.join("\n")}\n\nPlan objective: ${planObjective}\n\nPlan revision (exact scope, do not exceed it):\n${revisionMarkdown.slice(0, 12000)}\n\nRequest objective: ${objective}${brief ? `\nBrief: ${brief.slice(0, 4000)}` : ""}`;
    const correlationId = createId("cor");
    // El modelo a veces corta el JSON (límite de salida) o añade prosa. Un
    // reintento compacto evita que build se quede sin DAG por una respuesta
    // truncada; el segundo intento pide menos tareas y texto más corto.
    let lastFailure = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const retryNote =
        attempt === 0
          ? ""
          : "\n\nRETRY: your previous answer was incomplete or invalid JSON. Return ONLY complete valid JSON, at most 8 tasks, and keep every description/acceptance criterion short.";
      let text = "";
      const stream = this.router.generateStream(
        resolution,
        { providerId: model.providerId, modelId: model.modelId, effort: model.effort as never, instructions: instructions + retryNote, messages: [{ role: "user", blocks: [{ type: "text", text: "Propose the task DAG as JSON. Return ONLY the JSON object {\"tasks\": [...]} with the exact keys and roles from the instructions — no markdown, no preamble, no invented keys." }] }], maxOutputTokens: 8000, conversationId },
        { providerId: model.providerId, modelId: model.modelId, agentDefinitionId: "coordinator-build", agentInstanceId: "planner", runId: "planner", sessionId: "planner", correlationId },
        new AbortController().signal,
      );
      for await (const event of stream) {
        if (event.type === "text.delta") text += event.delta;
        if (event.type === "error") throw new OctusError("tool_failed", `TaskPlanner model call failed: ${event.error.message}`);
        if (event.type === "completed") break;
      }
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      const jsonText = start >= 0 && end > start ? text.slice(start, end + 1).trim() : text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        lastFailure = `invalid JSON: ${text.slice(0, 300)}`;
        continue;
      }
      const result = proposalSchema.safeParse(parsed);
      if (!result.success) {
        lastFailure = `invalid proposal: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 5).join("; ")} (raw head: ${jsonText.slice(0, 200)})`;
        continue;
      }
      return result.data.tasks.map((t) => ({ ...t, reviewTargetTempId: t.reviewTargetTempId ?? undefined, estimatedComplexity: t.estimatedComplexity ?? undefined }));
    }
    throw new OctusError("tool_failed", `TaskPlanner did not return a valid proposal after 2 attempts: ${lastFailure}`);
  }
}
