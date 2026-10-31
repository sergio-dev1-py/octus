/**
 * @octus/core — PlanManager: propuestas y revisiones internas en SQLite (ADR-022/023).
 * Los modelos solo crean/actualizan/consultan; aprobar/rechazar/archivar/exportar
 * son acciones de la aplicación en nombre del usuario.
 */
import { z } from "zod";
import type {
  ApprovalRequest,
  Plan,
  PlanRevision,
  PlanStructuredContent,
} from "@octus/shared";
import { createId } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { now } from "../util.js";
import type { PlanToolService } from "../tools/tool-services.js";

export const structuredContentSchema = z.object({
  objective: z.string().min(1).max(2000),
  steps: z.array(z.object({
    title: z.string().min(1).max(500),
    detail: z.string().max(4000).optional(),
    files: z.array(z.string().max(500)).max(100).optional(),
    verification: z.string().max(2000).optional(),
  })).min(1).max(60),
  acceptanceCriteria: z.array(z.string().min(1).max(1000)).min(1).max(60),
  dependencies: z.array(z.string().max(1000)).max(60).optional(),
  risks: z.array(z.string().max(1000)).max(60).optional(),
  alternatives: z.array(z.string().max(1000)).max(30).optional(),
  openQuestions: z.array(z.string().max(1000)).max(30).optional(),
});

/** Render determinista: el Markdown nunca diverge del estructurado. */
export function renderPlanMarkdown(plan: Plan, revision: PlanRevision): string {
  const c = revision.structuredContent;
  const lines: string[] = [`# ${plan.objective}`, "", `> Revision ${revision.version} · ${new Date(revision.createdAt).toISOString()}`, ""];
  lines.push("## Steps", "");
  c.steps.forEach((s, i) => {
    lines.push(`### ${i + 1}. ${s.title}`);
    if (s.detail) lines.push("", s.detail);
    if (s.files?.length) {
      lines.push("", "Files:");
      for (const f of s.files) lines.push(`- \`${f}\``);
    }
    if (s.verification) lines.push("", `Verification: ${s.verification}`);
    lines.push("");
  });
  lines.push("## Acceptance criteria", "");
  for (const a of c.acceptanceCriteria) lines.push(`- [ ] ${a}`);
  lines.push("");
  const section = (title: string, items?: string[]) => {
    if (!items?.length) return;
    lines.push(`## ${title}`, "");
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  };
  section("Dependencies", c.dependencies);
  section("Risks", c.risks);
  section("Alternatives", c.alternatives);
  section("Open questions", c.openQuestions);
  return lines.join("\n").trimEnd() + "\n";
}

export interface PlanCreateInput {
  sessionId: string;
  projectId: string;
  objective: string;
  structured: unknown;
  runId: string;
  createdBy: string;
}

export class PlanManager implements PlanToolService {
  constructor(
    private readonly db: PersistenceService,
    private readonly events: EventStore,
    private readonly bus: EventBus,
  ) {}

  private parseStructured(input: unknown): PlanStructuredContent {
    const parsed = structuredContentSchema.safeParse(input);
    if (!parsed.success) {
      throw new OctusError("invalid_tool_args", `Invalid plan content: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 4).join("; ")}`);
    }
    return parsed.data;
  }

  private async emit(type: string, aggregate: { kind: "plan" | "plan_revision" | "approval"; id: string }, correlationId: string, payload: Record<string, unknown>, causationId?: string): Promise<void> {
    const event = await this.events.append({ type: type as "plan.created", aggregate, correlationId, causationId, payload });
    this.bus.publish(event);
  }

  async createPlan(input: PlanCreateInput): Promise<{ plan: Plan; revision: PlanRevision }> {
    const session = await this.db.queryOne<{ id: string }>("SELECT id FROM sessions WHERE id = ?", [input.sessionId]);
    if (!session) throw new OctusError("not_found", `Session not found: ${input.sessionId}`);
    const structured = this.parseStructured(input.structured);
    const timestamp = now();
    const planId = createId("plan");
    const revisionId = createId("prev");
    const plan: Plan = {
      id: planId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      objective: input.objective.slice(0, 2000),
      status: "active",
      currentRevisionId: undefined,
      approvedRevisionId: undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const markdown = renderPlanMarkdown(plan, { id: revisionId, structuredContent: structured, createdAt: timestamp } as PlanRevision);
    const revision: PlanRevision = {
      id: revisionId,
      planId,
      version: 1,
      structuredContent: structured,
      contentMarkdown: markdown,
      sourceMessageId: undefined,
      createdInRunId: input.runId,
      createdBy: input.createdBy,
      lifecycle: "unpresented",
      approval: "pending",
      createdAt: timestamp,
    };
    await this.db.batch([
      { sql: "INSERT INTO plans (id, project_id, session_id, objective, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)", params: [planId, input.projectId, input.sessionId, plan.objective, timestamp, timestamp] },
      { sql: "INSERT INTO plan_revisions (id, plan_id, version, structured_content, content_markdown, created_in_run_id, created_by, lifecycle, approval, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, 'unpresented', 'pending', ?)", params: [revisionId, planId, JSON.stringify(structured), markdown, input.runId, input.createdBy, timestamp] },
    ]);
    const correlationId = createId("cor");
    await this.emit("plan.created", { kind: "plan", id: planId }, correlationId, { sessionId: input.sessionId, objective: plan.objective });
    await this.emit("plan.revision_created", { kind: "plan_revision", id: revisionId }, correlationId, { planId, version: 1 });
    return { plan, revision };
  }

  async updatePlan(planId: string, structured: unknown, runId: string, createdBy: string): Promise<PlanRevision> {
    const plan = await this.requirePlan(planId);
    if (plan.status !== "active") throw new OctusError("invalid_state", `Plan ${planId} is archived`);
    const content = this.parseStructured(structured);
    const timestamp = now();
    const revisionId = createId("prev");
    const markdown = renderPlanMarkdown(plan, { id: revisionId, structuredContent: content, createdAt: timestamp } as PlanRevision);
    // Versión consecutiva asignada atómicamente; la restricción única evita duplicados.
    await this.db.exec(
      `INSERT INTO plan_revisions (id, plan_id, version, structured_content, content_markdown, created_in_run_id, created_by, lifecycle, approval, created_at)
       SELECT ?, ?, COALESCE((SELECT MAX(version) FROM plan_revisions WHERE plan_id = ?), 0) + 1, ?, ?, ?, ?, 'unpresented', 'pending', ?`,
      [revisionId, planId, planId, JSON.stringify(content), markdown, runId, createdBy, timestamp],
    );
    const row = await this.db.queryOne<{ version: number }>("SELECT version FROM plan_revisions WHERE id = ?", [revisionId]);
    const revision = (await this.getRevision(revisionId))!;
    const correlationId = createId("cor");
    await this.emit("plan.revision_created", { kind: "plan_revision", id: revisionId }, correlationId, { planId, version: row?.version ?? 0 });
    return revision;
  }

  async getPlan(planId: string): Promise<Plan> {
    return this.requirePlan(planId);
  }

  async listPlans(sessionId: string): Promise<Plan[]> {
    const rows = await this.db.query<Record<string, string | number | null>>("SELECT * FROM plans WHERE session_id = ? ORDER BY updated_at DESC", [sessionId]);
    return rows.map(deserializePlan);
  }

  async listRevisions(planId: string): Promise<PlanRevision[]> {
    await this.requirePlan(planId);
    const rows = await this.db.query<Record<string, string | number | null>>("SELECT * FROM plan_revisions WHERE plan_id = ? ORDER BY version ASC", [planId]);
    return rows.map(deserializeRevision);
  }

  async getRevision(revisionId: string): Promise<PlanRevision | undefined> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM plan_revisions WHERE id = ?", [revisionId]);
    return row ? deserializeRevision(row) : undefined;
  }

  /** Vincula una revisión a su mensaje presentador; solo avanza current_revision_id. */
  async presentRevision(revisionId: string, messageId: string): Promise<PlanRevision> {
    const revision = await this.getRevision(revisionId);
    if (!revision) throw new OctusError("not_found", `Revision not found: ${revisionId}`);
    if (revision.lifecycle !== "unpresented") return revision;
    const timestamp = now();
    await this.db.batch([
      { sql: "UPDATE plan_revisions SET lifecycle = 'presented', source_message_id = ?, presented_at = ? WHERE id = ? AND lifecycle = 'unpresented'", params: [messageId, timestamp, revisionId] },
      { sql: "UPDATE plans SET current_revision_id = ?, updated_at = ? WHERE id = ?", params: [revisionId, timestamp, revision.planId] },
    ]);
    const correlationId = createId("cor");
    await this.emit("plan.revision_presented", { kind: "plan_revision", id: revisionId }, correlationId, { planId: revision.planId, messageId });
    return (await this.getRevision(revisionId))!;
  }

  /**
   * Cierra el ciclo de un run: cada revisión sin presentar se vincula al primer
   * mensaje asistente posterior a su creación; sin mensaje, queda huérfana.
   */
  async settleRunRevisions(runId: string): Promise<{ presented: number; orphaned: number }> {
    const pending = await this.db.query<Record<string, string | number | null>>(
      "SELECT * FROM plan_revisions WHERE created_in_run_id = ? AND lifecycle = 'unpresented' ORDER BY created_at ASC",
      [runId],
    );
    let presented = 0;
    let orphaned = 0;
    for (const row of pending) {
      const message = await this.db.queryOne<{ id: string }>(
        "SELECT id FROM messages WHERE run_id = ? AND role = 'assistant' AND created_at >= ? ORDER BY created_at ASC, seq ASC LIMIT 1",
        [runId, Number(row.created_at)],
      );
      if (message) {
        await this.presentRevision(String(row.id), message.id);
        presented++;
      } else {
        await this.db.exec("UPDATE plan_revisions SET lifecycle = 'orphaned' WHERE id = ?", [String(row.id)]);
        const correlationId = createId("cor");
        await this.emit("plan.revision_orphaned", { kind: "plan_revision", id: String(row.id) }, correlationId, { planId: String(row.plan_id) });
        orphaned++;
      }
    }
    return { presented, orphaned };
  }

  /** Solicitud de aprobación (idempotente por revisión pendiente). */
  async requestApproval(planId: string, revisionId: string, sessionId: string, runId: string): Promise<ApprovalRequest> {
    const revision = await this.getRevision(revisionId);
    if (!revision || revision.planId !== planId) throw new OctusError("not_found", `Revision ${revisionId} not found in plan ${planId}`);
    if (revision.lifecycle !== "presented") throw new OctusError("invalid_state", "Only a presented revision can be approved");
    if (revision.approval !== "pending") throw new OctusError("invalid_state", `Revision is already ${revision.approval}`);
    const existing = await this.db.queryOne<Record<string, string | number | null>>(
      "SELECT * FROM approval_requests WHERE revision_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      [revisionId],
    );
    if (existing) return deserializeApprovalRequest(existing);
    const timestamp = now();
    const request: ApprovalRequest = { id: createId("apr"), planId, revisionId, sessionId, runId, status: "pending", createdAt: timestamp };
    await this.db.exec("INSERT INTO approval_requests (id, plan_id, revision_id, session_id, run_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)", [
      request.id,
      planId,
      revisionId,
      sessionId,
      runId,
      timestamp,
    ]);
    const correlationId = createId("cor");
    await this.emit("plan.approval_requested", { kind: "approval", id: request.id }, correlationId, { planId, revisionId, sessionId });
    return request;
  }

  async pendingApprovals(sessionId: string): Promise<ApprovalRequest[]> {
    const rows = await this.db.query<Record<string, string | number | null>>(
      "SELECT * FROM approval_requests WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC",
      [sessionId],
    );
    return rows.map(deserializeApprovalRequest);
  }

  /** Decisión exclusiva de la aplicación en nombre del usuario (sin herramienta de modelo). */
  async decideApproval(requestId: string, decision: "approved" | "rejected"): Promise<ApprovalRequest> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM approval_requests WHERE id = ?", [requestId]);
    if (!row) throw new OctusError("not_found", `Approval request not found: ${requestId}`);
    if (String(row.status) !== "pending") throw new OctusError("invalid_state", "Approval request is no longer pending");
    const timestamp = now();
    const revisionId = String(row.revision_id);
    const planId = String(row.plan_id);
    await this.db.batch([
      { sql: "UPDATE approval_requests SET status = 'decided', decision = ?, decided_at = ? WHERE id = ?", params: [decision, timestamp, requestId] },
      { sql: "UPDATE plan_revisions SET approval = ?, approved_at = ? WHERE id = ?", params: [decision, decision === "approved" ? timestamp : null, revisionId] },
      ...(decision === "approved"
        ? [{ sql: "UPDATE plans SET approved_revision_id = ?, updated_at = ? WHERE id = ?", params: [revisionId, timestamp, planId] as Array<string | number | null> }]
        : []),
    ]);
    const correlationId = createId("cor");
    await this.emit("plan.approval_decided", { kind: "approval", id: requestId }, correlationId, { planId, revisionId, decision });
    await this.emit(decision === "approved" ? "plan.approved" : "plan.rejected", { kind: "plan_revision", id: revisionId }, correlationId, { planId });
    const updated = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM approval_requests WHERE id = ?", [requestId]);
    return deserializeApprovalRequest(updated!);
  }

  /** Atajos directos por (plan, revisión) para las acciones de la UI. */
  async approveRevision(planId: string, revisionId: string): Promise<void> {
    const revision = await this.getRevision(revisionId);
    if (!revision || revision.planId !== planId) throw new OctusError("not_found", `Revision ${revisionId} not found in plan ${planId}`);
    if (revision.lifecycle !== "presented") throw new OctusError("invalid_state", "Only a presented revision can be approved");
    if (revision.approval !== "pending") throw new OctusError("invalid_state", `Revision is already ${revision.approval}`);
    const pending = await this.db.queryOne<{ id: string }>("SELECT id FROM approval_requests WHERE revision_id = ? AND status = 'pending' LIMIT 1", [revisionId]);
    if (pending) {
      await this.decideApproval(pending.id, "approved");
      return;
    }
    // Sin solicitud previa: la aplicación registra la decisión directa del usuario.
    const timestamp = now();
    const requestId = createId("apr");
    const sessionId = (await this.requirePlan(planId)).sessionId;
    await this.db.exec("INSERT INTO approval_requests (id, plan_id, revision_id, session_id, run_id, status, decision, decided_at, created_at) VALUES (?, ?, ?, ?, '', 'decided', 'approved', ?, ?)", [
      requestId,
      planId,
      revisionId,
      sessionId,
      timestamp,
      timestamp,
    ]);
    await this.decideDirect(revisionId, planId, "approved");
  }

  async rejectRevision(planId: string, revisionId: string): Promise<void> {
    const revision = await this.getRevision(revisionId);
    if (!revision || revision.planId !== planId) throw new OctusError("not_found", `Revision ${revisionId} not found in plan ${planId}`);
    if (revision.approval !== "pending") throw new OctusError("invalid_state", `Revision is already ${revision.approval}`);
    const pending = await this.db.queryOne<{ id: string }>("SELECT id FROM approval_requests WHERE revision_id = ? AND status = 'pending' LIMIT 1", [revisionId]);
    if (pending) {
      await this.decideApproval(pending.id, "rejected");
      return;
    }
    const timestamp = now();
    const requestId = createId("apr");
    const sessionId = (await this.requirePlan(planId)).sessionId;
    await this.db.exec("INSERT INTO approval_requests (id, plan_id, revision_id, session_id, run_id, status, decision, decided_at, created_at) VALUES (?, ?, ?, ?, '', 'decided', 'rejected', ?, ?)", [
      requestId,
      planId,
      revisionId,
      sessionId,
      timestamp,
      timestamp,
    ]);
    await this.decideDirect(revisionId, planId, "rejected");
  }

  private async decideDirect(revisionId: string, planId: string, decision: "approved" | "rejected"): Promise<void> {
    const timestamp = now();
    await this.db.batch([
      { sql: "UPDATE plan_revisions SET approval = ?, approved_at = ? WHERE id = ?", params: [decision, decision === "approved" ? timestamp : null, revisionId] },
      ...(decision === "approved"
        ? [{ sql: "UPDATE plans SET approved_revision_id = ?, updated_at = ? WHERE id = ?", params: [revisionId, timestamp, planId] as Array<string | number | null> }]
        : []),
    ]);
    const correlationId = createId("cor");
    await this.emit(decision === "approved" ? "plan.approved" : "plan.rejected", { kind: "plan_revision", id: revisionId }, correlationId, { planId });
  }

  async archivePlan(planId: string): Promise<void> {
    await this.requirePlan(planId);
    await this.db.exec("UPDATE plans SET status = 'archived', updated_at = ? WHERE id = ?", [now(), planId]);
    const correlationId = createId("cor");
    await this.emit("plan.archived", { kind: "plan", id: planId }, correlationId, {});
  }

  async exportRevision(planId: string, revisionId: string): Promise<{ markdown: string; suggestedName: string }> {
    const revision = await this.getRevision(revisionId);
    if (!revision || revision.planId !== planId) throw new OctusError("not_found", `Revision ${revisionId} not found in plan ${planId}`);
    const plan = await this.requirePlan(planId);
    const slug = plan.objective.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "plan";
    const correlationId = createId("cor");
    await this.emit("plan.exported", { kind: "plan_revision", id: revisionId }, correlationId, { planId, version: revision.version });
    return { markdown: revision.contentMarkdown, suggestedName: `${slug}-v${revision.version}.md` };
  }

  /** Barrido de recuperación: revisiones sin presentar de runs terminales → huérfanas. */
  async orphanSweep(): Promise<number> {
    const rows = await this.db.query<{ id: string; plan_id: string }>(
      `SELECT pr.id AS id, pr.plan_id AS plan_id FROM plan_revisions pr
       JOIN runs r ON r.id = pr.created_in_run_id
       WHERE pr.lifecycle = 'unpresented' AND r.status IN ('done', 'failed', 'cancelled', 'rejected')`,
    );
    for (const row of rows) {
      await this.db.exec("UPDATE plan_revisions SET lifecycle = 'orphaned' WHERE id = ?", [row.id]);
      const correlationId = createId("cor");
      await this.emit("plan.revision_orphaned", { kind: "plan_revision", id: row.id }, correlationId, { planId: row.plan_id, reason: "settle-on-startup" });
    }
    return rows.length;
  }

  private async requirePlan(planId: string): Promise<Plan> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM plans WHERE id = ?", [planId]);
    if (!row) throw new OctusError("not_found", `Plan not found: ${planId}`);
    return deserializePlan(row);
  }

  // ------------------------------------------------------------------ cara herramienta
  async create(input: { sessionId: string; objective: string; structured: PlanStructuredContent; runId: string; createdBy: string }): Promise<{ planId: string; revisionId: string; version: number }> {
    const project = await this.db.queryOne<{ project_id: string }>("SELECT project_id FROM sessions WHERE id = ?", [input.sessionId]);
    if (!project) throw new OctusError("not_found", `Session not found: ${input.sessionId}`);
    const { plan, revision } = await this.createPlan({ ...input, projectId: project.project_id });
    return { planId: plan.id, revisionId: revision.id, version: revision.version };
  }

  async update(input: { planId: string; structured: PlanStructuredContent; runId: string; createdBy: string }): Promise<{ revisionId: string; version: number }> {
    const revision = await this.updatePlan(input.planId, input.structured, input.runId, input.createdBy);
    return { revisionId: revision.id, version: revision.version };
  }

  async get(planId: string, revisionId?: string): Promise<string> {
    const plan = await this.requirePlan(planId);
    const revisions = await this.listRevisions(planId);
    const target = revisionId ? revisions.find((r) => r.id === revisionId) : revisions.find((r) => r.id === plan.currentRevisionId) ?? revisions[revisions.length - 1];
    if (!target) throw new OctusError("not_found", `No revision available for plan ${planId}`);
    return formatRevision(plan, target);
  }

  async list(sessionId: string): Promise<string> {
    const plans = await this.listPlans(sessionId);
    if (plans.length === 0) return "No plans in this session yet.";
    const lines: string[] = [];
    for (const plan of plans) {
      const revisions = await this.listRevisions(plan.id);
      const current = revisions.find((r) => r.id === plan.currentRevisionId);
      lines.push(`- ${plan.id} "${plan.objective}" [${plan.status}] revisions=${revisions.length} current=v${current?.version ?? "?"}(${current?.approval ?? "?"}) approved=${plan.approvedRevisionId ?? "none"}`);
    }
    return lines.join("\n");
  }
}

function deserializePlan(row: Record<string, string | number | null>): Plan {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    sessionId: String(row.session_id),
    objective: String(row.objective),
    status: String(row.status) as Plan["status"],
    currentRevisionId: row.current_revision_id ? String(row.current_revision_id) : undefined,
    approvedRevisionId: row.approved_revision_id ? String(row.approved_revision_id) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function deserializeRevision(row: Record<string, string | number | null>): PlanRevision {
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    version: Number(row.version),
    structuredContent: JSON.parse(String(row.structured_content)) as PlanRevision["structuredContent"],
    contentMarkdown: String(row.content_markdown),
    sourceMessageId: row.source_message_id ? String(row.source_message_id) : undefined,
    createdInRunId: String(row.created_in_run_id),
    createdBy: String(row.created_by),
    lifecycle: String(row.lifecycle) as PlanRevision["lifecycle"],
    presentedAt: row.presented_at ? Number(row.presented_at) : undefined,
    approval: String(row.approval) as PlanRevision["approval"],
    approvedAt: row.approved_at ? Number(row.approved_at) : undefined,
    createdAt: Number(row.created_at),
  };
}

function deserializeApprovalRequest(row: Record<string, string | number | null>): ApprovalRequest {
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    revisionId: String(row.revision_id),
    sessionId: String(row.session_id),
    runId: String(row.run_id),
    status: String(row.status) as ApprovalRequest["status"],
    decision: row.decision ? (String(row.decision) as ApprovalRequest["decision"]) : undefined,
    decidedAt: row.decided_at ? Number(row.decided_at) : undefined,
    createdAt: Number(row.created_at),
  };
}

function formatRevision(plan: Plan, revision: PlanRevision): string {
  const c = revision.structuredContent;
  const lines = [
    `Plan ${plan.id} "${plan.objective}" — revision v${revision.version} [${revision.lifecycle}/${revision.approval}]`,
    `Objective: ${c.objective}`,
    "Steps:",
    ...c.steps.map((s, i) => `  ${i + 1}. ${s.title}${s.verification ? ` (verify: ${s.verification})` : ""}`),
    "Acceptance criteria:",
    ...c.acceptanceCriteria.map((a) => `  - ${a}`),
  ];
  if (c.openQuestions?.length) {
    lines.push("Open questions:", ...c.openQuestions.map((q) => `  - ${q}`));
  }
  return lines.join("\n");
}
