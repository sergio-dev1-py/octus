/** Chat timeline — lógica pura del Todo 13 (N-C-12a, N-C-06, N-C-12b, N-C-12c).
 * Sin Solid ni DOM: la consumen `store.ts` (envoltorios finos) y los tests
 * bun directamente. Solo `import type`: sin resolución en tiempo de ejecución.
 */
import type { Message, PartDeltaEvent, PartDoneEvent, StepRetryEvent } from "@octus/shared";

/** Estado visible de un marco de streaming: en curso o cerrado por part.done. */
export type FrameStatus = "streaming" | "done";

export interface LiveToolFrame {
  args: string;
  status: FrameStatus;
}

/** Un mensaje asistente aún no persistido, con marcos que se cierran. */
export interface LiveFrame {
  id: string;
  sessionId: string;
  runId: string;
  text: string;
  textStatus: FrameStatus;
  reasoning: string;
  reasoningStatus: FrameStatus;
  tools: Record<string, LiveToolFrame>;
}

export type LiveMap = Record<string, LiveFrame>;

/** Ventana por defecto del timeline virtualizado (N-C-06). */
export const TIMELINE_PAGE = 100;

/** Topes del composer con adjuntos (solo texto, en línea en el prompt). */
export const TIMELINE_MAX_ATTACHMENT_BYTES = 64 * 1024;
export const TIMELINE_MAX_ATTACHMENTS = 5;

export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  text: string;
}

export function emptyFrame(messageId: string, sessionId: string, runId: string): LiveFrame {
  return {
    id: messageId,
    sessionId,
    runId,
    text: "",
    textStatus: "streaming",
    reasoning: "",
    reasoningStatus: "streaming",
    tools: {},
  };
}

function baseOf(live: LiveMap, messageId: string, sessionId: string, runId: string): LiveFrame {
  return live[messageId] ?? emptyFrame(messageId, sessionId, runId);
}

/** N-C-12a/N-C-12b: acumula deltas y marca cada herramienta en vuelo. */
export function applyPartDelta(live: LiveMap, event: PartDeltaEvent): LiveMap {
  const base = baseOf(live, event.messageId, event.sessionId, event.runId);
  if (event.part === "text") {
    return { ...live, [event.messageId]: { ...base, text: base.text + event.delta, textStatus: "streaming" } };
  }
  if (event.part === "reasoning_summary") {
    return {
      ...live,
      [event.messageId]: { ...base, reasoning: base.reasoning + event.delta, reasoningStatus: "streaming" },
    };
  }
  const key = event.key ?? "?";
  const prev = base.tools[key] ?? { args: "", status: "streaming" as FrameStatus };
  return {
    ...live,
    [event.messageId]: {
      ...base,
      tools: { ...base.tools, [key]: { args: prev.args + event.delta, status: "streaming" as FrameStatus } },
    },
  };
}

/** N-C-12a: part.done cierra el marco (antes se descartaba en store.ts:950). */
export function applyPartDone(live: LiveMap, event: PartDoneEvent): LiveMap {
  const base = live[event.messageId];
  if (!base) return live;
  if (event.part === "text") {
    return { ...live, [event.messageId]: { ...base, textStatus: "done" } };
  }
  if (event.part === "reasoning_summary") {
    return { ...live, [event.messageId]: { ...base, reasoningStatus: "done" } };
  }
  const key = event.key ?? "?";
  const prev = base.tools[key];
  if (!prev) return live;
  return {
    ...live,
    [event.messageId]: { ...base, tools: { ...base.tools, [key]: { ...prev, status: "done" } } },
  };
}

/** Un reintento descarta el marco parcial en curso. */
export function applyStepRetry(live: LiveMap, event: StepRetryEvent): LiveMap {
  return { ...live, [event.messageId]: emptyFrame(event.messageId, event.sessionId, event.runId) };
}

/** Al cerrar un run (done/failed/cancelled) sus marcos desaparecen:
 *  sin fantasma de streaming ni duplicado al llegar message.appended. */
export function purgeRunFrames(live: LiveMap, runId: string): LiveMap {
  const next: LiveMap = {};
  for (const [id, frame] of Object.entries(live)) {
    if (frame.runId !== runId) next[id] = frame;
  }
  return next;
}

/** Inserción idempotente del historial: el mismo message.appended (replay o
 *  doble entrega) nunca duplica la línea de tiempo. */
export function appendMessage(messages: Message[], message: Message): Message[] {
  if (messages.some((m) => m.id === message.id)) return messages;
  return [...messages, message];
}

/** N-C-06: ventana virtualizada — solo los últimos N en el DOM. */
export function windowMessages<T>(messages: T[], visibleCount: number): T[] {
  if (visibleCount <= 0) return [];
  return messages.slice(Math.max(0, messages.length - Math.floor(visibleCount)));
}

/** Adjuntos como bloques cercados al final del prompt (sin cambiar el IPC:
 *  sigue siendo sessions.prompt con texto). */
export function buildPromptText(text: string, attachments: ChatAttachment[]): string {
  const trimmed = text.trim();
  if (attachments.length === 0) return trimmed;
  const blocks = attachments.map((a) => `Adjunto ${a.name}:\n\`\`\`\n${a.text}\n\`\`\``);
  return `${trimmed}\n\n${blocks.join("\n\n")}`;
}

/** N-C-12c: motivo de cancelación visible. El payload de run.cancelled trae
 *  error solo a veces (interrupt de usuario → undefined): por defecto se
 *  informa la cancelación del usuario en vez de un blanco. */
export function cancelReasonOf(payload: Record<string, unknown> | undefined): string {
  const error = payload?.["error"];
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Cancelado por el usuario";
}
