/** Renderer/views — conversación: mensajes, composer, diálogos y vista de chat. */
import { For, Show, createSignal } from "solid-js";
import type { Message, MessagePart } from "@octus/shared";
import { invoke } from "../api.js";
import { renderMarkdown } from "../markdown.js";
import {
  dismissSessionNotice,
  interrupt,
  sendPrompt,
  setError,
  setProfile,
  state,
} from "../store.js";
import { PlansSection, TasksSection, WorktreesSection, IntegrationsSection, MemorySection, AgentsSection } from "./sections.jsx";

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
    <div class={`message ${message().role}`}>
      <div class="role">
        {message().role}
        <Show when={message().mode}>
          <span class={`pill mode ${message().mode}`}>[{message().mode}]</span>
        </Show>
      </div>
      <For each={message().parts}>{(part) => <PartView part={part} />}</For>
    </div>
  );
}

export function Composer() {
  let input: HTMLTextAreaElement | undefined;
  const send = () => {
    if (input && input.value.trim()) {
      void sendPrompt(input.value);
      input.value = "";
    }
  };
  return (
    <div class="composer" id="composer">
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
      <div class="row">
        <button class="primary" disabled={!state.activeSessionId || state.busy} onClick={send}>
          Send
        </button>
        <Show when={state.busy}>
          <button onClick={() => void interrupt()}>Interrupt</button>
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
          <div class="dialog">
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
          <div class="dialog">
            <h3>Octus asks</h3>
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
                  void invoke("questions.reply", { requestId: request.id, answers });
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
      <div class="timeline message-timeline">
        <For each={state.messages}>{(message) => <MessageView message={message} />}</For>
        <For each={Object.values(state.live)}>
          {(live) =>
            live.text || live.reasoning || Object.keys(live.toolArgs).length > 0 ? (
              <div class="message assistant live">
                <div class="role">assistant (streaming)</div>
                <Show when={live.text}>
                  <div class="md" innerHTML={renderMarkdown(live.text)} />
                </Show>
                <Show when={live.reasoning}>
                  <details class="reasoning" open>
                    <summary>Reasoning summary</summary>
                    <div class="md" innerHTML={renderMarkdown(live.reasoning)} />
                  </details>
                </Show>
                <For each={Object.entries(live.toolArgs)}>
                  {([key, args]) => (
                    <div class="toolcall">
                      <span class="toolname">tool {key}</span>
                      <code>{args.slice(0, 500)}</code>
                    </div>
                  )}
                </For>
              </div>
            ) : null
          }
        </For>
      </div>
      <PlansSection />
      <TasksSection />
      <WorktreesSection />
      <IntegrationsSection />
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
