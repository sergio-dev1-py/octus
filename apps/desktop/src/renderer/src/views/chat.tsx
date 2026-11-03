/** Renderer/views — conversación: mensajes, composer, diálogos y vista de chat. */
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { Message, MessagePart, ModelDescriptor, PairedToolCall } from "@octus/shared";
import { footerForMessage, formatDuration, formatMessageFooter, messageRenderItems } from "@octus/shared";
import { invoke } from "../api.js";
import { renderMarkdown } from "../markdown.js";
import { CHAT_DOM_WINDOW } from "../perf.js";
import { windowMessages } from "../timeline.js";
import {
  SubagentToolGroup,
  orderedApprovals,
  questionTimeoutLabel,
  replyToQuestion,
} from "../toolcall-widgets.jsx";
import type { LiveMessage } from "../store.js";
import {
  addAttachments,
  decideApproval,
  dismissCancelNotice,
  dismissSessionNotice,
  interrupt,
  loadModels,
  loadOlderMessages,
  reloadProviderModels,
  reloadProviders,
  removeAttachment,
  sendPrompt,
  setError,
  setProfile,
  setSessionModel,
  setState,
  state,
} from "../store.js";
import { PlansSection } from "./sections.jsx";

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
  // Todo workbench-chat-terminal/3: textos directos; los tool calls se agrupan
  // por subagente en un details colapsable (aparecen SOLO mientras hay trabajo).
  const textParts = (): MessagePart[] => {
    const out: MessagePart[] = [];
    for (const part of message().parts) {
      if (part.type !== "tool_call" && part.type !== "tool_result") out.push(part);
    }
    return out;
  };
  const toolItems = (): PairedToolCall[] => {
    const out: PairedToolCall[] = [];
    for (const item of messageRenderItems(message().parts)) {
      if (item.kind === "tool") out.push(item);
    }
    return out;
  };
  // Todo workbench-chat-terminal/4: footer fuera de la burbuja, solo con
  // filas del mensaje exacto (runs.usage ya cargado); legacy NULL = sin footer.
  const footer = () => (message().role === "assistant" ? footerForMessage(message().id, state.usage) : undefined);
  // Chat todo en uno (estilo opencode): sin cabeceras de rol/modo y sin
  // burbujas vacías (un mensaje sin texto ni tool calls no pinta nada).
  // El trabajo del asistente se agrupa colapsable: "Worked for X · Used N tools".
  const isEmpty = () => textParts().length === 0 && toolItems().length === 0;
  const workLabel = () => {
    const parts: string[] = [];
    const footerValue = footer();
    if (footerValue) parts.push(`Worked for ${formatDuration(footerValue.durationMs)}`);
    if (toolItems().length > 0) parts.push(`Used ${toolItems().length} tool${toolItems().length === 1 ? "" : "s"}`);
    return parts.join(" · ");
  };
  return (
    <Show when={!isEmpty()}>
      <Show when={message().role === "assistant" && workLabel()} fallback={
        <div class={`message ${message().role}`} data-message-id={message().id}>
          <For each={textParts()}>{(part) => <PartView part={part} />}</For>
          <Show when={toolItems().length > 0}>
            <SubagentToolGroup instanceId={message().instanceId} runId={message().runId} calls={toolItems()} />
          </Show>
        </div>
      }>
        <details class="work" open data-message-id={message().id}>
          <summary>{workLabel()}</summary>
          <div class={`message ${message().role}`}>
            <For each={textParts()}>{(part) => <PartView part={part} />}</For>
            <Show when={toolItems().length > 0}>
              <SubagentToolGroup instanceId={message().instanceId} runId={message().runId} calls={toolItems()} />
            </Show>
          </div>
        </details>
      </Show>
      <Show when={footer()}>
        <div class="message-footer" data-message-footer={message().id} data-footer-status={footer()!.status} title={`${toolItems().length} herramienta(s) · in ${footer()!.inputTokens.toLocaleString()} / out ${footer()!.outputTokens.toLocaleString()}`}>
          {formatMessageFooter(footer()!, toolItems().length)}
        </div>
      </Show>
    </Show>
  );
}

/** Marco de streaming con estado visible por marco (N-C-12a/12b). */
export function LiveView(props: { live: LiveMessage }) {
  const live = () => props.live;
  return (
    <Show when={live().text || live().reasoning || Object.keys(live().tools).length > 0}>
      <div class="message assistant live" data-live={live().id} data-text-status={live().textStatus}>
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

const RECENT_MODELS_KEY = "octus.recentModels.v1";

interface RecentModel {
  providerId: string;
  modelId: string;
}

function readRecentModels(): RecentModel[] {
  try {
    const raw = localStorage.getItem(RECENT_MODELS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is RecentModel => typeof r === "object" && r !== null && typeof (r as RecentModel).providerId === "string" && typeof (r as RecentModel).modelId === "string")
      .slice(0, 5);
  } catch {
    return [];
  }
}

function pushRecentModel(ref: RecentModel): void {
  try {
    const next = [{ providerId: ref.providerId, modelId: ref.modelId }, ...readRecentModels().filter((r) => !(r.providerId === ref.providerId && r.modelId === ref.modelId))].slice(0, 5);
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(next));
  } catch {
    // Sin almacenamiento: sin recientes.
  }
}

export function ModelPicker() {
  const session = () => state.sessions.find((s) => s.id === state.activeSessionId);
  const providerId = () => session()?.model?.providerId ?? state.providers.find((p) => p.configured)?.id ?? state.providers[0]?.id ?? "";
  // Ante caché ausente se carga una vez; no refetchea si ya hay caché.
  createEffect(() => {
    const pid = providerId();
    if (pid && !state.modelsByProvider[pid]) void loadModels(pid);
  });
  const catalogOf = (pid: string): ModelDescriptor[] =>
    state.modelsByProvider[pid] ?? state.providers.find((p) => p.id === pid)?.models ?? [];
  const displayOf = (pid: string, mid: string): string =>
    catalogOf(pid).find((m) => m.modelId === mid)?.displayName ?? mid;
  const currentModel = () => catalogOf(providerId()).find((m) => m.modelId === session()?.model?.modelId);
  const efforts = () => currentModel()?.capabilities?.reasoningEfforts ?? [];
  const profile = () => session()?.profile ?? "plan";
  const disabled = () => !state.activeSessionId || state.busy;
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [refreshing, setRefreshing] = createSignal(false);
  const [recentsTick, setRecentsTick] = createSignal(0);

  const recents = () => {
    void recentsTick();
    return readRecentModels().filter((r) => catalogOf(r.providerId).some((m) => m.modelId === r.modelId));
  };

  const groups = () => {
    const needle = query().trim().toLowerCase();
    return state.providers
      .map((provider) => ({
        providerId: provider.id,
        displayName: provider.displayName,
        configured: provider.configured,
        models: catalogOf(provider.id).filter(
          (m) => !needle || m.modelId.toLowerCase().includes(needle) || (m.displayName ?? "").toLowerCase().includes(needle),
        ),
      }))
      .filter((g) => g.models.length > 0 || !needle);
  };

  const refreshAll = () => {
    if (refreshing()) return;
    setRefreshing(true);
    void (async () => {
      try {
        for (const provider of state.providers) {
          if (!provider.configured) continue;
          try {
            await invoke("providers.refreshCatalog", { providerId: provider.id });
          } catch {
            // Sigue con el catálogo en caché.
          }
          await reloadProviderModels(provider.id).catch(() => undefined);
        }
        await reloadProviders().catch(() => undefined);
      } finally {
        setRefreshing(false);
      }
    })();
  };

  const pickModel = (pid: string, mid: string) => {
    const supported = catalogOf(pid).find((m) => m.modelId === mid)?.capabilities?.reasoningEfforts ?? [];
    const prev = session()?.model?.effort;
    // El esfuerzo solo sobrevive si el modelo nuevo lo publica; si no, se limpia.
    const effort = prev && (supported as string[]).includes(prev) ? prev : undefined;
    pushRecentModel({ providerId: pid, modelId: mid });
    setRecentsTick((t) => t + 1);
    setOpen(false);
    setQuery("");
    void setSessionModel({ providerId: pid, modelId: mid, effort });
  };

  const chooseEffort = (effort: string | undefined) => {
    const modelId = session()?.model?.modelId;
    if (!modelId) return;
    void setSessionModel({ providerId: providerId(), modelId, effort });
  };
  return (
    <div class="model-picker" id="model-picker" aria-label="Modelo y esfuerzo">
      <select
        id="composer-profile"
        class="composer-chip"
        aria-label="Perfil"
        title="Perfil (Shift+Tab para cambiar)"
        value={profile()}
        disabled={disabled()}
        onChange={(event) => void setProfile(event.currentTarget.value as "plan" | "build")}
      >
        <option value="plan">plan</option>
        <option value="build">build</option>
      </select>
      <button
        type="button"
        id="composer-model-button"
        class="composer-chip composer-model-button"
        title="Elegir modelo"
        disabled={disabled()}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => {
          if (!open()) {
            setOpen(true);
            setQuery("");
            refreshAll();
          } else {
            setOpen(false);
          }
        }}
      >
        <span class="value">{currentModel()?.displayName ?? session()?.model?.modelId ?? "Elegir modelo…"}</span>
        <span aria-hidden="true">▾</span>
      </button>
      <Show when={efforts().length > 0}>
        <div class="effort-segment" role="group" aria-label="Esfuerzo de razonamiento">
          <button
            type="button"
            class={`effort-chip${!session()?.model?.effort ? " active" : ""}`}
            title="Usar el ajuste por defecto"
            disabled={disabled()}
            onClick={() => chooseEffort(undefined)}
          >
            Default
          </button>
          <For each={efforts()}>
            {(effort) => (
              <button
                type="button"
                class={`effort-chip${session()?.model?.effort === effort ? " active" : ""}`}
                disabled={disabled()}
                onClick={() => chooseEffort(effort)}
              >
                {effort}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={open()}>
        <div class="model-popover-backdrop" onClick={() => setOpen(false)} />
        <div class="model-popover" role="listbox" aria-label="Modelos disponibles">
          <input
            type="text"
            id="composer-model-search"
            placeholder="Buscar modelo…"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            aria-label="Buscar modelo"
          />
          <Show when={refreshing()}>
            <p class="muted">Actualizando catálogo…</p>
          </Show>
          <Show when={query().trim() === "" && recents().length > 0}>
            <div class="model-group-label">Recientes</div>
            <For each={recents()}>
              {(recent) => (
                <button
                  type="button"
                  class="model-item"
                  data-model-item={`${recent.providerId}/${recent.modelId}`}
                  aria-selected={recent.modelId === session()?.model?.modelId && recent.providerId === providerId()}
                  onClick={() => pickModel(recent.providerId, recent.modelId)}
                >
                  <span class="name">{displayOf(recent.providerId, recent.modelId)}</span>
                  <span class="sub">{state.providers.find((p) => p.id === recent.providerId)?.displayName ?? recent.providerId}</span>
                </button>
              )}
            </For>
          </Show>
          <For each={groups()}>
            {(group) => (
              <>
                <div class="model-group-label">
                  {group.displayName} {!group.configured ? <span class="muted">· sin key</span> : null}
                </div>
                <For each={group.models}>
                  {(model) => (
                    <button
                      type="button"
                      class="model-item"
                      data-model-item={`${group.providerId}/${model.modelId}`}
                      aria-selected={model.modelId === session()?.model?.modelId && group.providerId === providerId()}
                      disabled={!group.configured}
                      title={!group.configured ? "Carga la API key en Ajustes › Proveedores" : `${model.modelId} · ctx ${model.capabilities.maxContextTokens.toLocaleString()}`}
                      onClick={() => pickModel(group.providerId, model.modelId)}
                    >
                      <span class="name">{model.displayName}</span>
                      <span class="sub">{model.modelId}</span>
                      <Show when={model.capabilities.reasoningEfforts.length > 0}>
                        <span class="sub">{model.capabilities.reasoningEfforts.join(" · ")}</span>
                      </Show>
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function Composer() {
  let input: HTMLTextAreaElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  const [mentionSkills, setMentionSkills] = createSignal<string[]>([]);
  const [suggestions, setSuggestions] = createSignal<Array<{ kind: "skill" | "file"; value: string; label: string; description?: string }>>([]);
  const [suggestionIndex, setSuggestionIndex] = createSignal(0);
  let suggestTimer: ReturnType<typeof setTimeout> | undefined;
  const autogrow = () => {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  };
  const send = () => {
    if (input && (input.value.trim() || mentionSkills().length > 0)) {
      const skills = mentionSkills();
      void sendPrompt(input.value, skills.length > 0 ? skills : undefined);
      input.value = "";
      setMentionSkills([]);
      setSuggestions([]);
      autogrow();
    }
  };
  const mentionQuery = (): string | undefined => {
    if (!input) return undefined;
    const cursor = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, cursor);
    const match = before.match(/(?:^|\s)@([A-Za-z0-9_.\-/]*)$/);
    return match ? (match[1] ?? "") : undefined;
  };
  const refreshSuggestions = (needle: string) => {
    if (suggestTimer !== undefined) clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => {
      void (async () => {
        const q = needle.toLowerCase();
        const out: Array<{ kind: "skill" | "file"; value: string; label: string; description?: string }> = [];
        try {
          const projectId = state.activeProjectId;
          const { skills } = await invoke("skills.catalog", projectId ? { projectId } : {});
          for (const skill of skills.filter((s) => s.enabled !== false)) {
            if (!q || skill.name.toLowerCase().includes(q) || (skill.description ?? "").toLowerCase().includes(q)) {
              out.push({ kind: "skill", value: skill.name, label: skill.name, description: skill.description });
              if (out.length >= 6) break;
            }
          }
        } catch {
          // Sin catálogo: solo archivos.
        }
        try {
          const project = state.projects.find((p) => p.id === state.activeProjectId);
          if (project && out.length < 10) {
            const { ok, page } = await invoke("files.list", { projectId: project.id, relDir: ".", page: 1, pageSize: 50 });
            if (ok && page) {
              for (const entry of page.entries.filter((e) => e.kind === "file")) {
                if (!q || entry.relPath.toLowerCase().includes(q)) {
                  out.push({ kind: "file", value: entry.relPath, label: entry.relPath });
                  if (out.length >= 10) break;
                }
              }
            }
          }
        } catch {
          // Sin archivos: solo skills.
        }
        setSuggestions(out);
        setSuggestionIndex(0);
      })();
    }, 120);
  };
  const applySuggestion = (suggestion: { kind: "skill" | "file"; value: string; label: string }) => {
    if (!input) return;
    const cursor = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, cursor);
    const after = input.value.slice(cursor);
    const replaced = before.replace(/(?:^|\s)@[A-Za-z0-9_.\-/]*$/, (match) => (match.startsWith(" ") ? " " : ""));
    if (suggestion.kind === "skill") {
      if (!mentionSkills().includes(suggestion.value)) setMentionSkills([...mentionSkills(), suggestion.value]);
      input.value = `${replaced}${after}`;
    } else {
      input.value = `${replaced}@${suggestion.value} ${after}`;
      void attachMentionedFile(suggestion.value);
    }
    setSuggestions([]);
    autogrow();
    input.focus();
  };
  const attachMentionedFile = async (relPath: string) => {
    const project = state.projects.find((p) => p.id === state.activeProjectId);
    if (!project) return;
    try {
      const result = await invoke("files.read", { projectId: project.id, relPath });
      if (!result.ok || !result.file) return;
      const text = result.file.content;
      setState("attachments", [
        ...state.attachments,
        { id: `mention-${Date.now()}-${relPath}`, name: `@${relPath}`, size: text.length, text },
      ]);
    } catch {
      // El @ queda como texto si la lectura falla.
    }
  };
  return (
    <div class="composer-wrap">
    <div class="composer">
    <div class="composer-box" id="composer">
      <Show when={mentionSkills().length > 0}>
        <div class="composer-attachments" aria-label="Skills adjuntas">
          <For each={mentionSkills()}>
            {(skill) => (
              <span class="composer-attachment composer-skill" data-skill={skill}>
                @{skill}
                <button type="button" class="icon-button" aria-label={`Quitar skill ${skill}`} onClick={() => setMentionSkills(mentionSkills().filter((s) => s !== skill))}>
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={state.attachments.length > 0}>
        <div class="composer-attachments" aria-label="Adjuntos">
          <For each={state.attachments}>
            {(attachment) => (
              <span class="composer-attachment" data-attachment={attachment.id}>
                {attachment.name} <span class="muted">{attachment.size} B</span>
                <button type="button" class="icon-button" aria-label={`Quitar ${attachment.name}`} onClick={() => removeAttachment(attachment.id)}>
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={suggestions().length > 0}>
        <div class="composer-suggestions" role="listbox" aria-label="Menciones">
          <For each={suggestions()}>
            {(suggestion, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index() === suggestionIndex()}
                class={`suggestion${index() === suggestionIndex() ? " selected" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applySuggestion(suggestion);
                }}
              >
                <span aria-hidden="true">{suggestion.kind === "skill" ? "✦ " : "@ "}</span>
                <span class="name">{suggestion.label}</span>
                <Show when={suggestion.description}>
                  <span class="muted">{suggestion.description?.slice(0, 60)}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <textarea
        ref={input}
        rows={1}
        placeholder={state.activeSessionId ? "Escribe un mensaje… (@ para skills y archivos, Enter para enviar)" : "Crea o elige una sesión para empezar"}
        disabled={!state.activeSessionId || state.busy}
        onInput={() => {
          autogrow();
          const needle = mentionQuery();
          if (needle === undefined) setSuggestions([]);
          else refreshSuggestions(needle);
        }}
        onKeyDown={(event) => {
          const list = suggestions();
          if (list.length > 0) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSuggestionIndex((i) => (i + 1) % list.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setSuggestionIndex((i) => (i - 1 + list.length) % list.length);
              return;
            }
            if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
              event.preventDefault();
              applySuggestion(list[suggestionIndex()]!);
              return;
            }
            if (event.key === "Escape") {
              setSuggestions([]);
              return;
            }
          }
          if (event.key === "Tab" && event.shiftKey) {
            event.preventDefault();
            const session = state.sessions.find((s) => s.id === state.activeSessionId);
            if (session && !state.busy) void setProfile(session.profile === "plan" ? "build" : "plan");
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div class="composer-footer">
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
        <button id="composer-attach" type="button" class="composer-chip composer-attach" title="Adjuntar archivos (Ctrl+U)" disabled={!state.activeSessionId || state.busy} onClick={() => fileInput?.click()}>
          +
        </button>
        <div class="composer-model">
          <ModelPicker />
        </div>
        <span style="flex:1" />
        <Show when={state.busy} fallback={
          <button class="send-button" title="Enviar (Enter)" disabled={!state.activeSessionId || state.busy} onClick={send}>
            ↑
          </button>
        }>
          <button id="composer-cancel" class="send-button stop" title="Detener" onClick={() => void interrupt()}>
            ■
          </button>
        </Show>
      </div>
    </div>
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
      <Show when={state.compactionNotice}>
        <div id="compaction-notice" class="banner warn" role="status" data-compaction-notice>
          <span class="spinner" aria-hidden="true" /> {state.compactionNotice}
          <button aria-label="Descartar aviso de compactación" onClick={() => { setState("compactionNotice", undefined); setState("compactionSummary", undefined); }}>
            ×
          </button>
        </div>
        <Show when={state.compactionSummary}>
          <details class="compaction-summary" open>
            <summary>Ver resumen compactado (nuevo contexto de los agentes)</summary>
            <div class="md" innerHTML={renderMarkdown(state.compactionSummary!)} />
          </details>
        </Show>
      </Show>
      <Show when={state.cancelReason}>
        <div id="cancel-notice" class="banner warn" role="status">
          Run cancelado: {state.cancelReason}
          <button aria-label="Descartar aviso de cancelación" onClick={() => dismissCancelNotice()}>
            ×
          </button>
        </div>
      </Show>
      <Show when={!state.busy && orderedApprovals().length > 0}>
        <div id="approval-notice" class="banner warn" role="alert" data-approval-pending={orderedApprovals().length}>
          <span>⚠ Plan esperando tu aprobación ({orderedApprovals().length}): sin aprobar no hay subagentes.</span>
          <span class="row" style={{ display: "inline-flex", gap: "var(--oc-space-2)" }}>
            <For each={orderedApprovals().slice(0, 1)}>
              {(request) => (
                <>
                  <button type="button" class="primary" data-approval-approve={request.id} onClick={() => void decideApproval(request.id, "approved")}>
                    Aprobar {request.revisionId}
                  </button>
                  <button type="button" class="danger" data-approval-reject={request.id} onClick={() => void decideApproval(request.id, "rejected")}>
                    Rechazar
                  </button>
                </>
              )}
            </For>
          </span>
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
        <Show when={visibleMessages().length === 0 && Object.keys(state.live).length === 0}>
          <div class="empty-state">
            {session() ? "Sin mensajes todavía. Escribe abajo para empezar." : "Crea o elige una sesión para empezar a conversar."}
          </div>
        </Show>
        <For each={visibleMessages()}>{(message) => <MessageView message={message} />}</For>
        <For each={Object.values(state.live)}>{(live) => <LiveView live={live} />}</For>
        <div id="timeline-bottom" ref={bottomAnchor} />
      </div>
      <Show when={!state.busy && state.approvals.length > 0}>
        <PlansSection />
      </Show>
      <Composer />
    </main>
  );
}
