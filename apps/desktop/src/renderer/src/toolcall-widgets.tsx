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
  buildSubagentTree,
  collectModifiedFiles,
  collectRunErrors,
  formatTimeoutRemainingMs,
  formatToolDurationMs,
  indexToolResults,
  messageRenderItems,
  questionTimeoutRemainingMs,
  subagentLineage,
  subagentRollup,
  toolStatusMeta,
  type PairedToolCall,
  type RuntimeErrorItem,
  type SubagentNode,
} from "@octus/shared";
import { invoke, onEvent } from "./api.js";
import { DiffCard } from "./diff-view.jsx";
import { loadChildMessages, loadRunUsage, retryTask, setError, state } from "./store.js";

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

// ------------------------------------------- grupo colapsable por subagente
/** Árbol compacto de subagentes: una línea por agente y por herramienta.
 *  Colapsado muestra "subagente explorer · 3 tools · running"; al desplegar
 *  aparecen sus herramientas y sus hijos indentados (estilo opencode). */
export function ChildAgents(props: { parentInstanceId: string; depth?: number }) {
  const depth = () => props.depth ?? 1;
  const children = () => state.agentInstances.filter((i) => i.parentInstanceId === props.parentInstanceId);
  const fmtClock = (ms: number): string => {
    const total = Math.max(0, Math.round(ms / 1000));
    if (total < 60) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(total / 60)}m ${total % 60}s`;
  };
  return (
    <For each={children()}>
      {(child) => {
        const messages = () => state.childMessages[child.id] ?? [];
        createEffect(() => { void loadChildMessages(child.id, child.sessionId); });
        const tools = () => {
          const results = indexToolResults(messages());
          return messages().flatMap((m) =>
            messageRenderItems(m.parts)
              .filter((item) => item.kind === "tool")
              .map((item) => (item.kind === "tool" ? { ...item, result: item.result ?? results.get(item.call.toolCallId) } : item)),
          );
        };
        const def = () => state.definitions.find((d) => d.id === child.definitionId);
        const task = () => (child.taskId ? state.tasks.find((t) => t.id === child.taskId) : undefined);
        const label = () => {
          if (def()?.kind === "coordinator") return "coordinador";
          return `subagente ${def()?.name ?? child.definitionId}${task() ? ` · ${task()!.title}` : ""}`;
        };
        const active = () => ["created", "running", "waiting_permission", "waiting_input"].includes(child.status);
        const status = () => (active() ? "working" : child.status);
        const elapsed = () => (active() ? "" : formatToolDurationMs(child.createdAt, child.updatedAt));
        createEffect(() => {
          if (!active()) void loadRunUsage(child.runId);
        });
        const usage = () => (state.usageByRun[child.runId] ?? []).filter((row) => row.agentInstanceId === child.id);
        const model = () => {
          const own = child.model ?? usage()[0];
          if (!own) return "";
          const catalog = state.modelsByProvider[own.providerId] ?? [];
          return catalog.find((entry) => entry.modelId === own.modelId)?.displayName ?? own.modelId;
        };
        const agentFooter = () => {
          if (active()) return "working";
          const wall = Math.max(0, child.updatedAt - child.createdAt);
          return [model(), fmtClock(wall)].filter(Boolean).join(" · ");
        };
        return (
          <details class="activity-node" open={active()} data-subagent-group={child.id} data-subagent-depth={depth()} data-subagent-status={status()} style={{ "margin-left": `${(depth() - 1) * 14}px` }}>
            <summary>
              <span class="activity-caret" aria-hidden="true">›</span>
              <span class="activity-name">{label()}</span>
              <span class="activity-meta">
                {status()}
                {elapsed() ? ` · ${elapsed()}` : ""}
                {tools().length > 0 ? ` · ${tools().length} tool${tools().length === 1 ? "" : "s"}` : ""}
              </span>
            </summary>
            <div class="activity-body">
              <For each={tools()}>
                {(item) => (
                  <div class="activity-tool" data-tool-status={item.kind === "tool" && item.result ? (item.result.ok ? "completed" : "failed") : "running"}>
                    <span class="activity-dot" aria-hidden="true" />
                    <span class="activity-tool-name">{item.kind === "tool" ? item.call.name : ""}</span>
                    <span class="activity-meta">{item.kind === "tool" && item.result ? (item.result.ok ? "ok" : "failed") : "running"}</span>
                  </div>
                )}
              </For>
              <For each={tools().filter((item) => item.result?.diff)}>{(item) => <DiffCard diff={item.result!.diff!} />}</For>
              <ChildAgents parentInstanceId={child.id} depth={depth() + 1} />
              <Show when={!active() && agentFooter()}>
                <div class="agent-footer" data-agent-footer={child.id}>{agentFooter()}</div>
              </Show>
            </div>
          </details>
        );
      }}
    </For>
  );
}

/** Tool calls de un mensaje agrupados bajo su subagente (todo workbench-chat-terminal/3).
 *  Colapsado por defecto (también `depth>=1` anidado); la pill resume el
 *  grupo (failed > active > done). El cuerpo reutiliza ToolCallCard. */
export function SubagentToolGroup(props: { instanceId: string; runId: string; calls: PairedToolCall[] }) {
  const node = (): SubagentNode | undefined => {
    const stack = [...buildSubagentTree(state.agentInstances)];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.instance.id === props.instanceId) return current;
      stack.push(...current.children);
    }
    return undefined;
  };
  const lineage = () => subagentLineage(state.agentInstances, props.instanceId);
  const depth = () => node()?.depth ?? 0;
  const nested = () => node()?.children.length ?? 0;
  const label = () => {
    const chain = lineage();
    if (chain.length === 0) return props.instanceId.slice(0, 12);
    return chain.map((entry) => {
      const def = state.definitions.find((d) => d.id === entry.definitionId);
      if (def?.kind === "coordinator") return "coordinador";
      const task = entry.taskId ? state.tasks.find((t) => t.id === entry.taskId) : undefined;
      return `subagente ${entry.definitionId}${task ? ` · ${task.title}` : ""}`;
    }).join(" › ");
  };
  const callStatus = (item: PairedToolCall) =>
    toolRecordFor(props.runId, item.call.toolCallId)?.status ?? (item.result ? (item.result.ok ? "completed" : "failed") : "pending");
  const rollup = () => {
    const statuses: string[] = props.calls.map(callStatus);
    const chain = lineage();
    const leaf = chain[chain.length - 1];
    if (leaf) statuses.push(leaf.status);
    return subagentRollup(statuses);
  };
  return (
    <details class="subagent-group" data-subagent-group={props.instanceId} data-subagent-depth={depth()} data-subagent-status={rollup().status}>
      <summary>
        <span class="toolname">{label()}</span>
        <span class={`pill ${toneClass(rollup().tone)}`} data-subagent-rollup={rollup().status}>
          {rollup().status}
        </span>
        <span class="muted">
          {props.calls.length} tool call(s)
          <Show when={nested() > 0}> · {nested()} nested</Show>
        </span>
      </summary>
      <div class="subagent-body">
        <For each={props.calls}>{(item) => <ToolCallCard call={item.call} result={item.result} runId={props.runId} />}</For>
      </div>
    </details>
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
      <details class="stage2" id="run-errors">
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

