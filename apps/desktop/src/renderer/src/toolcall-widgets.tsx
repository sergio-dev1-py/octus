/** Widgets de conversación (Todo 14): tool calls expandibles, errores, archivos.
 *  Lee eventos y registros reales: `runs.get` (ToolCallRecord), `tasks.list/get`
 *  (TaskAttempt.artifacts), `error.raised` en vivo y el estado del store.
 *  Estado propio mínimo (toolCalls por run + raised en vivo) para no solaparse
 *  con la cirugía del Todo 13 en store.ts: solo LEE `state` y reutiliza sus
 *  acciones. Sin literales de diseño: clases de styles.css sobre var(--oc-*).
 *  Ningún modelo concede aprobaciones: estos widgets solo llaman a
 *  `approvals.decide` / `plans.approve` desde gestos humanos (onClick). */
import { For, Show, createEffect, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type { QuestionRequest, ToolCallPart, ToolCallRecord, ToolResultPart } from "@octus/shared";
import {
  approvalGateForRevision,
  collectModifiedFiles,
  collectRunErrors,
  formatTimeoutRemainingMs,
  formatToolDurationMs,
  indexToolResults,
  questionTimeoutRemainingMs,
  toolStatusMeta,
  type RuntimeErrorItem,
} from "@octus/shared";
import { invoke, onEvent } from "./api.js";
import { retryTask, setError, state } from "./store.js";

// ---------------------------------------------------------------- caché propia
interface WidgetCache {
  toolCalls: Record<string, ToolCallRecord[]>;
  raised: RuntimeErrorItem[];
}

const [cache, setCache] = createStore<WidgetCache>({ toolCalls: {}, raised: [] });
const inflight = new Set<string>();
let subscribed = false;

function describeRaised(payload: Record<string, unknown>): string {
  const reason = typeof payload.reason === "string" ? payload.reason : "raised";
  const skippedMessages = Array.isArray(payload.skippedMessages) ? payload.skippedMessages.length : 0;
  const skippedEvents = typeof payload.skippedEvents === "number" ? payload.skippedEvents : 0;
  if (reason === "session-recovery") {
    return `Sesión recuperada con pérdidas: ${skippedMessages} mensajes omitidos, ${skippedEvents} eventos. Usa «Recuperar sesión» para degradar a sesión vacía registrada.`;
  }
  const detail = typeof payload.message === "string" ? payload.message : typeof payload.error === "string" ? payload.error : "";
  return [`Error del core (${reason})`, detail].filter(Boolean).join(": ").slice(0, 500);
}

/** Tool calls del run vía `runs.get` (estados reales pending→…→terminal). */
export async function refreshToolCalls(): Promise<void> {
  for (const run of state.runs) {
    if (inflight.has(run.id)) continue;
    inflight.add(run.id);
    try {
      const { toolCalls } = await invoke("runs.get", { runId: run.id });
      setCache("toolCalls", run.id, toolCalls);
    } catch {
      setCache("toolCalls", run.id, []);
    } finally {
      inflight.delete(run.id);
    }
  }
}

function watchConversationWidgets(): void {
  if (subscribed) return;
  subscribed = true;
  // Suscripción única de vida de la app (el renderer no se desmonta):
  // el Todo 13 ya consume el bus en store.ts; este segundo oyente solo
  // refresca toolCalls y recoge `error.raised` para la banda de errores.
  onEvent((event) => {
    if (event.kind !== "event") return;
    const persisted = event.event;
    if (persisted.type === "error.raised") {
      const payload = (persisted.payload ?? {}) as Record<string, unknown>;
      const item: RuntimeErrorItem = {
        id: `raised-${persisted.id}`,
        scope: "session",
        message: describeRaised(payload),
        at: persisted.occurredAt,
      };
      setCache("raised", (raised) => (raised.some((entry) => entry.id === item.id) ? raised : [...raised, item].slice(-50)));
      return;
    }
    if (
      persisted.type.startsWith("tool_call.") ||
      persisted.type.startsWith("run.") ||
      persisted.type === "message.appended" ||
      persisted.type.startsWith("agent_instance.") ||
      persisted.type.startsWith("task")
    ) {
      void refreshToolCalls();
    }
  });
  void refreshToolCalls();
}

function trackSession(): void {
  createEffect(() => {
    void state.activeSessionId;
    void state.runs.length;
    void refreshToolCalls();
  });
}

export function toolRecordFor(runId: string, toolCallId: string): ToolCallRecord | undefined {
  return cache.toolCalls[runId]?.find((record) => record.id === toolCallId);
}

function toneClass(tone: "ok" | "warn" | "err" | "muted"): string {
  return tone === "muted" ? "" : tone;
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2).slice(0, 8000);
  } catch {
    return raw.slice(0, 8000);
  }
}

// ------------------------------------------------------- tool call expandible
export function ToolCallCard(props: { call: ToolCallPart; result?: ToolResultPart; runId: string }) {
  const [open, setOpen] = createSignal(false);
  const record = () => toolRecordFor(props.runId, props.call.toolCallId);
  // El result vive en el mensaje `tool`, separado del `tool_call` (W-C6): índice de sesión.
  const indexedResult = () => props.result ?? indexToolResults(state.messages).get(props.call.toolCallId);
  const status = () => record()?.status ?? (indexedResult() ? (indexedResult()!.ok ? "completed" : "failed") : "pending");
  const meta = () => toolStatusMeta(status());
  const duration = () => formatToolDurationMs(record()?.startedAt, record()?.completedAt);
  return (
    <div class="toolcall tc-card" data-toolcall={props.call.toolCallId} data-tc-status={status()}>
      <button
        type="button"
        class="tc-toggle"
        data-toolcall-toggle
        aria-expanded={open() ? "true" : "false"}
        aria-label={`${open() ? "Contraer" : "Expandir"} tool call ${props.call.name} (${meta().label})`}
        onClick={() => setOpen((value) => !value)}
      >
        <span class="toolname">{props.call.name}</span>
        <span class={`pill ${toneClass(meta().tone)}`} data-tc-status-pill={meta().label}>
          {meta().label}
        </span>
        <span class="muted tc-dur">{duration()}</span>
        <span class="tc-caret" aria-hidden="true">
          {open() ? "▾" : "▸"}
        </span>
      </button>
      <Show when={open()}>
        <div class="tc-body">
          <div class="tc-label">Arguments</div>
          <pre data-toolcall-args>{prettyJson(props.call.argumentsJson)}</pre>
          <Show when={indexedResult()}>
            <div class="tc-label">Result</div>
            <div class={`toolresult ${indexedResult()!.ok ? "ok" : "err"}`}>
              <pre data-toolcall-result>{indexedResult()!.text.slice(0, 4000)}</pre>
            </div>
          </Show>
          <Show when={!indexedResult() && record()?.resultText}>
            <div class="tc-label">Result</div>
            <div class="toolresult ok">
              <pre data-toolcall-result>{record()!.resultText!.slice(0, 4000)}</pre>
            </div>
          </Show>
          <Show when={record()?.error}>
            <div class="tc-label">Error</div>
            <pre class="tc-error" data-toolcall-error>
              {record()!.error}
            </pre>
          </Show>
          <Show when={record()?.artifactId}>
            <p class="muted tc-artifact" data-toolcall-artifact={record()!.artifactId}>
              Salida completa en artifact <code>{record()!.artifactId}</code> (el visor dedicado llega con el contrato N-C-03 del Todo 4; aquí se muestra el resumen inline real).
            </p>
          </Show>
          <Show when={record() && record()!.permission.decision !== "allow"}>
            <p class="muted" data-toolcall-permission={record()!.permission.decision}>
              Permiso: {record()!.permission.decision}
              {record()!.permission.rule ? ` (regla: ${record()!.permission.rule})` : ""}
            </p>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------- banda de errores
export function RunErrorsSection() {
  watchConversationWidgets();
  trackSession();
  const items = (): RuntimeErrorItem[] =>
    collectRunErrors({ runs: state.runs, tasks: state.tasks, instances: state.agentInstances, raised: cache.raised });

  return (
    <Show when={items().length > 0}>
      <details class="stage2" id="run-errors" open>
        <summary>
          Errores ({items().length})
        </summary>
        <ul class="err-list">
          <For each={items()}>
            {(item) => (
              <li class="err-item" data-error-item={item.id} data-error-scope={item.scope}>
                <span class="pill err">{item.scope}</span>
                <span class="err-msg">{item.message}</span>
                <Show when={item.taskId}>
                  <button type="button" data-error-retry={item.taskId} onClick={() => void retryTask(item.taskId!)}>
                    Reintentar
                  </button>
                </Show>
                <Show when={item.scope === "session" && item.id.startsWith("raised-")}>
                  <button
                    type="button"
                    data-error-dismiss={item.id}
                    onClick={() => setCache("raised", (raised) => raised.filter((entry) => entry.id !== item.id))}
                  >
                    Descartar
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </details>
    </Show>
  );
}

// ---------------------------------------------------------- archivos modificados
export function ModifiedFilesSection() {
  watchConversationWidgets();
  trackSession();
  const files = () => {
    const attempts = Object.values(state.taskAttempts).flat();
    const calls = Object.values(cache.toolCalls).flat();
    return collectModifiedFiles(attempts, calls);
  };
  return (
    <Show when={files().length > 0}>
      <details class="stage2" id="modified-files">
        <summary>
          Archivos modificados ({files().length})
        </summary>
        <ul class="file-list">
          <For each={files()}>
            {(file) => (
              <li class="file-item" data-modified-file={file.path} data-modified-source={file.source}>
                <code>{file.path}</code>
                <span class="muted">{file.summary}</span>
                <span class="pill">{file.source === "task-artifact" ? "task" : "tool"}</span>
              </li>
            )}
          </For>
        </ul>
        <p class="muted">El diff unificado por artifact llega con el contrato N-C-05 (Todo 17); aquí se listan rutas y resúmenes reales.</p>
      </details>
    </Show>
  );
}

// ------------------------------------------------- preguntas: timeout + réplica
export function questionTimeoutLabel(request: QuestionRequest): string {
  const remaining = questionTimeoutRemainingMs(request.createdAt, Date.now());
  return `Timeout: ${formatTimeoutRemainingMs(remaining)} — al responder se registra tu decisión.`;
}

export async function replyToQuestion(requestId: string, answers: Array<{ question: string; answers: string[] }>): Promise<void> {
  const result = await invoke("questions.reply", { requestId, answers });
  if (!result.ok) {
    setError("La pregunta ya fue respondida, venció o se canceló con la sesión (réplica duplicada rechazada por idempotencia).");
  }
}

/** Aprobaciones pendientes ordenadas (la más antigua primero). */
export function orderedApprovals() {
  return [...state.approvals].sort((a, b) => a.createdAt - b.createdAt);
}

/** Gate humano por revisión: presentada + pendiente (+ solicitud pendiente si existe). */
export function revisionGate(planId: string, revisionId: string) {
  const revision = state.planRevisions[planId]?.find((entry) => entry.id === revisionId);
  if (!revision) return { decidable: false, reason: "revision not loaded" };
  const pending = state.approvals.find((request) => request.revisionId === revisionId && request.status === "pending");
  return approvalGateForRevision(revision, pending);
}

