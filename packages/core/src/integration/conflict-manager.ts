/**
 * @octus/core — ConflictManager: resolución asistida de conflictos (Etapa 5, §C).
 * Determinista salvo el agente que propone: prepara un worktree de resolución
 * con el merge a medias (MERGE_HEAD vive SOLO ahí), spawnea un implementer con
 * scope estricto, valida el resultado y lo incorpora sin tocar la rama destino.
 * Sin perfiles nuevos: reutiliza implementer (resuelve) y reviewer (revisa).
 * El agente NUNCA commitea: el harness fija el merge commit (padres intactos).
 */
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { createId, type IntegrationConflict } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { isSecretBasename, isUncPath, sameOrInside } from "../tools/path-scope.js";
import { now } from "../util.js";
import { assertValidBranchName, runGit } from "../repositories/git-exec.js";
import type { RepositoryManager } from "../repositories/repository-manager.js";
import type { AgentManager } from "../orchestration/agent-manager.js";
import type { WorktreeManager } from "../worktrees/worktree-manager.js";
import type { ResolutionPort, ResolutionWorkspace } from "./resolution-port.js";

export interface RequestResolutionResult {
  conflictId: string;
  instanceId?: string;
  resolutionSha?: string;
  reused: boolean;
  workspacePath: string;
  branchName: string;
}

export class ConflictManager implements ResolutionPort {
  constructor(
    private readonly db: PersistenceService,
    private readonly events: EventStore,
    private readonly bus: EventBus,
    private readonly repos: RepositoryManager,
    private readonly worktrees: WorktreeManager,
    private readonly agents: () => AgentManager,
    private readonly dataDir: string,
  ) {}

  // ------------------------------------------------------------------ lectura
  async getConflict(id: string): Promise<IntegrationConflict> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM integration_conflicts WHERE id = ?", [id]);
    if (!row) throw new OctusError("not_found", `Conflict not found: ${id}`);
    return deserializeConflict(row);
  }

  async listConflicts(filter?: { scope?: "integration" | "work_base"; scopeRef?: string; status?: string }): Promise<IntegrationConflict[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.scope) {
      clauses.push("scope = ?");
      params.push(filter.scope);
    }
    if (filter?.scopeRef) {
      clauses.push("scope_ref = ?");
      params.push(filter.scopeRef);
    }
    if (filter?.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const rows = await this.db.query<Record<string, string | number | null>>(
      `SELECT * FROM integration_conflicts ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at ASC`,
      params as import("../persistence/protocol.js").SqlParam[],
    );
    return rows.map(deserializeConflict);
  }

  /** Puerto consumido por AgentManager: el workspace existe físicamente. */
  async getResolutionWorkspace(conflictId: string): Promise<ResolutionWorkspace | undefined> {
    const conflict = await this.getConflict(conflictId).catch(() => undefined);
    if (!conflict) return undefined;
    const ctx = await this.resolutionContext(conflict).catch(() => undefined);
    if (!ctx) return undefined;
    const candidate = path.join(ctx.worktreesRoot, "resolutions", conflictId);
    if (!(await this.physicalWorkspace(ctx.repoRoot, candidate))) return undefined;
    return {
      id: conflictId,
      projectId: ctx.projectId,
      path: realpathSync(candidate),
      branchName: `harness/resolution/${conflictId}`,
      status: conflict.status,
    };
  }

  // ------------------------------------------------------- resolución asistida
  /**
   * Prepara el workspace de resolución y spawnea el implementer. Idempotente:
   * reutiliza resoluciones previas con los mismos padres, el workspace
   * existente y la instancia activa (sin agentes duplicados).
   */
  async requestResolution(conflictId: string, opts?: { briefSuffix?: string }): Promise<RequestResolutionResult> {
    const conflict = await this.getConflict(conflictId);
    if (conflict.status === "resolved" || conflict.status === "aborted") {
      throw new OctusError("invalid_state", `Conflict ${conflictId} is ${conflict.status}`);
    }
    const ctx = await this.resolutionContext(conflict);
    const branch = `harness/resolution/${conflictId}`;
    await assertValidBranchName(ctx.repoRoot, branch);

    // Reutilización: misma pareja (ours, theirs) ya resuelta y verificada
    // contra el tip actual → sin agente, sin workspace nuevo.
    const reusable = await this.findReusableResolution(ctx.repoRoot, conflict.oursSha, conflict.theirsSha, ctx.currentTip);
    if (reusable) {
      await this.markResolved(conflict, reusable, null, true);
      return { conflictId, resolutionSha: reusable, reused: true, workspacePath: path.join(ctx.worktreesRoot, "resolutions", conflictId), branchName: branch };
    }

    // Workspace: crear o adoptar (mid-merge existente).
    const candidate = path.join(ctx.worktreesRoot, "resolutions", conflictId);
    if (isUncPath(candidate)) throw new OctusError("scope_violation", "UNC paths are not allowed for resolution workspaces");
    const cleanMerged = await this.prepareWorkspace(ctx.repoRoot, candidate, branch, conflict.oursSha, conflict.theirsSha);
    const real = realpathSync(candidate);
    if (cleanMerged) {
      // Merge limpio al reproducir: resuelto por el harness sin agente.
      await this.markResolved(conflict, cleanMerged, null, false);
      return { conflictId, resolutionSha: cleanMerged, reused: false, workspacePath: real, branchName: branch };
    }

    // Instancia activa existente → no duplicar agentes.
    if (conflict.status === "resolving" && conflict.resolutionInstanceId) {
      const active = await this.db.queryOne<{ status: string }>("SELECT status FROM agent_instances WHERE id = ?", [conflict.resolutionInstanceId]).catch(() => null);
      if (active && ["created", "running", "waiting_permission", "waiting_input"].includes(String(active.status))) {
        return { conflictId, instanceId: conflict.resolutionInstanceId, reused: true, workspacePath: real, branchName: branch };
      }
    }

    const opId = createId("iop");
    const timestamp = now();
    await this.db.exec("INSERT INTO integration_ops (id, integration_id, op, status, step, detail, created_at, updated_at) VALUES (?, ?, 'resolution', 'started', 'spawn', ?, ?, ?)", [
      opId,
      conflict.scope === "integration" ? conflict.scopeRef : null,
      JSON.stringify({ conflict: conflictId, workspace: real }),
      timestamp,
      timestamp,
    ]);
    const coord = await this.requireCoordinatorInstance(ctx.runId);
    const brief = this.resolutionBrief(conflict, ctx, opts?.briefSuffix);
    const spawned = await this.agents().spawn({
      parentInstanceId: coord,
      definitionId: "implementer",
      brief,
      mode: "background",
      resolutionWorkspaceId: conflictId,
    });
    await this.db.batch([
      { sql: "UPDATE integration_conflicts SET status = 'resolving', resolution_instance_id = ?, updated_at = ? WHERE id = ?", params: [spawned.instanceId, now(), conflictId] },
      { sql: "UPDATE integration_ops SET status = 'done', step = 'spawned', detail = ?, updated_at = ? WHERE id = ?", params: [spawned.instanceId.slice(0, 200), now(), opId] },
    ]);
    const event = await this.events.append({ type: "resolution.requested", aggregate: { kind: conflict.scope === "integration" ? "integration" : "work_base", id: conflict.scopeRef }, correlationId: createId("cor"), payload: { conflictId, instanceId: spawned.instanceId } });
    this.bus.publish(event);
    return { conflictId, instanceId: spawned.instanceId, reused: false, workspacePath: real, branchName: branch };
  }

  /**
   * Valida el trabajo del agente y fija el merge commit con el harness.
   * El agente edita; solo el harness commitea (padres intactos).
   */
  async finalizeResolution(conflictId: string, instanceId: string): Promise<{ resolutionSha: string }> {
    const conflict = await this.getConflict(conflictId);
    if (conflict.status !== "resolving") {
      throw new OctusError("invalid_state", `Conflict ${conflictId} is ${conflict.status}, not awaiting finalize`);
    }
    if (conflict.resolutionInstanceId !== instanceId) {
      throw new OctusError("invalid_state", `Instance ${instanceId.slice(-6)} is not the assigned resolver of conflict ${conflictId.slice(-6)}`);
    }
    const delivery = await this.agents().result(instanceId).catch(() => undefined);
    if (!delivery || delivery.status !== "completed") {
      throw new OctusError("invalid_state", `Resolver instance ${instanceId.slice(-6)} is not completed`);
    }
    const ctx = await this.resolutionContext(conflict);
    const ws = await this.getResolutionWorkspace(conflictId);
    if (!ws) throw new OctusError("not_found", `Resolution workspace for ${conflictId} is missing`);
    const cwd = ws.path;

    // Estado merge intacto: HEAD == ours, MERGE_HEAD == theirs.
    const mergeHead = await runGit(cwd, ["rev-parse", "--verify", "MERGE_HEAD"]).then((r) => r.stdout.trim(), () => "");
    if (mergeHead !== conflict.theirsSha) {
      throw new OctusError("invalid_state", `Resolution workspace is no longer in merge state (MERGE_HEAD mismatch); request a fresh resolution`);
    }
    const head = (await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
    if (head !== conflict.oursSha) {
      throw new OctusError("invalid_state", `Resolution workspace HEAD moved (${head.slice(0, 8)}); request a fresh resolution`);
    }
    // Solo ficheros del conflicto, sin secretos ni .git. Fuente: status porcelain
    // (cubre staged + unstaged + untracked; git diff solo no ve untracked).
    const unique = await this.workspaceChangedFiles(cwd);
    const outside = unique.filter((f) => !conflict.files.includes(f));
    if (outside.length > 0) {
      throw new OctusError("scope_violation", `Resolution touches files outside the conflict scope: ${outside.slice(0, 5).join(",")}`);
    }
    for (const f of unique) {
      if (f.split("/").includes(".git")) throw new OctusError("scope_violation", `Resolution touches .git internals: ${f.slice(0, 200)}`);
      const base = f.split("/").pop() ?? f;
      if (isSecretBasename(base)) throw new OctusError("scope_violation", `Resolution touches a protected secret file: ${f.slice(0, 200)}`);
    }
    if (unique.length === 0) {
      throw new OctusError("invalid_state", "No changes staged in the resolution workspace; edit the conflicting files first");
    }
    await runGit(cwd, ["add", "--", ...unique]);
    await runGit(cwd, ["-c", "user.name=Octus Harness", "-c", "user.email=octus-harness@localhost", "commit", "--no-edit"]);
    const sha = (await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const parents = await this.parentsOf(cwd, sha);
    if (parents[0] !== conflict.oursSha || parents[1] !== conflict.theirsSha) {
      throw new OctusError("tool_failed", `Resolution commit has unexpected parents (${parents.map((p) => p.slice(0, 8)).join(",")}); expected ours+theirs)`);
    }
    await this.markResolved(conflict, sha, instanceId, false);
    return { resolutionSha: sha };
  }

  /**
   * Incorpora una resolución validada a la integración (FF, padres verificados).
   * Idempotente por UNIQUE(integration, task, attempt).
   */
  async incorporateResolution(integrationId: string, conflictId: string): Promise<{ integratedSha: string; reused: boolean }> {
    const conflict = await this.getConflict(conflictId);
    if (conflict.scope !== "integration" || conflict.scopeRef !== integrationId) {
      throw new OctusError("invalid_state", `Conflict ${conflictId} does not belong to integration ${integrationId}`);
    }
    if (conflict.status !== "resolved" || !conflict.resolutionSha) {
      throw new OctusError("invalid_state", `Conflict ${conflictId} is ${conflict.status}, not resolved`);
    }
    if (!conflict.taskId || conflict.attempt === undefined) {
      throw new OctusError("invalid_state", `Conflict ${conflictId} has no linked task/attempt`);
    }
    const prior = await this.db.queryOne<{ integrated_sha: string }>("SELECT integrated_sha FROM integration_commits WHERE integration_id = ? AND task_id = ? AND attempt = ?", [integrationId, conflict.taskId, conflict.attempt]);
    if (prior) return { integratedSha: String(prior.integrated_sha), reused: true };
    const integration = await this.db.queryOne<{ canonical_path: string; head: string | null }>("SELECT canonical_path, head FROM integrations WHERE id = ?", [integrationId]);
    if (!integration) throw new OctusError("not_found", `Integration not found: ${integrationId}`);
    const intPath = realpathSync(String(integration.canonical_path));
    const parents = await this.parentsOf(intPath, conflict.resolutionSha);
    const head = String(integration.head ?? "");
    if (parents[0] !== head || parents[1] !== conflict.theirsSha) {
      throw new OctusError("invalid_state", `Resolution parents do not verify against integration HEAD (expected ${head.slice(0, 8)}+${conflict.theirsSha.slice(0, 8)})`);
    }
    await runGit(intPath, ["merge", "--ff-only", conflict.resolutionSha]);
    const commitId = createId("ic");
    const timestamp = now();
    await this.db.batch([
      {
        sql: "INSERT INTO integration_commits (id, integration_id, task_id, attempt, instance_id, worktree_id, original_sha, integrated_sha, kind, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'resolution', ?)",
        params: [commitId, integrationId, conflict.taskId, conflict.attempt, conflict.resolutionInstanceId ?? null, conflict.theirsSha, conflict.resolutionSha, timestamp],
      },
      { sql: "UPDATE integrations SET head = ?, status = 'building', updated_at = ? WHERE id = ?", params: [conflict.resolutionSha, timestamp, integrationId] },
      { sql: "INSERT INTO integration_ops (id, integration_id, op, status, step, detail, created_at, updated_at) VALUES (?, ?, 'incorporate', 'done', 'incorporated-resolution', ?, ?, ?)", params: [createId("iop"), integrationId, `${conflict.taskId.slice(-6)} via ${conflictId.slice(-6)}`, timestamp, timestamp] },
    ]);
    const event = await this.events.append({ type: "integration.status_changed", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { conflictId, strategy: "resolution", head: conflict.resolutionSha } });
    this.bus.publish(event);
    return { integratedSha: conflict.resolutionSha, reused: false };
  }

  /** Cierre explícito sin borrar nada (rama/worktree/commits preservados). */
  async abortResolution(conflictId: string, reason = "aborted"): Promise<void> {
    const conflict = await this.getConflict(conflictId);
    if (!["open", "resolving"].includes(conflict.status)) {
      throw new OctusError("invalid_state", `Conflict ${conflictId} is ${conflict.status}, cannot abort`);
    }
    await this.db.exec("UPDATE integration_conflicts SET status = 'aborted', updated_at = ? WHERE id = ?", [now(), conflictId]);
    const event = await this.events.append({ type: "integration.conflict_opened", aggregate: { kind: conflict.scope === "integration" ? "integration" : "work_base", id: conflict.scopeRef }, correlationId: createId("cor"), payload: { conflictId, to: "aborted", reason } });
    void event;
    this.bus.publish(await this.events.append({ type: "integration.status_changed", aggregate: { kind: conflict.scope === "integration" ? "integration" : "work_base", id: conflict.scopeRef }, correlationId: createId("cor"), payload: { conflictId, to: "aborted", reason } }));
  }

  /** Higiene de tests/herramientas: retira el worktree físico (la rama se conserva). */
  async cleanupResolutionWorkspace(conflictId: string): Promise<{ removed: boolean }> {
    const conflict = await this.getConflict(conflictId).catch(() => undefined);
    if (!conflict) return { removed: false };
    const ctx = await this.resolutionContext(conflict).catch(() => undefined);
    if (!ctx) return { removed: false };
    const candidate = path.join(ctx.worktreesRoot, "resolutions", conflictId);
    try {
      await runGit(ctx.repoRoot, ["worktree", "remove", "--force", candidate]);
      return { removed: true };
    } catch {
      return { removed: false };
    }
  }

  // ---------------------------------------------------------------- internas
  private async resolutionContext(conflict: IntegrationConflict): Promise<{ projectId: string; repoRoot: string; runId: string; worktreesRoot: string; currentTip: string }> {
    if (conflict.scope === "integration") {
      const integration = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM integrations WHERE id = ?", [conflict.scopeRef]);
      if (!integration) throw new OctusError("not_found", `Integration not found: ${conflict.scopeRef}`);
      const repo = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM repositories WHERE id = ?", [String(integration.repository_id)]);
      if (!repo) throw new OctusError("not_found", `Repository not found`);
      return {
        projectId: String(integration.project_id),
        repoRoot: String(repo.root_path),
        runId: String(integration.run_id),
        worktreesRoot: await this.worktrees.effectiveWorktreesRoot(String(integration.project_id)),
        currentTip: integration.head ? String(integration.head) : "",
      };
    }
    const wb = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM work_bases WHERE id = ?", [conflict.scopeRef]);
    if (!wb) throw new OctusError("not_found", `Work base not found: ${conflict.scopeRef}`);
    const repo = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM repositories WHERE id = ?", [String(wb.repository_id)]);
    if (!repo) throw new OctusError("not_found", `Repository not found`);
    return {
      projectId: String(wb.project_id),
      repoRoot: String(repo.root_path),
      runId: String(wb.run_id),
      worktreesRoot: await this.worktrees.effectiveWorktreesRoot(String(wb.project_id)),
      currentTip: String(wb.tip_sha),
    };
  }

  private async markResolved(conflict: IntegrationConflict, sha: string, instanceId: string | null, reused: boolean): Promise<void> {
    const timestamp = now();
    await this.db.batch([
      { sql: "UPDATE integration_conflicts SET status = 'resolved', resolution_sha = ?, updated_at = ? WHERE id = ?", params: [sha, timestamp, conflict.id] },
      { sql: "INSERT INTO conflict_resolutions (id, conflict_id, instance_id, resolution_sha, reused, created_at) VALUES (?, ?, ?, ?, ?, ?)", params: [createId("crs"), conflict.id, instanceId, sha, reused ? 1 : 0, timestamp] },
    ]);
    if (conflict.scope === "work_base") {
      await this.db.exec("UPDATE work_bases SET tip_sha = ?, status = 'ready', error = NULL, updated_at = ? WHERE id = ?", [sha, timestamp, conflict.scopeRef]);
      const event = await this.events.append({ type: "workbase.status_changed", aggregate: { kind: "work_base", id: conflict.scopeRef }, correlationId: createId("cor"), payload: { from: "conflicted", to: "ready", resolution: sha } });
      this.bus.publish(event);
    }
    const done = await this.events.append({ type: "resolution.completed", aggregate: { kind: conflict.scope === "integration" ? "integration" : "work_base", id: conflict.scopeRef }, correlationId: createId("cor"), payload: { conflictId: conflict.id, resolutionSha: sha, reused } });
    this.bus.publish(done);
  }

  /** Reutilización: misma pareja (ours, theirs) ya resuelta y padres aún válidos. */
  private async findReusableResolution(repoRoot: string, ours: string, theirs: string, currentTip: string): Promise<string | undefined> {
    if (!currentTip) return undefined;
    const rows = await this.db.query<{ sha: string }>(
      `SELECT r.resolution_sha AS sha FROM conflict_resolutions r JOIN integration_conflicts c ON c.id = r.conflict_id WHERE c.ours_sha = ? AND c.theirs_sha = ? ORDER BY r.created_at DESC`,
      [ours, theirs],
    );
    for (const r of rows) {
      const sha = String(r.sha);
      if (!(await this.repos.commitExists(repoRoot, sha))) continue;
      const parents = await this.parentsOf(repoRoot, sha).catch(() => [] as string[]);
      if (parents[0] === currentTip && parents[1] === theirs) return sha;
    }
    return undefined;
  }

  /**
   * Crea o adopta el workspace con el merge reproducido. Devuelve el tip si el
   * merge salió limpio (resuelto por el harness, sin agente) o null si hay
   * conflicto abierto para el agente.
   */
  private async prepareWorkspace(repoRoot: string, candidate: string, branch: string, ours: string, theirs: string): Promise<string | null> {
    const registered = await this.physicalWorkspace(repoRoot, candidate);
    if (!registered) {
      mkdirSync(path.dirname(candidate), { recursive: true });
      if (await this.branchExists(repoRoot, branch)) {
        await runGit(repoRoot, ["worktree", "add", candidate, branch]);
      } else {
        await runGit(repoRoot, ["worktree", "add", "-b", branch, candidate, ours]);
      }
      const real = realpathSync(candidate);
      const head = (await runGit(real, ["rev-parse", "HEAD"], { tries: 4 })).stdout.trim();
      if (head !== ours) {
        // Rama preexistente con otro tip: no tocar; el llamador decide.
        throw new OctusError("invalid_state", `Resolution branch ${branch} points at ${head.slice(0, 8)}, expected ${ours.slice(0, 8)}`);
      }
      // El merge queda A MEDIAS a propósito: MERGE_HEAD vive SOLO en este
      // worktree de resolución (jamás en la rama de integración).
      try {
        await runGit(real, ["-c", "user.name=Octus Harness", "-c", "user.email=octus-harness@localhost", "merge", "--no-ff", "--no-edit", "-m", `harness: reproduce conflict (${ours.slice(0, 8)}+${theirs.slice(0, 8)})`, theirs]);
      } catch {
        const files = await this.conflictedFiles(real).catch(() => [] as string[]);
        if (files.length === 0) {
          try {
            await runGit(real, ["merge", "--abort"]);
          } catch {
            // queda para reconcile
          }
          throw new OctusError("tool_failed", "Resolution workspace merge behaved unexpectedly");
        }
        return null; // conflicto abierto para el agente (con MERGE_HEAD intacto)
      }
      return (await runGit(real, ["rev-parse", "HEAD"])).stdout.trim();
    }
    // Adoptar: mid-merge existente (agente en curso) o merge ya limpio.
    const real = realpathSync(candidate);
    const mergeHead = await runGit(real, ["rev-parse", "--verify", "MERGE_HEAD"]).then((r) => r.stdout.trim(), () => "");
    if (mergeHead) return null; // a medias: para el agente
    const head = (await runGit(real, ["rev-parse", "HEAD"])).stdout.trim();
    if (head !== ours) return head; // ya fusionado limpio antes
    // Sin merge reproducido aún: reproducirlo ahora (queda a medias a propósito).
    try {
      await runGit(real, ["-c", "user.name=Octus Harness", "-c", "user.email=octus-harness@localhost", "merge", "--no-ff", "--no-edit", "-m", `harness: reproduce conflict (${ours.slice(0, 8)}+${theirs.slice(0, 8)})`, theirs]);
    } catch {
      const files = await this.conflictedFiles(real).catch(() => [] as string[]);
      if (files.length === 0) {
        try {
          await runGit(real, ["merge", "--abort"]);
        } catch {
          // queda para reconcile
        }
        throw new OctusError("tool_failed", "Resolution workspace merge behaved unexpectedly");
      }
      return null; // conflicto abierto para el agente (con MERGE_HEAD intacto)
    }
    return (await runGit(real, ["rev-parse", "HEAD"])).stdout.trim();
  }

  private async physicalWorkspace(repoRoot: string, candidate: string): Promise<boolean> {
    let entries: Array<{ path: string }> = [];
    try {
      entries = await this.repos.listWorktrees(repoRoot);
    } catch {
      return false;
    }
    const norm = (p: string): string => {
      let out = p.replaceAll("\\", "/");
      if (process.platform === "win32") out = out.toLowerCase();
      return out.replace(/\/+$/, "");
    };
    let real = candidate;
    try {
      real = realpathSync(candidate);
    } catch {
      return false;
    }
    return entries.some((e) => norm(e.path) === norm(real));
  }

  private async branchExists(repoRoot: string, branch: string): Promise<boolean> {
    const branches = await this.repos.listBranches(repoRoot).catch(() => [] as string[]);
    return branches.includes(branch);
  }

  /** Ficheros cambiados (staged, unstaged y untracked) vía status porcelain. */
  private async workspaceChangedFiles(cwd: string): Promise<string[]> {
    const { stdout } = await runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const out = new Set<string>();
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      // Formato: XY<espacio>ruta (renombres: "R  vieja -> nueva").
      const rest = line.slice(3);
      const arrow = rest.indexOf(" -> ");
      const rel = (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim().replace(/^"|"$/g, "");
      if (rel) out.add(rel);
    }
    return [...out];
  }

  private async conflictedFiles(cwd: string): Promise<string[]> {
    const { stdout } = await runGit(cwd, ["diff", "--name-only", "--diff-filter=U"]);
    return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  private async parentsOf(cwd: string, sha: string): Promise<string[]> {
    const out = (await runGit(cwd, ["rev-list", "--parents", "-n", "1", sha])).stdout.trim().split(/\s+/);
    return out.slice(1);
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

  private resolutionBrief(conflict: IntegrationConflict, ctx: { runId: string }, briefSuffix?: string): string {
    const files = conflict.files.map((f) => `- ${f}`).join("\n");
    return `Conflict resolution in an isolated workspace.
You are resolving a merge conflict between:
- ours (${conflict.oursSha.slice(0, 12)}): current state of the integration line
- theirs (${conflict.theirsSha.slice(0, 12)}): incoming changes
${conflict.baseSha ? `Common ancestor: ${conflict.baseSha.slice(0, 12)}` : "Common ancestor: unknown"}
Conflicting files (EDIT ONLY THESE):
${files}
Rules:
- Read the conflicting files and their conflict markers first.
- Edit ONLY the listed files to produce a correct merged result.
- Never commit, branch, merge, push, rebase or reset. Leave your edits UNCOMMITTED.
- Never touch files outside the listed set.
- End with a summary of each resolution decision.${briefSuffix ? `\n${briefSuffix}` : ""}`;
  }
}

function deserializeConflict(row: Record<string, string | number | null>): IntegrationConflict {
  const parseFiles = (value: string | number | null): string[] => {
    try {
      const parsed = JSON.parse(String(value ?? "[]")) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  };
  return {
    id: String(row.id),
    scope: row.scope as IntegrationConflict["scope"],
    scopeRef: String(row.scope_ref),
    files: parseFiles(row.files),
    oursSha: String(row.ours_sha),
    theirsSha: String(row.theirs_sha),
    baseSha: row.base_sha ? String(row.base_sha) : undefined,
    taskId: row.task_id ? String(row.task_id) : undefined,
    attempt: row.attempt !== null && row.attempt !== undefined ? Number(row.attempt) : undefined,
    status: row.status as IntegrationConflict["status"],
    resolutionSha: row.resolution_sha ? String(row.resolution_sha) : undefined,
    resolutionInstanceId: row.resolution_instance_id ? String(row.resolution_instance_id) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
