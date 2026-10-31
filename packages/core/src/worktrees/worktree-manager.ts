/**
 * @octus/core — WorktreeManager: administración automática de ramas y Git Worktrees (Etapa 4).
 * Determinista, sin modelos. El Scheduler solicita espacios; el manager provisiona
 * worktrees desde HEAD o desde el produced_commit del writer-predecesor, con
 * journal persistente de operaciones y reconciliación post-reinicio.
 *
 * Invariantes:
 * - Un worktree por task (UNIQUE(task_id)); reintentos reutilizan, nunca duplican.
 * - Ramas `harness/run-<runId>/task-<taskId>` (+ sufijo -rN ante colisión ajena).
 * - Paths planos bajo worktrees_root: `<root>/<taskId>/` (seguro en Windows).
 * - Cero auto-borrado: la limpieza es explícita del usuario con guardas.
 * - Las ramas con trabajo producido se conservan para la Etapa 5.
 */
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { createId, type Task, type Worktree, type WorktreeOperation, type WorktreeStatus } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { isUncPath, sameOrInside } from "../tools/path-scope.js";
import { now } from "../util.js";
import { RepositoryManager } from "../repositories/repository-manager.js";
import { assertValidBranchName, resolveCommitSha, runGit } from "../repositories/git-exec.js";
import type { WorktreeAssignment, WorktreePort } from "./worktree-port.js";

export interface EnsureInput {
  projectId: string;
  runId: string;
  taskId: string;
  attempt: number;
}

export type EnsureResult =
  | { ok: true; worktreeId: string; path: string; branch: string; baseCommit: string; reused: boolean }
  | { ok: false; blockedReason: "no-repository" | "repo-blocked" | "deps-unavailable" | "no-capacity"; details: Record<string, unknown> };

const ACTIVE_STATES: WorktreeStatus[] = ["provisioning", "available", "assigned", "running", "suspended", "cleanup_pending"];
const TERMINAL_KEPT: WorktreeStatus[] = ["finished", "retained", "removed", "orphaned"];

export class WorktreeManager implements WorktreePort {
  constructor(
    private readonly db: PersistenceService,
    private readonly events: EventStore,
    private readonly bus: EventBus,
    private readonly repos: RepositoryManager,
    private readonly dataDir: string,
  ) {}

  // ------------------------------------------------------------------ puerto
  async getAssignment(worktreeId: string): Promise<WorktreeAssignment | undefined> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM worktrees WHERE id = ?", [worktreeId]);
    if (!row) return undefined;
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      taskId: String(row.task_id ?? ""),
      path: String(row.canonical_path),
      branch: String(row.branch_name),
      baseCommit: String(row.base_commit),
      status: row.status as WorktreeStatus,
    };
  }

  async getWorktree(id: string): Promise<Worktree> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM worktrees WHERE id = ?", [id]);
    if (!row) throw new OctusError("not_found", `Worktree not found: ${id}`);
    return deserializeWorktree(row);
  }

  async getByTask(taskId: string): Promise<Worktree | undefined> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM worktrees WHERE task_id = ?", [taskId]);
    return row ? deserializeWorktree(row) : undefined;
  }

  async listProjectWorktrees(projectId: string): Promise<Worktree[]> {
    const rows = await this.db.query<Record<string, string | number | null>>("SELECT * FROM worktrees WHERE project_id = ? ORDER BY created_at ASC", [projectId]);
    return rows.map(deserializeWorktree);
  }

  async listTaskWorktrees(taskId: string): Promise<Worktree[]> {
    const row = await this.getByTask(taskId);
    return row ? [row] : [];
  }

  async listOperations(worktreeId: string): Promise<WorktreeOperation[]> {
    const rows = await this.db.query<Record<string, string | number | null>>("SELECT * FROM worktree_ops WHERE worktree_id = ? ORDER BY created_at ASC", [worktreeId]);
    return rows.map(deserializeOp);
  }

  // ------------------------------------------------------- raíz administrada
  defaultWorktreesRoot(projectId: string): string {
    return path.join(this.dataDir, "..", "octus-worktrees", projectId);
  }

  /**
   * Fija la raíz administrada del proyecto (P3). Validada por ruta canónica:
   * absoluta, no UNC, fuera del repo, fuera de dataDir. Solo sin worktrees activos.
   */
  async setWorktreesRoot(projectId: string, rawPath: string): Promise<string> {
    if (!path.isAbsolute(rawPath)) throw new OctusError("invalid_tool_args", "Worktrees root must be an absolute path");
    // UNC denegadas antes de tocar el FS (nunca intentar mkdir en red).
    if (isUncPath(rawPath)) throw new OctusError("scope_violation", "UNC paths are not allowed for worktrees root");
    const project = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM projects WHERE id = ?", [projectId]);
    if (!project) throw new OctusError("not_found", `Project not found: ${projectId}`);
    mkdirSync(rawPath, { recursive: true });
    const canon = realpathSync(rawPath);
    const dataReal = realpathSync(this.dataDir);
    if (sameOrInside(dataReal, canon)) {
      throw new OctusError("scope_violation", "Worktrees root must stay outside Octus dataDir");
    }
    let repoRoot: string | undefined;
    try {
      repoRoot = await this.repoRootOf(String(project.root_path));
    } catch {
      // Proyecto no-git: sin restricción de repo.
      repoRoot = undefined;
    }
    if (repoRoot && sameOrInside(repoRoot, canon)) {
      throw new OctusError("scope_violation", "Worktrees root must stay outside the repository");
    }
    const active = await this.db.queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM worktrees WHERE project_id = ? AND status IN ('provisioning','available','assigned','running','suspended','cleanup_pending')",
      [projectId],
    );
    if ((active?.n ?? 0) > 0) {
      throw new OctusError("invalid_state", "Cannot change worktrees root while the project has active worktrees");
    }
    const projectRoot = this.safeReal(String(project.root_path));
    await this.repos.ensureRepositoryRow(projectId, projectRoot ?? String(project.root_path), canon);
    return canon;
  }

  /** Raíz efectiva: la configurada o el default hermano de dataDir (P3). */
  async effectiveWorktreesRoot(projectId: string): Promise<string> {
    const row = await this.db.queryOne<{ worktrees_root: string }>("SELECT worktrees_root FROM repositories WHERE project_id = ?", [projectId]);
    if (row?.worktrees_root) return String(row.worktrees_root);
    const def = this.defaultWorktreesRoot(projectId);
    mkdirSync(def, { recursive: true });
    return realpathSync(def);
  }

  // ------------------------------------------------------- aprovisionamiento
  /**
   * Punto de entrada del Scheduler: devuelve el espacio para (task, attempt).
   * Idempotente por UNIQUE(task_id): re-solicitar devuelve el mismo worktree.
   * No crea ramas/worktrees duplicados; nunca lanza.
   */
  async ensureForTask(input: EnsureInput): Promise<EnsureResult> {
    const existing = await this.getByTask(input.taskId);
    if (existing) {
      if (existing.status === "removed") {
        // Fila de una limpieza explícita anterior: provisionar de nuevo es seguro.
        await this.db.exec("DELETE FROM worktrees WHERE id = ?", [existing.id]);
      } else if (existing.status === "orphaned") {
        const adopted = await this.adoptOrReap(existing);
        if (!adopted.ok) return adopted;
        return { ok: true, worktreeId: existing.id, path: existing.canonicalPath, branch: existing.branchName, baseCommit: existing.baseCommit, reused: true };
      } else {
        await this.db.exec("UPDATE worktrees SET status = 'assigned', attempt = ?, updated_at = ? WHERE id = ? AND status IN ('finished','retained','available','suspended')", [
          input.attempt,
          now(),
          existing.id,
        ]);
        return { ok: true, worktreeId: existing.id, path: existing.canonicalPath, branch: existing.branchName, baseCommit: existing.baseCommit, reused: true };
      }
    }

    // Proyecto git o camino legacy (Etapa 3): sin repo no hay worktrees.
    const project = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM projects WHERE id = ?", [input.projectId]);
    if (!project) throw new OctusError("not_found", `Project not found: ${input.projectId}`);
    let repoRoot: string;
    try {
      repoRoot = await this.repoRootOf(String(project.root_path));
    } catch {
      return { ok: false, blockedReason: "no-repository", details: { reason: "project is not inside a git repository; register an isolated directory (legacy path)" } };
    }
    try {
      await this.repos.validateRepository(repoRoot);
    } catch (error) {
      return { ok: false, blockedReason: "repo-blocked", details: { reason: error instanceof Error ? error.message.slice(0, 500) : String(error) } };
    }
    const repoId = await this.repos.ensureRepositoryRow(input.projectId, repoRoot, await this.effectiveWorktreesRoot(input.projectId));

    // Base: HEAD o produced_commit del único writer-predecesor (§G).
    const base = await this.resolveBase(input.taskId, repoRoot);
    if (!base.ok) return base;

    // Rama segura desde IDs internos + path plano por taskId.
    const branch = await this.uniqueBranchName(repoRoot, repoId, input.runId, input.taskId);
    const root = await this.effectiveWorktreesRoot(input.projectId);
    const candidate = path.join(root, input.taskId);
    if (isUncPath(candidate)) {
      return { ok: false, blockedReason: "no-capacity", details: { reason: "worktrees root resolves to UNC" } };
    }

    const worktreeId = createId("wt");
    const timestamp = now();
    const opId = createId("wop");
    const dirty = await this.repos.getStatus(repoRoot).catch(() => ({ staged: 0, unstaged: 0, untracked: 0 }));
    const dirtySummary = dirty.staged + dirty.unstaged + dirty.untracked > 0 ? `staged=${dirty.staged} unstaged=${dirty.unstaged} untracked=${dirty.untracked} (created from HEAD; local changes NOT included)` : undefined;
    try {
      await this.db.batch([
        {
          sql: "INSERT INTO worktrees (id, project_id, repository_id, run_id, task_id, branch_name, base_commit, base_source, canonical_path, status, attempt, dirty_excluded, dirty_summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?)",
          params: [
            worktreeId,
            input.projectId,
            repoId,
            input.runId,
            input.taskId,
            branch,
            base.sha,
            base.source,
            candidate,
            input.attempt,
            dirtySummary ? 1 : 0,
            dirtySummary ?? null,
            timestamp,
            timestamp,
          ],
        },
        {
          sql: "INSERT INTO worktree_ops (id, worktree_id, task_id, op, status, step, created_at, updated_at) VALUES (?, ?, ?, 'provision', 'started', 'begin', ?, ?)",
          params: [opId, worktreeId, input.taskId, timestamp, timestamp],
        },
      ]);
    } catch (error) {
      // Carrera: otro tick provisionó primero (UNIQUE(task_id)) → reutilizar.
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        const winner = await this.getByTask(input.taskId);
        if (winner) {
          return { ok: true, worktreeId: winner.id, path: winner.canonicalPath, branch: winner.branchName, baseCommit: winner.baseCommit, reused: true };
        }
      }
      throw error;
    }
    try {
      await this.opStep(opId, "git worktree add", `branch ${branch} at ${base.sha.slice(0, 12)}`);
      await runGit(repoRoot, ["worktree", "add", "-b", branch, candidate, base.sha]);
      await this.validateFreshWorktree(repoRoot, candidate, base.sha);
      const real = realpathSync(candidate);
      await this.db.batch([
        { sql: "UPDATE worktrees SET canonical_path = ?, status = 'assigned', error = NULL, updated_at = ? WHERE id = ?", params: [real, now(), worktreeId] },
        {
          sql: "INSERT INTO managed_branches (repository_id, branch_name, worktree_id, base_commit, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?) ON CONFLICT(repository_id, branch_name) DO UPDATE SET worktree_id = excluded.worktree_id, base_commit = excluded.base_commit, status = 'active', updated_at = excluded.updated_at",
          params: [repoId, branch, worktreeId, base.sha, now(), now()],
        },
        { sql: "UPDATE worktree_ops SET status = 'done', step = 'created', updated_at = ? WHERE id = ?", params: [now(), opId] },
      ]);
      const event = await this.events.append({ type: "worktree.created", aggregate: { kind: "worktree", id: worktreeId }, correlationId: createId("cor"), payload: { taskId: input.taskId, runId: input.runId, branch, baseCommit: base.sha, path: real } });
      this.bus.publish(event);
      return { ok: true, worktreeId, path: real, branch, baseCommit: base.sha, reused: false };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.db.exec("UPDATE worktree_ops SET status = 'failed', step = 'git failed', detail = ?, updated_at = ? WHERE id = ?", [msg.slice(0, 2000), now(), opId]);
      await this.db.exec("UPDATE worktrees SET status = 'orphaned', error = ?, updated_at = ? WHERE id = ?", [msg.slice(0, 2000), now(), worktreeId]);
      // Best-effort: retirar el worktree a medias para no dejar basura física.
      try {
        await runGit(repoRoot, ["worktree", "remove", "--force", candidate]);
      } catch {
        // queda registrado como orphaned para reconcile
      }
      return { ok: false, blockedReason: "no-capacity", details: { reason: `worktree provisioning failed (recoverable on retry): ${msg.slice(0, 300)}` } };
    }
  }

  /** Marca en ejecución con la instancia asignada (tras spawn OK del Scheduler). */
  async markRunning(worktreeId: string, instanceId: string): Promise<void> {
    const wt = await this.getWorktree(worktreeId);
    if (!["assigned", "available", "suspended"].includes(wt.status)) {
      throw new OctusError("invalid_state", `Worktree ${worktreeId} is ${wt.status}, cannot mark running`);
    }
    const timestamp = now();
    await this.db.batch([
      { sql: "UPDATE worktrees SET status = 'running', instance_id = ?, updated_at = ? WHERE id = ?", params: [instanceId, timestamp, worktreeId] },
      { sql: "UPDATE agent_instances SET worktree_id = ? WHERE id = ?", params: [worktreeId, instanceId] },
    ]);
    const event = await this.events.append({ type: "worktree.status_changed", aggregate: { kind: "worktree", id: worktreeId }, correlationId: createId("cor"), payload: { from: wt.status, to: "running", instanceId } });
    this.bus.publish(event);
  }

  /** Vuelta a disponible sin borrar nada (retención de parciales). */
  async releaseWorktree(worktreeId: string, reason = "released"): Promise<void> {
    const wt = await this.getWorktree(worktreeId);
    if (!["assigned", "running", "suspended"].includes(wt.status)) return;
    const active = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM agent_instances WHERE worktree_id = ? AND status IN ('created','running','waiting_permission','waiting_input') LIMIT 1`,
      [worktreeId],
    );
    if (active) throw new OctusError("invalid_state", `Worktree ${worktreeId} has an active agent and cannot be released`);
    const timestamp = now();
    await this.db.batch([
      { sql: "UPDATE worktrees SET status = 'available', instance_id = NULL, updated_at = ? WHERE id = ?", params: [timestamp, worktreeId] },
      { sql: "INSERT INTO worktree_ops (id, worktree_id, op, status, step, created_at, updated_at) VALUES (?, ?, 'release', 'done', ?, ?, ?)", params: [createId("wop"), worktreeId, reason.slice(0, 200), timestamp, timestamp] },
    ]);
    const event = await this.events.append({ type: "worktree.released", aggregate: { kind: "worktree", id: worktreeId }, correlationId: createId("cor"), payload: { from: wt.status, reason } });
    this.bus.publish(event);
  }

  /** Reutilización para reintentos: conserva parciales, no crea nada nuevo. */
  async recoverForRetry(taskId: string, attempt: number): Promise<EnsureResult> {
    const wt = await this.getByTask(taskId);
    if (!wt) {
      const task = await this.db.queryOne<{ run_id: string }>("SELECT run_id FROM tasks WHERE id = ?", [taskId]);
      if (!task) throw new OctusError("not_found", `Task not found: ${taskId}`);
      const run = await this.db.queryOne<{ session_id: string }>("SELECT session_id FROM runs WHERE id = ?", [String(task.run_id)]);
      const session = run ? await this.db.queryOne<{ project_id: string }>("SELECT project_id FROM sessions WHERE id = ?", [String(run.session_id)]) : undefined;
      if (!session) throw new OctusError("not_found", `Session for task not found: ${taskId}`);
      return this.ensureForTask({ projectId: String(session.project_id), runId: String(task.run_id), taskId, attempt });
    }
    if (["removed", "cleanup_pending"].includes(wt.status)) {
      // El anterior fue limpiado explícitamente: provisionar de nuevo es lo pedido.
      await this.db.exec("DELETE FROM worktrees WHERE id = ?", [wt.id]);
      const task = await this.db.queryOne<{ run_id: string }>("SELECT run_id FROM tasks WHERE id = ?", [taskId]);
      const run = task ? await this.db.queryOne<{ session_id: string }>("SELECT session_id FROM runs WHERE id = ?", [String(task.run_id)]) : undefined;
      const session = run ? await this.db.queryOne<{ project_id: string }>("SELECT project_id FROM sessions WHERE id = ?", [String(run.session_id)]) : undefined;
      if (!task || !session) throw new OctusError("not_found", `Task session not found: ${taskId}`);
      return this.ensureForTask({ projectId: String(session.project_id), runId: String(task.run_id), taskId, attempt });
    }
    await this.db.exec("UPDATE worktrees SET status = 'assigned', attempt = ?, error = NULL, updated_at = ? WHERE id = ?", [attempt, now(), wt.id]);
    return { ok: true, worktreeId: wt.id, path: wt.canonicalPath, branch: wt.branchName, baseCommit: wt.baseCommit, reused: true };
  }

  /**
   * Commit harness de lo producido por un implementer (lo invoca el Scheduler
   * al supervisar un attempt completed). Añade solo los scopes de la task,
   * con identidad fija y sin hooks. Si el árbol está limpio, produced = base
   * (sin commit vacío). Nunca modifica el repo principal.
   */
  async commitTaskWork(worktreeId: string, input: { scopes: string[]; sessionDir: string; message: string }): Promise<{ producedCommit: string; committed: boolean }> {
    const wt = await this.getWorktree(worktreeId);
    const root = await this.repoRootForWorktree(wt);
    const workReal = realpathSync(wt.canonicalPath);
    const rels: string[] = [];
    for (const scope of input.scopes) {
      const abs = scope.startsWith("/") || /^[A-Za-z]:[\\/]/.test(scope) ? scope : `${input.sessionDir}/${scope}`;
      let real = abs;
      try {
        real = realpathSync(abs);
      } catch {
        real = abs;
      }
      // El scope vive en el repo principal; su equivalente en el worktree es
      // la ruta relativa a la raíz del repo.
      const repoReal = realpathSync(root);
      if (!sameOrInside(repoReal, real)) {
        throw new OctusError("scope_violation", `Write scope is outside the repository: ${scope.slice(0, 200)}`);
      }
      const rel = path.relative(repoReal, real) || ".";
      const target = path.join(workReal, rel);
      if (!sameOrInside(workReal, target)) {
        throw new OctusError("scope_violation", `Write scope escapes the worktree: ${scope.slice(0, 200)}`);
      }
      rels.push(rel);
    }
    if (rels.length > 0) {
      await runGit(workReal, ["add", "--", ...rels]);
    }
    const porcelain = (await runGit(workReal, ["status", "--porcelain=v1"])).stdout.trim();
    if (!porcelain) {
      await this.recordProducedCommit(worktreeId, wt.baseCommit);
      return { producedCommit: wt.baseCommit, committed: false };
    }
    await runGit(workReal, ["-c", "user.name=Octus Harness", "-c", "user.email=octus-harness@localhost", "commit", "--no-verify", "-m", input.message.slice(0, 500)]);
    const sha = (await runGit(workReal, ["rev-parse", "HEAD"], { tries: 4 })).stdout.trim();
    await this.recordProducedCommit(worktreeId, sha);
    return { producedCommit: sha, committed: true };
  }

  /** Registra el commit producido por/hacia la task (commit harness del Scheduler). */
  async recordProducedCommit(worktreeId: string, sha: string): Promise<void> {    if (!/^[0-9a-f]{40}$/.test(sha)) throw new OctusError("invalid_tool_args", "produced_commit must be a full SHA");
    const wt = await this.getWorktree(worktreeId);
    const timestamp = now();
    await this.db.batch([
      { sql: "UPDATE worktrees SET produced_commit = ?, updated_at = ? WHERE id = ?", params: [sha, timestamp, worktreeId] },
      { sql: "UPDATE managed_branches SET produced_commit = ?, updated_at = ? WHERE repository_id = ? AND branch_name = ?", params: [sha, timestamp, wt.repositoryId, wt.branchName] },
    ]);
    const event = await this.events.append({ type: "worktree.status_changed", aggregate: { kind: "worktree", id: worktreeId }, correlationId: createId("cor"), payload: { producedCommit: sha } });
    this.bus.publish(event);
  }

  /** Marca finished reteniendo el espacio (auditoría + Etapa 5). La asignación se libera. */
  async markFinished(worktreeId: string): Promise<void> {
    const wt = await this.getWorktree(worktreeId);
    if (!["running", "assigned", "suspended", "available"].includes(wt.status)) return;
    const timestamp = now();
    await this.db.exec("UPDATE worktrees SET status = 'finished', instance_id = NULL, updated_at = ? WHERE id = ?", [timestamp, worktreeId]);
    const event = await this.events.append({ type: "worktree.status_changed", aggregate: { kind: "worktree", id: worktreeId }, correlationId: createId("cor"), payload: { from: wt.status, to: "finished" } });
    this.bus.publish(event);
  }

  // ---------------------------------------------------------------- inspección
  async inspectWorktree(worktreeId: string): Promise<{ worktree: Worktree; status: string; head: string; branch: string }> {
    const wt = await this.getWorktree(worktreeId);
    let status = "";
    let head = "";
    let branch = wt.branchName;
    try {
      status = (await runGit(wt.canonicalPath, ["status", "--porcelain=v1", "--branch"])).stdout.trim() || "(clean)";
      head = (await runGit(wt.canonicalPath, ["rev-parse", "HEAD"])).stdout.trim();
      branch = (await runGit(wt.canonicalPath, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    } catch (error) {
      throw new OctusError("not_found", `Worktree path not readable as git: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    }
    return { worktree: wt, status, head, branch };
  }

  async getWorktreeStatus(worktreeId: string): Promise<string> {
    return (await this.inspectWorktree(worktreeId)).status;
  }

  /** Diff acotado del worktree contra base (default: base_commit). Solo lectura. */
  async getWorktreeDiff(worktreeId: string, base?: string): Promise<string> {
    const wt = await this.getWorktree(worktreeId);
    const from = base ?? wt.baseCommit;
    if (!/^[0-9a-f]{40}$/.test(from)) throw new OctusError("invalid_tool_args", "base must be a full SHA");
    const { stdout } = await runGit(wt.canonicalPath, ["diff", "--no-color", "--no-ext-diff", "--stat", `${from}...HEAD`, "--"]);
    return stdout.slice(0, 60000) || "(no differences)";
  }

  async validateBranch(repoRoot: string, branch: string): Promise<void> {
    await assertValidBranchName(repoRoot, branch);
  }

  /** El worktree existe en git, la ruta es canónica, dentro de worktrees_root y fuera del workspace. */
  async validateWorktree(worktreeId: string): Promise<void> {
    const wt = await this.getWorktree(worktreeId);
    const repo = await this.repos.inspectRepository(wt.projectId).catch(() => undefined);
    const root = repo?.isGit ? repo.rootPath : undefined;
    if (root) {
      const listed = await this.repos.listWorktrees(root);
      if (!listed.some((e) => this.samePath(e.path, wt.canonicalPath))) {
        throw new OctusError("invalid_state", `Worktree ${worktreeId} is not registered in git`);
      }
    }
    const real = realpathSync(wt.canonicalPath);
    const workRoot = await this.effectiveWorktreesRoot(wt.projectId);
    if (!sameOrInside(realpathSync(workRoot), real)) {
      throw new OctusError("scope_violation", `Worktree ${worktreeId} is outside the managed worktrees root`);
    }
    if (root && sameOrInside(realpathSync(root), real)) {
      throw new OctusError("scope_violation", `Worktree ${worktreeId} is inside the main workspace`);
    }
    if (isUncPath(real)) throw new OctusError("scope_violation", "UNC paths are not allowed for worktrees");
  }

  // ------------------------------------------------------------------ limpieza
  /**
   * Limpieza explícita del usuario. Guardas: sin agentes activos, árbol limpio
   * (si sucio → rechazo con resumen, sin flag force en Etapa 4).
   * La rama se conserva salvo deleteBranch con tip==base.
   */
  async cleanupWorktree(worktreeId: string, opts?: { deleteBranch?: boolean }): Promise<{ removed: boolean; branchDeleted: boolean }> {
    const wt = await this.getWorktree(worktreeId);
    const active = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM agent_instances WHERE worktree_id = ? AND status IN ('created','running','waiting_permission','waiting_input') LIMIT 1`,
      [worktreeId],
    );
    if (active) throw new OctusError("invalid_state", `Worktree ${worktreeId} has an active agent and cannot be cleaned`);
    let porcelain = "";
    try {
      porcelain = (await runGit(wt.canonicalPath, ["status", "--porcelain=v1"])).stdout.trim();
    } catch {
      // Sin acceso git: tratar como huérfano físico (ver reconcile).
    }
    if (porcelain) {
      throw new OctusError("invalid_state", `Worktree ${worktreeId} has pending changes and is preserved (no destructive cleanup in Stage 4). Pending:\n${porcelain.slice(0, 1000)}`);
    }
    const timestamp = now();
    const opId = createId("wop");
    await this.db.exec("INSERT INTO worktree_ops (id, worktree_id, task_id, op, status, step, created_at, updated_at) VALUES (?, ?, ?, 'cleanup', 'started', 'begin', ?, ?)", [
      opId,
      worktreeId,
      wt.taskId,
      timestamp,
      timestamp,
    ]);
    await this.db.exec("UPDATE worktrees SET status = 'cleanup_pending', updated_at = ? WHERE id = ?", [timestamp, worktreeId]);
    try {
      const repo = await this.repoRootForWorktree(wt);
      await runGit(repo, ["worktree", "remove", wt.canonicalPath]);
      // Rama: conservar siempre salvo petición explícita con tip==base.
      let branchDeleted = false;
      if (opts?.deleteBranch) {
        const tip = await runGit(repo, ["rev-parse", wt.branchName]).then((r) => r.stdout.trim(), () => "");
        if (tip && tip === wt.baseCommit) {
          await runGit(repo, ["branch", "-d", wt.branchName]);
          await this.db.exec("UPDATE managed_branches SET status = 'removed', updated_at = ? WHERE repository_id = ? AND branch_name = ?", [now(), wt.repositoryId, wt.branchName]);
          branchDeleted = true;
        }
      }
      await this.db.batch([
        { sql: "UPDATE worktrees SET status = 'removed', instance_id = NULL, updated_at = ? WHERE id = ?", params: [now(), worktreeId] },
        { sql: "UPDATE worktree_ops SET status = 'done', step = 'removed', updated_at = ? WHERE id = ?", params: [now(), opId] },
      ]);
      const event = await this.events.append({ type: "worktree.removed", aggregate: { kind: "worktree", id: worktreeId }, correlationId: createId("cor"), payload: { branchDeleted } });
      this.bus.publish(event);
      return { removed: true, branchDeleted };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.db.exec("UPDATE worktree_ops SET status = 'failed', step = 'remove failed', detail = ?, updated_at = ? WHERE id = ?", [msg.slice(0, 2000), now(), opId]);
      await this.db.exec("UPDATE worktrees SET status = 'orphaned', error = ?, updated_at = ? WHERE id = ?", [msg.slice(0, 2000), now(), worktreeId]);
      throw new OctusError("tool_failed", `Worktree cleanup failed (marked orphaned for reconcile): ${msg.slice(0, 300)}`);
    }
  }

  // ------------------------------------------------------------- reconciliación
  /**
   * Post-reinicio (tras tasks.reconcile): resuelve ops 'started', suspende lo
   * asignado/en ejecución y barre huérfanos en ambas direcciones.
   * Nunca genera agentes (ADR-040).
   */
  async reconcile(): Promise<{ suspended: number; orphaned: number; resumed: number }> {
    let suspended = 0;
    let orphaned = 0;
    let resumed = 0;
    // 1. Ops 'started' sin terminal: la fuente de verdad es git + la fila.
    const pending = await this.db.query<Record<string, string | number | null>>("SELECT * FROM worktree_ops WHERE status = 'started' ORDER BY created_at ASC");
    for (const op of pending) {
      const opId = String(op.id);
      const wtId = op.worktree_id ? String(op.worktree_id) : undefined;
      const wt = wtId ? await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM worktrees WHERE id = ?", [wtId]).catch(() => null) : null;
      if (!wt) {
        await this.db.exec("UPDATE worktree_ops SET status = 'failed', step = 'row gone', updated_at = ? WHERE id = ?", [now(), opId]);
        continue;
      }
      const path = String(wt.canonical_path);
      const physical = await this.physicalWorktreeExists(String(wt.project_id), path);
      if (String(wt.status) === "provisioning") {
        if (physical) {
          await this.db.batch([
            { sql: "UPDATE worktrees SET status = 'available', updated_at = ? WHERE id = ?", params: [now(), String(wt.id)] },
            { sql: "UPDATE worktree_ops SET status = 'done', step = 'reconciled-existing', updated_at = ? WHERE id = ?", params: [now(), opId] },
          ]);
          resumed++;
        } else {
          await this.db.batch([
            { sql: "UPDATE worktrees SET status = 'orphaned', error = 'provisioning interrupted without physical worktree', updated_at = ? WHERE id = ?", params: [now(), String(wt.id)] },
            { sql: "UPDATE worktree_ops SET status = 'failed', step = 'interrupted', updated_at = ? WHERE id = ?", params: [now(), opId] },
          ]);
          orphaned++;
        }
      } else if (String(wt.status) === "cleanup_pending") {
        if (physical) {
          // Limpieza interrumpida: queda pendiente para el usuario, con op reabierta.
          await this.db.exec("UPDATE worktree_ops SET status = 'failed', step = 'interrupted-cleanup', updated_at = ? WHERE id = ?", [now(), opId]);
        } else {
          await this.db.batch([
            { sql: "UPDATE worktrees SET status = 'removed', updated_at = ? WHERE id = ?", params: [now(), String(wt.id)] },
            { sql: "UPDATE worktree_ops SET status = 'done', step = 'reconciled-removed', updated_at = ? WHERE id = ?", params: [now(), opId] },
          ]);
          resumed++;
        }
      } else {
        await this.db.exec("UPDATE worktree_ops SET status = 'failed', step = 'stale-started', updated_at = ? WHERE id = ?", [now(), opId]);
      }
    }
    // 2. Asignado/en ejecución → suspended (reutilizable por retry/recover, sin auto-run).
    const live = await this.db.query<{ id: string; status: string }>("SELECT id, status FROM worktrees WHERE status IN ('assigned','running')");
    for (const w of live) {
      await this.db.exec("UPDATE worktrees SET status = 'suspended', instance_id = NULL, updated_at = ? WHERE id = ?", [now(), w.id]);
      const event = await this.events.append({ type: "worktree.status_changed", aggregate: { kind: "worktree", id: w.id }, correlationId: createId("cor"), payload: { from: w.status, to: "suspended", reason: "settle-on-startup" } });
      this.bus.publish(event);
      suspended++;
    }
    // 3. Huérfanos: físico harness/* sin fila, y fila sin físico.
    const orphans = await this.sweepOrphans();
    orphaned += orphans;
    return { suspended, orphaned, resumed };
  }

  /** Barre huérfanos en ambas direcciones; devuelve cuántos marcó. */
  async sweepOrphans(): Promise<number> {
    let marked = 0;
    const repos = await this.db.query<Record<string, string | number | null>>("SELECT * FROM repositories");
    for (const repo of repos) {
      const projectId = String(repo.project_id);
      const root = String(repo.root_path);
      let entries: Array<{ path: string; branch?: string }> = [];
      try {
        entries = await this.repos.listWorktrees(root);
      } catch {
        continue;
      }
      const workRoot = String(repo.worktrees_root);
      let workRootReal = workRoot;
      try {
        workRootReal = realpathSync(workRoot);
      } catch {
        continue;
      }
      // Físico sin fila: solo ramas harness/* bajo worktrees_root.
      for (const e of entries) {
        let real = e.path;
        try {
          real = realpathSync(e.path);
        } catch {
          continue;
        }
        if (!sameOrInside(workRootReal, real)) continue;
        if (!e.branch || !e.branch.startsWith("harness/")) continue;
        const known = await this.db.queryOne<{ id: string }>("SELECT id FROM worktrees WHERE canonical_path = ?", [real]);
        if (known) continue;
        const id = createId("wt");
        const timestamp = now();
        // Base real si es legible; si no, marcador explícito (fila de auditoría, trigger exige no-vacío).
        let base = "unknown";
        try {
          base = (await runGit(real, ["rev-parse", "HEAD"])).stdout.trim() || base;
        } catch {
          // Sin HEAD legible: se registra igual como huérfano para inspección.
        }
        await this.db.exec(
          "INSERT INTO worktrees (id, project_id, repository_id, task_id, branch_name, base_commit, base_source, canonical_path, status, error, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, 'unknown', ?, 'orphaned', 'physical worktree without record (reconcile)', ?, ?)",
          [id, projectId, String(repo.id), e.branch, base, real, timestamp, timestamp],
        );
        const event = await this.events.append({ type: "worktree.status_changed", aggregate: { kind: "worktree", id }, correlationId: createId("cor"), payload: { to: "orphaned", reason: "physical-without-record" } });
        this.bus.publish(event);
        marked++;
      }
      // Fila sin físico: marcar orphaned (excepto estados finales ya cerrados).
      const rows = await this.db.query<{ id: string; canonical_path: string; status: string }>("SELECT id, canonical_path AS canonical_path, status FROM worktrees WHERE project_id = ?", [projectId]);
      const listed = new Set(entries.map((e) => this.normPath(e.path)));
      for (const r of rows) {
        if (["removed", "retained", "finished", "orphaned"].includes(r.status)) continue;
        let real = r.canonical_path;
        try {
          real = realpathSync(r.canonical_path);
        } catch {
          await this.db.exec("UPDATE worktrees SET status = 'orphaned', error = 'record without physical worktree', updated_at = ? WHERE id = ?", [now(), r.id]);
          const event = await this.events.append({ type: "worktree.status_changed", aggregate: { kind: "worktree", id: r.id }, correlationId: createId("cor"), payload: { from: r.status, to: "orphaned", reason: "record-without-physical" } });
          this.bus.publish(event);
          marked++;
          continue;
        }
        if (!listed.has(this.normPath(real))) {
          await this.db.exec("UPDATE worktrees SET status = 'orphaned', error = 'record without registered worktree', updated_at = ? WHERE id = ?", [now(), r.id]);
          const event = await this.events.append({ type: "worktree.status_changed", aggregate: { kind: "worktree", id: r.id }, correlationId: createId("cor"), payload: { from: r.status, to: "orphaned", reason: "record-without-physical" } });
          this.bus.publish(event);
          marked++;
        }
      }
    }
    return marked;
  }

  // ------------------------------------------------------------------ internas
  private normPath(p: string): string {
    let out = p.replaceAll("\\", "/");
    if (process.platform === "win32") out = out.toLowerCase();
    return out.replace(/\/+$/, "");
  }

  private samePath(a: string, b: string): boolean {
    return this.normPath(a) === this.normPath(b);
  }

  private safeReal(p: string): string | undefined {
    try {
      return realpathSync(p);
    } catch {
      return undefined;
    }
  }

  private async repoRootOf(projectRoot: string): Promise<string> {
    let toplevel: string;
    try {
      toplevel = (await runGit(projectRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
    } catch {
      throw new OctusError("invalid_state", "Project is not inside a git repository");
    }
    return realpathSync(toplevel);
  }

  private async repoRootForWorktree(wt: Worktree): Promise<string> {
    const row = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM repositories WHERE id = ?", [wt.repositoryId]);
    if (!row) throw new OctusError("not_found", `Repository not found: ${wt.repositoryId}`);
    return String(row.root_path);
  }

  private async opStep(opId: string, step: string, detail?: string): Promise<void> {
    await this.db.exec("UPDATE worktree_ops SET step = ?, detail = ?, updated_at = ? WHERE id = ?", [step.slice(0, 200), detail?.slice(0, 2000) ?? null, now(), opId]);
  }

  /**
   * Base del worktree (§G): HEAD o produced_commit del único writer-predecesor.
   * Cero predecesores → HEAD. ≥2 writers → blocked deps-unavailable (sin merges).
   */
  private async resolveBase(taskId: string, repoRoot: string): Promise<{ ok: true; sha: string; source: string } | { ok: false; blockedReason: "deps-unavailable" | "repo-blocked"; details: Record<string, unknown> }> {
    const deps = await this.db.query<{ depends_on: string }>("SELECT depends_on FROM task_dependencies WHERE task_id = ?", [taskId]);
    if (deps.length === 0) {
      const head = await this.repos.getHead(repoRoot).catch((e) => {
        throw e;
      });
      return { ok: true, sha: head, source: "head" };
    }
    const depIds = deps.map((d) => String(d.depends_on));
    const placeholders = depIds.map(() => "?").join(",");
    const rows = await this.db.query<Record<string, string | number | null>>(`SELECT id, agent_role, status FROM tasks WHERE id IN (${placeholders})`, depIds as unknown as import("../persistence/protocol.js").SqlParam[]);
    const writers = rows.filter((r) => String(r.agent_role) === "implementer");
    if (writers.length > 1) {
      return {
        ok: false,
        blockedReason: "deps-unavailable",
        details: { reason: "multiple writer predecessors require a merge (Stage 5); task stays blocked", predecessors: writers.map((r) => String(r.id)) },
      };
    }
    if (writers.length === 0) {
      // Solo predecesores lectores: la base es HEAD (no producen código).
      const head = await this.repos.getHead(repoRoot);
      return { ok: true, sha: head, source: "head" };
    }
    const writer = writers[0]!;
    const writerId = String(writer.id);
    const writerStatus = String(writer.status);
    if (writerStatus !== "completed" && writerStatus !== "reviewed") {
      return { ok: false, blockedReason: "deps-unavailable", details: { reason: `writer predecessor ${writerId} is ${writerStatus}, not ready`, predecessor: writerId } };
    }
    const wt = await this.getByTask(writerId);
    const produced = wt?.producedCommit;
    if (produced) {
      const exists = await this.repos.commitExists(repoRoot, produced).catch(() => false);
      if (exists) return { ok: true, sha: produced, source: `task:${writerId}` };
      return { ok: false, blockedReason: "deps-unavailable", details: { reason: `produced commit ${produced.slice(0, 12)} of ${writerId} not found in repo`, predecessor: writerId } };
    }
    // Legacy (tarea pre-worktree sin produced_commit): HEAD + warning registrado.
    const head = await this.repos.getHead(repoRoot);
    return { ok: true, sha: head, source: "head" };
  }

  private async uniqueBranchName(repoRoot: string, repoId: string, runId: string, taskId: string): Promise<string> {
    const base = `harness/run-${runId}/task-${taskId}`;
    await assertValidBranchName(repoRoot, base);
    const taken = new Set(await this.repos.listBranches(repoRoot).catch(() => [] as string[]));
    if (!taken.has(base)) return base;
    for (let n = 2; n <= 50; n++) {
      const candidate = `${base}-r${n}`;
      await assertValidBranchName(repoRoot, candidate);
      if (!taken.has(candidate)) return candidate;
    }
    throw new OctusError("invalid_state", `No free branch name for task ${taskId} after 50 attempts`);
  }

  private async validateFreshWorktree(repoRoot: string, candidate: string, baseSha: string): Promise<void> {
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      throw new OctusError("tool_failed", `Worktree path missing after creation: ${candidate.slice(0, 200)}`);
    }
    const listed = await this.repos.listWorktrees(repoRoot);
    if (!listed.some((e) => this.samePath(e.path, real))) {
      throw new OctusError("tool_failed", "Created worktree is not registered in git");
    }
    const head = (await runGit(real, ["rev-parse", "HEAD"], { tries: 4 })).stdout.trim();
    if (head !== baseSha) {
      throw new OctusError("tool_failed", `Worktree HEAD ${head.slice(0, 12)} does not match base ${baseSha.slice(0, 12)}`);
    }
    if (isUncPath(real)) throw new OctusError("scope_violation", "UNC paths are not allowed for worktrees");
  }

  /** Adopta un orphaned con físico presente (→ available) o lo marca si ya no hay nada. */
  private async adoptOrReap(existing: Worktree): Promise<EnsureResult> {
    const physical = await this.physicalWorktreeExists(existing.projectId, existing.canonicalPath);
    if (physical) {
      await this.db.exec("UPDATE worktrees SET status = 'available', error = NULL, updated_at = ? WHERE id = ?", [now(), existing.id]);
      return { ok: true, worktreeId: existing.id, path: existing.canonicalPath, branch: existing.branchName, baseCommit: existing.baseCommit, reused: true };
    }
    await this.db.exec("DELETE FROM worktrees WHERE id = ?", [existing.id]);
    const task = await this.db.queryOne<{ run_id: string }>("SELECT run_id FROM tasks WHERE id = ?", [existing.taskId]);
    const run = task ? await this.db.queryOne<{ session_id: string }>("SELECT session_id FROM runs WHERE id = ?", [String(task.run_id)]) : undefined;
    const session = run ? await this.db.queryOne<{ project_id: string }>("SELECT project_id FROM sessions WHERE id = ?", [String(run.session_id)]) : undefined;
    if (!task || !session) throw new OctusError("not_found", `Task session not found: ${existing.taskId}`);
    return this.ensureForTask({ projectId: String(session.project_id), runId: String(task.run_id), taskId: existing.taskId, attempt: existing.attempt });
  }

  private async physicalWorktreeExists(projectId: string, canonicalPath: string): Promise<boolean> {
    const root = await this.db.queryOne<{ root_path: string }>("SELECT p.root_path AS root_path FROM projects p WHERE p.id = ?", [projectId]).catch(() => undefined);
    if (!root) return false;
    let entries: Array<{ path: string }> = [];
    try {
      const toplevel = realpathSync((await runGit(String(root.root_path), ["rev-parse", "--show-toplevel"])).stdout.trim());
      entries = await this.repos.listWorktrees(toplevel);
    } catch {
      return existsSync(canonicalPath);
    }
    return entries.some((e) => this.samePath(e.path, canonicalPath));
  }
}

function deserializeWorktree(row: Record<string, string | number | null>): Worktree {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    repositoryId: String(row.repository_id),
    runId: row.run_id ? String(row.run_id) : "",
    taskId: String(row.task_id ?? ""),
    branchName: String(row.branch_name),
    baseCommit: String(row.base_commit),
    baseSource: String(row.base_source ?? "head"),
    producedCommit: row.produced_commit ? String(row.produced_commit) : undefined,
    canonicalPath: String(row.canonical_path),
    status: row.status as WorktreeStatus,
    attempt: Number(row.attempt ?? 0),
    instanceId: row.instance_id ? String(row.instance_id) : undefined,
    dirtyExcluded: Number(row.dirty_excluded ?? 0) === 1,
    dirtySummary: row.dirty_summary ? String(row.dirty_summary) : undefined,
    error: row.error ? String(row.error) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function deserializeOp(row: Record<string, string | number | null>): WorktreeOperation {
  return {
    id: String(row.id),
    worktreeId: row.worktree_id ? String(row.worktree_id) : undefined,
    taskId: row.task_id ? String(row.task_id) : undefined,
    op: row.op as WorktreeOperation["op"],
    status: row.status as WorktreeOperation["status"],
    step: row.step ? String(row.step) : undefined,
    detail: row.detail ? String(row.detail) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
