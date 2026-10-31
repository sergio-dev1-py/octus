/**
 * @octus/core — preguntas del modelo al usuario (flujo ask con timeout y cancelación).
 */
import type { QuestionAnswer, QuestionPrompt, QuestionRequest } from "@octus/shared";
import { createId } from "@octus/shared";
import { OctusError } from "../errors.js";
import { now } from "../util.js";
import type { EventBus, EventStore } from "../events/event-store.js";

export interface QuestionContext {
  sessionId: string;
  runId: string;
  instanceId: string;
  toolCallId: string;
  correlationId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface PendingQuestion {
  request: QuestionRequest;
  resolve: (answers: QuestionAnswer[]) => void;
  reject: (error: Error) => void;
}

export class QuestionService {
  private readonly pending = new Map<string, PendingQuestion>();

  constructor(
    private readonly events: EventStore,
    private readonly bus: EventBus,
  ) {}

  async ask(questions: QuestionPrompt[], ctx: QuestionContext): Promise<QuestionAnswer[]> {
    const request: QuestionRequest = {
      id: createId("que"),
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      instanceId: ctx.instanceId,
      toolCallId: ctx.toolCallId,
      questions,
      createdAt: now(),
    };
    // El pendiente se registra ANTES de publicar: una respuesta inmediata no debe perderse.
    return new Promise<QuestionAnswer[]>((resolve, reject) => {
      const timeoutMs = ctx.timeoutMs ?? 300_000;
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new OctusError("timeout", `Question timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(new OctusError("aborted", "Question aborted by interrupt"));
      };
      const settle = (answers: QuestionAnswer[]) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve(answers);
      };
      this.pending.set(request.id, { request, resolve: settle, reject });
      if (ctx.signal?.aborted) {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(new OctusError("aborted", "Question aborted by interrupt"));
        return;
      }
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      void (async () => {
        try {
          const event = await this.events.append({
            type: "question.asked",
            aggregate: { kind: "tool_call", id: ctx.toolCallId },
            correlationId: ctx.correlationId,
            payload: { requestId: request.id, questions },
          });
          this.bus.publish(event);
        } catch (error) {
          clearTimeout(timer);
          this.pending.delete(request.id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  }

  async reply(requestId: string, answers: QuestionAnswer[], correlationId: string): Promise<boolean> {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    const event = await this.events.append({
      type: "question.replied",
      aggregate: { kind: "tool_call", id: entry.request.toolCallId },
      correlationId,
      payload: { requestId, answers },
    });
    this.bus.publish(event);
    entry.resolve(answers);
    return true;
  }

  pendingFor(sessionId?: string): QuestionRequest[] {
    return [...this.pending.values()].map((p) => p.request).filter((r) => !sessionId || r.sessionId === sessionId);
  }

  cancelSession(sessionId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.request.sessionId !== sessionId) continue;
      this.pending.delete(id);
      entry.reject(new OctusError("aborted", "Session interrupted"));
    }
  }
}
