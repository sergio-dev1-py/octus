/**
 * @octus/shared — eventos. Unión tipada única para persistencia, bus en memoria e IPC.
 * Etapa 1: los eventos de etapas futuras están definidos pero ningún emisor los produce.
 */
import type { Milliseconds } from "./domain.js";

export type AggregateKind =
  | "session"
  | "run"
  | "instance"
  | "task"
  | "planning"
  | "reservation"
  | "scheduler"
  | "tool_call"
  | "worktree"
  | "integration"
  | "approval"
  | "plan"
  | "plan_revision"
  | "memory"
  | "budget"
  | "provider";

/** Eventos persistidos en el EventStore (cambios de estado). */
export type PersistedEventType =
  | "session.created"
  | "session.updated"
  | "user_message.received"
  | "run.created"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "agent_instance.created"
  | "agent_instance.started"
  | "agent_instance.status_changed"
  | "agent_instance.completed"
  | "agent_instance.failed"
  | "agent_instance.cancelled"
  | "message.appended"
  | "tool_call.requested"
  | "tool_call.started"
  | "tool_call.completed"
  | "tool_call.failed"
  | "permission.asked"
  | "permission.replied"
  | "question.asked"
  | "question.replied"
  | "budget.warning"
  | "budget.exceeded"
  | "budgets.configured"
  | "provider.usage_recorded"
  | "task.created"
  | "task.status_changed"
  | "task.progress"
  | "task_attempt.created"
  | "task_attempt.status_changed"
  | "planning.created"
  | "planning.rejected"
  | "review.recorded"
  | "scheduler.assigned"
  | "reservation.acquired"
  | "reservation.released"
  | "worktree.created"
  | "worktree.released"
  | "integration.started"
  | "integration.status_changed"
  | "integration.completed"
  | "preview.ready"
  | "approval.requested"
  | "approval.granted"
  | "promotion.completed"
  | "plan.created"
  | "plan.revision_created"
  | "plan.revision_presented"
  | "plan.revision_orphaned"
  | "plan.approved"
  | "plan.rejected"
  | "plan.archived"
  | "plan.exported"
  | "plan.approval_requested"
  | "plan.approval_decided"
  | "agent.delivery_ready"
  | "memory.recorded"
  | "error.raised";

export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  id: string;
  type: TType;
  aggregate: { kind: AggregateKind; id: string };
  /** Secuencia por agregado, asignada por el EventStore. */
  seq: number;
  occurredAt: Milliseconds;
  correlationId: string;
  causationId?: string;
  idempotencyKey: string;
  payload: TPayload;
}

export type PersistedEvent = EventEnvelope<PersistedEventType, Record<string, unknown>>;

/** Eventos efímeros de streaming (nunca se persisten; solo bus en memoria e IPC). */
export type PartKind = "text" | "reasoning_summary" | "tool_arguments";

export interface PartDeltaEvent {
  kind: "part.delta";
  sessionId: string;
  runId: string;
  instanceId: string;
  messageId: string;
  part: PartKind;
  /** Para tool_arguments: providerCallId en curso. */
  key?: string;
  delta: string;
}

export interface PartDoneEvent {
  kind: "part.done";
  sessionId: string;
  runId: string;
  instanceId: string;
  messageId: string;
  part: PartKind;
  key?: string;
}

export type StreamEvent = PartDeltaEvent | PartDoneEvent | StepRetryEvent;

/** Un reintento descarta el paso parcial en curso: la UI debe reiniciar el mensaje indicado. */
export interface StepRetryEvent {
  kind: "step.retry";
  sessionId: string;
  runId: string;
  instanceId: string;
  messageId: string;
  attempt: number;
  reason: string;
}

/** Todo lo que viaja del core al renderer por el canal de eventos. */
export type CoreEvent = { kind: "event"; event: PersistedEvent } | StreamEvent;
