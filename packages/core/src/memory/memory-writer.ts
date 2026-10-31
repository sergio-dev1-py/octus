/**
 * @octus/core — MemoryWriter: gobernanza de la memoria (Etapa 6, P1/P2).
 * Servicio interno, no perfil de agente. Los agentes solo proponen (tool
 * `memory_propose`); validar ordinarias = coordinador; arquitectónicas e
 * instrucciones confiables = usuario vía QuestionService con bloqueo
 * parcial (solo la decisión/dependientes esperan, jamás el sistema).
 * Nunca altera estado operativo (runs, tasks, integraciones).
 */
import { createId, type MemoryItem } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { QuestionService } from "../questions/question-service.js";
import { MemoryService, type ProposeInput } from "./memory-service.js";

/** Categorías que exigen aprobación del usuario (nunca basta `validate`). */
const USER_APPROVAL_CATEGORIES = new Set(["decision", "instruction"]);

export interface AgentProvenance {
  projectId: string;
  sessionId: string;
  runId: string;
  instanceId: string;
}

export interface ApprovalContext {
  sessionId: string;
  runId?: string;
  instanceId?: string;
  toolCallId?: string;
  timeoutMs?: number;
}

export class MemoryWriter {
  constructor(
    private readonly memories: MemoryService,
    private readonly questions: QuestionService,
  ) {}

  // ---------------------------------------------------------------- proponer
  /**
   * Propuesta desde un agente (P1): siempre `proposed`; valida procedencia
   * (el scope pertenece al linaje del agente) y existencia del scope.
   * Sin agente (acción del usuario en UI): solo existencia del scope.
   * Jamás aprueba ni verifica aquí.
   */
  async propose(input: ProposeInput, agent?: AgentProvenance): Promise<MemoryItem> {
    if (agent) await this.checkProvenance(input.scope, input.scopeId, agent);
    await this.memories.requireScopeRow(input.scope, input.scopeId);
    return this.memories.propose(input);
  }

  // ---------------------------------------------------------------- validar
  /**
   * Validación del coordinador (ordinarias). Rechaza categorías que exigen
   * al usuario y a no-coordinadores. `verified` nunca se auto-convierte.
   */
  async validate(id: string, coordinatorInstanceId: string): Promise<MemoryItem> {
    const entry = await this.memories.get(id);
    if (entry.status !== "proposed") {
      throw new OctusError("invalid_state", `Memory ${id} is ${entry.status}, only proposed entries can be validated`);
    }
    await this.requireCoordinator(coordinatorInstanceId);
    if (USER_APPROVAL_CATEGORIES.has(entry.category)) {
      throw new OctusError("invalid_state", `Memory category '${entry.category}' requires explicit user approval (requestApproval), coordinator validation is not enough`);
    }
    return this.memories.setStatus(id, "verified", `coordinator:${coordinatorInstanceId.slice(-6)}`);
  }

  // ------------------------------------------------------- aprobación usuaria
  /**
   * Solicita confirmación del usuario (P2, bloqueo parcial: solo esta
   * decisión espera; runs/agentes ajenos siguen). Timeout → sigue proposed
   * con nota; reject → `rejected`. Approve → `approved` (+contradicción).
   */
  async requestApproval(id: string, ctx: ApprovalContext): Promise<{ approved: boolean; entry: MemoryItem; reason?: string }> {
    const entry = await this.memories.get(id);
    if (entry.status !== "proposed") {
      throw new OctusError("invalid_state", `Memory ${id} is ${entry.status}, only proposed entries can be approved`);
    }
    const answers = await this.askUser(entry, ctx).catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      if (error instanceof OctusError && (error.code === "timeout" || error.code === "aborted")) {
        return null;
      }
      throw error instanceof Error ? error : new OctusError("tool_failed", msg);
    });
    if (answers === null) {
      const noted = await this.memories.setReviewNote(id, "approval timed out; still proposed", "governance");
      return { approved: false, entry: noted, reason: "timeout" };
    }
    const verdict = (answers[0]?.answers ?? []).map((a) => a.toLowerCase());
    if (verdict.includes("approve")) {
      return { approved: true, entry: await this.approveEntry(entry, "user") };
    }
    const rejected = await this.memories.setStatus(id, "rejected", "user");
    return { approved: false, entry: rejected, reason: "rejected" };
  }

  /**
   * Decisión explícita del usuario sin pregunta (UI/IPC `memory.decide`):
   * actor fijo `user`. `verified` aquí también vale para ordinarias.
   */
  async decide(id: string, decision: "verified" | "approved" | "rejected"): Promise<MemoryItem> {
    const entry = await this.memories.get(id);
    if (decision === "verified" && USER_APPROVAL_CATEGORIES.has(entry.category)) {
      throw new OctusError("invalid_state", `Memory category '${entry.category}' requires approved, not verified`);
    }
    if (decision === "approved") return this.approveEntry(entry, "user");
    return this.memories.setStatus(id, decision, "user");
  }

  // ------------------------------------------------------- versión/conflicto
  /** Nueva versión con contenido distinto; la anterior queda `superseded`. */
  async supersede(id: string, fields: { content: string; source?: string; originRef?: MemoryItem["originRef"]; confidence?: MemoryItem["confidence"] }, by?: string): Promise<MemoryItem> {
    return this.memories.supersede(id, fields, by ?? "governance");
  }

  /**
   * Resuelve una contradicción pendiente: ganadora conserva (nota limpia),
   * perdedoras aprobadas/verificadas → `stale` con nota. Sin borrar nada.
   */
  async resolveConflict(winnerId: string, note?: string): Promise<MemoryItem> {
    const winner = await this.memories.get(winnerId);
    if (!["approved", "verified"].includes(winner.status)) {
      throw new OctusError("invalid_state", `Conflict winner must be approved or verified (got ${winner.status})`);
    }
    const group = await this.memories.conflictGroup(winner.scope, winner.scopeId, winner.topic);
    for (const other of group) {
      if (other.id === winnerId) continue;
      await this.memories.setStatus(other.id, "stale", "governance");
      await this.memories.setReviewNote(other.id, note ?? `contradiction resolved in favor of ${winnerId.slice(-6)}`, "governance");
    }
    return this.memories.setReviewNote(winnerId, null, "governance");
  }

  /** Revalidación contra el origen (hash); delega en el servicio. */
  async revalidate(id: string) {
    return this.memories.revalidate(id);
  }

  // ---------------------------------------------------------------- internas
  private async approveEntry(entry: MemoryItem, by: string): Promise<MemoryItem> {
    const approved = await this.memories.setStatus(entry.id, "approved", by);
    const siblings = await this.memories.findApprovedSiblings(entry.scope, entry.scopeId, entry.topic, entry.id);
    if (siblings.length > 0) {
      const ids = siblings.map((s) => s.id.slice(-6)).join(",");
      const note = `contradiction pending vs ${ids}: same ${entry.scope} topic '${entry.topic}' has multiple approved entries`;
      await this.memories.setReviewNote(approved.id, note, by);
      for (const sib of siblings) {
        await this.memories.setReviewNote(sib.id, `contradiction pending vs ${approved.id.slice(-6)}: same ${entry.scope} topic '${entry.topic}' has multiple approved entries`, by);
      }
      return this.memories.get(approved.id);
    }
    return approved;
  }

  private async askUser(entry: MemoryItem, ctx: ApprovalContext) {
    return this.questions.ask(
      [
        {
          header: "Memoria: aprobación requerida",
          question: `Approve memory [${entry.scope}:${entry.category}:${entry.topic}]? Content: ${entry.content.slice(0, 500)}`,
          options: [
            { label: "approve", description: "Aprobar esta memoria" },
            { label: "reject", description: "Rechazar esta memoria" },
          ],
        },
      ],
      {
        sessionId: ctx.sessionId,
        runId: ctx.runId ?? "",
        instanceId: ctx.instanceId ?? "",
        toolCallId: ctx.toolCallId ?? `mem-${entry.id}`,
        correlationId: createId("cor"),
        timeoutMs: ctx.timeoutMs ?? 300_000,
      },
    );
  }

  private async requireCoordinator(instanceId: string): Promise<void> {
    const kind = await this.memories.instanceKind(instanceId);
    if (kind !== "coordinator") {
      throw new OctusError("invalid_state", "Only the coordinator can validate memory entries (subagents propose; they never approve)");
    }
  }

  /** El scope propuesto pertenece al linaje del agente (anti scope ajeno). */
  private async checkProvenance(scope: MemoryItem["scope"], scopeId: string, agent: AgentProvenance): Promise<void> {
    if (scope === "project" && scopeId !== agent.projectId) {
      throw new OctusError("scope_violation", "Memory project scope does not match the agent project");
    }
    if (scope === "session") {
      if (scopeId !== agent.sessionId) throw new OctusError("scope_violation", "Memory session scope does not match the agent session");
      const projectId = await this.memories.sessionProject(scopeId);
      if (!projectId || projectId !== agent.projectId) throw new OctusError("scope_violation", "Memory session is outside the agent project");
      return;
    }
    if (scope === "run") {
      if (scopeId !== agent.runId) throw new OctusError("scope_violation", "Memory run scope does not match the agent run");
      return;
    }
    if (scope === "task") {
      const runId = await this.memories.taskRunId(scopeId);
      if (!runId || runId !== agent.runId) throw new OctusError("scope_violation", "Memory task is outside the agent run");
      return;
    }
    if (scope === "instance" && scopeId !== agent.instanceId) {
      throw new OctusError("scope_violation", "Memory instance scope does not match the agent instance");
    }
  }
}
