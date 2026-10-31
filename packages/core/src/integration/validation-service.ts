/**
 * @octus/core — ValidationService: validación centralizada de la integración (Etapa 5, §D).
 * Determinista salvo los comandos allowlist que ejecuta (en copia desechable,
 * nunca en worktrees vivos) y el agente reviewer (solo informa; el veredicto
 * lo registra una acción explícita). Cada validación queda pinneada al SHA exacto.
 *
 * Estados: pending/running/passed/failed/skipped/blocked. Distingue ejecutado
 * que pasa, ejecutado que falla, no ejecutado (skipped explícito) y bloqueado.
 * Nunca declara una suite aprobada con solo una parte ejecutada.
 */
import { realpathSync } from "node:fs";
import { createId } from "@octus/shared";
import type { IntegrationReview, Validation } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import type { TestRunner } from "../tools/test-runner.js";
import { now } from "../util.js";

export interface ValidationGate {
  ok: boolean;
  reasons: string[];
}

export class ValidationService {
  constructor(
    private readonly db: PersistenceService,
    private readonly events: EventStore,
    private readonly bus: EventBus,
    private readonly tests: TestRunner,
  ) {}

  // ------------------------------------------------------------------ lectura
  async listValidations(integrationId: string, sha?: string): Promise<Validation[]> {
    const rows = await this.db.query<Record<string, string | number | null>>(
      `SELECT * FROM validations WHERE integration_id = ? ${sha ? "AND sha = ?" : ""} ORDER BY created_at ASC`,
      sha ? [integrationId, sha] : [integrationId],
    );
    return rows.map(deserializeValidation);
  }

  async listReviews(integrationId: string): Promise<IntegrationReview[]> {
    const rows = await this.db.query<Record<string, string | number | null>>("SELECT * FROM integration_reviews WHERE integration_id = ? ORDER BY created_at ASC", [integrationId]);
    return rows.map(deserializeReview);
  }

  // -------------------------------------------------------------------- suite
  /**
   * Ejecuta la suite de la integración para un SHA: unión de validationCommands
   * de las tasks incorporadas. Idempotente por (integration, sha, kind, entry);
   * `force` borra y re-ejecuta. Sin comandos → fila suite/skipped explícita.
   */
  async runSuiteValidation(integrationId: string, sha?: string, opts?: { force?: boolean }): Promise<Validation[]> {
    const integration = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM integrations WHERE id = ?", [integrationId]);
    if (!integration) throw new OctusError("not_found", `Integration not found: ${integrationId}`);
    const head = sha ?? (integration.head ? String(integration.head) : undefined);
    if (!head) throw new OctusError("invalid_state", `Integration ${integrationId} has no head to validate`);
    if (String(integration.status) === "conflicted") {
      throw new OctusError("invalid_state", `Integration ${integrationId} is conflicted; resolve first`);
    }
    // La suite marca el inicio de la validación (solo desde building).
    await this.db.exec("UPDATE integrations SET status = 'validating', updated_at = ? WHERE id = ? AND status = 'building'", [now(), integrationId]);
    if (opts?.force) {
      await this.db.exec("DELETE FROM validations WHERE integration_id = ? AND sha = ?", [integrationId, head]);
    }
    const wanted = await this.incorporatedCommands(integrationId);
    const timestamp = now();
    if (wanted.length === 0) {
      const existing = await this.db.queryOne<{ id: string }>("SELECT id FROM validations WHERE integration_id = ? AND sha = ? AND kind = 'suite'", [integrationId, head]);
      if (existing) return this.listValidations(integrationId, head);
      const id = createId("val");
      await this.db.exec("INSERT INTO validations (id, integration_id, sha, kind, status, detail, created_at, updated_at) VALUES (?, ?, ?, 'suite', 'skipped', ?, ?, ?)", [
        id,
        integrationId,
        head,
        "no validationCommands declared by any incorporated task (explicit skip; review and preview gates still apply)",
        timestamp,
        timestamp,
      ]);
      return this.listValidations(integrationId, head);
    }
    const allowed = new Set((await this.tests.listAllowlist(String(integration.project_id))).map((e) => e.id));
    const dir = realpathSync(String(integration.canonical_path));
    for (const entryId of wanted) {
      const prior = await this.db.queryOne<{ id: string }>("SELECT id FROM validations WHERE integration_id = ? AND sha = ? AND kind = 'command' AND entry_id = ?", [integrationId, head, entryId]);
      if (prior) continue;
      if (!allowed.has(entryId)) {
        const id = createId("val");
        await this.db.exec("INSERT INTO validations (id, integration_id, sha, kind, entry_id, status, detail, created_at, updated_at) VALUES (?, ?, ?, 'command', ?, 'blocked', ?, ?, ?)", [
          id,
          integrationId,
          head,
          entryId,
          `entry '${entryId}' is not in the project test allowlist`,
          timestamp,
          timestamp,
        ]);
        continue;
      }
      const id = createId("val");
      await this.db.exec("INSERT INTO validations (id, integration_id, sha, kind, entry_id, status, created_at, updated_at) VALUES (?, ?, ?, 'command', ?, 'running', ?, ?)", [id, integrationId, head, entryId, timestamp, timestamp]);
      try {
        const ctl = new AbortController();
        const result = await this.tests.run(String(integration.project_id), entryId, dir, ctl.signal);
        await this.db.exec("UPDATE validations SET status = 'passed', detail = ?, updated_at = ? WHERE id = ?", [`exit 0 in ${(result.durationMs / 1000).toFixed(1)}s${result.truncated ? " (truncated)" : ""}`, now(), id]);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const code = error instanceof OctusError ? error.code : "tool_failed";
        // Fallo del comando (exit≠0) → failed; error de infra → blocked.
        const status = code === "tool_failed" ? "failed" : "blocked";
        await this.db.exec("UPDATE validations SET status = ?, detail = ?, updated_at = ? WHERE id = ?", [status, msg.slice(0, 2000), now(), id]);
      }
    }
    return this.listValidations(integrationId, head);
  }

  /**
   * Puerta de validación para un SHA: cero failed/blocked/pending/running +
   * review accept registrado para ese SHA. Skipped explícito permitido (P4).
   */
  async validationGate(integrationId: string, sha: string): Promise<ValidationGate> {
    const rows = await this.listValidations(integrationId, sha);
    const reasons: string[] = [];
    if (rows.length === 0) reasons.push("no validations recorded for sha (run the suite first)");
    const failed = rows.filter((r) => r.status === "failed");
    if (failed.length > 0) reasons.push(`${failed.length} failing validation(s): ${failed.map((r) => r.entryId ?? r.kind).join(",")}`);
    const blocked = rows.filter((r) => r.status === "blocked");
    if (blocked.length > 0) reasons.push(`${blocked.length} blocked validation(s): ${blocked.map((r) => r.entryId ?? r.kind).join(",")}`);
    const pending = rows.filter((r) => r.status === "pending" || r.status === "running");
    if (pending.length > 0) reasons.push(`${pending.length} validation(s) still in progress`);
    const review = await this.db.queryOne<{ verdict: string }>("SELECT verdict FROM integration_reviews WHERE integration_id = ? AND sha = ? ORDER BY created_at DESC LIMIT 1", [integrationId, sha]);
    if (!review || review.verdict !== "accept") {
      reasons.push("no accept review recorded for sha");
    }
    return { ok: reasons.length === 0, reasons };
  }

  /**
   * Registra el veredicto del reviewer sobre el SHA exacto. La instancia debe
   * ser reviewer, estar completed y haber corrido DENTRO del worktree de la
   * integración (directory == canonical path). Acción explícita, nunca modelo.
   */
  async recordIntegrationReview(integrationId: string, input: { instanceId: string; verdict: "accept" | "request-changes"; summary?: string }): Promise<void> {
    const integration = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM integrations WHERE id = ?", [integrationId]);
    if (!integration) throw new OctusError("not_found", `Integration not found: ${integrationId}`);
    const head = integration.head ? String(integration.head) : undefined;
    if (!head) throw new OctusError("invalid_state", `Integration ${integrationId} has no head to review`);
    const inst = await this.db.queryOne<{ status: string; directory: string; definition_id: string }>(
      `SELECT i.status AS status, i.directory AS directory, i.definition_id AS definition_id FROM agent_instances i WHERE i.id = ?`,
      [input.instanceId],
    );
    if (!inst) throw new OctusError("not_found", `Agent instance not found: ${input.instanceId}`);
    const def = await this.db.queryOne<{ kind: string }>("SELECT kind FROM agent_definitions WHERE id = ?", [String(inst.definition_id)]);
    if (!def || def.kind !== "reviewer") {
      throw new OctusError("invalid_state", `Instance ${input.instanceId.slice(-6)} is not a reviewer`);
    }
    if (inst.status !== "completed") {
      throw new OctusError("invalid_state", `Reviewer instance is ${inst.status}, not completed`);
    }
    const { realpathSync } = await import("node:fs");
    let same = false;
    try {
      same = realpathSync(String(inst.directory)) === realpathSync(String(integration.canonical_path));
    } catch {
      same = false;
    }
    if (!same) {
      throw new OctusError("invalid_state", "Reviewer instance did not run inside the integration worktree");
    }
    const timestamp = now();
    await this.db.exec("INSERT INTO integration_reviews (id, integration_id, sha, instance_id, verdict, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      createId("irv"),
      integrationId,
      head,
      input.instanceId,
      input.verdict,
      input.summary?.slice(0, 8000) ?? null,
      timestamp,
    ]);
    const event = await this.events.append({ type: "integration.reviewed", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { instanceId: input.instanceId, verdict: input.verdict, sha: head } });
    this.bus.publish(event);
  }

  // ---------------------------------------------------------------- internas
  /** Comandos de validación de las tasks incorporadas. */
  private async incorporatedCommands(integrationId: string): Promise<string[]> {
    const rows = await this.db.query<{ validation_commands: string }>(
      `SELECT t.validation_commands AS validation_commands FROM integration_commits c JOIN tasks t ON t.id = c.task_id WHERE c.integration_id = ?`,
      [integrationId],
    );
    const out = new Set<string>();
    for (const r of rows) {
      try {
        const parsed = JSON.parse(String(r.validation_commands ?? "[]")) as unknown;
        if (Array.isArray(parsed)) for (const c of parsed) out.add(String(c));
      } catch {
        // ignora filas corruptas (auditaría: no tumba la suite)
      }
    }
    return [...out].sort();
  }
}

function deserializeValidation(row: Record<string, string | number | null>): Validation {
  return {
    id: String(row.id),
    integrationId: String(row.integration_id),
    sha: String(row.sha),
    kind: row.kind as Validation["kind"],
    entryId: row.entry_id ? String(row.entry_id) : undefined,
    status: row.status as Validation["status"],
    detail: row.detail ? String(row.detail) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function deserializeReview(row: Record<string, string | number | null>): IntegrationReview {
  return {
    id: String(row.id),
    integrationId: String(row.integration_id),
    sha: String(row.sha),
    instanceId: String(row.instance_id),
    verdict: row.verdict as IntegrationReview["verdict"],
    summary: row.summary ? String(row.summary) : undefined,
    createdAt: Number(row.created_at),
  };
}
