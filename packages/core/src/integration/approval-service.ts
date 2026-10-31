/**
 * @octus/core — ApprovalService: aprobación explícita del usuario (Etapa 5, §F).
 * Determinista. La aprobación queda vinculada de forma inmutable a
 * (integration, head exacto, preview|waiver, destino+base observados,
 * hash de validaciones, actor=user, fecha). Cualquier cambio posterior
 * invalida (nunca autoriza una versión nueva). Rechazar es terminal + rebuild.
 */
import { createHash } from "node:crypto";
import { createId, type Approval, type Integration } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { now } from "../util.js";
import { runGit } from "../repositories/git-exec.js";
import type { ValidationService } from "./validation-service.js";
import type { PreviewManager } from "./preview-manager.js";

export interface ApprovalCheck {
  ok: boolean;
  reasons: string[];
  approval?: Approval;
}

export class ApprovalService {
  constructor(
    private readonly db: PersistenceService,
    private readonly events: EventStore,
    private readonly bus: EventBus,
    private readonly validations: ValidationService,
    private readonly previews: PreviewManager,
  ) {}

  // ------------------------------------------------------------------ lectura
  async getApproval(id: string): Promise<Approval> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM integration_approvals WHERE id = ?", [id]);
    if (!row) throw new OctusError("not_found", `Approval not found: ${id}`);
    return deserializeApproval(row);
  }

  async listApprovals(integrationId: string): Promise<Approval[]> {
    const rows = await this.db.query<Record<string, string | number | null>>("SELECT * FROM integration_approvals WHERE integration_id = ? ORDER BY created_at ASC", [integrationId]);
    return rows.map(deserializeApproval);
  }

  /**
   * Validez viva de una aprobación: head, destino, validaciones y preview
   * deben coincidir con lo registrado. Sin auto-reparación.
   */
  async checkApproval(approvalId: string): Promise<ApprovalCheck> {
    const approval = await this.getApproval(approvalId);
    const reasons: string[] = [];
    if (approval.decision !== "approved") {
      return { ok: false, reasons: [`decision is ${approval.decision}, not approved`], approval };
    }
    const integration = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM integrations WHERE id = ?", [approval.integrationId]);
    if (!integration) return { ok: false, reasons: ["integration row gone"], approval };
    // Deriva física: el worktree de integración debe seguir en el SHA aprobado.
    try {
      const physical = (await runGit(String(integration.canonical_path), ["rev-parse", "HEAD"])).stdout.trim();
      if (physical !== approval.candidateSha) {
        reasons.push(`integration workspace HEAD moved (${physical.slice(0, 12)} != approved ${approval.candidateSha.slice(0, 12)})`);
      }
    } catch {
      reasons.push("integration workspace is not readable");
    }
    const head = integration.head ? String(integration.head) : undefined;
    if (head !== approval.candidateSha) {
      reasons.push(`integration HEAD moved (${(head ?? "none").slice(0, 12)} != approved ${(approval.candidateSha).slice(0, 12)})`);
    }
    const currentTip = await this.targetTip(String(integration.repository_id), approval.targetBranch).catch(() => undefined);
    if (currentTip === undefined) {
      reasons.push("target branch is not resolvable");
    } else if (currentTip !== approval.targetShaObserved) {
      reasons.push(`target branch moved (${currentTip.slice(0, 12)} != observed ${approval.targetShaObserved.slice(0, 12)})`);
    }
    const gate = await this.validations.validationGate(approval.integrationId, approval.candidateSha);
    if (!gate.ok) reasons.push(`validations no longer pass: ${gate.reasons.join("; ")}`);
    const validationsHash = await this.validationsHash(approval.integrationId, approval.candidateSha);
    if (validationsHash !== approval.validationsHash) {
      reasons.push("validation report changed since approval");
    }
    if (approval.previewId) {
      const preview = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM previews WHERE id = ?", [approval.previewId]).catch(() => null);
      if (!preview) {
        reasons.push("approved preview is gone");
      } else {
        if (String(preview.sha) !== approval.candidateSha) reasons.push("preview SHA no longer matches the approved head");
        const live = await this.previews.verifyReachable(String(preview.id)).catch(() => false);
        if (!live) reasons.push("approved preview is not reachable anymore");
      }
    }
    return { ok: reasons.length === 0, reasons, approval };
  }

  async getApprovalStatus(integrationId: string): Promise<ApprovalCheck> {
    const integration = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM integrations WHERE id = ?", [integrationId]);
    if (!integration || !integration.head) {
      return { ok: false, reasons: ["no integration head"], approval: undefined };
    }
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM integration_approvals WHERE integration_id = ? AND candidate_sha = ?", [integrationId, String(integration.head)]);
    if (!row) return { ok: false, reasons: ["no approval for the current head"], approval: undefined };
    return this.checkApproval(String(row.id));
  }

  // ------------------------------------------------------------------ decidir
  /**
   * Aprueba el head exacto. Requiere suite clara + review accept (gate),
   * preview reachable sobre el head o waiver explícito con motivo (P5: el
   * waiver está prohibido si existe cualquier preview para ese head).
   * Idempotente ante duplicado idéntico; decisión distinta exige rebuild.
   */
  async approveIntegration(integrationId: string, input: { previewId?: string; waiverReason?: string }): Promise<{ approvalId: string; duplicate: boolean }> {
    const integration = await this.getIntegration(integrationId);
    if (!integration.head) throw new OctusError("invalid_state", `Integration ${integrationId} has no head to approve`);
    // Idempotente ante duplicado idéntico (vale en cualquier estado posterior);
    // decisión distinta exige rebuild.
    const existing = await this.db.queryOne<{ id: string; decision: string }>("SELECT id, decision FROM integration_approvals WHERE integration_id = ? AND candidate_sha = ?", [integrationId, integration.head]);
    if (existing) {
      if (existing.decision === "approved") return { approvalId: String(existing.id), duplicate: true };
      throw new OctusError("invalid_state", "A decision is already recorded for this head; rebuild for a new decision");
    }
    if (!["validating", "preview_ready"].includes(integration.status)) {
      throw new OctusError("invalid_state", `Integration ${integrationId} is ${integration.status}, not ready for approval`);
    }
    const gate = await this.validations.validationGate(integrationId, integration.head);
    if (!gate.ok) {
      throw new OctusError("invalid_state", `Cannot approve: ${gate.reasons.join("; ").slice(0, 500)}`);
    }
    let previewId: string | undefined;
    if (input.previewId) {
      if (input.waiverReason) throw new OctusError("invalid_tool_args", "Cannot combine a preview with a waiver");
      const preview = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM previews WHERE id = ?", [input.previewId]);
      if (!preview || String(preview.integration_id) !== integrationId) {
        throw new OctusError("not_found", `Preview ${input.previewId} does not belong to integration ${integrationId}`);
      }
      if (String(preview.sha) !== integration.head) {
        throw new OctusError("invalid_state", `Preview is at ${String(preview.sha).slice(0, 12)}, not at the integration head`);
      }
      const live = await this.previews.verifyReachable(input.previewId);
      if (!live) throw new OctusError("invalid_state", `Preview ${input.previewId} is not reachable`);
      previewId = input.previewId;
    } else {
      if (!input.waiverReason || !input.waiverReason.trim()) {
        throw new OctusError("invalid_tool_args", "Approval requires a reachable preview or an explicit waiver reason");
      }
      const existingPreview = await this.db.queryOne<{ id: string }>("SELECT id FROM previews WHERE integration_id = ? AND sha = ? LIMIT 1", [integrationId, integration.head]);
      if (existingPreview) {
        throw new OctusError("invalid_state", "A preview exists for this head; waivers cannot hide an applicable preview (remove it explicitly first)");
      }
    }
    const targetTip = await this.targetTip(integration.repositoryId, integration.targetBranch);
    const validationsHash = await this.validationsHash(integrationId, integration.head);
    const id = createId("apr");
    const timestamp = now();
    await this.db.batch([
      {
        sql: "INSERT INTO integration_approvals (id, integration_id, candidate_sha, preview_id, waiver_reason, target_branch, target_sha_observed, validations_hash, decision, actor, granted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', 'user', ?, ?)",
        params: [id, integrationId, integration.head, previewId ?? null, input.waiverReason?.slice(0, 2000) ?? null, integration.targetBranch, targetTip, validationsHash, timestamp, timestamp],
      },
      { sql: "UPDATE integrations SET status = 'approved', updated_at = ? WHERE id = ?", params: [timestamp, integrationId] },
    ]);
    const event = await this.events.append({ type: "approval.granted", aggregate: { kind: "approval", id }, correlationId: createId("cor"), payload: { integrationId, head: integration.head, previewId: previewId ?? null, waiver: previewId ? undefined : true } });
    this.bus.publish(event);
    const changed = await this.events.append({ type: "integration.status_changed", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { to: "approved", head: integration.head } });
    this.bus.publish(changed);
    return { approvalId: id, duplicate: false };
  }

  /**
   * Rechaza la integración (P2): terminal. Cierra el run como rejected.
   * Candidato/ramas/worktrees/commits se conservan; re-decidir exige rebuild.
   */
  async rejectIntegration(integrationId: string, reason = "rejected by user"): Promise<{ approvalId: string }> {
    const integration = await this.getIntegration(integrationId);
    if (!["validating", "preview_ready", "building", "conflicted"].includes(integration.status)) {
      throw new OctusError("invalid_state", `Integration ${integrationId} is ${integration.status}, cannot reject`);
    }
    const head = integration.head ?? integration.targetBaseCommit;
    const targetTip = await this.targetTip(integration.repositoryId, integration.targetBranch);
    const validationsHash = integration.head ? await this.validationsHash(integrationId, integration.head) : "no-head";
    const id = createId("apr");
    const timestamp = now();
    await this.db.batch([
      {
        sql: "INSERT INTO integration_approvals (id, integration_id, candidate_sha, target_branch, target_sha_observed, validations_hash, decision, actor, granted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'rejected', 'user', ?, ?)",
        params: [id, integrationId, head, integration.targetBranch, targetTip, validationsHash, timestamp, timestamp],
      },
      { sql: "UPDATE integrations SET status = 'rejected', error = ?, updated_at = ? WHERE id = ?", params: [reason.slice(0, 500), timestamp, integrationId] },
      { sql: "UPDATE runs SET status = 'rejected', error = ?, updated_at = ?, completed_at = ? WHERE id = ?", params: [reason.slice(0, 500), timestamp, timestamp, integration.runId] },
    ]);
    const event = await this.events.append({ type: "approval.rejected", aggregate: { kind: "approval", id }, correlationId: createId("cor"), payload: { integrationId, head } });
    this.bus.publish(event);
    const changed = await this.events.append({ type: "integration.status_changed", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { to: "rejected", reason } });
    this.bus.publish(changed);
    return { approvalId: id };
  }

  // ---------------------------------------------------------------- internas
  private async getIntegration(id: string): Promise<Integration> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM integrations WHERE id = ?", [id]);
    if (!row) throw new OctusError("not_found", `Integration not found: ${id}`);
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
      status: row.status as Integration["status"],
      error: row.error ? String(row.error) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private async targetTip(repositoryId: string, targetBranch: string): Promise<string> {
    const repo = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM repositories WHERE id = ?", [repositoryId]);
    if (!repo) throw new OctusError("not_found", `Repository not found: ${repositoryId}`);
    try {
      return (await runGit(String(repo.root_path), ["rev-parse", targetBranch])).stdout.trim();
    } catch {
      throw new OctusError("invalid_state", `Target branch ${targetBranch} is not resolvable`);
    }
  }

  /** Hash estable del informe de validaciones vigente para un SHA. */
  async validationsHash(integrationId: string, sha: string): Promise<string> {
    const rows = await this.validations.listValidations(integrationId, sha);
    const reviews = await this.validations.listReviews(integrationId);
    const material = JSON.stringify({
      validations: rows.map((r) => [r.kind, r.entryId ?? "", r.status]).sort(),
      reviews: reviews.filter((r) => r.sha === sha).map((r) => [r.instanceId, r.verdict, r.summary ?? ""]).sort(),
    });
    return createHash("sha256").update(material).digest("hex");
  }
}

function deserializeApproval(row: Record<string, string | number | null>): Approval {
  return {
    id: String(row.id),
    integrationId: String(row.integration_id),
    candidateSha: String(row.candidate_sha),
    previewId: row.preview_id ? String(row.preview_id) : undefined,
    waiverReason: row.waiver_reason ? String(row.waiver_reason) : undefined,
    targetBranch: String(row.target_branch),
    targetShaObserved: String(row.target_sha_observed),
    validationsHash: String(row.validations_hash),
    decision: row.decision as Approval["decision"],
    actor: "user",
    grantedAt: Number(row.granted_at),
    createdAt: Number(row.created_at),
  };
}
