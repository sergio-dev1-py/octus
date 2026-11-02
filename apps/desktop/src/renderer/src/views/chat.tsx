/** Renderer/views — conversación: mensajes, composer, diálogos y vista de chat. */
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { Message, MessagePart } from "@octus/shared";
import { messageRenderItems } from "@octus/shared";
import { invoke } from "../api.js";
import { renderMarkdown } from "../markdown.js";
import { CHAT_DOM_WINDOW } from "../perf.js";
import { windowMessages } from "../timeline.js";
import {
  ModifiedFilesSection,
  RunErrorsSection,
  ToolCallCard,
  questionTimeoutLabel,
  replyToQuestion,
} from "../toolcall-widgets.jsx";
import type { LiveMessage } from "../store.js";
import {
  addAttachments,
  dismissCancelNotice,
  dismissSessionNotice,
  interrupt,
  loadModels,
  loadOlderMessages,
  removeAttachment,
  sendPrompt,
  setError,
  setProfile,
  setSessionModel,
  state,
} from "../store.js";
import { PlansSection, TasksSection, WorktreesSection, IntegrationsSection, MemorySection, AgentsSection } from "./sections.jsx";
import { DagSection, WorktreeDiffSection, IntegrationHistorySection } from "./dag.jsx";

export function PartView(props: { part: MessagePart }) {
  const part = () => props.part;
  return (
    <>
      {part().type === "text" && <div class="md" innerHTML={renderMarkdown((part() as { text: string }).text)} />}
      {part().type === "reasoning_summary" && (
        <details class="reasoning">
          <summary>Reasoning summary</summary>
          <div class="md" innerHTML={renderMarkdown((part() as { text: string }).text)} />
        </details>
      )}
      {part().type === "tool_call" && (
        <div class="toolcall">
          <span class="toolname">{(part() as { name: string }).name}</span>
          <code>{(part() as { argumentsJson: string }).argumentsJson.slice(0, 500)}</code>
        </div>
      )}
      {part().type === "tool_result" && (
        <div class={`toolresult ${(part() as { ok: boolean }).ok ? "ok" : "err"}`}>
          <pre>{(part() as { text: string }).text.slice(0, 4000)}</pre>
        </div>
      )}
    </>
  );
}

export function MessageView(props: { message: Message }) {
  const message = () => props.message;
  return (
    <div class={`message ${message().role}`} data-message-id={message().id}>
      <div class="role">
        {message().role}
        <Show when={message().mode}>
          <span class={`pill mode ${message().mode}`}>[{message().mode}]</span>
        </Show>
      </div>
      <For each={messageRenderItems(message().parts)}>
        {(item) =>
          item.kind === "tool" ? (
            <ToolCallCard call={item.call} result={item.result} runId={message().runId} />
          ) : (
            <PartView part={item.part} />
          )
        }
      </For>
    </div>
  );
}

/** Marco de streaming con estado visible por marco (N-C-12a/12b). */
export function LiveView(props: { live: LiveMessage }) {
  const live = () => props.live;
  return (
    <Show when={live().text || live().reasoning || Object.keys(live().tools).length > 0}>
      <div class="message assistant live" data-live={live().id} data-text-status={live().textStatus}>
        <div class="role">
          assistant (streaming) <FrameStatus status={live().textStatus} />
        </div>
        <Show when={live().text}>
          <div class="md" innerHTML={renderMarkdown(live().text)} />
        </Show>
        <Show when={live().reasoning}>
          <details class="reasoning" open>
            <summary>
              Reasoning summary <FrameStatus status={live().reasoningStatus} />
            </summary>
            <div class="md" innerHTML={renderMarkdown(live().reasoning)} />
          </details>
        </Show>
        <For each={Object.entries(live().tools)}>
          {([key, frame]) => (
            <div class="toolcall" data-tool-status={frame.status}>
              <span class="toolname">tool {key}</span>
              <FrameStatus status={frame.status} />
              <code>{frame.args.slice(0, 500)}</code>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

export function FrameStatus(props: { status: "streaming" | "done" }) {
  return (
    <span class="frame-status" data-status={props.status}>
      {props.status === "done" ? "listo" : "en curso…"}
    </span>
  );
}

export function Composer() {
  let input: HTMLTextAreaElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  const session = () => state.sessions.find((s) => s.id === state.activeSessionId);
  const providerId = () => session()?.model?.providerId ?? state.providers[0]?.id ?? "";
  const providerModels = () =>
    state.modelsByProvider[providerId()] ?? state.providers.find((p) => p.id === providerId())?.models ?? [];
  const send = () => {
    if (input && input.value.trim()) {
      void sendPrompt(input.value);
      input.value = "";
    }
  };
  return (
    <div class="composer" id="composer">
      <Show when={state.attachments.length > 0}>
        <div class="chips" aria-label="Adjuntos">
          <For each={state.attachments}>
            {(attachment) => (
              <span class="chip" data-attachment={attachment.id}>
                {attachment.name} <span class="muted">{attachment.size} B</span>
                <button type="button" aria-label={`Quitar ${attachment.name}`} onClick={() => removeAttachment(attachment.id)}>
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <textarea
        ref={input}
        placeholder={state.activeSessionId ? "Type a request… (Enter to send)" : "Create or select a session first"}
        disabled={!state.activeSessionId || state.busy}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div class="row composer-row">
        <input
          ref={fileInput}
          id="composer-files"
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.currentTarget.files) void addAttachments(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
        <button id="composer-attach" type="button" disabled={!state.activeSessionId || state.busy} onClick={() => fileInput?.click()}>
          Adjuntar
        </button>
        <select
          id="composer-provider"
          aria-label="Proveedor"
          value={providerId()}
          disabled={!state.activeSessionId || state.busy || state.providers.length === 0}
          onChange={(event) => {
            const next = event.currentTarget.value;
            void loadModels(next);
          }}
        >
          <For each={state.providers}>{(provider) => <option value={provider.id}>{provider.displayName}</option>}</For>
        </select>
        <select
          id="composer-model"
          aria-label="Modelo"
          value={session()?.model?.modelId ?? ""}
          disabled={!state.activeSessionId || state.busy || providerModels().length === 0}
          onChange={(event) => {
            const modelId = event.currentTarget.value;
            if (modelId) void setSessionModel({ providerId: providerId(), modelId });
          }}
        >
          <Show when={!session()?.model?.modelId}>
            <option value="">Elegir modelo…</option>
          </Show>
          <For each={providerModels()}>{(model) => <option value={model.modelId}>{model.displayName}</option>}</For>
        </select>
        <button class="primary" disabled={!state.activeSessionId || state.busy} onClick={send}>
          Send
        </button>
        <Show when={state.busy}>
          <button id="composer-cancel" onClick={() => void interrupt()}>
            Interrupt
          </button>
        </Show>
      </div>
    </div>
  );
}

export function PermissionDialogs() {
  const [feedback, setFeedback] = createSignal("");
  return (
    <For each={state.permissions}>
      {(request) => (
        <div class="modal">
          <div class="dialog" data-permission-request={request.id}>
            <h3>Permission requested</h3>
            <p>
              <strong>{request.action}</strong>
            </p>
            <pre>{request.resources.join("\n")}</pre>
            <Show when={request.detail}>
              <pre class="detail">{request.detail}</pre>
            </Show>
            <input placeholder="Feedback for reject (optional)" value={feedback()} onInput={(e) => setFeedback(e.currentTarget.value)} />
            <div class="row">
              <button class="primary" onClick={() => void invoke("permissions.reply", { requestId: request.id, decision: "once" })}>
                Allow once
              </button>
              <Show when={request.action !== "shell"}>
                <button onClick={() => void invoke("permissions.reply", { requestId: request.id, decision: "always" })}>Always</button>
              </Show>
              <button
                class="danger"
                onClick={() => void invoke("permissions.reply", { requestId: request.id, decision: "reject", message: feedback() })}
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      )}
    </For>
  );
}

export function QuestionDialogs() {
  return (
    <For each={state.questions}>
      {(request) => (
        <div class="modal">
          <div class="dialog" data-question-request={request.id}>
            <h3>Octus asks</h3>
            <p class="muted q-timeout" data-question-timeout>
              {questionTimeoutLabel(request)}
            </p>
            <For each={request.questions}>
              {(question, qi) => (
                <div class="question">
                  <p>
                    <strong>{question.header}</strong>: {question.question}
                  </p>
                  <For each={question.options}>
                    {(option, oi) => (
                      <label>
                        <input
                          type={question.multiple ? "checkbox" : "radio"}
                          name={request.id + qi()}
                          value={option.label}
                          data-question={question.question}
                          data-multiple={question.multiple ? "1" : ""}
                        />
                        {option.label} <span class="muted">{option.description ?? ""}</span>
                      </label>
                    )}
                  </For>
                  <input type="text" placeholder="Or type your own answer" data-custom={question.question} />
                </div>
              )}
            </For>
            <div class="row">
              <button
                class="primary"
                onClick={(event) => {
                  const dialog = (event.currentTarget as HTMLElement).closest(".dialog")!;
                  const answers = request.questions.map((question) => {
                    const checked = [...dialog.querySelectorAll<HTMLInputElement>(`input[data-question="${CSS.escape(question.question)}"]:checked`)].map(
                      (el) => el.value,
                    );
                    const custom = dialog.querySelector<HTMLInputElement>(`input[data-custom="${CSS.escape(question.question)}"]`)?.value.trim();
                    if (custom) checked.push(custom);
                    return { question: question.question, answers: checked };
                  });
                  void replyToQuestion(request.id, answers);
                }}
              >
                Answer
              </button>
            </div>
          </div>
        </div>
      )}
    </For>
  );
}

export function ChatView() {
  const session = () => state.sessions.find((s) => s.id === state.activeSessionId);
  // Todo 34 (§7: scroll de 5.000 mensajes a 60 fps): el historial pagina en el
  // servidor de 100 en 100 y el DOM pinta como máximo CHAT_DOM_WINDOW nodos.
  // Sin esta ventana, paginar hacia atrás haría crecer el DOM con la conversación.
  const visibleMessages = () => windowMessages(state.messages, CHAT_DOM_WINDOW);
  const domHidden = () => state.messages.length - visibleMessages().length;
  let timelineEl: HTMLDivElement | undefined;
  let olderObserver: IntersectionObserver | undefined;
  // N-C-06: carga automática de la página anterior al asomar el centinela.
  const observeOlder = (el: HTMLDivElement) => {
    olderObserver?.disconnect();
    if (!el || typeof IntersectionObserver === "undefined") return;
    // Raíz = el propio scroller (closest, no la ref: el orden de montaje no la garantiza).
    const root = el.closest(".message-timeline") ?? timelineEl ?? undefined;
    olderObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadOlderMessages();
      },
      { root: root ?? null },
    );
    olderObserver.observe(el);
  };
  const bottomAnchor: (el: HTMLDivElement) => void = () => undefined;
  onCleanup(() => olderObserver?.disconnect());
  onMount(() => {
    // El centinela solo se arma al desplazar: sin carrera con el autoscroll inicial.
    const el = timelineEl;
    if (!el) return;
    const arm = () => {
      const sentinel = el.querySelector("#timeline-sentinel");
      if (sentinel instanceof HTMLDivElement) observeOlder(sentinel);
    };
    el.addEventListener("scroll", arm, { passive: true });
    onCleanup(() => el.removeEventListener("scroll", arm));
  });
  // Al abrir/cambiar de sesión se salta al final; después solo se sigue el
  // directo si el usuario ya estaba abajo (no roba el scroll).
  let followKey = "";
  createEffect(() => {
    const count = state.messages.length;
    void Object.keys(state.live).length;
    const el = timelineEl;
    if (!el || count === 0) return;
    const key = state.activeSessionId ?? "";
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (key !== followKey || nearBottom) el.scrollTop = el.scrollHeight;
    followKey = key;
  });
  return (
    <main class="chat">
      <Show when={!state.budgetsConfigured}>
        <div class="banner warn">Budgets are not configured: paid calls are blocked until you save limits in Settings → Budgets.</div>
      </Show>
      <Show when={state.error}>
        <div class="banner err">
          {state.error}
          <button onClick={() => setError(undefined)}>×</button>
        </div>
      </Show>
      <Show when={state.sessionNotice}>
        <div id="session-notice" class="banner warn" role="status">
          {state.sessionNotice}
          <button onClick={() => void dismissSessionNotice()}>×</button>
        </div>
      </Show>
      <header>
        <h2>{session()?.title ?? "No session"}</h2>
        <Show when={session()}>
          <div class="row">
            <select value={session()!.profile} onChange={(e) => void setProfile(e.currentTarget.value as "plan" | "build")}>
              <option value="build">build</option>
              <option value="plan">plan</option>
            </select>
            <span class="muted">{state.busy ? "working…" : "idle"}</span>
          </div>
        </Show>
      </header>
      <Show when={state.cancelReason}>
        <div id="cancel-notice" class="banner warn" role="status">
          Run cancelado: {state.cancelReason}
          <button aria-label="Descartar aviso de cancelación" onClick={() => dismissCancelNotice()}>
            ×
          </button>
        </div>
      </Show>
      <div
        class="timeline message-timeline"
        ref={timelineEl}
        data-timeline-total={state.timelineTotal}
        data-timeline-rendered={visibleMessages().length}
        data-timeline-older={state.timelineHasOlder ? "true" : "false"}
      >
        <Show when={state.timelineHasOlder}>
          <div class="older-wrap">
            <div id="timeline-sentinel" />
            <button id="timeline-older" onClick={() => void loadOlderMessages()}>
              Mostrar anteriores ({state.timelineTotal - state.messages.length} restantes)
            </button>
          </div>
        </Show>
        <Show when={domHidden() > 0}>
          <p class="muted" data-timeline-dom-window>
            Ventana del DOM: {visibleMessages().length} de {state.messages.length} cargados (los anteriores quedan diferidos fuera del DOM).
          </p>
        </Show>
        <For each={visibleMessages()}>{(message) => <MessageView message={message} />}</For>
        <For each={Object.values(state.live)}>{(live) => <LiveView live={live} />}</For>
        <div id="timeline-bottom" ref={bottomAnchor} />
      </div>
      <PlansSection />
      <RunErrorsSection />
      <ModifiedFilesSection />
      <TasksSection />
      <WorktreesSection />
      <IntegrationsSection />
      <DagSection />
      <WorktreeDiffSection />
      <IntegrationHistorySection />
      <MemorySection />
      <AgentsSection />
      <Composer />
      <details>
        <summary>Usage of the last run ({state.usage.length} calls)</summary>
        <ul>
          <For each={state.usage}>
            {(record) => (
              <li>
                <code>
                  {record.providerId}/{record.modelId}
                </code>{" "}
                in {record.inputTokens.toLocaleString()} / out {record.outputTokens.toLocaleString()} / reason{" "}
                {record.reasoningTokens.toLocaleString()} / cached {record.cachedTokens.toLocaleString()} —{" "}
                {record.costMicroUsd === null ? "cost unknown (no pricing)" : `$${(record.costMicroUsd / 1_000_000).toFixed(4)}`} — {record.status}
              </li>
            )}
          </For>
        </ul>
      </details>
    </main>
  );
}
