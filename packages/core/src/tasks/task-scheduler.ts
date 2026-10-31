/**
 * @octus/core — TaskScheduler determinista (Etapa 3, ADR-030/034/038).
 * Nunca usa modelos: ordena, reserva, ejecuta vía AgentManager y supervisa.
 * Sin DAG visual, sin worktrees automáticos, sin integración (Etapas 4-5).
 */
import { realpathSync } from "node:fs";
import { createId, type AgentKind, type Task } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { isUncPath, sameOrInside } from "../tools/path-scope.js";
import { normalizePath, now } from "../util.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { DirectoryRegistry } from "../orchestration/directory-registry.js";
import type { AgentManager } from "../orchestration/agent-manager.js";
import type { WorktreeManager } from "../worktrees/worktree-manager.js";
import { cascadeCancelSet, isDependencySatisfied, orderTasks } from "./task-graph.js";
import { deserializeTask, type RoleLimits, type TaskManager } from "./task-manager.js";

export interface Assignment {
  taskId: string;
  runId: string;
  instanceId: string;
  attempt: number;
  definitionId: string;
  directoryId?: string;
}

interface EligibleRun {
  runId: string;
  sessionId: string;
  projectId: string;
  sessionDir: string;
  seq: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Canonicaliza un scope de escritura (Windows/UNC/symlinks como Etapa 2). */
export function canonicalizeScope(raw: string, baseDir: string): string {
  if (isUncPath(raw)) {
    throw new OctusError("scope_violation", "UNC paths are not allowed as write scopes");
  }
  const abs = raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) ? raw : `${baseDir}/${raw}`;
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    real = abs;
  }
  if (process.platform === "win32") return normalizePath(real);
  return real;
}

export function scopesOverlap(a: string, b: string): boolean {
  return sameOrInside(a, b) || sameOrInside(b, a);
}

export class TaskScheduler {
  /** Serializa ticks en el proceso: la BD es la fuente de verdad, el mutex evita carreras locales. */
  private ticking: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: PersistenceService,
    private readonly events: EventStore,
    private readonly bus: EventBus,
    private readonly registry: AgentRegistry,
    private readonly directories: DirectoryRegistry,
    private readonly agents: () => AgentManager,
    private readonly tasks: () => TaskManager,
    private readonly getRoleLimits: () => RoleLimits,
    private readonly getSchedulerConfig: () => { maxAttemptsPerTask: number; backoffBaseMs: number },
    private readonly getGlobalLimits: () => { maxPerSession: number; maxPerProject: number; maxDepth: number },
    private readonly worktrees?: () => WorktreeManager,
  ) {}

  async tick(filter?: { sessionId?: string }): Promise<Assignment[]> {
    const run = this.ticking.then(() => this.tickInner(filter));
    this.ticking = run.catch(() => undefined);
    return run;
  }

  private async tickInner(filter?: { sessionId?: string }): Promise<Assignment[]> {
    const assigned: Assignment[] = [];
    // Oleadas acotadas: asignar → supervisar; si supervise completó intentos,
    // los dependientes recién desbloqueados se evalúan en la misma pasada
    // (sin esperar un tick externo que quizá nunca llegue en sesión quieta).
    // El orden y la equidad de cada oleada son los mismos; 4 oleadas como tope.
    for (let wave = 0; wave < 4; wave++) {
      const fresh = await this.assignWave(filter, assigned.length);
      assigned.push(...fresh);
      const progressed = await this.supervise(filter?.sessionId);
      if (!progressed) break;
    }
    return assigned;
  }

  /** Una oleada: promover drafts, ordenar con equidad y asignar (pasos 1–8 + 11). */
  private async assignWave(filter: { sessionId?: string } | undefined, alreadyAssigned: number): Promise<Assignment[]> {
    const assigned: Assignment[] = [];
    // Promueve drafts elegibles (incluye reviewer cuyo target ya completó).
    for (const run of await this.runsWithTasks(filter?.sessionId)) {
      await this.promoteDrafts(run.runId);
    }
    // 1. Runs elegibles con trabajo pendiente (ready o blocked re-evaluable).
    const runs = await this.eligibleRuns(filter?.sessionId);
    if (runs.length === 0) return assigned;
    // 2-3. Orden justo: rotación entre runs, prioridad/desc dentro.
    const ordered = await this.fairOrder(runs);
    for (const run of ordered) {
      const ready = await this.readyTasks(run.runId);
      if (ready.length === 0) continue;
      for (const task of ready) {
        const result = await this.tryAssign(run, task);
        if (result) {
          assigned.push(result);
          await this.tasks().setFairnessCursor(run.sessionId, run.runId);
          break; // una asignación por run y vuelta: equidad estricta
        }
      }
      // 11. Despertar dependientes: la próxima evaluación los recoge (mismo tick si hay hueco).
      // El cómputo de capacidad acumula lo asignado en oleadas previas del mismo tick.
      const more = await this.readyTasks(run.runId);
      if (more.length > 0 && assigned.length + alreadyAssigned < this.totalCapacity()) {
        const next = await this.tryAssign(run, more[0]!);
        if (next) {
          assigned.push(next);
          await this.tasks().setFairnessCursor(run.sessionId, run.runId);
        }
      }
    }
    return assigned;
  }

  private totalCapacity(): number {
    const r = this.getRoleLimits();
    return r.maxImplementers + r.maxReaders + r.maxReviewers;
  }

  private async runsWithTasks(sessionId?: string): Promise<EligibleRun[]> {
    const rows = await this.db.query<Record<string, string | number | null>>(
      `SELECT DISTINCT r.id AS run_id, r.session_id AS session_id, s.project_id AS project_id,
              s.directory AS directory, r.rowid AS seq
       FROM tasks t
       JOIN runs r ON r.id = t.run_id
       JOIN sessions s ON s.id = r.session_id
       ${sessionId ? "WHERE r.session_id = ?" : ""}
       ORDER BY r.rowid ASC`,
      sessionId ? [sessionId] : [],
    );
    return rows.map((r) => ({
      runId: String(r.run_id),
      sessionId: String(r.session_id),
      projectId: String(r.project_id),
      sessionDir: String(r.directory),
      seq: Number(r.seq),
    }));
  }

  /** Draft → ready cuando sus dependencias están satisfechas (reviewer: target completed). */
  private async promoteDrafts(runId: string): Promise<void> {
    const tasks = await this.tasks().listTasks({ runId });
    const raw = await this.db.query<{ task_id: string; depends_on: string; kind: string }>("SELECT * FROM task_dependencies");
    const mine = new Set(tasks.map((t) => t.id));
    const deps = raw.filter((d) => mine.has(d.task_id)).map((d) => ({ taskId: d.task_id, dependsOn: d.depends_on }));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const task of tasks) {
      if (task.status !== "draft") continue;
      if (task.agentRole === "reviewer" && task.reviewTargetTaskId) {
        const target = byId.get(task.reviewTargetTaskId);
        if (target && target.status === "completed") {
          await this.tasks().setStatus(task.id, "ready");
        }
        continue;
      }
      if (this.missingDeps(task, byId, deps).length === 0) {
        await this.tasks().setStatus(task.id, "ready");
        continue;
      }
      // Estructural Etapa 4 (§G): ≥2 predecesores escritores directos exigen
      // combinar cambios (= merge, Etapa 5). Sin combinación segura, bloqueo
      // explícito en vez de draft eterno. Re-evaluable si el DAG cambia.
      if (task.agentRole === "implementer") {
        const depIds = deps.filter((d) => d.taskId === task.id).map((d) => d.dependsOn);
        const writers = depIds.filter((id) => byId.get(id)?.agentRole === "implementer");
        if (writers.length > 1) {
          await this.tasks().setStatus(task.id, "blocked", {
            reason: "deps-unavailable",
            details: { reason: "multiple writer predecessors require a merge (Stage 5); task stays blocked", predecessors: writers },
          });
        }
      }
    }
  }

  private async eligibleRuns(sessionId?: string): Promise<EligibleRun[]> {
    const rows = await this.db.query<Record<string, string | number | null>>(
      `SELECT DISTINCT r.id AS run_id, r.session_id AS session_id, s.project_id AS project_id,
              s.directory AS directory, r.rowid AS seq
       FROM tasks t
       JOIN runs r ON r.id = t.run_id
       JOIN sessions s ON s.id = r.session_id
       WHERE t.status IN ('ready','blocked','assigned')
       ${sessionId ? "AND r.session_id = ?" : ""}
       ORDER BY r.rowid ASC`,
      sessionId ? [sessionId] : [],
    );
    return rows.map((r) => ({
      runId: String(r.run_id),
      sessionId: String(r.session_id),
      projectId: String(r.project_id),
      sessionDir: String(r.directory),
      seq: Number(r.seq),
    }));
  }

  private async fairOrder(runs: EligibleRun[]): Promise<EligibleRun[]> {
    if (runs.length === 0) return runs;
    const bySession = new Map<string, EligibleRun[]>();
    for (const r of runs) {
      const list = bySession.get(r.sessionId) ?? [];
      list.push(r);
      bySession.set(r.sessionId, list);
    }
    const out: EligibleRun[] = [];
    for (const [sessionId, list] of bySession) {
      const cursor = await this.tasks().fairnessCursor(sessionId);
      const sorted = [...list].sort((a, b) => a.seq - b.seq);
      const idx = cursor ? sorted.findIndex((r) => r.runId === cursor) : -1;
      const rotated = idx < 0 ? sorted : [...sorted.slice(idx + 1), ...sorted.slice(0, idx + 1)];
      out.push(...rotated);
    }
    return out;
  }

  /** 5. Tasks listas: ready + blocked re-evaluables, en orden determinista. */
  private async readyTasks(runId: string): Promise<Task[]> {
    const tasks = await this.tasks().listTasks({ runId });
    const raw = await this.db.query<{ task_id: string; depends_on: string; kind: string }>("SELECT * FROM task_dependencies");
    const mine = new Set(tasks.map((t) => t.id));
    const deps = raw.filter((d) => mine.has(d.task_id)).map((d) => ({ taskId: d.task_id, dependsOn: d.depends_on }));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const out: Task[] = [];
    for (const task of tasks) {
      if (task.status === "ready") {
        if (await this.dependenciesSatisfied(task, byId, deps)) out.push(task);
        else await this.tasks().setStatus(task.id, "blocked", { reason: "waiting-deps", details: { missing: this.missingDeps(task, byId, deps) } });
      } else if (task.status === "blocked") {
        const reason = task.blockedReason;
        if (reason === "waiting-deps") {
          if (await this.dependenciesSatisfied(task, byId, deps)) {
            await this.tasks().setStatus(task.id, "ready");
            out.push({ ...task, status: "ready" });
          }
        } else if (reason === "waiting-review-target") {
          const target = task.reviewTargetTaskId ? byId.get(task.reviewTargetTaskId) : undefined;
          if (target?.status === "completed") {
            await this.tasks().setStatus(task.id, "ready");
            out.push({ ...task, status: "ready" });
          }
        } else if (reason === "no-workspace") {
          if (await this.workspaceResolvable(task)) {
            await this.tasks().setStatus(task.id, "ready");
            out.push({ ...task, status: "ready" });
          }
        } else if (reason === "no-capacity") {
          out.push(task); // reintenta adquisición abajo
        } else if (reason === "no-repository" || reason === "repo-blocked" || reason === "deps-unavailable") {
          out.push(task); // entorno/dependencias pueden haber cambiado; re-resuelve abajo
        }
      }
    }
    return orderTasks(out);
  }

  private missingDeps(task: Task, byId: Map<string, Task>, deps: Array<{ taskId: string; dependsOn: string }>): string[] {
    const missing: string[] = [];
    for (const d of deps.filter((x) => x.taskId === task.id)) {
      const dep = byId.get(d.dependsOn);
      if (!dep || !isDependencySatisfied(dep.status, dep.needsReview)) missing.push(d.dependsOn);
    }
    return missing;
  }

  private async dependenciesSatisfied(task: Task, byId: Map<string, Task>, deps: Array<{ taskId: string; dependsOn: string }>): Promise<boolean> {
    return this.missingDeps(task, byId, deps).length === 0;
  }

  private async workspaceResolvable(task: Task): Promise<boolean> {
    if (task.agentRole !== "implementer") return true;
    if (task.writeScope.length === 0) return false;
    try {
      const session = await this.db.queryOne<{ directory: string; project_id: string }>(
        "SELECT s.directory AS directory, s.project_id AS project_id FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ?",
        [task.runId],
      );
      if (!session) return false;
      const isolated = await this.directories.list(session.project_id);
      const roots = [session.directory, ...isolated.map((d) => d.realPath)];
      for (const scope of task.writeScope) {
        const canon = canonicalizeScope(scope, session.directory);
        const ok = roots.some((r) => {
          try {
            return sameOrInside(realpathSync(r), canon);
          } catch {
            return false;
          }
        });
        if (!ok) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Workspace de escritura: worktree gestionado si hay repo git, legacy si no. */
  private async ensureWorkspace(
    run: EligibleRun,
    task: Task,
  ): Promise<
    | { ok: true; worktreeId?: string; path?: string }
    | { ok: false; blockedReason: "no-repository" | "repo-blocked" | "deps-unavailable" | "no-capacity"; details: Record<string, unknown> }
  > {
    const wt = this.worktrees?.();
    if (!wt) return { ok: true };
    const ensured = await wt.ensureForTask({ projectId: run.projectId, runId: run.runId, taskId: task.id, attempt: task.attempt + 1 });
    if (!ensured.ok) {
      if (ensured.blockedReason === "no-repository") return { ok: true };
      return { ok: false, blockedReason: ensured.blockedReason, details: ensured.details };
    }
    return { ok: true, worktreeId: ensured.worktreeId, path: ensured.path };
  }

  /** Intento de asignación atómica (pasos 3–8). Devuelve null si queda bloqueada. */
  private async tryAssign(run: EligibleRun, task: Task): Promise<Assignment | null> {
    const tm = this.tasks();
    // Reviewer: gate por target completed.
    if (task.agentRole === "reviewer" && task.reviewTargetTaskId) {
      const target = await tm.getTask(task.reviewTargetTaskId).catch(() => undefined);
      if (!target || target.status !== "completed") {
        if (task.status !== "blocked" || task.blockedReason !== "waiting-review-target") {
          await tm.setStatus(task.id, "blocked", { reason: "waiting-review-target", details: { target: task.reviewTargetTaskId } });
        }
        return null;
      }
    }
    // 4. Perfil delegable por el coordinador.
    const coordDef = await this.registry.get("coordinator-build");
    if (!coordDef || !coordDef.canDelegateTo.includes(task.agentRole)) {
      await tm.setStatus(task.id, "blocked", { reason: "needs-approval", details: { reason: `coordinator cannot delegate to ${task.agentRole}` } });
      return null;
    }
    // Reviewer: lee el worktree del target (P2). Sin worktree (legacy) usa el workspace.
    let reviewTargetWorktreeId: string | undefined;
    if (task.agentRole === "reviewer" && task.reviewTargetTaskId && this.worktrees) {
      const targetWt = await this.worktrees().getByTask(task.reviewTargetTaskId).catch(() => undefined);
      if (targetWt && ["assigned", "running", "suspended", "available", "finished"].includes(targetWt.status)) {
        reviewTargetWorktreeId = targetWt.id;
      }
    }
    // 10b. Sin doble intento activo.
    const activeAttempt = await this.db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM task_attempts WHERE task_id = ? AND status IN ('pending','running')", [task.id]);
    if ((activeAttempt?.n ?? 0) > 0) return null;
    if (task.attempt >= this.getSchedulerConfig().maxAttemptsPerTask) {
      await tm.setStatus(task.id, "blocked", { reason: "no-capacity", details: { reason: "max attempts exhausted, explicit retry required" } });
      return null;
    }
    // 5/6. Límites: globales + rol (conteo de instancias activas).
    if (!(await this.checkLimits(run, task))) {
      await tm.setStatus(task.id, "blocked", { reason: "no-capacity", details: { reason: "concurrency limits reached" } });
      return null;
    }
    // 7. Workspace para escritores: worktree automático si el proyecto es git (Etapa 4),
    // camino legacy (directorios registrados) si no lo es.
    let directoryId: string | undefined;
    let scopes: string[] = [];
    let worktreeId: string | undefined;
    if (task.agentRole === "implementer") {
      const ensured = await this.ensureWorkspace(run, task);
      if (!ensured.ok) {
        const reason = ensured.blockedReason === "no-repository" || ensured.blockedReason === "repo-blocked" || ensured.blockedReason === "deps-unavailable"
          ? ensured.blockedReason
          : "no-capacity";
        await tm.setStatus(task.id, "blocked", { reason, details: ensured.details });
        return null;
      }
      if (ensured.worktreeId && ensured.path) {
        worktreeId = ensured.worktreeId;
        scopes = [ensured.path];
        directoryId = undefined;
      } else {
        if (!(await this.workspaceResolvable(task))) {
          await tm.setStatus(task.id, "blocked", { reason: "no-workspace", details: { writeScope: task.writeScope } });
          return null;
        }
        scopes = task.writeScope.map((s) => canonicalizeScope(s, run.sessionDir));
        directoryId = await this.resolveDirectoryId(run.projectId, run.sessionDir, scopes);
      }
    }
    // Reservas atómicas: slots + scopes (todo o nada, sin transacciones largas).
    const reservationId = createId("rsv");
    const timestamp = now();
    const reservationRows: Array<{ kind: string; key: string }> = [
      { kind: "slot-session", key: run.sessionId },
      { kind: "slot-project", key: run.projectId },
      { kind: "slot-role", key: task.agentRole },
      ...scopes.map((s) => ({ kind: "scope-write", key: s })),
    ];
    // 6b. Exclusividad de escritura: igualdad y solape padre/hijo contra reservas activas.
    if (scopes.length > 0) {
      const existing = await this.db.query<{ resource_key: string }>("SELECT resource_key FROM scheduler_reservations WHERE kind = 'scope-write'");
      for (const scope of scopes) {
        for (const row of existing) {
          if (scopesOverlap(scope, String(row.resource_key))) {
            await tm.setStatus(task.id, "blocked", { reason: "no-capacity", details: { reason: "write scope overlapped", scope, conflicting: String(row.resource_key) } });
            return null;
          }
        }
      }
    }
    try {
      await this.db.batch([
        ...reservationRows.map((r, i) => ({
          sql: "INSERT INTO scheduler_reservations (id, kind, resource_key, session_id, project_id, task_id, attempt, acquired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          params: [`${reservationId}_${i}`, r.kind, r.key, run.sessionId, run.projectId, task.id, task.attempt + 1, timestamp] as Array<string | number>,
        })),
        { sql: "UPDATE tasks SET status = 'assigned', blocked_reason = NULL, blocked_details = NULL, updated_at = ? WHERE id = ? AND status IN ('ready','blocked')", params: [timestamp, task.id] as Array<string | number> },
        { sql: "UPDATE runs SET status = 'executing', updated_at = ? WHERE id = ? AND status = 'planning'", params: [timestamp, run.runId] as Array<string | number> },
      ]);
    } catch (error) {
      // Carrera (índice exacto) u otra condición: bloquea sin duplicar.
      await tm.setStatus(task.id, "blocked", { reason: "no-capacity", details: { reason: errorMessage(error).slice(0, 300) } }).catch(() => undefined);
      return null;
    }
    await tm.setFairnessCursor(run.sessionId, run.runId);
    const assignedEvent = await this.events.append({ type: "scheduler.assigned", aggregate: { kind: "scheduler", id: run.sessionId }, correlationId: createId("cor"), payload: { taskId: task.id, runId: run.runId } });
    this.bus.publish(assignedEvent);

    // 8. Runtime: spawn en background como hijo del coordinador del run.
    const coord = await this.requireCoordinatorInstance(run.runId);
    const brief = this.renderBrief(task);
    try {
      const spawned = await this.agents().spawn({
        parentInstanceId: coord,
        definitionId: task.agentRole,
        brief,
        mode: "background",
        directoryId,
        taskId: task.id,
        worktreeId: worktreeId ?? reviewTargetWorktreeId,
        reviewTargetTaskId: task.agentRole === "reviewer" ? task.reviewTargetTaskId : undefined,
      });
      const attempt = await tm.startAttempt(task.id, spawned.instanceId);
      await this.db.exec("UPDATE scheduler_reservations SET instance_id = ? WHERE task_id = ? AND attempt = ?", [spawned.instanceId, task.id, attempt]);
      // markRunning solo para el worktree propio (el reviewer lee el del target sin tomarlo).
      if (worktreeId && this.worktrees) {
        await this.worktrees().markRunning(worktreeId, spawned.instanceId).catch(() => undefined);
      }
      return { taskId: task.id, runId: run.runId, instanceId: spawned.instanceId, attempt, definitionId: task.agentRole, directoryId };
    } catch (error) {
      await this.releaseReservations(task.id, "spawn-failed");
      const code = error instanceof Error && "code" in error ? String((error as { code: string }).code) : "";
      if (code === "concurrency_limit" || code === "scope_conflict") {
        await tm.setStatus(task.id, "blocked", { reason: "no-capacity", details: { reason: errorMessage(error).slice(0, 300) } }).catch(() => undefined);
      } else {
        const msg = errorMessage(error).slice(0, 2000);
        // Si el spawn murió antes de crear el intento no hay nada que completar:
        // marcar failed directamente en vez de dejar la task atascada en assigned.
        await tm.completeAttempt(task.id, "failed", { errorCode: code || "spawn_failed", errorMessage: msg }).catch(() => tm.failUnstarted(task.id, msg));
      }
      return null;
    }
  }

  private async checkLimits(run: EligibleRun, task: Task): Promise<boolean> {
    const ACTIVE = "('created','running','waiting_permission','waiting_input')";
    const global = this.getGlobalLimits();
    const sessionCount = await this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM agent_instances WHERE session_id = ? AND status IN ${ACTIVE}`, [run.sessionId]);
    if ((sessionCount?.n ?? 0) >= global.maxPerSession) return false;
    const projectCount = await this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agent_instances i JOIN sessions s ON s.id = i.session_id WHERE s.project_id = ? AND i.status IN ${ACTIVE}`,
      [run.projectId],
    );
    if ((projectCount?.n ?? 0) >= global.maxPerProject) return false;
    // Rol: lectores = explorer+researcher.
    const role = this.getRoleLimits();
    const counts = await this.db.query<{ kind: string; n: number }>(
      `SELECT d.kind AS kind, COUNT(*) AS n FROM agent_instances i
       JOIN agent_definitions d ON d.id = i.definition_id
       WHERE i.session_id = ? AND i.status IN ${ACTIVE} GROUP BY d.kind`,
      [run.sessionId],
    );
    const byKind = new Map(counts.map((r) => [String(r.kind), Number(r.n)]));
    const readers = (byKind.get("explorer") ?? 0) + (byKind.get("researcher") ?? 0);
    if (task.agentRole === "implementer" && (byKind.get("implementer") ?? 0) >= role.maxImplementers) return false;
    if ((task.agentRole === "explorer" || task.agentRole === "researcher") && readers >= role.maxReaders) return false;
    if (task.agentRole === "reviewer" && (byKind.get("reviewer") ?? 0) >= role.maxReviewers) return false;
    return true;
  }

  private async resolveDirectoryId(projectId: string, sessionDir: string, scopes: string[]): Promise<string | undefined> {
    if (scopes.length === 0) return undefined;
    const isolated = await this.directories.list(projectId);
    // Directorio registrado más interno que contenga el primer scope.
    let best: { id: string; len: number } | undefined;
    for (const dir of isolated) {
      let real = dir.realPath;
      try {
        real = realpathSync(dir.realPath);
      } catch {
        // usa el registrado tal cual
      }
      if (sameOrInside(real, scopes[0]!)) {
        if (!best || real.length > best.len) best = { id: dir.id, len: real.length };
      }
    }
    void sessionDir;
    return best?.id;
  }

  private renderBrief(task: Task): string {
    return `Task: ${task.title}\n${task.description}\nAcceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}${task.writeScope.length > 0 ? `\nWrite only inside: ${task.writeScope.join(", ")}` : ""}${task.validationCommands.length > 0 ? `\nValidate with allowlisted commands: ${task.validationCommands.join(", ")}` : ""}`;
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

  /** 9–10. Supervisa ejecuciones: registra resultado, libera reservas, marca runs. Devuelve true si completó algún intento (hay trabajo nuevo que despertar). */
  private async supervise(sessionId?: string): Promise<boolean> {
    let progressed = false;
    const rows = await this.db.query<Record<string, string | number | null>>(
      `SELECT t.* FROM tasks t JOIN runs r ON r.id = t.run_id
       WHERE t.status = 'running' ${sessionId ? "AND r.session_id = ?" : ""}`,
      sessionId ? [sessionId] : [],
    );
    for (const row of rows) {
      const task = deserializeTask(row);
      const attempt = await this.db.queryOne<Record<string, string | number | null>>(
        "SELECT * FROM task_attempts WHERE task_id = ? AND status IN ('pending','running') ORDER BY attempt DESC LIMIT 1",
        [task.id],
      );
      if (!attempt || !attempt.instance_id) continue;
      const instanceId = String(attempt.instance_id);
      const inst = await this.db.queryOne<{ status: string; error: string | null }>("SELECT status, error FROM agent_instances WHERE id = ?", [instanceId]);
      if (!inst || ["created", "running", "waiting_permission", "waiting_input"].includes(inst.status)) continue;
      if (inst.status === "completed" || inst.status === "failed" || inst.status === "cancelled") {
        let summary = "";
        let deliveryError: string | undefined;
        try {
          const delivery = await this.agents().result(instanceId);
          summary = delivery.summary;
          deliveryError = delivery.error;
        } catch {
          summary = "";
        }
        const terminal = inst.status as "completed" | "failed" | "cancelled";
        const message = deliveryError ?? inst.error ?? undefined;
        await this.tasks().completeAttempt(task.id, terminal, {
          summary: summary || `(agent ${terminal})`,
          errorCode: terminal === "completed" ? undefined : "agent_failed",
          errorMessage: message?.slice(0, 2000),
        });
        progressed = true;
        // Commit harness del implementer (Etapa 4): fija produced_commit antes de liberar.
        if (task.agentRole === "implementer" && terminal === "completed" && this.worktrees) {
          try {
            const assignment = await this.worktrees().getByTask(task.id);
            if (assignment) {
              const sess = await this.db.queryOne<{ directory: string }>(
                "SELECT s.directory AS directory FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ?",
                [task.runId],
              );
              await this.worktrees().commitTaskWork(assignment.id, {
                scopes: task.writeScope,
                sessionDir: sess ? String(sess.directory) : "",
                message: `harness: task ${task.id} attempt ${attempt.attempt ?? "?"} (run ${task.runId})`,
              });
              await this.worktrees().markFinished(assignment.id);
            }
          } catch (err) {
            // Auditar sin tumbar el run: el error queda en la fila del worktree.
            const msg = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
            await this.db.exec("UPDATE worktrees SET error = ?, updated_at = ? WHERE task_id = ?", [msg, now(), task.id]).catch(() => undefined);
          }
        } else if (task.agentRole === "implementer" && terminal !== "completed" && this.worktrees) {
          // Fallo/cancelación: liberar para reintento (conserva parciales).
          const assignment = await this.worktrees().getByTask(task.id).catch(() => undefined);
          if (assignment) await this.worktrees().releaseWorktree(assignment.id, `attempt-${terminal}`).catch(() => undefined);
        }
        await this.releaseReservations(task.id, `attempt-${terminal}`);
        if (task.agentRole === "reviewer" && terminal === "completed") {
          await this.tasks().recordProgress(task.id, "result", "Review delivery ready; awaiting explicit recordReview verdict.");
        }
        await this.finishRunIfDone(task.runId);
      }
    }
    return progressed;
  }

  private async releaseReservations(taskId: string, reason: string): Promise<void> {
    const rows = await this.db.query<{ id: string }>("SELECT id FROM scheduler_reservations WHERE task_id = ?", [taskId]);
    for (const r of rows) {
      await this.db.exec("DELETE FROM scheduler_reservations WHERE id = ?", [r.id]);
      const event = await this.events.append({ type: "reservation.released", aggregate: { kind: "reservation", id: r.id }, correlationId: createId("cor"), payload: { taskId, reason } });
      this.bus.publish(event);
    }
  }

  private async finishRunIfDone(runId: string): Promise<void> {
    const tasks = await this.tasks().listTasks({ runId });
    if (tasks.length === 0) return;
    const maxAttempts = this.getSchedulerConfig().maxAttemptsPerTask;
    const open = tasks.filter(
      (t) => !["completed", "reviewed", "cancelled"].includes(t.status) && !(t.status === "failed" && t.attempt >= maxAttempts),
    );
    if (open.length > 0) return;
    const failed = tasks.some((t) => t.status === "failed");
    const timestamp = now();
    await this.db.exec("UPDATE runs SET status = ?, updated_at = ?, completed_at = ? WHERE id = ? AND status IN ('planning','executing')", [
      failed ? "failed" : "done",
      timestamp,
      timestamp,
      runId,
    ]);
    const event = await this.events.append({
      type: failed ? "run.failed" : "run.completed",
      aggregate: { kind: "run", id: runId },
      correlationId: createId("cor"),
      payload: { tasks: tasks.length },
    });
    this.bus.publish(event);
  }

  /** Reconciliación post-reinicio (la llama OctusCore.settleInterrupted). */
  async reconcile(): Promise<{ interrupted: number; released: number }> {
    return this.tasks().reconcile();
  }
}
