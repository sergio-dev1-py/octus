/**
 * @octus/core — TaskManager: persistencia y ciclo de vida de tasks (Etapa 3).
 * Determinista y sin modelos: valida, inserta atómicamente, transiciona estados,
 * registra intentos/veredictos y reconcilia tras reinicio. El AgentManager
 * ejecuta; el Scheduler decide.
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { createId, type AgentKind, type Task, type TaskBlockedReason, type TaskDependency, type TaskStatus } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { isUncPath, sameOrInside } from "../tools/path-scope.js";
import { backoffMs, now } from "../util.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { DirectoryRegistry } from "../orchestration/directory-registry.js";
import type { AgentManager } from "../orchestration/agent-manager.js";
import type { TestRunner } from "../tools/test-runner.js";
import { adjacency, cascadeCancelSet, detectCycle, isDependencySatisfied, orderTasks } from "./task-graph.js";

export type { TaskStatus, TaskBlockedReason };

const TERMINAL_SUCCESS: TaskStatus[] = ["completed", "reviewed"];
const TERMINAL_ANY: TaskStatus[] = ["completed", "reviewed", "failed", "cancelled", "interrupted"];
const NON_TERMINAL: TaskStatus[] = ["draft", "ready", "assigned", "running", "blocked", "failed"];

/** Transiciones explícitas permitidas por setStatus (recordReview/retry tienen las suyas). */
const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  draft: ["ready", "cancelled"],
  ready: ["assigned", "blocked", "cancelled"],
  assigned: ["running", "blocked", "cancelled", "interrupted"],
  running: ["completed", "failed", "blocked", "cancelled", "interrupted"],
  blocked: ["ready", "blocked", "cancelled"],
  failed: ["assigned", "cancelled"],
  completed: ["cancelled"],
  reviewed: ["cancelled"],
  integrated: ["cancelled"],
  cancelled: [],
  interrupted: ["assigned", "cancelled"],
};

export interface PlannedTaskInput {
  tempId: string;
  title: string;
  description: string;
  agentRole: AgentKind;
  priority: number;
  dependencies: string[];
  acceptanceCriteria: string[];
  requiredTools: string[];
  writeScope: string[];
  validationCommands: string[];
  needsReview: boolean;
  reviewTargetTempId?: string;
  estimatedComplexity?: string;
}

export interface CreateDagInput {
  runId: string;
  planId: string;
  revisionId: string;
  planningId?: string;
  /** Hash de idempotencia; si se omite se deriva (menos estricto, para tests). */
  requestHash?: string;
  tasks: PlannedTaskInput[];
}

export interface RoleLimits {
  maxImplementers: number;
  maxReaders: number;
  maxReviewers: number;
}

export function requestHashOf(input: { runId: string; planId: string; revisionId: string; objective: string; brief: string; nonce?: string }): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export class TaskManager {
  constructor(
    private readonly db: PersistenceService,
    private readonly events: EventStore,
    private readonly bus: EventBus,
    private readonly registry: AgentRegistry,
    private readonly directories: DirectoryRegistry,
    private readonly tests: TestRunner,
    private readonly agents: () => AgentManager,
    private readonly getRoleLimits: () => RoleLimits,
    private readonly getSchedulerConfig: () => { maxAttemptsPerTask: number; backoffBaseMs: number },
  ) {}

  // ------------------------------------------------------------------ lectura
  async getTask(taskId: string): Promise<Task> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM tasks WHERE id = ?", [taskId]);
    if (!row) throw new OctusError("not_found", `Task not found: ${taskId}`);
    return deserializeTask(row);
  }

  async listTasks(filter: { runId?: string; sessionId?: string }): Promise<Task[]> {
    let rows: Record<string, string | number | null>[];
    if (filter.runId) {
      rows = await this.db.query("SELECT * FROM tasks WHERE run_id = ? ORDER BY priority DESC, created_at ASC, id ASC", [filter.runId]);
    } else if (filter.sessionId) {
      rows = await this.db.query(
        "SELECT t.* FROM tasks t JOIN runs r ON r.id = t.run_id WHERE r.session_id = ? ORDER BY t.created_at ASC, t.id ASC",
        [filter.sessionId],
      );
    } else {
      throw new OctusError("invalid_tool_args", "listTasks requires runId or sessionId");
    }
    return rows.map(deserializeTask);
  }

  async getDependencies(taskId: string): Promise<TaskDependency[]> {
    const rows = await this.db.query<{ task_id: string; depends_on: string; kind: string }>("SELECT * FROM task_dependencies WHERE task_id = ?", [taskId]);
    return rows.map((r) => ({ taskId: r.task_id, dependsOn: r.depends_on, kind: r.kind as "requires" }));
  }

  async getAttempts(taskId: string): Promise<import("@octus/shared").TaskAttempt[]> {
    const rows = await this.db.query<Record<string, string | number | null>>("SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt ASC", [taskId]);
    return rows.map(deserializeAttempt);
  }

  async getDelivery(taskId: string): Promise<{ summary: string; artifacts: Array<{ summary?: string }> } | undefined> {
    const row = await this.db.queryOne<Record<string, string | number | null>>(
      "SELECT * FROM task_attempts WHERE task_id = ? AND status = 'completed' ORDER BY attempt DESC LIMIT 1",
      [taskId],
    );
    if (!row) return undefined;
    const artifacts = row.artifacts ? (JSON.parse(String(row.artifacts)) as Array<{ summary?: string }>) : [];
    return { summary: artifacts.map((a) => a.summary ?? "").join("\n"), artifacts };
  }

  async getPlanning(id: string): Promise<import("@octus/shared").Planning> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM plannings WHERE id = ?", [id]);
    if (!row) throw new OctusError("not_found", `Planning not found: ${id}`);
    return deserializePlanning(row);
  }

  // ------------------------------------------------------- creación idempotente
  async createDag(input: CreateDagInput): Promise<{ planningId: string; taskIds: string[]; created: boolean }> {
    const run = await this.db.queryOne<{ id: string; session_id: string; plan_revision_id: string | null }>("SELECT id, session_id, plan_revision_id FROM runs WHERE id = ?", [input.runId]);
    if (!run) throw new OctusError("not_found", `Run not found: ${input.runId}`);
    const rev = await this.db.queryOne<{ id: string; plan_id: string; approval: string }>("SELECT id, plan_id, approval FROM plan_revisions WHERE id = ?", [input.revisionId]);
    if (!rev || rev.plan_id !== input.planId) throw new OctusError("not_found", `Revision ${input.revisionId} not found in plan ${input.planId}`);
    if (rev.approval !== "approved") {
      throw new OctusError("invalid_state", "Cannot create executable tasks without an approved revision (needs-approval)");
    }
    if (run.plan_revision_id && run.plan_revision_id !== input.revisionId) {
      throw new OctusError("plan_conflict", `Run is pinned to revision ${run.plan_revision_id}, not ${input.revisionId}`);
    }
    const session = await this.db.queryOne<{ project_id: string; directory: string }>("SELECT project_id, directory FROM sessions WHERE id = ?", [run.session_id]);
    if (!session) throw new OctusError("not_found", `Session not found: ${run.session_id}`);

    const hash = input.requestHash ?? requestHashOf({ runId: input.runId, planId: input.planId, revisionId: input.revisionId, objective: "", brief: JSON.stringify(input.tasks.map((t) => t.title)) });
    const existing = await this.db.queryOne<{ id: string; status: string; reason: string | null }>(
      "SELECT id, status, reason FROM plannings WHERE run_id = ? AND plan_id = ? AND revision_id = ? AND request_hash = ?",
      [input.runId, input.planId, input.revisionId, hash],
    );
    if (existing) {
      if (existing.status === "valid") {
        const ids = (await this.db.query<{ id: string }>("SELECT id FROM tasks WHERE planning_id = ? ORDER BY created_at ASC, id ASC", [existing.id])).map((r) => r.id);
        return { planningId: existing.id, taskIds: ids, created: false };
      }
      throw new OctusError("invalid_state", `Planning was rejected: ${existing.reason ?? "no reason recorded"}`);
    }

    // Validación estructural en memoria (antes de tocar la DB).
    this.validateProposal(input.tasks);
    await this.validateSemantics(input.tasks, session.project_id, session.directory);
    const cycle = detectCycle({
      tasks: input.tasks.map((t) => ({ id: t.tempId, status: "draft" as const, needsReview: t.needsReview })),
      deps: input.tasks.flatMap((t) => t.dependencies.map((d) => ({ taskId: t.tempId, dependsOn: d, kind: "requires" as const }))),
    });
    if (cycle) throw new OctusError("invalid_state", `Task dependencies contain a cycle: ${cycle.join(" → ")}`);

    const timestamp = now();
    const planningId = input.planningId ?? createId("pln");
    const tempToReal = new Map<string, string>();
    for (const t of input.tasks) tempToReal.set(t.tempId, createId("tsk"));
    const statements: Array<{ sql: string; params?: unknown[] }> = [
      {
        sql: "INSERT INTO plannings (id, run_id, plan_id, revision_id, request_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'valid', ?)",
        params: [planningId, input.runId, input.planId, input.revisionId, hash, timestamp],
      },
    ];
    // Primero no-reviewer (los reviewer referencian targets ya insertados).
    const sorted = [...input.tasks].sort((a, b) => (a.agentRole === "reviewer" ? 1 : 0) - (b.agentRole === "reviewer" ? 1 : 0));
    for (const t of sorted) {
      statements.push({
        sql: `INSERT INTO tasks (id, run_id, planning_id, plan_id, revision_id, title, description, agent_role, priority, acceptance_criteria, required_tools, write_scope, validation_commands, review_target_task_id, needs_review, status, attempt, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0, ?, ?)`,
        params: [
          tempToReal.get(t.tempId)!,
          input.runId,
          planningId,
          input.planId,
          input.revisionId,
          t.title,
          t.description,
          t.agentRole,
          t.priority,
          JSON.stringify(t.acceptanceCriteria),
          JSON.stringify(t.requiredTools),
          JSON.stringify(t.writeScope),
          JSON.stringify(t.validationCommands),
          t.reviewTargetTempId ? tempToReal.get(t.reviewTargetTempId)! : null,
          t.needsReview ? 1 : 0,
          timestamp,
          timestamp,
        ],
      });
    }
    for (const t of input.tasks) {
      for (const d of t.dependencies) {
        statements.push({
          sql: "INSERT INTO task_dependencies (task_id, depends_on, kind) VALUES (?, ?, 'requires')",
          params: [tempToReal.get(t.tempId)!, tempToReal.get(d)!],
        });
      }
    }
    await this.db.batch(statements as Array<{ sql: string; params?: import("../persistence/protocol.js").SqlParam[] }>);
    const correlationId = createId("cor");
    for (const t of input.tasks) {
      const event = await this.events.append({ type: "task.created", aggregate: { kind: "task", id: tempToReal.get(t.tempId)! }, correlationId, payload: { runId: input.runId, planningId, agentRole: t.agentRole } });
      this.bus.publish(event);
    }
    const planned = await this.events.append({ type: "planning.created", aggregate: { kind: "planning", id: planningId }, correlationId, payload: { runId: input.runId } });
    this.bus.publish(planned);
    return { planningId, taskIds: input.tasks.map((t) => tempToReal.get(t.tempId)!), created: true };
  }

  async recordPlanningRejected(input: { runId: string; planId: string; revisionId: string; requestHash: string; reason: string }): Promise<string> {
    const id = createId("pln");
    await this.db.exec("INSERT INTO plannings (id, run_id, plan_id, revision_id, request_hash, status, reason, created_at) VALUES (?, ?, ?, ?, ?, 'rejected', ?, ?)", [
      id,
      input.runId,
      input.planId,
      input.revisionId,
      input.requestHash,
      input.reason.slice(0, 2000),
      now(),
    ]);
    const event = await this.events.append({ type: "planning.rejected", aggregate: { kind: "planning", id }, correlationId: createId("cor"), payload: { runId: input.runId, reason: input.reason.slice(0, 500) } });
    this.bus.publish(event);
    return id;
  }

  private validateProposal(tasks: PlannedTaskInput[]): void {
    const reasons: string[] = [];
    const seen = new Set<string>();
    for (const t of tasks) {
      if (seen.has(t.tempId)) reasons.push(`duplicate temp_id '${t.tempId}'`);
      seen.add(t.tempId);
      if (!["explorer", "researcher", "implementer", "reviewer"].includes(t.agentRole)) {
        reasons.push(`task '${t.tempId}': agent_role '${t.agentRole}' is not a worker profile`);
      }
      if (!Number.isInteger(t.priority)) reasons.push(`task '${t.tempId}': priority must be an integer`);
      for (const d of t.dependencies ?? []) {
        if (d === t.tempId) reasons.push(`task '${t.tempId}': self-dependency is forbidden`);
        else if (!tasks.some((x) => x.tempId === d)) reasons.push(`task '${t.tempId}': unknown dependency '${d}'`);
      }
      if (t.reviewTargetTempId && !tasks.some((x) => x.tempId === t.reviewTargetTempId)) {
        reasons.push(`task '${t.tempId}': unknown review target '${t.reviewTargetTempId}'`);
      }
      if (t.reviewTargetTempId && t.agentRole !== "reviewer") {
        reasons.push(`task '${t.tempId}': only reviewer tasks may declare a review target`);
      }
      if (!t.title || t.title.trim().length < 8) reasons.push(`task '${t.tempId}': title is too vague (min 8 chars with a concrete deliverable)`);
      if (!t.description || t.description.trim().length < 20) reasons.push(`task '${t.tempId}': description is too vague (min 20 chars)`);
      if (!t.acceptanceCriteria || t.acceptanceCriteria.length === 0) reasons.push(`task '${t.tempId}': at least one acceptance criterion is required`);
      for (const c of t.acceptanceCriteria ?? []) {
        if (c.trim().length < 10 || !/[\\/.:0-9]|test|spec|lint|build|compil|verific|verif|comprob|check|ejecut|exec|valid|pasar|fallar|medir|assert|expect|should|must|run|pass|fail|coverage/i.test(c)) {
          reasons.push(`task '${t.tempId}': acceptance criterion is not verifiable: '${c.slice(0, 80)}'`);
        }
      }
    }
    if (reasons.length > 0) {
      throw new OctusError("invalid_tool_args", `Invalid task proposal: ${reasons.slice(0, 6).join("; ")}`, { details: { reasons: reasons.slice(0, 20) } });
    }
  }

  private async validateSemantics(tasks: PlannedTaskInput[], projectId: string, sessionDir: string): Promise<void> {
    const reasons: string[] = [];
    const allowlist = new Set((await this.tests.listAllowlist(projectId)).map((e) => e.id));
    const isolated = await this.directories.list(projectId);
    const roots = [sessionDir, ...isolated.map((d) => d.realPath)];
    const insideRoots = (p: string): boolean => {
      if (isUncPath(p)) return false;
      try {
        const abs = p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) ? p : `${sessionDir}/${p}`;
        const real = existsSync(abs) ? realpathSync(abs) : abs;
        return roots.some((r) => {
          try {
            return sameOrInside(realpathSync(r), real);
          } catch {
            return false;
          }
        });
      } catch {
        return false;
      }
    };
    for (const t of tasks) {
      const def = await this.registry.get(t.agentRole);
      if (!def) {
        reasons.push(`task '${t.tempId}': unknown agent definition '${t.agentRole}'`);
        continue;
      }
      for (const tool of t.requiredTools ?? []) {
        if (!def.tools.includes(tool) || def.deniedTools.includes(tool)) {
          reasons.push(`task '${t.tempId}': tool '${tool}' is not authorized for '${t.agentRole}'`);
        }
      }
      for (const scope of t.writeScope ?? []) {
        if (!insideRoots(scope)) reasons.push(`task '${t.tempId}': write_scope '${scope}' is outside assigned directories`);
      }
      if (t.agentRole !== "implementer" && (t.writeScope ?? []).length > 0) {
        reasons.push(`task '${t.tempId}': only implementer tasks may declare write_scope`);
      }
      for (const cmd of t.validationCommands ?? []) {
        if (!allowlist.has(cmd)) reasons.push(`task '${t.tempId}': validation command '${cmd}' is not in the project allowlist`);
      }
      if (t.agentRole === "implementer" && !t.needsReview) reasons.push(`task '${t.tempId}': implementer tasks require needsReview`);
      if (t.agentRole === "reviewer" && t.needsReview) reasons.push(`task '${t.tempId}': reviewer tasks cannot require review`);
      if (t.agentRole === "reviewer" && !t.reviewTargetTempId) reasons.push(`task '${t.tempId}': reviewer tasks require a review target`);
      if (t.reviewTargetTempId) {
        const target = tasks.find((x) => x.tempId === t.reviewTargetTempId);
        if (target && !target.needsReview) reasons.push(`task '${t.tempId}': review target '${t.reviewTargetTempId}' does not require review`);
      }
      if (t.agentRole === "reviewer") {
        // Un reviewer que depende de una task con needsReview se bloquea para siempre:
        // la dependencia solo se satisface con `reviewed`, y `reviewed` exige el
        // veredicto de (normalmente) este mismo reviewer. El orden reviewer→target
        // va por reviewTargetTempId, nunca por dependencies.
        for (const d of t.dependencies ?? []) {
          const depTarget = tasks.find((x) => x.tempId === d);
          if (depTarget && depTarget.needsReview) {
            reasons.push(`task '${t.tempId}': reviewer tasks must not depend on tasks requiring review ('${d}'); order review via reviewTargetTempId instead (dependency would deadlock)`);
          }
        }
      }
    }
    if (reasons.length > 0) {
      throw new OctusError("invalid_tool_args", `Invalid task proposal: ${reasons.slice(0, 6).join("; ")}`, { details: { reasons: reasons.slice(0, 20) } });
    }
  }

  // ------------------------------------------------------------------ estados
  async setStatus(taskId: string, status: Task["status"], blocked?: { reason: TaskBlockedReason; details?: Record<string, unknown> }): Promise<Task> {
    const task = await this.getTask(taskId);
    const allowed = ALLOWED[task.status] ?? [];
    const isBlockedSelf = task.status === "blocked" && status === "blocked";
    if (!allowed.includes(status) && !isBlockedSelf) {
      throw new OctusError("invalid_state", `Invalid task transition ${task.status} → ${status}`);
    }
    const timestamp = now();
    await this.db.exec("UPDATE tasks SET status = ?, blocked_reason = ?, blocked_details = ?, updated_at = ? WHERE id = ?", [
      status,
      status === "blocked" ? (blocked?.reason ?? task.blockedReason ?? null) : null,
      status === "blocked" ? JSON.stringify(blocked?.details ?? task.blockedDetails ?? {}) : null,
      timestamp,
      taskId,
    ]);
    const event = await this.events.append({ type: "task.status_changed", aggregate: { kind: "task", id: taskId }, correlationId: createId("cor"), payload: { from: task.status, to: status } });
    this.bus.publish(event);
    return this.getTask(taskId);
  }

  async cancelTask(taskId: string): Promise<{ cancelled: string[] }> {
    const task = await this.getTask(taskId);
    const siblings = await this.listTasks({ runId: task.runId });
    const deps = await this.db.query<{ task_id: string; depends_on: string; kind: string }>("SELECT * FROM task_dependencies");
    const graph = {
      tasks: siblings.map((t) => ({ id: t.id, status: t.status, needsReview: t.needsReview })),
      deps: deps.filter((d) => siblings.some((t) => t.id === d.task_id)).map((d) => ({ taskId: d.task_id, dependsOn: d.depends_on, kind: d.kind as "requires" })),
    };
    const target = cascadeCancelSet(graph, taskId);
    const cancelled: string[] = [];
    for (const id of target) {
      const row = await this.db.queryOne<{ instance_id: string | null }>(
        "SELECT instance_id FROM task_attempts WHERE task_id = ? AND status IN ('pending','running') ORDER BY attempt DESC LIMIT 1",
        [id],
      );
      if (row?.instance_id) {
        await this.agents().cancel(row.instance_id).catch(() => undefined);
      }
      await this.db.batch([
        { sql: "UPDATE task_attempts SET status = 'cancelled', completed_at = ? WHERE task_id = ? AND status IN ('pending','running')", params: [now(), id] },
        { sql: "UPDATE tasks SET status = 'cancelled', blocked_reason = NULL, blocked_details = NULL, updated_at = ? WHERE id = ? AND status NOT IN ('completed','reviewed')", params: [now(), id] },
        { sql: "DELETE FROM scheduler_reservations WHERE task_id = ?", params: [id] },
      ]);
      const event = await this.events.append({ type: "task.status_changed", aggregate: { kind: "task", id }, correlationId: createId("cor"), payload: { to: "cancelled", reason: "cascade" } });
      this.bus.publish(event);
      cancelled.push(id);
    }
    return { cancelled };
  }

  // ------------------------------------------------------------------ intentos
  async startAttempt(taskId: string, instanceId: string): Promise<number> {
    const task = await this.getTask(taskId);
    const cfg = this.getSchedulerConfig();
    if (task.attempt >= cfg.maxAttemptsPerTask) {
      throw new OctusError("invalid_state", `Task ${taskId} exhausted its ${cfg.maxAttemptsPerTask} attempts`);
    }
    const active = await this.db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM task_attempts WHERE task_id = ? AND status IN ('pending','running')", [taskId]);
    if ((active?.n ?? 0) > 0) {
      throw new OctusError("invalid_state", `Task ${taskId} already has an active attempt`);
    }
    const attempt = task.attempt + 1;
    const timestamp = now();
    await this.db.batch([
      { sql: "INSERT INTO task_attempts (task_id, attempt, instance_id, status, started_at, created_at) VALUES (?, ?, ?, 'running', ?, ?)", params: [taskId, attempt, instanceId, timestamp, timestamp] },
      { sql: "UPDATE tasks SET attempt = ?, status = 'running', blocked_reason = NULL, blocked_details = NULL, updated_at = ? WHERE id = ?", params: [attempt, timestamp, taskId] },
    ]);
    const event = await this.events.append({ type: "task_attempt.created", aggregate: { kind: "task", id: taskId }, correlationId: createId("cor"), payload: { attempt, instanceId } });
    this.bus.publish(event);
    return attempt;
  }

  async completeAttempt(taskId: string, status: "completed" | "failed" | "cancelled" | "interrupted", detail?: { summary?: string; errorCode?: string; errorMessage?: string }): Promise<void> {
    const task = await this.getTask(taskId);
    const row = await this.db.queryOne<{ attempt: number }>("SELECT attempt FROM task_attempts WHERE task_id = ? AND status IN ('pending','running') ORDER BY attempt DESC LIMIT 1", [taskId]);
    if (!row) throw new OctusError("invalid_state", `Task ${taskId} has no active attempt`);
    const timestamp = now();
    const artifacts = detail?.summary ? JSON.stringify([{ kind: "report", summary: detail.summary.slice(0, 20000) }]) : null;
    await this.db.batch([
      { sql: "UPDATE task_attempts SET status = ?, error_code = ?, error_message = ?, artifacts = ?, completed_at = ? WHERE task_id = ? AND attempt = ?", params: [status, detail?.errorCode ?? null, detail?.errorMessage?.slice(0, 2000) ?? null, artifacts, timestamp, taskId, row.attempt] },
      { sql: "UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?", params: [status === "interrupted" ? "interrupted" : status, detail?.errorMessage?.slice(0, 2000) ?? null, timestamp, taskId] },
    ]);
    const event = await this.events.append({ type: "task_attempt.status_changed", aggregate: { kind: "task", id: taskId }, correlationId: createId("cor"), payload: { attempt: row.attempt, status } });
    this.bus.publish(event);
    const changed = await this.events.append({ type: "task.status_changed", aggregate: { kind: "task", id: taskId }, correlationId: createId("cor"), payload: { from: task.status, to: status === "interrupted" ? "interrupted" : status } });
    this.bus.publish(changed);
  }

  /**
   * Marca failed una task cuyo spawn murió antes de crear el intento (sin fila
   * de intento que completar). Evita el atasco en `assigned` sin reservas.
   * Caso live: delegación denegada por snapshot huérfano, límites en carrera, etc.
   */
  async failUnstarted(taskId: string, errorMessage: string): Promise<void> {
    const task = await this.getTask(taskId);
    const timestamp = now();
    await this.db.exec("UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status IN ('assigned','ready','blocked')", [
      errorMessage.slice(0, 2000),
      timestamp,
      taskId,
    ]);
    const event = await this.events.append({ type: "task.status_changed", aggregate: { kind: "task", id: taskId }, correlationId: createId("cor"), payload: { from: task.status, to: "failed", reason: "spawn-failed" } });
    this.bus.publish(event);
  }

  /**
   * Reintento explícito: conserva task_id, incrementa attempt, nueva fila,
   * nueva AgentInstance con el contexto del intento anterior. Nunca destructivo.
   */
  async retryTask(taskId: string, opts?: { directoryId?: string; briefSuffix?: string }): Promise<{ attempt: number; instanceId: string }> {
    const task = await this.getTask(taskId);
    if (task.status !== "failed" && task.status !== "interrupted") {
      throw new OctusError("invalid_state", `Only failed or interrupted tasks can be retried (task is ${task.status})`);
    }
    const cfg = this.getSchedulerConfig();
    if (task.attempt >= cfg.maxAttemptsPerTask) {
      throw new OctusError("invalid_state", `Task ${taskId} exhausted its ${cfg.maxAttemptsPerTask} attempts`);
    }
    const last = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt DESC LIMIT 1", [taskId]);
    if (last && String(last.status) !== "completed" && last.completed_at) {
      const waitMs = backoffMs(task.attempt + 1, cfg.backoffBaseMs);
      if (now() - Number(last.completed_at) < waitMs) {
        throw new OctusError("invalid_state", `Retry backoff: wait ${waitMs}ms after the previous attempt`, { retryable: true, details: { retryAfterMs: waitMs } });
      }
    }
    const active = await this.db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM task_attempts WHERE task_id = ? AND status IN ('pending','running')", [taskId]);
    if ((active?.n ?? 0) > 0) throw new OctusError("invalid_state", `Task ${taskId} already has an active attempt`);
    const attempt = task.attempt + 1;
    const timestamp = now();
    await this.db.batch([
      { sql: "INSERT INTO task_attempts (task_id, attempt, status, created_at) VALUES (?, ?, 'pending', ?)", params: [taskId, attempt, timestamp] },
      { sql: "UPDATE tasks SET attempt = ?, status = 'assigned', blocked_reason = NULL, blocked_details = NULL, error = NULL, updated_at = ? WHERE id = ?", params: [attempt, timestamp, taskId] },
    ]);
    // Contexto del intento anterior: resumen, errores, artefactos y estado del workspace.
    let previous = "";
    if (last) {
      try {
        const artifacts = last.artifacts ? (JSON.parse(String(last.artifacts)) as Array<{ summary?: string }>) : [];
        const summary = artifacts.map((a) => a.summary ?? "").join("\n").slice(0, 4000);
        previous = `\n\nPrevious attempt ${String(last.attempt)} ended as ${String(last.status)}${last.error_message ? `: ${String(last.error_message).slice(0, 1000)}` : ""}${summary ? `\nPrevious delivery:\n${summary}` : ""}\nContinue or repair within the same scope; never destroy work without explicit approval.`;
      } catch {
        previous = "";
      }
    }
    const scope = (task.writeScope ?? []).join(", ");
    const brief = `Task: ${task.title}\n${task.description}\nAcceptance criteria:\n${(task.acceptanceCriteria ?? []).map((c) => `- ${c}`).join("\n")}${scope ? `\nScope: ${scope}` : ""}\nValidation (allowlisted commands only): ${(task.validationCommands ?? []).join(", ") || "none"}${opts?.briefSuffix ? `\n${opts.briefSuffix}` : ""}${previous}`;
    const coord = await this.requireCoordinatorInstance(task.runId);
    let instanceId: string;
    try {
      const spawned = await this.agents().spawn({
        parentInstanceId: coord,
        definitionId: task.agentRole,
        brief,
        mode: "background",
        directoryId: opts?.directoryId,
      });
      instanceId = spawned.instanceId;
    } catch (error) {
      await this.db.batch([
        { sql: "UPDATE task_attempts SET status = 'failed', error_message = ?, completed_at = ? WHERE task_id = ? AND attempt = ?", params: [error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000), now(), taskId, attempt] },
        { sql: "UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", params: [error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), now(), taskId] },
      ]);
      throw error;
    }
    await this.db.batch([
      { sql: "UPDATE task_attempts SET instance_id = ?, status = 'running', started_at = ? WHERE task_id = ? AND attempt = ?", params: [instanceId, now(), taskId, attempt] },
      { sql: "UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?", params: [now(), taskId] },
    ]);
    const event = await this.events.append({ type: "task_attempt.status_changed", aggregate: { kind: "task", id: taskId }, correlationId: createId("cor"), payload: { attempt, status: "running", instanceId } });
    this.bus.publish(event);
    return { attempt, instanceId };
  }

  private async requireCoordinatorInstance(runId: string): Promise<string> {
    const row = await this.db.queryOne<{ id: string }>(
      `SELECT i.id AS id FROM agent_instances i
       JOIN agent_definitions d ON d.id = i.definition_id
       WHERE i.run_id = ? AND d.kind = 'coordinator'
       ORDER BY i.created_at DESC LIMIT 1`,
      [runId],
    );
    if (!row) throw new OctusError("not_found", `No coordinator instance for run ${runId}`);
    return row.id;
  }

  // ------------------------------------------------------------------ review
  async recordReview(reviewerTaskId: string, targetTaskId: string, verdict: "accept" | "request-changes", detail?: Record<string, unknown>): Promise<void> {
    const reviewer = await this.getTask(reviewerTaskId);
    const target = await this.getTask(targetTaskId);
    if (reviewer.agentRole !== "reviewer" || reviewer.reviewTargetTaskId !== targetTaskId) {
      throw new OctusError("invalid_state", `Task ${reviewerTaskId} is not the linked reviewer of ${targetTaskId}`);
    }
    if (reviewer.status !== "completed") {
      throw new OctusError("invalid_state", `Reviewer task must be completed before recording a verdict (is ${reviewer.status})`);
    }
    if (!target.needsReview || target.status !== "completed") {
      throw new OctusError("invalid_state", `Target task must be completed and require review (is ${target.status})`);
    }
    const existing = await this.db.queryOne<{ verdict: string }>("SELECT verdict FROM task_review_verdicts WHERE reviewer_task_id = ? AND target_task_id = ?", [reviewerTaskId, targetTaskId]);
    if (existing) throw new OctusError("already_exists", "A verdict is already recorded for this reviewer/target pair");
    const timestamp = now();
    if (verdict === "accept") {
      await this.db.batch([
        { sql: "INSERT INTO task_review_verdicts (reviewer_task_id, target_task_id, verdict, detail, created_at) VALUES (?, ?, 'accept', ?, ?)", params: [reviewerTaskId, targetTaskId, detail ? JSON.stringify(detail).slice(0, 8000) : null, timestamp] },
        { sql: "UPDATE tasks SET status = 'reviewed', reviewed_by_task_id = ?, reviewed_at = ?, updated_at = ? WHERE id = ?", params: [reviewerTaskId, timestamp, timestamp, targetTaskId] },
      ]);
    } else {
      await this.db.batch([
        { sql: "INSERT INTO task_review_verdicts (reviewer_task_id, target_task_id, verdict, detail, created_at) VALUES (?, ?, 'request-changes', ?, ?)", params: [reviewerTaskId, targetTaskId, detail ? JSON.stringify(detail).slice(0, 8000) : null, timestamp] },
        { sql: "UPDATE tasks SET status = 'failed', error = 'changes-requested', reviewed_by_task_id = ?, reviewed_at = ?, updated_at = ? WHERE id = ?", params: [reviewerTaskId, timestamp, timestamp, targetTaskId] },
      ]);
    }
    const event = await this.events.append({ type: "review.recorded", aggregate: { kind: "task", id: targetTaskId }, correlationId: createId("cor"), payload: { reviewerTaskId, verdict } });
    this.bus.publish(event);
    const changed = await this.events.append({ type: "task.status_changed", aggregate: { kind: "task", id: targetTaskId }, correlationId: createId("cor"), payload: { verdict, reviewerTaskId } });
    this.bus.publish(changed);
  }

  // ------------------------------------------------------------------ recuperación
  /**
   * Continúa una instancia interrumpida en la MISMA instancia y MISMO intento.
   * Acción explícita; nunca automática tras reinicio.
   */
  async recoverInstance(instanceId: string): Promise<{ taskId: string; attempt: number }> {
    const row = await this.db.queryOne<{ task_id: string; attempt: number }>(
      "SELECT task_id, attempt FROM task_attempts WHERE instance_id = ? AND status = 'interrupted' ORDER BY attempt DESC LIMIT 1",
      [instanceId],
    );
    if (!row) throw new OctusError("invalid_state", `No interrupted attempt found for instance ${instanceId}`);
    await this.agents().resumeInstance(instanceId);
    const timestamp = now();
    await this.db.exec("UPDATE task_attempts SET status = 'running', started_at = ? WHERE task_id = ? AND attempt = ?", [timestamp, row.task_id, row.attempt]);
    await this.db.exec("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'interrupted'", [timestamp, row.task_id]);
    const event = await this.events.append({ type: "task_attempt.status_changed", aggregate: { kind: "task", id: row.task_id }, correlationId: createId("cor"), payload: { attempt: row.attempt, status: "running", resumed: true } });
    this.bus.publish(event);
    return { taskId: row.task_id, attempt: row.attempt };
  }

  // ------------------------------------------------------------------ misc
  async recordProgress(taskId: string, kind: "progress" | "help" | "blocked" | "result", text: string): Promise<void> {
    await this.getTask(taskId);
    const event = await this.events.append({ type: "task.progress", aggregate: { kind: "task", id: taskId }, correlationId: createId("cor"), payload: { kind, text: text.slice(0, 8000) } });
    this.bus.publish(event);
  }

  async fairnessCursor(sessionId: string): Promise<string | undefined> {
    const row = await this.db.queryOne<{ last_run_id: string | null }>("SELECT last_run_id FROM scheduler_fairness WHERE session_id = ?", [sessionId]);
    return row?.last_run_id ?? undefined;
  }

  async setFairnessCursor(sessionId: string, runId: string): Promise<void> {
    await this.db.exec("INSERT INTO scheduler_fairness (session_id, last_run_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET last_run_id = excluded.last_run_id, updated_at = excluded.updated_at", [sessionId, runId, now()]);
  }

  /** Reconciliación post-reinicio: interrumpe lo activo, limpia reservas huérfanas. */
  async reconcile(): Promise<{ interrupted: number; released: number }> {
    const timestamp = now();
    const running = await this.db.query<{ id: string }>("SELECT id FROM tasks WHERE status IN ('assigned','running')");
    for (const t of running) {
      await this.db.exec("UPDATE tasks SET status = 'interrupted', updated_at = ? WHERE id = ?", [timestamp, t.id]);
      const event = await this.events.append({ type: "task.status_changed", aggregate: { kind: "task", id: t.id }, correlationId: createId("cor"), payload: { to: "interrupted", reason: "settle-on-startup" } });
      this.bus.publish(event);
    }
    await this.db.exec("UPDATE task_attempts SET status = 'interrupted', completed_at = ? WHERE status IN ('pending','running')", [timestamp]);
    // Reservas sin propietaria activa.
    const orphans = await this.db.query<{ id: string }>(
      `SELECT r.id AS id FROM scheduler_reservations r
       LEFT JOIN tasks t ON t.id = r.task_id AND t.status IN ('assigned','running') AND t.attempt = r.attempt
       WHERE t.id IS NULL`,
    );
    for (const o of orphans) {
      await this.db.exec("DELETE FROM scheduler_reservations WHERE id = ?", [o.id]);
    }
    // Doble escritor residual: conserva el más antiguo, re-bloquea el resto.
    const dupes = await this.db.query<{ resource_key: string; n: number }>(
      "SELECT resource_key, COUNT(*) AS n FROM scheduler_reservations WHERE kind = 'scope-write' GROUP BY resource_key HAVING COUNT(*) > 1",
    );
    let released = orphans.length;
    for (const d of dupes) {
      const holders = await this.db.query<{ id: string; task_id: string }>("SELECT id, task_id FROM scheduler_reservations WHERE kind = 'scope-write' AND resource_key = ? ORDER BY acquired_at ASC", [d.resource_key]);
      for (const extra of holders.slice(1)) {
        await this.db.exec("DELETE FROM scheduler_reservations WHERE id = ?", [extra.id]);
        await this.db.exec("UPDATE tasks SET status = 'blocked', blocked_reason = 'no-capacity', blocked_details = ?, updated_at = ? WHERE id = ? AND status IN ('assigned','running')", [JSON.stringify({ reason: "duplicate writer reconciled" }), timestamp, extra.task_id]);
        released++;
      }
    }
    return { interrupted: running.length, released };
  }
}

export function deserializeTask(row: Record<string, string | number | null>): Task {
  const parse = <T>(value: string | number | null, fallback: T): T => {
    if (value === null || value === undefined) return fallback;
    try {
      return JSON.parse(String(value)) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: String(row.id),
    runId: String(row.run_id),
    planningId: String(row.planning_id),
    planId: String(row.plan_id),
    revisionId: String(row.revision_id),
    title: String(row.title),
    description: String(row.description),
    agentRole: row.agent_role as Task["agentRole"],
    priority: Number(row.priority ?? 0),
    acceptanceCriteria: parse<string[]>(row.acceptance_criteria, []),
    requiredTools: parse<string[]>(row.required_tools, []),
    writeScope: parse<string[]>(row.write_scope, []),
    validationCommands: parse<string[]>(row.validation_commands, []),
    reviewTargetTaskId: row.review_target_task_id ? String(row.review_target_task_id) : undefined,
    needsReview: Number(row.needs_review ?? 0) === 1,
    status: row.status as Task["status"],
    blockedReason: row.blocked_reason ? (String(row.blocked_reason) as Task["blockedReason"]) : undefined,
    blockedDetails: row.blocked_details ? parse<Record<string, unknown>>(row.blocked_details, {}) : undefined,
    reviewedByTaskId: row.reviewed_by_task_id ? String(row.reviewed_by_task_id) : undefined,
    reviewedAt: row.reviewed_at ? Number(row.reviewed_at) : undefined,
    attempt: Number(row.attempt ?? 0),
    error: row.error ? String(row.error) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function deserializeAttempt(row: Record<string, string | number | null>): import("@octus/shared").TaskAttempt {
  const parse = <T>(value: string | number | null, fallback: T): T => {
    if (value === null || value === undefined) return fallback;
    try {
      return JSON.parse(String(value)) as T;
    } catch {
      return fallback;
    }
  };
  return {
    taskId: String(row.task_id),
    attempt: Number(row.attempt),
    instanceId: row.instance_id ? String(row.instance_id) : undefined,
    status: row.status as import("@octus/shared").TaskAttempt["status"],
    errorCode: row.error_code ? String(row.error_code) : undefined,
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    errorDetails: row.error_details ? parse(row.error_details, {}) : undefined,
    artifacts: row.artifacts ? parse(row.artifacts, []) : undefined,
    startedAt: row.started_at ? Number(row.started_at) : undefined,
    completedAt: row.completed_at ? Number(row.completed_at) : undefined,
    createdAt: Number(row.created_at),
  };
}

function deserializePlanning(row: Record<string, string | number | null>): import("@octus/shared").Planning {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    planId: String(row.plan_id),
    revisionId: String(row.revision_id),
    requestHash: String(row.request_hash),
    status: row.status as import("@octus/shared").Planning["status"],
    reason: row.reason ? String(row.reason) : undefined,
    taskIds: [],
    createdAt: Number(row.created_at),
  };
}
