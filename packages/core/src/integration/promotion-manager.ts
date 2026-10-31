/**
 * @octus/core — PromotionManager: promoción segura a la rama destino (Etapa 5, §G).
 * Determinista. Solo se ejecuta tras aprobación explícita y válida: re-verifica
 * SHA exacto, destino inmóvil, validaciones y preview. Fast-forward cuando es
 * posible; CAS atómica (update-ref con old-value) cuando el destino no está
 * checked out. Sin stash automático, sin push, con journal recuperable.
 */
import { realpathSync } from "node:fs";
import { createId } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { now } from "../util.js";
import { runGit } from "../repositories/git-exec.js";
import type { RepositoryManager } from "../repositories/repository-manager.js";
import type { ApprovalService } from "./approval-service.js";
import type { IntegrationManager } from "./integration-manager.js";

export interface PromotionResult {
  promotionId: string;
  integrationId: string;
  newSha: string;
  targetBranch: string;
  reused: boolean;
}

export class PromotionManager {
  constructor(
    private readonly db: PersistenceService,
    private readonly events: EventStore,
    private readonly bus: EventBus,
    private readonly repos: RepositoryManager,
    private readonly approvals: ApprovalService,
    private readonly integrations: () => IntegrationManager,
  ) {}

  // ------------------------------------------------------------------ lectura
  async getPromotion(id: string): Promise<{ id: string; status: string }> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM promotions WHERE id = ?", [id]);
    if (!row) throw new OctusError("not_found", `Promotion not found: ${id}`);
    return { id: String(row.id), status: String(row.status) };
  }

  async listByIntegration(integrationId: string): Promise<Array<{ id: string; status: string }>> {
    const rows = await this.db.query<{ id: string; status: string }>("SELECT id, status FROM promotions WHERE integration_id = ? ORDER BY created_at ASC", [integrationId]);
    return rows.map((r) => ({ id: String(r.id), status: String(r.status) }));
  }

  /**
   * Promueve el head aprobado a la rama destino. Verifica aprobación vigente,
   * destino inmóvil y checkout seguro antes de mover nada. Idempotente si el
   * destino ya está en el SHA (devuelve reused sin tocar nada).
   */
  async promoteIntegration(integrationId: string): Promise<PromotionResult> {
    const integration = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM integrations WHERE id = ?", [integrationId]);
    if (!integration) throw new OctusError("not_found", `Integration not found: ${integrationId}`);
    if (!["approved", "promoted"].includes(String(integration.status))) {
      throw new OctusError("invalid_state", `Integration ${integrationId} is ${String(integration.status)}, not approved`);
    }
    const head = integration.head ? String(integration.head) : undefined;
    if (!head) throw new OctusError("invalid_state", `Integration ${integrationId} has no head to promote`);
    const targetBranch = String(integration.target_branch);
    // Ya promovida: solo re-verificar que el destino sigue en el head.
    if (String(integration.status) === "promoted") {
      const repo = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM repositories WHERE id = ?", [String(integration.repository_id)]);
      if (!repo) throw new OctusError("not_found", `Repository not found`);
      const tip = await this.targetTip(String(repo.root_path), targetBranch);
      if (tip === head) {
        const prior = await this.db.queryOne<{ id: string }>("SELECT id FROM promotions WHERE integration_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1", [integrationId]);
        return { promotionId: prior ? String(prior.id) : "already-applied", integrationId, newSha: head, targetBranch, reused: true };
      }
      throw new OctusError("invalid_state", `Integration ${integrationId} is already promoted but ${targetBranch} moved since (${tip.slice(0, 12)} != ${head.slice(0, 12)})`);
    }
    // Aprobación vigente (re-verifica SHA, destino, validaciones, preview).
    const approval = await this.db.queryOne<{ id: string }>("SELECT id FROM integration_approvals WHERE integration_id = ? AND candidate_sha = ? AND decision = 'approved'", [integrationId, head]);
    if (!approval) {
      throw new OctusError("invalid_state", `No approved decision for the current head of ${integrationId} (rebuild for a new decision)`);
    }
    const check = await this.approvals.checkApproval(String(approval.id));
    if (!check.ok) {
      const moved = check.reasons.some((r) => r.includes("target branch moved"));
      if (moved) {
        await this.markStale(integrationId, `target branch moved: ${check.reasons.join("; ").slice(0, 300)}`);
      } else {
        const event = await this.events.append({ type: "approval.invalidated", aggregate: { kind: "approval", id: String(approval.id) }, correlationId: createId("cor"), payload: { integrationId, reasons: check.reasons.slice(0, 5) } });
        this.bus.publish(event);
      }
      throw new OctusError("invalid_state", `Approval is no longer valid: ${check.reasons.join("; ").slice(0, 400)}`);
    }
    const repo = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM repositories WHERE id = ?", [String(integration.repository_id)]);
    if (!repo) throw new OctusError("not_found", `Repository not found`);
    const repoRoot = String(repo.root_path);
    // Idempotencia: destino ya en el SHA (promoción anterior efectiva o el
    // contenido ya estaba en destino). Convergir: cerrar papeles pendientes
    // (integración→promoted, run→done) en vez de devolver sin tocar nada —
    // si no, el run quedaría en integrating para siempre sin vía de salida.
    const tip = await this.targetTip(repoRoot, targetBranch);
    if (tip === head) {
      const prior = await this.db.queryOne<{ id: string }>("SELECT id FROM promotions WHERE integration_id = ? AND approval_id = ? AND status = 'completed'", [integrationId, String(approval.id)]);
      const intStatus = String(integration.status);
      const runRow = await this.db.queryOne<{ status: string }>("SELECT status FROM runs WHERE id = ?", [String(integration.run_id)]);
      const runStatus = runRow ? String(runRow.status) : undefined;
      const timestamp = now();
      const stmts: Array<{ sql: string; params: unknown[] }> = [];
      let promotionId: string;
      if (prior) {
        promotionId = String(prior.id);
      } else {
        promotionId = createId("pr");
        stmts.push({ sql: "INSERT INTO promotions (id, integration_id, approval_id, target_branch, expected_old_sha, new_sha, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)", params: [promotionId, integrationId, String(approval.id), targetBranch, tip, head, timestamp, timestamp] });
        stmts.push({ sql: "INSERT INTO promotion_ops (id, promotion_id, op, status, step, detail, created_at, updated_at) VALUES (?, ?, 'promote', 'done', 'converged-idempotent', ?, ?, ?)", params: [createId("pop"), promotionId, `destination already at ${head.slice(0, 12)}`, timestamp, timestamp] });
      }
      if (intStatus !== "promoted") {
        stmts.push({ sql: "UPDATE integrations SET status = 'promoted', updated_at = ? WHERE id = ?", params: [timestamp, integrationId] });
      }
      if (runStatus !== undefined && runStatus !== "done") {
        stmts.push({ sql: "UPDATE runs SET status = 'done', updated_at = ?, completed_at = ? WHERE id = ?", params: [timestamp, timestamp, String(integration.run_id)] });
      }
      if (stmts.length > 0) {
        await this.db.batch(stmts as Array<{ sql: string; params: import("../persistence/protocol.js").SqlParam[] }>);
      }
      if (intStatus !== "promoted") {
        const completed = await this.events.append({ type: "promotion.completed", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { promotionId, targetBranch, newSha: head, converged: true } });
        this.bus.publish(completed);
        const changed = await this.events.append({ type: "integration.status_changed", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { to: "promoted", head, converged: true } });
        this.bus.publish(changed);
      }
      if (runStatus !== undefined && runStatus !== "done") {
        const runDone = await this.events.append({ type: "run.completed", aggregate: { kind: "run", id: String(integration.run_id) }, correlationId: createId("cor"), payload: { via: "promotion", promotionId, converged: true } });
        this.bus.publish(runDone);
      }
      return { promotionId, integrationId, newSha: head, targetBranch, reused: true };
    }
    const promotionId = createId("pr");
    const opId = createId("pop");
    const timestamp = now();
    await this.db.batch([
      { sql: "INSERT INTO promotions (id, integration_id, approval_id, target_branch, expected_old_sha, new_sha, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'started', ?, ?)", params: [promotionId, integrationId, String(approval.id), targetBranch, tip, head, timestamp, timestamp] },
      { sql: "INSERT INTO promotion_ops (id, promotion_id, op, status, step, created_at, updated_at) VALUES (?, ?, 'promote', 'started', 'begin', ?, ?)", params: [opId, promotionId, timestamp, timestamp] },
    ]);
    const started = await this.events.append({ type: "promotion.started", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { promotionId, targetBranch, expectedOld: tip, newSha: head } });
    this.bus.publish(started);
    await this.db.exec("UPDATE runs SET status = 'promoting', updated_at = ? WHERE id = ?", [timestamp, String(integration.run_id)]);
    try {
      await this.promoteToTarget(repoRoot, targetBranch, tip, head);
      const done = now();
      await this.db.batch([
        { sql: "UPDATE promotions SET status = 'completed', updated_at = ? WHERE id = ?", params: [done, promotionId] },
        { sql: "UPDATE promotion_ops SET status = 'done', step = 'promoted', updated_at = ? WHERE id = ?", params: [done, opId] },
        { sql: "UPDATE integrations SET status = 'promoted', updated_at = ? WHERE id = ?", params: [done, integrationId] },
        { sql: "UPDATE runs SET status = 'done', updated_at = ?, completed_at = ? WHERE id = ?", params: [done, done, String(integration.run_id)] },
      ]);
      const completed = await this.events.append({ type: "promotion.completed", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { promotionId, targetBranch, newSha: head } });
      this.bus.publish(completed);
      const runDone = await this.events.append({ type: "run.completed", aggregate: { kind: "run", id: String(integration.run_id) }, correlationId: createId("cor"), payload: { via: "promotion", promotionId } });
      this.bus.publish(runDone);
      const changed = await this.events.append({ type: "integration.status_changed", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { to: "promoted", head } });
      this.bus.publish(changed);
      return { promotionId, integrationId, newSha: head, targetBranch, reused: false };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const moved = /target branch moved|changed under|CAS|changed while/i.test(msg);
      if (moved) {
        await this.markStale(integrationId, msg.slice(0, 500));
      }
      await this.db.exec("UPDATE promotion_ops SET status = 'failed', step = 'promote failed', detail = ?, updated_at = ? WHERE id = ?", [msg.slice(0, 2000), now(), opId]);
      await this.db.exec("UPDATE promotions SET status = ?, updated_at = ? WHERE id = ?", [moved ? "diverged" : "failed", now(), promotionId]);
      const failed = await this.events.append({ type: "promotion.failed", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { promotionId, reason: msg.slice(0, 500) } });
      this.bus.publish(failed);
      if (error instanceof OctusError) throw error;
      throw new OctusError("tool_failed", `Promotion failed: ${msg.slice(0, 300)}`);
    }
  }

  /**
   * Marca la integración como stale (destino movido): conserva todo para
   * auditoría; re-decidir exige rebuild explícito.
   */
  async markStale(integrationId: string, reason: string): Promise<void> {
    const timestamp = now();
    await this.db.exec("UPDATE integrations SET status = 'stale', error = ?, updated_at = ? WHERE id = ? AND status NOT IN ('promoted','stale')", [reason.slice(0, 500), timestamp, integrationId]);
    const event = await this.events.append({ type: "integration.status_changed", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { to: "stale", reason: reason.slice(0, 300) } });
    this.bus.publish(event);
    const invalidated = await this.events.append({ type: "approval.invalidated", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { integrationId, reason: reason.slice(0, 300) } });
    this.bus.publish(invalidated);
  }

  /**
   * Rebuild explícito tras stale/failed/aborted (nunca tras rejected: exige
   * un run nuevo). Fila nueva con attempt+1 que supersede a la anterior.
   */
  async rebuildIntegration(integrationId: string): Promise<{ id: string; attempt: number }> {
    const integration = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM integrations WHERE id = ?", [integrationId]);
    if (!integration) throw new OctusError("not_found", `Integration not found: ${integrationId}`);
    if (!["stale", "failed", "aborted"].includes(String(integration.status))) {
      throw new OctusError("invalid_state", `Integration ${integrationId} is ${String(integration.status)}; rebuild requires stale, failed or aborted (rejected needs a new run)`);
    }
    await this.db.exec("UPDATE integrations SET status = 'stale', updated_at = ? WHERE id = ? AND status <> 'stale'", [now(), integrationId]);
    const fresh = await this.integrations().createForRun(
      { projectId: String(integration.project_id), runId: String(integration.run_id), targetBranch: String(integration.target_branch) },
      { supersedes: integrationId },
    );
    return { id: fresh.id, attempt: fresh.attempt };
  }

  /**
   * Reconciliación post-interrupción: determina el estado real comparando el
   * tip del destino (nunca repite a ciegas). Sin auto-run (ADR-040).
   */
  async reconcile(): Promise<{ resolved: number; diverged: number }> {
    let resolved = 0;
    let diverged = 0;
    const pending = await this.db.query<Record<string, string | number | null>>("SELECT * FROM promotions WHERE status = 'started' ORDER BY created_at ASC");
    for (const p of pending) {
      const promotionId = String(p.id);
      const integrationId = String(p.integration_id);
      const integration = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM integrations WHERE id = ?", [integrationId]).catch(() => null);
      if (!integration) {
        await this.db.exec("UPDATE promotions SET status = 'failed', updated_at = ? WHERE id = ?", [now(), promotionId]);
        resolved++;
        continue;
      }
      const repo = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM repositories WHERE id = ?", [String(integration.repository_id)]).catch(() => null);
      if (!repo) {
        await this.db.exec("UPDATE promotions SET status = 'failed', updated_at = ? WHERE id = ?", [now(), promotionId]);
        resolved++;
        continue;
      }
      let tip = "";
      try {
        tip = (await runGit(String(repo.root_path), ["rev-parse", String(p.target_branch)])).stdout.trim();
      } catch {
        await this.db.exec("UPDATE promotions SET status = 'failed', updated_at = ? WHERE id = ?", [now(), promotionId]);
        resolved++;
        continue;
      }
      const expectedOld = String(p.expected_old_sha);
      const newSha = String(p.new_sha);
      if (tip === newSha) {
        // La promoción se completó antes del corte: cerrar el papeleo
        // (incluido el run: si no, el próximo settle lo cancelaría).
        const runId = String(integration.run_id ?? "");
        const batchOps: Array<{ sql: string; params: unknown[] }> = [
          { sql: "UPDATE promotions SET status = 'completed', updated_at = ? WHERE id = ?", params: [now(), promotionId] },
          { sql: "UPDATE integrations SET status = 'promoted', updated_at = ? WHERE id = ? AND status <> 'promoted'", params: [now(), integrationId] },
        ];
        if (runId) {
          batchOps.push({ sql: "UPDATE runs SET status = 'done', updated_at = ?, completed_at = ? WHERE id = ? AND status <> 'done'", params: [now(), now(), runId] });
        }
        await this.db.batch(batchOps as Array<{ sql: string; params: import("../persistence/protocol.js").SqlParam[] }>);
        const event = await this.events.append({ type: "promotion.completed", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { promotionId, recovered: true } });
        this.bus.publish(event);
        resolved++;
      } else if (tip === expectedOld) {
        // Nunca empezó: marcar failed para reintentar con fila nueva.
        await this.db.exec("UPDATE promotions SET status = 'failed', updated_at = ? WHERE id = ?", [now(), promotionId]);
        resolved++;
      } else {
        // Tercer estado: alguien más movió el destino.
        await this.db.exec("UPDATE promotions SET status = 'diverged', updated_at = ? WHERE id = ?", [now(), promotionId]);
        await this.markStale(integrationId, `target moved during promotion (tip ${tip.slice(0, 12)})`);
        diverged++;
      }
    }
    return { resolved, diverged };
  }

  // ---------------------------------------------------------------- internas
  private async targetTip(repoRoot: string, targetBranch: string): Promise<string> {
    try {
      return (await runGit(repoRoot, ["rev-parse", targetBranch])).stdout.trim();
    } catch {
      throw new OctusError("invalid_state", `Target branch ${targetBranch} is not resolvable`);
    }
  }

  /**
   * Promoción segura: destino checked-out+limpio → merge --ff-only allí;
   * destino no checked-out → update-ref CAS. Sucio/incompleto → bloqueo.
   * Nunca stash, nunca push.
   */
  private async promoteToTarget(repoRoot: string, targetBranch: string, expectedOld: string, newSha: string): Promise<void> {
    const entries = await this.repos.listWorktrees(repoRoot);
    const holder = entries.find((e) => e.branch === targetBranch);
    if (holder) {
      let real = holder.path;
      try {
        real = realpathSync(holder.path);
      } catch {
        throw new OctusError("invalid_state", `Target branch is checked out at an unreadable path: ${holder.path.slice(0, 200)}`);
      }
      const porcelain = (await runGit(real, ["status", "--porcelain=v1"])).stdout.trim();
      if (porcelain) {
        throw new OctusError("invalid_state", `Target branch is checked out at ${real.slice(-60)} with pending changes; clean it or move it before promoting (no stash, no destructive cleanup)`);
      }
      let commonDir = "";
      try {
        commonDir = (await runGit(real, ["rev-parse", "--git-common-dir"])).stdout.trim();
      } catch {
        throw new OctusError("invalid_state", `Target checkout at ${real.slice(-60)} is not readable as git`);
      }
      const incomplete = await this.repos.detectIncompleteOperation(real, commonDir || undefined);
      if (incomplete) {
        throw new OctusError("invalid_state", `Target checkout has an incomplete ${incomplete.kind} operation (${incomplete.detail}); resolve it before promoting`);
      }
      await runGit(real, ["merge", "--ff-only", newSha]);
    } else {
      // CAS atómica: solo promueve si el destino sigue en expectedOld.
      try {
        await runGit(repoRoot, ["update-ref", `refs/heads/${targetBranch}`, newSha, expectedOld]);
      } catch {
        throw new OctusError("invalid_state", `Target branch moved while promoting (expected ${expectedOld.slice(0, 12)}); promotion refused, mark stale and rebuild`);
      }
    }
    const tip = (await runGit(repoRoot, ["rev-parse", targetBranch])).stdout.trim();
    if (tip !== newSha) {
      throw new OctusError("tool_failed", `Promotion verification failed: ${targetBranch} is at ${tip.slice(0, 12)}, expected ${newSha.slice(0, 12)}`);
    }
  }
}
