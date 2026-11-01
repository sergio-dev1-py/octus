/**
 * @octus/shared — helpers puros de los widgets de conversación (Todo 14).
 * Sin framework ni E/S: el renderer (SolidJS) los consume y `bun test` los cubre.
 * Fuentes de verdad: ToolCallRecord (6 estados), ApprovalRequest, QuestionRequest,
 * AgentInstance, TaskAttempt.artifacts y eventos `error.raised` / `run.failed`.
 */
import type {
  AgentInstance,
  ApprovalRequest,
  MessagePart,
  PlanRevision,
  Run,
  Task,
  TaskAttempt,
  ToolCallRecord,
  ToolCallPart,
  ToolResultPart,
} from "./domain.js";
import type { QuestionRequest } from "./permissions.js";

export type ToolTone = "ok" | "warn" | "err" | "muted";

export interface ToolStatusMeta {
  label: string;
  tone: ToolTone;
  terminal: boolean;
}

const TOOL_STATUS_META: Record<ToolCallRecord["status"], ToolStatusMeta> = {
  pending: { label: "pending", tone: "muted", terminal: false },
  running: { label: "running", tone: "warn", terminal: false },
  completed: { label: "completed", tone: "ok", terminal: true },
  failed: { label: "failed", tone: "err", terminal: true },
  denied: { label: "denied", tone: "err", terminal: true },
  cancelled: { label: "cancelled", tone: "muted", terminal: true },
};

export function toolStatusMeta(status: ToolCallRecord["status"]): ToolStatusMeta {
  return TOOL_STATUS_META[status];
}

/** Duración legible entre startedAt/completedAt de ToolCallRecord. */
export function formatToolDurationMs(startedAt?: number, completedAt?: number): string {
  if (startedAt === undefined || startedAt === null) return "—";
  if (completedAt === undefined || completedAt === null) return "en curso";
  const ms = Math.max(0, completedAt - startedAt);
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Empareja partes tool_call con su tool_result por toolCallId, en orden. */
export interface PairedToolCall {
  call: ToolCallPart;
  result?: ToolResultPart;
}

export function pairToolParts(parts: MessagePart[]): PairedToolCall[] {
  const results = new Map<string, ToolResultPart>();
  for (const part of parts) {
    if (part.type === "tool_result") results.set(part.toolCallId, part);
  }
  return parts
    .filter((part): part is ToolCallPart => part.type === "tool_call")
    .map((call) => ({ call, result: results.get(call.toolCallId) }));
}

/** Un humano solo puede decidir cuando la revisión está presentada y pendiente. */
export interface ApprovalGate {
  decidable: boolean;
  reason: string;
}

export function approvalGateForRevision(
  revision: Pick<PlanRevision, "lifecycle" | "approval">,
  pendingRequest?: Pick<ApprovalRequest, "status">,
): ApprovalGate {
  if (revision.lifecycle !== "presented") {
    return { decidable: false, reason: `revision is ${revision.lifecycle}, not presented` };
  }
  if (revision.approval !== "pending") {
    return { decidable: false, reason: `revision is already ${revision.approval}` };
  }
  if (pendingRequest && pendingRequest.status !== "pending") {
    return { decidable: false, reason: `request is ${pendingRequest.status}, no longer pending` };
  }
  return { decidable: true, reason: "presented and pending: only you can decide" };
}

/**
 * Ningún modelo concede aprobaciones: la UI solo llama a `approvals.decide` y
 * `plans.approve` desde un gesto humano. Este predicado nombra el origen
 * permitido para que el renderer lo afirme en pruebas.
 */
export type ApprovalOrigin = "human-gesture" | "model-tool" | "unknown";

export function mayGrantApproval(origin: ApprovalOrigin): boolean {
  return origin === "human-gesture";
}

export const DEFAULT_QUESTION_TIMEOUT_MS = 300_000;

/** Milisegundos restantes antes del timeout de una pregunta (<=0 = vencida). */
export function questionTimeoutRemainingMs(
  createdAt: number,
  nowMs: number,
  timeoutMs: number = DEFAULT_QUESTION_TIMEOUT_MS,
): number {
  return createdAt + timeoutMs - nowMs;
}

export function formatTimeoutRemainingMs(remainingMs: number): string {
  if (remainingMs <= 0) return "expired";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s left`;
  return `${minutes}m ${seconds}s left`;
}

export interface AgentActivitySummary {
  active: number;
  total: number;
  byStatus: Partial<Record<AgentInstance["status"], number>>;
}

export function summarizeAgentActivity(instances: AgentInstance[]): AgentActivitySummary {
  const byStatus: Partial<Record<AgentInstance["status"], number>> = {};
  for (const instance of instances) {
    byStatus[instance.status] = (byStatus[instance.status] ?? 0) + 1;
  }
  const active = (byStatus.created ?? 0) + (byStatus.running ?? 0) + (byStatus.waiting_permission ?? 0) + (byStatus.waiting_input ?? 0);
  return { active, total: instances.length, byStatus };
}

export interface RuntimeErrorItem {
  id: string;
  scope: "run" | "task" | "instance" | "session";
  message: string;
  runId?: string;
  taskId?: string;
  instanceId?: string;
  at: number;
}

export interface ErrorSources {
  runs: Run[];
  tasks: Task[];
  instances: AgentInstance[];
  raised: Array<{ id: string; message: string; aggregateId?: string; at: number }>;
}

/** Banda unificada de errores sobre eventos y estados reales (W-C11). */
export function collectRunErrors(sources: ErrorSources, limit = 20): RuntimeErrorItem[] {
  const items: RuntimeErrorItem[] = [];
  for (const run of sources.runs) {
    if ((run.status === "failed" || run.status === "rejected") && run.error) {
      items.push({ id: `run-${run.id}`, scope: "run", message: run.error, runId: run.id, at: run.updatedAt });
    }
    if (run.status === "cancelled") {
      items.push({ id: `run-${run.id}-cancelled`, scope: "run", message: "Run cancelled: showing its final state.", runId: run.id, at: run.updatedAt });
    }
  }
  for (const task of sources.tasks) {
    if ((task.status === "failed" || task.status === "blocked") && (task.error || task.blockedReason)) {
      items.push({
        id: `task-${task.id}`,
        scope: "task",
        message: task.error ?? `Blocked: ${task.blockedReason}`,
        runId: task.runId,
        taskId: task.id,
        at: task.updatedAt,
      });
    }
  }
  for (const instance of sources.instances) {
    if (instance.status === "failed" && instance.error) {
      items.push({ id: `instance-${instance.id}`, scope: "instance", message: instance.error, runId: instance.runId, instanceId: instance.id, at: instance.updatedAt });
    }
  }
  for (const raised of sources.raised) {
    items.push({ id: `raised-${raised.id}`, scope: "session", message: raised.message, at: raised.at });
  }
  items.sort((a, b) => b.at - a.at);
  return items.slice(0, limit);
}

export interface ModifiedFile {
  path: string;
  summary: string;
  source: "task-artifact" | "tool-artifact";
  taskId?: string;
  toolCallId?: string;
  artifactId?: string;
}

/** Archivos modificados desde TaskAttempt.artifacts y tool calls con artifact (W-C13). */
export function collectModifiedFiles(attempts: TaskAttempt[], toolCalls: ToolCallRecord[]): ModifiedFile[] {
  const byPath = new Map<string, ModifiedFile>();
  for (const attempt of attempts) {
    for (const artifact of attempt.artifacts ?? []) {
      if (!artifact.path) continue;
      if (!byPath.has(artifact.path)) {
        byPath.set(artifact.path, {
          path: artifact.path,
          summary: artifact.summary || artifact.kind,
          source: "task-artifact",
          taskId: attempt.taskId,
          artifactId: artifact.artifactId,
        });
      }
    }
  }
  for (const call of toolCalls) {
    if (!call.artifactId) continue;
    const key = `tool:${call.id}`;
    if (!byPath.has(key)) {
      byPath.set(key, {
        path: `${call.name} output`,
        summary: call.resultText ?? call.status,
        source: "tool-artifact",
        toolCallId: call.id,
        artifactId: call.artifactId,
      });
    }
  }
  return [...byPath.values()];
}

/** Índice de resultados por toolCallId sobre todos los mensajes (W-C6):
 *  el `tool_result` vive en el mensaje `tool`, separado del `tool_call`.
 *  La tarjeta lo resuelve por índice, no por mensaje. */
export function indexToolResults(messages: Array<{ parts: MessagePart[] }>): Map<string, ToolResultPart> {
  const map = new Map<string, ToolResultPart>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_result" && !map.has(part.toolCallId)) map.set(part.toolCallId, part);
    }
  }
  return map;
}

/** Items de render de un mensaje: las tool_result viajan con su tool_call (W-C5/W-C6).
 *  Una tool_result huérfana (sin call) nunca se oculta: se muestra inline. */
export type MessageRenderItem = { kind: "part"; part: MessagePart } | { kind: "tool"; call: ToolCallPart; result?: ToolResultPart };

export function messageRenderItems(parts: MessagePart[]): MessageRenderItem[] {
  const results = new Map<string, ToolResultPart>();
  for (const part of parts) {
    if (part.type === "tool_result") results.set(part.toolCallId, part);
  }
  const items: MessageRenderItem[] = [];
  const paired = new Set<string>();
  for (const part of parts) {
    if (part.type === "tool_call") {
      items.push({ kind: "tool", call: part, result: results.get(part.toolCallId) });
      paired.add(part.toolCallId);
    } else if (part.type !== "tool_result") {
      items.push({ kind: "part", part });
    }
  }
  for (const part of parts) {
    if (part.type === "tool_result" && !paired.has(part.toolCallId)) items.push({ kind: "part", part });
  }
  return items;
}

/** Preguntas pendientes ordenadas por creación (la más antigua primero). */
export function orderPendingQuestions(requests: QuestionRequest[]): QuestionRequest[] {
  return [...requests].sort((a, b) => a.createdAt - b.createdAt);
}
