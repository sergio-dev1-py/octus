/**
 * @octus/core — IntegrationManager: integración controlada en rama intermedia (Etapa 5).
 * Determinista, sin modelos. Crea un espacio de integración por run (rama
 * `harness/integration/run-<runId>` + worktree), incorpora produced_commits
 * verificados en orden topológico y deja journal persistente. Nunca toca el
 * workspace principal; nunca mergea a la rama destino (Etapa 5: PromotionManager).
 *
 * Invariantes:
 * - Un commit (task, attempt) se integra una sola vez (UNIQUE); reintentar es idempotente.
 * - Solo SHAs resueltos desde la DB (produced_commit registrado); jamás SHA de un modelo.
 * - Estrategia: contenido→skip, FF→fast-forward, resto→merge --no-ff; conflicto→abort + fila abierta.
 * - Sin rebase/squash/cherry-pick (preservan procedencia).
 */
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { createId, type Integration, type IntegrationCommit, type IntegrationOperation, type IntegrationStatus, type WorkBase, type WorkBaseStatus } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { isSecretBasename, isUncPath, sameOrInside } from "../tools/path-scope.js";
import { now } from "../util.js";
import { assertValidBranchName, runGit } from "../repositories/git-exec.js";
import type { RepositoryManager } from "../repositories/repository-manager.js";
import { deserializeTask } from "../tasks/task-manager.js";
import type { WorktreeManager } from "../worktrees/worktree-manager.js";
import type { ValidationService } from "./validation-service.js";
import type { EnsureWorkBaseResult, IntegrationPort, IntegrationWorkspace, WorkBaseAssignment } from "./integration-port.js";

export interface IncorporateResult {
  integrationId: string;
  taskId: string;
  attempt: number;
  originalSha: string;
  integratedSha: string;
  reused: boolean;
  strategy: "contained" | "fast-forward" | "merge";
}

export class IntegrationManager implements IntegrationPort {
  constructor(
    private readonly db: PersistenceService,
    private readonly events: EventStore,
    private readonly bus: EventBus,
    private readonly repos: RepositoryManager,
    private readonly worktrees: WorktreeManager,
    private readonly dataDir: string,
    private readonly validations?: ValidationService,
  ) {}

  // ------------------------------------------------------------------ lectura
  async getIntegration(id: string): Promise<Integration> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM integrations WHERE id = ?", [id]);
    if (!row) throw new OctusError("not_found", `Integration not found: ${id}`);
    return deserializeIntegration(row);
  }

  async listByRun(runId: string): Promise<Integration[]> {
    const rows = await this.db.query<Record<string, string | number | null>>("SELECT * FROM integrations WHERE run_id = ? ORDER BY attempt ASC, created_at ASC", [runId]);
    return rows.map(deserializeIntegration);
  }

  async getCommits(integrationId: string): Promise<IntegrationCommit[]> {
    const rows = await this.db.query<Record<string, string | number | null>>("SELECT * FROM integration_commits WHERE integration_id = ? ORDER BY created_at ASC", [integrationId]);
    return rows.map(deserializeCommit);
  }

  async listOperations(integrationId: string): Promise<IntegrationOperation[]> {
    const rows = await this.db.query<Record<string, string | number | null>>("SELECT * FROM integration_ops WHERE integration_id = ? ORDER BY created_at ASC", [integrationId]);
    return rows.map(deserializeOp);
  }

  // ------------------------------------------------------------------ creación
  /**
   * Crea (o devuelve, idempotente) el espacio de integración del run: rama
   * intermedia + worktree desde el destino observado. Sin efectos en el
   * workspace principal.
   */
  async createForRun(input: { projectId: string; runId: string; targetBranch?: string }, opts?: { supersedes?: string }): Promise<Integration> {
    const open = await this.db.queryOne<Record<string, string | number | null>>(
      "SELECT * FROM integrations WHERE run_id = ? AND status NOT IN ('rejected','promoted','stale','aborted','failed','invalidated') ORDER BY attempt DESC, created_at DESC LIMIT 1",
      [input.runId],
    );
    if (open) return deserializeIntegration(open);

    const project = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM projects WHERE id = ?", [input.projectId]);
    if (!project) throw new OctusError("not_found", `Project not found: ${input.projectId}`);
    let repoRoot: string;
    try {
      repoRoot = realpathSync((await runGit(String(project.root_path), ["rev-parse", "--show-toplevel"])).stdout.trim());
    } catch {
      throw new OctusError("invalid_state", "Project is not inside a git repository");
    }
    await this.repos.validateRepository(repoRoot);
    const repoId = await this.repos.ensureRepositoryRow(input.projectId, repoRoot, await this.worktrees.effectiveWorktreesRoot(input.projectId));

    const targetBranch = input.targetBranch ?? (await this.repos.getCurrentBranch(repoRoot));
    await assertValidBranchName(repoRoot, targetBranch);
    const targetBase = await this.repos.getHead(repoRoot);
    const existingAttempts = await this.db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM integrations WHERE run_id = ?", [input.runId]);
    const attempt = existingAttempts?.n ?? 0;
    const branch = await this.uniqueIntegrationBranch(repoRoot, repoId, input.runId);
    const root = await this.worktrees.effectiveWorktreesRoot(input.projectId);
    if (isUncPath(root)) throw new OctusError("scope_violation", "UNC paths are not allowed for integrations");
    // Path por intento: el rebuild convive con la fila superseded (UNIQUE).
    const candidate = path.join(root, "integrations", attempt > 0 ? `run-${input.runId}-a${attempt}` : `run-${input.runId}`);

    const id = createId("int");
    const opId = createId("iop");
    const timestamp = now();
    await this.db.batch([
      {
        sql: "INSERT INTO integrations (id, project_id, repository_id, run_id, target_branch, target_base_commit, integration_branch, canonical_path, attempt, supersedes, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'building', ?, ?)",
        params: [id, input.projectId, repoId, input.runId, targetBranch, targetBase, branch, candidate, attempt, opts?.supersedes ?? null, timestamp, timestamp],
      },
      {
        sql: "INSERT INTO integration_ops (id, integration_id, op, status, step, detail, created_at, updated_at) VALUES (?, ?, 'create', 'started', 'begin', ?, ?, ?)",
        params: [opId, id, `branch ${branch} at ${targetBase.slice(0, 12)}`, timestamp, timestamp],
      },
    ]);
    try {
      mkdirSync(path.dirname(candidate), { recursive: true });
      await this.opStep(opId, "git worktree add", `branch ${branch} at ${targetBase.slice(0, 12)}`);
      await runGit(repoRoot, ["worktree", "add", "-b", branch, candidate, targetBase]);
      await this.validateFreshIntegration(repoRoot, candidate, targetBase);
      const real = realpathSync(candidate);
      await this.db.batch([
        { sql: "UPDATE integrations SET canonical_path = ?, updated_at = ? WHERE id = ?", params: [real, now(), id] },
        { sql: "UPDATE integration_ops SET status = 'done', step = 'created', updated_at = ? WHERE id = ?", params: [now(), opId] },
      ]);
      const event = await this.events.append({ type: "integration.created", aggregate: { kind: "integration", id }, correlationId: createId("cor"), payload: { runId: input.runId, branch, targetBranch, targetBase } });
      this.bus.publish(event);
      return this.getIntegration(id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.db.exec("UPDATE integration_ops SET status = 'failed', step = 'git failed', detail = ?, updated_at = ? WHERE id = ?", [msg.slice(0, 2000), now(), opId]);
      await this.db.exec("UPDATE integrations SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", [msg.slice(0, 2000), now(), id]);
      try {
        await runGit(repoRoot, ["worktree", "remove", "--force", candidate]);
      } catch {
        // queda para reconcile
      }
      throw new OctusError("tool_failed", `Integration workspace creation failed: ${msg.slice(0, 300)}`);
    }
  }

  /**
   * Incorpora el produced_commit de (task, attempt) con las 12 verificaciones.
   * Idempotente por UNIQUE(integration, task, attempt): repetir devuelve reused.
   * El attempt debe ser el último completado de la task (sin contenido rancio).
   */
  async incorporateCommit(integrationId: string, taskId: string, attempt: number): Promise<IncorporateResult> {
    const integration = await this.getIntegration(integrationId);
    if (!["building", "conflicted", "validating"].includes(integration.status)) {
      throw new OctusError("invalid_state", `Integration ${integrationId} is ${integration.status}, not open for incorporation`);
    }
    const prior = await this.db.queryOne<{ original_sha: string; integrated_sha: string }>(
      "SELECT original_sha, integrated_sha FROM integration_commits WHERE integration_id = ? AND task_id = ? AND attempt = ?",
      [integrationId, taskId, attempt],
    );
    if (prior) {
      return { integrationId, taskId, attempt, originalSha: String(prior.original_sha), integratedSha: String(prior.integrated_sha), reused: true, strategy: "contained" };
    }
    // Conflicto abierto: no re-fusionar en cada tick (la resolución lo reintentará).
    const openConflict = await this.db.queryOne<{ id: string }>("SELECT id FROM integration_conflicts WHERE scope = 'integration' AND scope_ref = ? AND status IN ('open','resolving') ORDER BY created_at DESC LIMIT 1", [integrationId]);
    if (openConflict) {
      throw new OctusError("invalid_state", `Integration ${integrationId} has an open conflict (${String(openConflict.id).slice(-6)}); resolve it before incorporating`, {
        details: { conflictId: String(openConflict.id) },
      });
    }

    // ---- verificaciones 1–6: procedencia en la DB ----
    const task = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM tasks WHERE id = ?", [taskId]);
    if (!task) throw new OctusError("not_found", `Task not found: ${taskId}`);
    const t = deserializeTask(task);
    if (t.needsReview && t.status !== "reviewed") {
      throw new OctusError("invalid_state", `Task ${taskId} requires review but is ${t.status}`);
    }
    if (!t.needsReview && t.status !== "completed" && t.status !== "reviewed") {
      throw new OctusError("invalid_state", `Task ${taskId} is ${t.status}, not integrable`);
    }
    const activeVerdict = t.needsReview
      ? await this.db.queryOne<{ verdict: string }>("SELECT verdict FROM task_review_verdicts WHERE target_task_id = ? AND verdict = 'accept' ORDER BY created_at DESC LIMIT 1", [taskId])
      : { verdict: "accept" };
    if (!activeVerdict) throw new OctusError("invalid_state", `Task ${taskId} has no recorded accept verdict`);
    const attemptRow = await this.db.queryOne<{ status: string }>("SELECT status FROM task_attempts WHERE task_id = ? AND attempt = ?", [taskId, attempt]);
    if (!attemptRow || attemptRow.status !== "completed") {
      throw new OctusError("invalid_state", `Task ${taskId} attempt ${attempt} is ${attemptRow?.status ?? "missing"}, not completed`);
    }
    const latest = await this.db.queryOne<{ attempt: number }>("SELECT attempt FROM task_attempts WHERE task_id = ? AND status = 'completed' ORDER BY attempt DESC LIMIT 1", [taskId]);
    if (!latest || Number(latest.attempt) !== attempt) {
      throw new OctusError("invalid_state", `Task ${taskId} attempt ${attempt} is not the latest completed attempt (${latest ? Number(latest.attempt) : "none"})`);
    }
    const wt = await this.worktrees.getByTask(taskId);
    if (!wt?.producedCommit) throw new OctusError("invalid_state", `Task ${taskId} has no recorded produced_commit`);
    if (wt.projectId !== integration.projectId || wt.repositoryId !== integration.repositoryId) {
      throw new OctusError("invalid_state", `Task ${taskId} belongs to another project or repository`);
    }
    const produced = wt.producedCommit;

    // ---- verificaciones 7–8: historial esperado en git ----
    const repoRoot = await this.repoRootFor(integration);
    // El produced debe existir en el repo de integración (misma forja, no SHA ajeno).
    if (!(await this.repos.commitExists(repoRoot, produced))) {
      throw new OctusError("invalid_state", `produced commit ${produced.slice(0, 12)} not found in the integration repository`);
    }
    if (!(await this.isAncestor(repoRoot, wt.baseCommit, produced))) {
      throw new OctusError("invalid_state", `produced commit ${produced.slice(0, 12)} is not a descendant of base ${wt.baseCommit.slice(0, 12)}`);
    }
    // Dependencias escritoras ya incorporadas (orden topológico observado, no asumido).
    const depRows = await this.db.query<{ depends_on: string }>("SELECT depends_on FROM task_dependencies WHERE task_id = ?", [taskId]);
    for (const dep of depRows) {
      const depTask = await this.db.queryOne<{ agent_role: string }>("SELECT agent_role FROM tasks WHERE id = ?", [String(dep.depends_on)]);
      if (depTask && String(depTask.agent_role) === "implementer") {
        const incorporated = await this.db.queryOne<{ id: string }>("SELECT id FROM integration_commits WHERE integration_id = ? AND task_id = ?", [integrationId, String(dep.depends_on)]);
        if (!incorporated) {
          throw new OctusError("invalid_state", `Writer predecessor ${String(dep.depends_on).slice(0, 12)} is not incorporated yet; incorporate in dependency order`);
        }
      }
    }

    // ---- verificaciones 9–10: diff, scopes, secretos, .git ----
    const files = await this.commitFiles(repoRoot, produced);
    const sessionDir = await this.sessionDirOf(t.runId);
    const allowed = await this.scopeRelatives(t.writeScope, sessionDir, repoRoot);
    for (const f of files) {
      if (f.split("/").includes(".git")) throw new OctusError("scope_violation", `produced commit touches .git internals: ${f.slice(0, 200)}`);
      const base = f.split("/").pop() ?? f;
      if (isSecretBasename(base)) throw new OctusError("scope_violation", `produced commit touches a protected secret file: ${f.slice(0, 200)}`);
      const inside = allowed.some((rel) => rel === "." || f === rel || f.startsWith(`${rel}/`));
      if (!inside) throw new OctusError("scope_violation", `produced commit escapes the task write scope: ${f.slice(0, 200)}`);
    }

    // ---- 11: estrategia determinista ----
    const opId = createId("iop");
    const timestamp = now();
    await this.db.exec("INSERT INTO integration_ops (id, integration_id, op, status, step, detail, created_at, updated_at) VALUES (?, ?, 'incorporate', 'started', 'verify-done', ?, ?, ?)", [
      opId,
      integrationId,
      `task ${taskId.slice(-6)} attempt ${attempt} ${produced.slice(0, 12)}`,
      timestamp,
      timestamp,
    ]);
    const intPath = realpathSync(integration.canonicalPath);
    try {
      let strategy: IncorporateResult["strategy"];
      let integratedSha: string;
      if (await this.isAncestor(intPath, produced, "HEAD")) {
        strategy = "contained";
        integratedSha = (await runGit(intPath, ["rev-parse", "HEAD"])).stdout.trim();
      } else if (await this.tryFastForward(intPath, produced)) {
        strategy = "fast-forward";
        integratedSha = produced;
      } else {
        integratedSha = await this.mergeNoFf(intPath, produced, taskId, attempt, integration);
        strategy = "merge";
      }
      if (!/^[0-9a-f]{40}$/.test(integratedSha)) throw new OctusError("tool_failed", "Integration resulted in an invalid HEAD");
      const commitId = createId("ic");
      await this.db.batch([
        {
          sql: "INSERT INTO integration_commits (id, integration_id, task_id, attempt, instance_id, worktree_id, original_sha, integrated_sha, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          params: [commitId, integrationId, taskId, attempt, wt.instanceId ?? null, wt.id, produced, integratedSha, strategy === "merge" ? "resolution" : "original", now()],
        },
        { sql: "UPDATE integrations SET head = ?, updated_at = ? WHERE id = ?", params: [integratedSha, now(), integrationId] },
        { sql: "UPDATE integration_ops SET status = 'done', step = ?, updated_at = ? WHERE id = ?", params: [`incorporated-${strategy}`, now(), opId] },
      ]);
      const event = await this.events.append({ type: "integration.status_changed", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { taskId, attempt, strategy, head: integratedSha } });
      this.bus.publish(event);
      await markTaskIntegrated(this.db, this.events, this.bus, taskId);
      return { integrationId, taskId, attempt, originalSha: produced, integratedSha, reused: false, strategy };
    } catch (error) {
      const details = error instanceof OctusError ? (error as OctusError & { details?: { conflict?: boolean; files?: string[]; ours?: string; theirs?: string } }).details : undefined;
      if (details?.conflict === true && Array.isArray(details.files) && typeof details.ours === "string" && typeof details.theirs === "string") {
        await this.markConflicted(integrationId, opId, { files: details.files as string[], ours: details.ours, theirs: details.theirs }, taskId, attempt);
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        await this.db.exec("UPDATE integration_ops SET status = 'failed', step = 'incorporate failed', detail = ?, updated_at = ? WHERE id = ?", [msg.slice(0, 2000), now(), opId]);
      }
      if (error instanceof OctusError) throw error;
      throw new OctusError("tool_failed", `Incorporation failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
    }
  }

  /**
   * Incorpora todos los escritores revisados del run en orden topológico.
   * Emite integration.completed al asentar el último (ensamblado completo).
   */
  async incorporateRun(integrationId: string): Promise<IncorporateResult[]> {
    const integration = await this.getIntegration(integrationId);
    const run = await this.db.queryOne<{ session_id: string }>("SELECT session_id FROM runs WHERE id = ?", [integration.runId]);
    if (!run) throw new OctusError("not_found", `Run not found: ${integration.runId}`);
    const rows = await this.db.query<Record<string, string | number | null>>("SELECT * FROM tasks WHERE run_id = ? AND agent_role = 'implementer' ORDER BY priority DESC, created_at ASC, id ASC", [integration.runId]);
    const writers = rows.map(deserializeTask);
    const out: IncorporateResult[] = [];
    const done = new Set((await this.getCommits(integrationId)).map((c) => c.taskId));
    // Estricto: sin escritores pendientes de revisión no hay nada que asentar.
    const notReady = writers.filter((w) => !done.has(w.id) && !(w.status === "reviewed" || (!w.needsReview && w.status === "completed")));
    if (notReady.length > 0) {
      throw new OctusError("invalid_state", `Cannot incorporate: ${notReady.length} writer(s) not reviewed yet (${notReady.map((w) => w.id.slice(-6)).join(",")})`);
    }
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const w of writers) {
        if (done.has(w.id)) continue;
        const ready = w.status === "reviewed" || (!w.needsReview && w.status === "completed");
        if (!ready) continue;
        const deps = await this.db.query<{ depends_on: string }>("SELECT depends_on FROM task_dependencies WHERE task_id = ?", [w.id]);
        let blocked = false;
        for (const dep of deps) {
          const depTask = await this.db.queryOne<{ agent_role: string }>("SELECT agent_role FROM tasks WHERE id = ?", [String(dep.depends_on)]);
          if (depTask && String(depTask.agent_role) === "implementer" && !done.has(String(dep.depends_on))) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        const latest = await this.db.queryOne<{ attempt: number }>("SELECT attempt FROM task_attempts WHERE task_id = ? AND status = 'completed' ORDER BY attempt DESC LIMIT 1", [w.id]);
        if (!latest) continue;
        out.push(await this.incorporateCommit(integrationId, w.id, Number(latest.attempt)));
        done.add(w.id);
        progressed = true;
      }
    }
    const pending = writers.filter((w) => !done.has(w.id) && (w.status === "reviewed" || (!w.needsReview && w.status === "completed")));
    if (pending.length > 0) {
      throw new OctusError("invalid_state", `Cannot incorporate ${pending.length} writer(s): predecessors not incorporated or attempts not completed (${pending.map((w) => w.id.slice(-6)).join(",")})`);
    }
    // Idempotente: todo asentado y nada nuevo → sin evento duplicado.
    if (out.length === 0) return out;
    const head = (await this.getIntegration(integrationId)).head;
    const event = await this.events.append({ type: "integration.completed", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { commits: out.length, head } });
    this.bus.publish(event);
    // P1 (Etapa 5): el ensamblado completo ejecuta la suite sobre el head.
    // Los fallos de infra se auditan; los de tests quedan en filas failed.
    await this.runSuiteForHead(integrationId).catch(() => undefined);
    return out;
  }

  /**
   * Marca validating y ejecuta la suite sobre el head actual. La suite nunca
   * tumba la incorporación: sus resultados viven en filas por SHA.
   */
  private async runSuiteForHead(integrationId: string): Promise<void> {
    if (!this.validations) return;
    const timestamp = now();
    try {
      await this.validations.runSuiteValidation(integrationId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const opId = createId("iop");
      await this.db.exec("INSERT INTO integration_ops (id, integration_id, op, status, step, detail, created_at, updated_at) VALUES (?, ?, 'validate', 'failed', 'suite infra', ?, ?, ?)", [
        opId,
        integrationId,
        msg.slice(0, 2000),
        timestamp,
        now(),
      ]);
    }
  }

  /** Cierre explícito sin borrar nada (ramas/worktrees/commits preservados). */
  async abortIntegration(integrationId: string, reason = "aborted"): Promise<void> {
    const integration = await this.getIntegration(integrationId);
    if (!["building", "conflicted", "validating"].includes(integration.status)) {
      throw new OctusError("invalid_state", `Integration ${integrationId} is ${integration.status}, cannot abort`);
    }
    const timestamp = now();
    await this.db.batch([
      { sql: "UPDATE integrations SET status = 'aborted', error = ?, updated_at = ? WHERE id = ?", params: [reason.slice(0, 500), timestamp, integrationId] },
      { sql: "INSERT INTO integration_ops (id, integration_id, op, status, step, created_at, updated_at) VALUES (?, ?, 'abort', 'done', ?, ?, ?)", params: [createId("iop"), integrationId, reason.slice(0, 200), timestamp, timestamp] },
    ]);
    const event = await this.events.append({ type: "integration.status_changed", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { from: integration.status, to: "aborted", reason } });
    this.bus.publish(event);
  }

  /**
   * Reconciliación post-reinicio: resuelve ops 'started', marca integraciones
   * de runs liquidados como interrupted y workbases sin físico como stale
   * (rebuild en el próximo ensure). Nunca genera agentes (ADR-040).
   */
  async reconcile(): Promise<{ resolved: number; interrupted: number; stale: number }> {
    let resolved = 0;
    let interrupted = 0;
    const pending = await this.db.query<Record<string, string | number | null>>("SELECT * FROM integration_ops WHERE status = 'started' ORDER BY created_at ASC");
    for (const op of pending) {
      const opId = String(op.id);
      const intId = op.integration_id ? String(op.integration_id) : undefined;
      const integration = intId ? await this.db.queryOne<{ status: string }>("SELECT status FROM integrations WHERE id = ?", [intId]).catch(() => null) : null;
      if (!integration) {
        await this.db.exec("UPDATE integration_ops SET status = 'failed', step = 'row gone', updated_at = ? WHERE id = ?", [now(), opId]);
        resolved++;
        continue;
      }
      // La fuente de verdad es git + filas de commits: si el último commit
      // registrado coincide con el HEAD físico, la op se había completado.
      await this.db.exec("UPDATE integration_ops SET status = 'failed', step = 'interrupted', updated_at = ? WHERE id = ?", [now(), opId]);
      resolved++;
    }
    const stale = await this.db.query<{ id: string }>(
      `SELECT i.id AS id FROM integrations i JOIN runs r ON r.id = i.run_id WHERE i.status IN ('building','conflicted','validating') AND r.status NOT IN ('integrating','awaiting_approval','promoting','executing','planning')`,
    );
    for (const s of stale) {
      await this.db.exec("UPDATE integrations SET status = 'interrupted', error = 'run settled while integrating', updated_at = ? WHERE id = ?", [now(), s.id]);
      const event = await this.events.append({ type: "integration.status_changed", aggregate: { kind: "integration", id: s.id }, correlationId: createId("cor"), payload: { to: "interrupted", reason: "settle-on-startup" } });
      this.bus.publish(event);
      interrupted++;
    }
    // Workbases sin físico → stale (el próximo ensure reconstruye).
    let staleCount = 0;
    const wbs = await this.db.query<{ id: string; canonical_path: string; status: string; repository_id: string }>("SELECT id, canonical_path, status, repository_id FROM work_bases WHERE status IN ('building','ready')");
    for (const wb of wbs) {
      const repo = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM repositories WHERE id = ?", [wb.repository_id]).catch(() => null);
      let physical = false;
      if (repo) {
        try {
          const entries = await this.repos.listWorktrees(String(repo.root_path));
          physical = entries.some((e) => this.samePath(e.path, wb.canonical_path));
        } catch {
          physical = false;
        }
      }
      if (!physical) {
        await this.db.exec("UPDATE work_bases SET status = 'stale', error = 'physical worktree missing', updated_at = ? WHERE id = ?", [now(), wb.id]);
        const event = await this.events.append({ type: "workbase.status_changed", aggregate: { kind: "work_base", id: wb.id }, correlationId: createId("cor"), payload: { from: wb.status, to: "stale", reason: "record-without-physical" } });
        this.bus.publish(event);
        staleCount++;
      }
    }
    return { resolved, interrupted, stale: staleCount };
  }

  // ---------------------------------------------------------- bases de trabajo
  async getWorkBase(taskId: string): Promise<WorkBaseAssignment | undefined> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM work_bases WHERE task_id = ?", [taskId]);
    if (!row) return undefined;
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      taskId: String(row.task_id),
      tipSha: String(row.tip_sha),
      branchName: String(row.branch_name),
      path: String(row.canonical_path),
      status: row.status as WorkBaseStatus,
      reused: true,
    };
  }

  /** Puerto consumido por AgentManager: el reviewer lee el worktree de integración. */
  async getIntegrationWorkspace(integrationId: string): Promise<IntegrationWorkspace | undefined> {
    const integration = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM integrations WHERE id = ?", [integrationId]).catch(() => null);
    if (!integration || !["building", "validating"].includes(String(integration.status))) return undefined;
    const candidate = String(integration.canonical_path);
    if (!(await this.physicalIntegrationWorkspace(candidate))) return undefined;
    return {
      id: integrationId,
      projectId: String(integration.project_id),
      path: realpathSync(candidate),
      branchName: String(integration.integration_branch),
      status: String(integration.status),
    };
  }

  /**
   * Base de trabajo para una task con ≥2 predecesores escritores (§B): rama
   * `harness/workbase/...` con el merge de los produced. Idempotente por
   * task (mismos SHAs → reused). Nunca lanza: devuelve blocked re-evaluable.
   * Conflicto entre predecesores → fila abierta + blocked con {conflict:true}.
   */
  async ensureWorkBaseForTask(input: { projectId: string; runId: string; taskId: string; predecessorIds: string[] }): Promise<EnsureWorkBaseResult> {
    try {
      return await this.ensureWorkBaseInner(input);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const details = (error as OctusError & { details?: Record<string, unknown> }).details;
      if (details?.conflict === true) {
        return { ok: false, blockedReason: "deps-unavailable", details: { ...details, reason: msg.slice(0, 500) } };
      }
      const code = error instanceof OctusError ? error.code : "tool_failed";
      const reason = code === "invalid_state" ? "deps-unavailable" : code === "not_found" || code === "scope_violation" ? "repo-blocked" : "no-capacity";
      return { ok: false, blockedReason: reason, details: { reason: msg.slice(0, 500) } };
    }
  }

  private async ensureWorkBaseInner(input: { projectId: string; runId: string; taskId: string; predecessorIds: string[] }): Promise<EnsureWorkBaseResult> {
    const predecessors = [...new Set(input.predecessorIds)].sort();
    if (predecessors.length < 2) throw new OctusError("invalid_tool_args", "A work base requires at least two writer predecessors");
    const project = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM projects WHERE id = ?", [input.projectId]);
    if (!project) throw new OctusError("not_found", `Project not found: ${input.projectId}`);
    const repoRoot = realpathSync((await runGit(String(project.root_path), ["rev-parse", "--show-toplevel"])).stdout.trim());
    await this.repos.validateRepository(repoRoot);
    const repoId = await this.repos.ensureRepositoryRow(input.projectId, repoRoot, await this.worktrees.effectiveWorktreesRoot(input.projectId));
    // Todos los predecesores revisados con produced (sin contenido rancio).
    const produced: string[] = [];
    for (const predId of predecessors) {
      const pred = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM tasks WHERE id = ?", [predId]);
      if (!pred) throw new OctusError("not_found", `Predecessor task not found: ${predId}`);
      const t = deserializeTask(pred);
      // integrated implica reviewed + produced: sirve como base igual.
      if (t.needsReview && t.status !== "reviewed" && t.status !== "integrated") {
        throw new OctusError("invalid_state", `Writer predecessor ${predId.slice(-6)} is ${t.status}, not reviewed`);
      }
      if (!t.needsReview && t.status !== "completed" && t.status !== "reviewed" && t.status !== "integrated") {
        throw new OctusError("invalid_state", `Writer predecessor ${predId.slice(-6)} is ${t.status}, not completed`);
      }
      const wt = await this.worktrees.getByTask(predId);
      if (!wt?.producedCommit) throw new OctusError("invalid_state", `Writer predecessor ${predId.slice(-6)} has no produced_commit`);
      if (!(await this.repos.commitExists(repoRoot, wt.producedCommit))) {
        throw new OctusError("invalid_state", `produced commit ${wt.producedCommit.slice(0, 12)} of ${predId.slice(-6)} not found in repo`);
      }
      produced.push(wt.producedCommit);
    }
    produced.sort();
    const expected = JSON.stringify(produced);

    const existing = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM work_bases WHERE task_id = ?", [input.taskId]);
    if (existing) {
      if (String(existing.status) === "conflicted") {
        const conflict = await this.db.queryOne<{ id: string; files: string }>("SELECT id, files FROM integration_conflicts WHERE scope = 'work_base' AND scope_ref = ? AND status IN ('open','resolving') ORDER BY created_at DESC LIMIT 1", [String(existing.id)]);
        return { ok: false, blockedReason: "deps-unavailable", details: { conflict: true, conflictId: conflict?.id, files: conflict ? JSON.parse(String(conflict.files)) : [], reason: "predecessors conflict; resolution required" } };
      }
      if (String(existing.status) === "ready" && String(existing.predecessor_shas) === expected) {
        const physical = await this.physicalRefExists(repoRoot, String(existing.canonical_path));
        const tipOk = physical && (await runGit(String(existing.canonical_path), ["rev-parse", "HEAD"]).then((r) => r.stdout.trim(), () => "")) === String(existing.tip_sha);
        if (tipOk) {
          return { ok: true, workBaseId: String(existing.id), tipSha: String(existing.tip_sha), branch: String(existing.branch_name), path: String(existing.canonical_path), reused: true };
        }
      }
      // Stale, mismatch o físico ausente: reconstruir (contenido derivado, reproducible).
      try {
        await runGit(repoRoot, ["worktree", "remove", "--force", String(existing.canonical_path)]);
      } catch {
        // best effort
      }
      await this.db.exec("DELETE FROM work_bases WHERE id = ?", [String(existing.id)]);
    }

    const branch = await this.uniqueWorkBaseBranch(repoRoot, repoId, input.runId, input.taskId);
    const root = await this.worktrees.effectiveWorktreesRoot(input.projectId);
    if (isUncPath(root)) throw new OctusError("scope_violation", "UNC paths are not allowed for work bases");
    const candidate = path.join(root, "workbases", input.taskId);
    const id = createId("wb");
    const timestamp = now();
    await this.db.batch([
      {
        sql: "INSERT INTO work_bases (id, project_id, repository_id, run_id, task_id, predecessor_shas, tip_sha, branch_name, canonical_path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 'building', ?, ?)",
        params: [id, input.projectId, repoId, input.runId, input.taskId, expected, branch, candidate, timestamp, timestamp],
      },
      {
        sql: "INSERT INTO integration_ops (id, op, status, step, detail, created_at, updated_at) VALUES (?, 'workbase', 'started', 'begin', ?, ?, ?)",
        params: [createId("iop"), `workbase ${id.slice(-6)} from ${produced.map((s) => s.slice(0, 8)).join("+")}`, timestamp, timestamp],
      },
    ]);
    const created = await this.events.append({ type: "workbase.created", aggregate: { kind: "work_base", id }, correlationId: createId("cor"), payload: { taskId: input.taskId, predecessors } });
    this.bus.publish(created);
    try {
      mkdirSync(path.dirname(candidate), { recursive: true });
      await runGit(repoRoot, ["worktree", "add", "-b", branch, candidate, produced[0]!]);
      let tip = produced[0]!;
      for (const sha of produced.slice(1)) {
        if (await this.isAncestor(candidate, tip, sha)) continue; // ya contenido
        if (await this.isAncestor(candidate, sha, tip)) {
          tip = sha; // fast-forward local: mover la rama
          await runGit(candidate, ["merge", "--ff-only", sha]);
          continue;
        }
        tip = await this.mergeBranchInto(candidate, sha, `harness: work base for task ${input.taskId} (run ${input.runId})`, `predecessor ${sha.slice(0, 12)}`);
      }
      tip = (await runGit(candidate, ["rev-parse", "HEAD"])).stdout.trim();
      const real = realpathSync(candidate);
      await this.db.batch([
        { sql: "UPDATE work_bases SET tip_sha = ?, canonical_path = ?, status = 'ready', updated_at = ? WHERE id = ?", params: [tip, real, now(), id] },
        { sql: "UPDATE integration_ops SET status = 'done', step = 'ready', updated_at = ? WHERE detail LIKE ? AND status = 'started'", params: [now(), `workbase ${id.slice(-6)}%`] },
      ]);
      const event = await this.events.append({ type: "workbase.status_changed", aggregate: { kind: "work_base", id }, correlationId: createId("cor"), payload: { from: "building", to: "ready", tip } });
      this.bus.publish(event);
      return { ok: true, workBaseId: id, tipSha: tip, branch, path: real, reused: false };
    } catch (error) {
      const details = (error as OctusError & { details?: { conflict?: boolean; files?: unknown; ours?: unknown; theirs?: unknown } }).details;
      if (details?.conflict === true && Array.isArray(details.files) && typeof details.ours === "string" && typeof details.theirs === "string") {
        await this.markWorkBaseConflicted(id, { files: details.files as string[], ours: details.ours, theirs: details.theirs });
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        await this.db.exec("UPDATE work_bases SET status = 'stale', error = ?, updated_at = ? WHERE id = ?", [msg.slice(0, 1000), now(), id]);
        try {
          await runGit(repoRoot, ["worktree", "remove", "--force", candidate]);
        } catch {
          // queda para reconcile
        }
      }
      throw error;
    }
  }

  private async markWorkBaseConflicted(workbaseId: string, conflict: { files: string[]; ours: string; theirs: string }): Promise<void> {
    const timestamp = now();
    const conflictId = createId("cf");
    const wb = await this.db.queryOne<{ canonical_path: string; task_id: string }>("SELECT canonical_path, task_id FROM work_bases WHERE id = ?", [workbaseId]);
    const base = wb ? await this.mergeBase(String(wb.canonical_path), conflict.ours, conflict.theirs).catch(() => undefined) : undefined;
    await this.db.batch([
      {
        sql: "INSERT INTO integration_conflicts (id, scope, scope_ref, files, ours_sha, theirs_sha, base_sha, task_id, status, created_at, updated_at) VALUES (?, 'work_base', ?, ?, ?, ?, ?, ?, 'open', ?, ?)",
        params: [conflictId, workbaseId, JSON.stringify(conflict.files.slice(0, 200)), conflict.ours, conflict.theirs, base ?? null, wb ? String(wb.task_id) : null, timestamp, timestamp],
      },
      { sql: "UPDATE work_bases SET status = 'conflicted', error = 'predecessors conflict; resolution required', updated_at = ? WHERE id = ?", params: [timestamp, workbaseId] },
    ]);
    const event = await this.events.append({ type: "integration.conflict_opened", aggregate: { kind: "work_base", id: workbaseId }, correlationId: createId("cor"), payload: { conflictId, scope: "work_base", files: conflict.files.slice(0, 20), taskId: wb ? String(wb.task_id) : undefined } });
    this.bus.publish(event);
  }

  private async uniqueWorkBaseBranch(repoRoot: string, repoId: string, runId: string, taskId: string): Promise<string> {
    void repoId;
    const base = `harness/workbase/run-${runId}/task-${taskId}`;
    await assertValidBranchName(repoRoot, base);
    const taken = new Set(await this.repos.listBranches(repoRoot).catch(() => [] as string[]));
    if (!taken.has(base)) return base;
    for (let n = 2; n <= 50; n++) {
      const candidate = `${base}-r${n}`;
      await assertValidBranchName(repoRoot, candidate);
      if (!taken.has(candidate)) return candidate;
    }
    throw new OctusError("invalid_state", `No free workbase branch for task ${taskId} after 50 attempts`);
  }

  private async physicalRefExists(repoRoot: string, canonicalPath: string): Promise<boolean> {
    let entries: Array<{ path: string }> = [];
    try {
      entries = await this.repos.listWorktrees(repoRoot);
    } catch {
      return false;
    }
    return entries.some((e) => this.samePath(e.path, canonicalPath));
  }

  private samePath(a: string, b: string): boolean {
    const norm = (p: string): string => {
      let out = p.replaceAll("\\", "/");
      if (process.platform === "win32") out = out.toLowerCase();
      return out.replace(/\/+$/, "");
    };
    return norm(a) === norm(b);
  }

  private async physicalIntegrationWorkspace(canonicalPath: string): Promise<boolean> {
    try {
      const toplevel = realpathSync((await runGit(canonicalPath, ["rev-parse", "--show-toplevel"])).stdout.trim());
      return this.samePath(toplevel, canonicalPath) || this.samePath(realpathSync(canonicalPath), canonicalPath);
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- internas (resto)
  private async markConflicted(integrationId: string, opId: string, conflict: { files: string[]; ours: string; theirs: string }, taskId: string, attempt: number): Promise<void> {
    const timestamp = now();
    const conflictId = createId("cf");
    const base = await this.mergeBase(await this.canonicalOf(integrationId), conflict.ours, conflict.theirs).catch(() => undefined);
    await this.db.batch([
      {
        sql: "INSERT INTO integration_conflicts (id, scope, scope_ref, files, ours_sha, theirs_sha, base_sha, task_id, attempt, status, created_at, updated_at) VALUES (?, 'integration', ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)",
        params: [conflictId, integrationId, JSON.stringify(conflict.files.slice(0, 200)), conflict.ours, conflict.theirs, base ?? null, taskId, attempt, timestamp, timestamp],
      },
      { sql: "UPDATE integrations SET status = 'conflicted', updated_at = ? WHERE id = ?", params: [timestamp, integrationId] },
      { sql: "UPDATE integration_ops SET status = 'failed', step = 'conflict', detail = ?, updated_at = ? WHERE id = ?", params: [`task ${taskId.slice(-6)}: ${conflict.files.slice(0, 10).join(",")}`.slice(0, 2000), timestamp, opId] },
    ]);
    const event = await this.events.append({ type: "integration.conflict_opened", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { conflictId, files: conflict.files.slice(0, 20), taskId } });
    this.bus.publish(event);
  }

  private async canonicalOf(integrationId: string): Promise<string> {
    const row = await this.db.queryOne<{ canonical_path: string }>("SELECT canonical_path FROM integrations WHERE id = ?", [integrationId]);
    if (!row) throw new OctusError("not_found", `Integration not found: ${integrationId}`);
    return String(row.canonical_path);
  }

  private async repoRootFor(integration: Integration): Promise<string> {
    const row = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM repositories WHERE id = ?", [integration.repositoryId]);
    if (!row) throw new OctusError("not_found", `Repository not found: ${integration.repositoryId}`);
    return String(row.root_path);
  }

  private async sessionDirOf(runId: string): Promise<string> {
    const row = await this.db.queryOne<{ directory: string }>("SELECT s.directory AS directory FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ?", [runId]);
    return row ? String(row.directory) : "";
  }

  /** Scopes de escritura como rutas repo-relativas ('.' = raíz). */
  private async scopeRelatives(scopes: string[], sessionDir: string, repoRoot: string): Promise<string[]> {
    const repoReal = realpathSync(repoRoot);
    const out: string[] = [];
    for (const scope of scopes) {
      const abs = scope.startsWith("/") || /^[A-Za-z]:[\\/]/.test(scope) ? scope : `${sessionDir}/${scope}`;
      let real = abs;
      try {
        real = realpathSync(abs);
      } catch {
        real = abs;
      }
      if (!sameOrInside(repoReal, real)) {
        throw new OctusError("scope_violation", `Write scope is outside the repository: ${scope.slice(0, 200)}`);
      }
      const rel = path.relative(repoReal, real).replaceAll("\\", "/") || ".";
      out.push(rel);
    }
    return out.length > 0 ? out : ["."];
  }

  private async commitFiles(repoRoot: string, sha: string): Promise<string[]> {
    const { stdout } = await runGit(repoRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
    return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  private async isAncestor(cwd: string, ancestor: string, rev: string): Promise<boolean> {
    try {
      await runGit(cwd, ["merge-base", "--is-ancestor", ancestor, rev]);
      return true;
    } catch {
      return false;
    }
  }

  private async mergeBase(cwd: string, a: string, b: string): Promise<string> {
    return (await runGit(cwd, ["merge-base", a, b])).stdout.trim();
  }

  private async tryFastForward(intPath: string, produced: string): Promise<boolean> {
    try {
      await runGit(intPath, ["merge", "--ff-only", produced]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Merge real en la rama actual. En conflicto: captura archivos, aborta (la rama
   * nunca queda con MERGE_HEAD) y lanza error estructurado {conflict:true}.
   */
  private async mergeBranchInto(cwd: string, produced: string, message: string, refForError: string): Promise<string> {
    try {
      await runGit(cwd, ["-c", "user.name=Octus Harness", "-c", "user.email=octus-harness@localhost", "merge", "--no-ff", "--no-edit", "-m", message, produced]);
    } catch (error) {
      const files = await this.conflictedFiles(cwd).catch(() => [] as string[]);
      try {
        await runGit(cwd, ["merge", "--abort"]);
      } catch {
        // si el abort falla, el reconcile lo detecta (MERGE_HEAD presente)
      }
      const head = await runGit(cwd, ["rev-parse", "HEAD"]).then((r) => r.stdout.trim(), () => "");
      throw new OctusError("tool_failed", `Merge conflict incorporating ${refForError} (${files.length} file(s)); workspace preserved, resolution required`, {
        details: { conflict: true, files, ours: head, theirs: produced },
      });
    }
    return (await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  }

  private async mergeNoFf(intPath: string, produced: string, taskId: string, attempt: number, integration: Integration): Promise<string> {
    return this.mergeBranchInto(intPath, produced, `harness: integrate task ${taskId} attempt ${attempt} (run ${integration.runId})`, `task ${taskId.slice(-6)}`);
  }

  private async conflictedFiles(intPath: string): Promise<string[]> {
    const { stdout } = await runGit(intPath, ["diff", "--name-only", "--diff-filter=U"]);
    return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  private async uniqueIntegrationBranch(repoRoot: string, repoId: string, runId: string): Promise<string> {
    const base = `harness/integration/run-${runId}`;
    await assertValidBranchName(repoRoot, base);
    const taken = new Set(await this.repos.listBranches(repoRoot).catch(() => [] as string[]));
    if (!taken.has(base)) return base;
    for (let n = 2; n <= 50; n++) {
      const candidate = `${base}-r${n}`;
      await assertValidBranchName(repoRoot, candidate);
      if (!taken.has(candidate)) return candidate;
    }
    throw new OctusError("invalid_state", `No free integration branch for run ${runId} after 50 attempts`);
  }

  private async validateFreshIntegration(repoRoot: string, candidate: string, baseSha: string): Promise<void> {
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      throw new OctusError("tool_failed", `Integration path missing after creation: ${candidate.slice(0, 200)}`);
    }
    const listed = await this.repos.listWorktrees(repoRoot);
    const norm = (p: string): string => {
      let out = p.replaceAll("\\", "/");
      if (process.platform === "win32") out = out.toLowerCase();
      return out.replace(/\/+$/, "");
    };
    if (!listed.some((e) => norm(e.path) === norm(real))) {
      throw new OctusError("tool_failed", "Created integration worktree is not registered in git");
    }
    const head = (await runGit(real, ["rev-parse", "HEAD"], { tries: 4 })).stdout.trim();
    if (head !== baseSha) {
      throw new OctusError("tool_failed", `Integration HEAD ${head.slice(0, 12)} does not match base ${baseSha.slice(0, 12)}`);
    }
    if (isUncPath(real)) throw new OctusError("scope_violation", "UNC paths are not allowed for integrations");
  }

  private async opStep(opId: string, step: string, detail?: string): Promise<void> {
    await this.db.exec("UPDATE integration_ops SET step = ?, detail = ?, updated_at = ? WHERE id = ?", [step.slice(0, 200), detail?.slice(0, 2000) ?? null, now(), opId]);
  }
}

function deserializeIntegration(row: Record<string, string | number | null>): Integration {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    repositoryId: String(row.repository_id),
    runId: String(row.run_id),
    targetBranch: String(row.target_branch),
    targetBaseCommit: String(row.target_base_commit),
    integrationBranch: String(row.integration_branch),
    canonicalPath: String(row.canonical_path),
    head: row.head ? String(row.head) : undefined,
    attempt: Number(row.attempt ?? 0),
    supersedes: row.supersedes ? String(row.supersedes) : undefined,
    status: row.status as IntegrationStatus,
    error: row.error ? String(row.error) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function deserializeCommit(row: Record<string, string | number | null>): IntegrationCommit {
  return {
    id: String(row.id),
    integrationId: String(row.integration_id),
    taskId: String(row.task_id),
    attempt: Number(row.attempt),
    instanceId: row.instance_id ? String(row.instance_id) : undefined,
    worktreeId: row.worktree_id ? String(row.worktree_id) : undefined,
    originalSha: String(row.original_sha),
    integratedSha: String(row.integrated_sha),
    kind: row.kind as IntegrationCommit["kind"],
    createdAt: Number(row.created_at),
  };
}

/**
 * Marca una task como integrada tras asentar su commit (completed/reviewed
 * → integrated). Idempotente; sin efecto en otros estados.
 */
export async function markTaskIntegrated(
  db: PersistenceService,
  events: EventStore,
  bus: EventBus,
  taskId: string,
): Promise<void> {
  const row = await db.queryOne<{ status: string }>("SELECT status FROM tasks WHERE id = ?", [taskId]);
  if (!row || !["completed", "reviewed"].includes(String(row.status))) return;
  const timestamp = now();
  await db.exec("UPDATE tasks SET status = 'integrated', updated_at = ? WHERE id = ? AND status IN ('completed','reviewed')", [timestamp, taskId]);
  const event = await events.append({ type: "task.status_changed", aggregate: { kind: "task", id: taskId }, correlationId: createId("cor"), payload: { from: String(row.status), to: "integrated" } });
  bus.publish(event);
}

function deserializeOp(row: Record<string, string | number | null>): IntegrationOperation {
  return {
    id: String(row.id),
    integrationId: row.integration_id ? String(row.integration_id) : undefined,
    op: row.op as IntegrationOperation["op"],
    status: row.status as IntegrationOperation["status"],
    step: row.step ? String(row.step) : undefined,
    detail: row.detail ? String(row.detail) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
