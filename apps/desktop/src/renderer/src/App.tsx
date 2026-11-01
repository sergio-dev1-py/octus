/** Renderer — vistas de la Etapa 1: sesiones, chat, permisos, preguntas y ajustes. */
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { ActivityId, BottomTab, Message, MessagePart, Project, Session } from "@octus/shared";
import { layoutStyles, messageRenderItems, resizeBottomBy, resizeInspectorBy, resizeSidebarBy } from "@octus/shared";
import { invoke } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import CatalogView from "./components/catalog.jsx";
import {
  ModifiedFilesSection,
  RunErrorsSection,
  ToolCallCard,
  orderedApprovals,
  questionTimeoutLabel,
  replyToQuestion,
  revisionGate,
} from "./toolcall-widgets.jsx";
import {
  abortConflict,
  abortIntegration,
  approveIntegration,
  approveRevision,
  archivePlan,
  cancelAgent,
  cancelTask,
  cleanupConflictResolution,
  cleanupPreview,
  cleanupWorktree,
  closeSession,
  createPreview,
  createProject,
  createSession,
  decideApproval,
  decideMemory,
  dismissLayoutNotice,
  dismissSessionNotice,
  exportRevision,
  finalizeConflictResolution,
  implementRevision,
  incorporateConflictResolution,
  incorporateIntegration,
  initStore,
  inspectPreview,
  interrupt,
  isProjectBroken,
  loadPreviewLogs,
  previewWorkbenchLayout,
  markProjectBroken,
  proposeMemory,
  promoteIntegration,
  recoverActiveSession,
  renameSession,
  revalidateMemory,
  rebuildIntegration,
  rejectIntegration,
  rejectRevision,
  reloadBudgets,
  reloadIntegrations,
  reloadProviders,
  reloadWorktrees,
  requestConflictResolution,
  resolveMemoryConflict,
  restartPreview,
  retryTask,
  reviewTask,
  rerunValidations,
  recordIntegrationReview,
  reconcileRecovery,
  reloadMemory,
  resetWorkbenchLayout,
  resizeBottomPanel,
  resizeInspectorPanel,
  resizeSidebarPanel,
  saveWorkbenchLayout,
  selectProject,
  selectSession,
  sendPrompt,
  setError,
  setLayoutActivity,
  setLayoutBottomTab,
  addAttachments,
  dismissCancelNotice,
  loadModels,
  loadOlderMessages,
  removeAttachment,
  setSessionModel,
  setUiPrefs,
  setProfile,
  setView,
  setWelcomeError,
  setWorktreesRoot,
  spawnIntegrationReviewer,
  startPreview,
  state,
  stopPreview,
  type LiveMessage,
  toggleBottomPanel,
  toggleInspectorPanel,
  toggleSidebarPanel,
  validateDirectory,
  validateMemory,
} from "./store.js";

function PartView(props: { part: MessagePart }) {
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

function MessageView(props: { message: Message }) {
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

function ExplorerPanel() {
  let projectName: HTMLInputElement | undefined;
  return (
    <>
      <div class="side-title">Octus</div>
      <section>
        <h2>Projects</h2>
        <For each={state.projects}>
          {(project) => (
            <button class={project.id === state.activeProjectId ? "active" : ""} onClick={() => void selectProject(project.id)}>
              {project.name}
            </button>
          )}
        </For>
        <div class="row">
          <input ref={projectName} placeholder="New project name" />
          <button
            onClick={() => {
              void (async () => {
                const picked = await invoke("app.pickDirectory", {});
                if (picked.path && projectName?.value.trim()) {
                  await createProject(projectName.value.trim(), picked.path);
                  projectName.value = "";
                }
              })();
            }}
          >
            Add
          </button>
        </div>
      </section>
      <section id="project-nav">
        <h2>Sessions</h2>
        <button id="session-new" class="primary" disabled={!state.activeProjectId} onClick={() => void createSession()}>
          New session
        </button>
        <Show when={state.sessions.length === 0}>
          <p class="muted">Sin sesiones en este proyecto. Crea una para empezar.</p>
        </Show>
        <div id="session-list" role="listbox" aria-label="Sesiones del proyecto">
          <For each={state.sessions}>
            {(session) => (
              <div class="row" role="option" aria-selected={session.id === state.activeSessionId} data-session-id={session.id}>
                <button class={session.id === state.activeSessionId ? "active" : ""} onClick={() => void selectSession(session.id)}>
                  {session.title} <span class="profile">[{session.profile}]</span>
                </button>
                <button type="button" title={`Cerrar sesión ${session.title}`} aria-label={`Cerrar sesión ${session.title}`} data-session-close={session.id} onClick={() => void closeSession(session.id)}>
                  ×
                </button>
              </div>
            )}
          </For>
        </div>
      </section>
    </>
  );
}

const WORKBENCH_ACTIVITIES: Array<{ id: ActivityId; label: string; hint: string }> = [
  { id: "explorer", label: "Explorer", hint: "Alt+1" },
  { id: "chat", label: "Chat", hint: "Alt+2" },
  { id: "plans", label: "Planes", hint: "Alt+3" },
  { id: "agents", label: "Agentes", hint: "Alt+4" },
  { id: "skills-mcp", label: "Skills y MCP", hint: "Alt+5" },
  { id: "settings", label: "Configuración", hint: "Alt+6" },
];

const BOTTOM_TABS: Array<{ id: BottomTab; label: string }> = [
  { id: "terminal", label: "Terminal" },
  { id: "problems", label: "Problemas" },
  { id: "output", label: "Salida" },
  { id: "tests", label: "Pruebas" },
];

function ActivityIcon(props: { id: ActivityId }) {
  const paths: Record<ActivityId, string> = {
    explorer: "M2 2h5v12H2z M9 2h5v5H9z M9 9h5v5H9z",
    chat: "M2 3h12v8H8l-3 3v-3H2z",
    plans: "M2 4h12 M2 8h12 M2 12h7",
    agents: "M8 2v4 M8 10v4 M2 6h4 M10 6h4 M8 4a2 2 0 100 4 2 2 0 000-4z",
    "skills-mcp": "M2 6h4V2h4v4h4v4H2z M6 10h4v4H6z",
    settings: "M8 2a6 6 0 100 12A6 6 0 008 2z M8 6a2 2 0 100 4 2 2 0 000-4z",
  };
  return (
    <svg class="ab-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d={paths[props.id]} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
    </svg>
  );
}

function ActivityBar() {
  return (
    <nav id="activity-bar" aria-label="Actividad">
      <For each={WORKBENCH_ACTIVITIES}>
        {(act) => (
          <button
            type="button"
            data-activity={act.id}
            title={`${act.label} (${act.hint})`}
            aria-label={`${act.label} (${act.hint})`}
            aria-pressed={state.layout.activity === act.id}
            class={state.layout.activity === act.id ? "active" : ""}
            onClick={() => void setLayoutActivity(act.id)}
          >
            <ActivityIcon id={act.id} />
          </button>
        )}
      </For>
      <div class="ab-spacer" />
      <button type="button" id="toggle-sidebar" title="Mostrar u ocultar sidebar (Ctrl+B)" aria-label="Mostrar u ocultar sidebar (Ctrl+B)" aria-pressed={state.layout.sidebarVisible} onClick={() => void toggleSidebarPanel()}>
        <svg class="ab-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h12v12H2z M6 2v12" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
      </button>
      <button type="button" id="toggle-inspector" title="Mostrar u ocultar inspector (Ctrl+Alt+I)" aria-label="Mostrar u ocultar inspector (Ctrl+Alt+I)" aria-pressed={state.layout.inspectorVisible} onClick={() => void toggleInspectorPanel()}>
        <svg class="ab-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h12v12H2z M10 2v12" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
      </button>
      <button type="button" id="toggle-bottom" title="Mostrar u ocultar panel inferior (Ctrl+J)" aria-label="Mostrar u ocultar panel inferior (Ctrl+J)" aria-pressed={state.layout.bottomVisible} onClick={() => void toggleBottomPanel()}>
        <svg class="ab-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h12v12H2z M2 10h12" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
      </button>
      <button type="button" id="layout-reset" title="Restablecer layout (Ctrl+0)" aria-label="Restablecer layout (Ctrl+0)" onClick={() => void resetWorkbenchLayout()}>
        <svg class="ab-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8A5 5 0 113 8a5 5 0 0110 0z M13 2v3H10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
      </button>
    </nav>
  );
}

function ThreadsPanel() {
  return (
    <section>
      <h2>Hilos</h2>
      <Show when={state.sessions.length > 0} fallback={<p class="muted">Sin hilos. Crea una sesión desde Explorer.</p>}>
        <For each={state.sessions}>
          {(session) => (
            <button class={session.id === state.activeSessionId ? "active" : ""} onClick={() => void selectSession(session.id)}>
              {session.title} <span class="profile">[{session.profile}]</span>
            </button>
          )}
        </For>
      </Show>
    </section>
  );
}

function PlansPanel() {
  return (
    <section>
      <h2>Planes</h2>
      <Show when={state.plans.length > 0} fallback={<p class="muted">Sin planes en esta sesión.</p>}>
        <For each={state.plans}>
          {(plan) => (
            <div class="row">
              <strong>{plan.objective}</strong>
              <span class="muted">[{plan.status}]</span>
            </div>
          )}
        </For>
      </Show>
    </section>
  );
}

function AgentsPanel() {
  const active = () => state.agentInstances.filter((i) => ["created", "running", "waiting_permission", "waiting_input"].includes(i.status));
  return (
    <section>
      <h2>Agentes</h2>
      <Show when={state.agentInstances.length > 0} fallback={<p class="muted">Sin agentes en esta sesión.</p>}>
        <p class="muted">{active().length} activos / {state.agentInstances.length} en total</p>
        <For each={state.agentInstances}>
          {(instance) => (
            <div class="row">
              <code>{instance.definitionId}</code>
              <span class="muted">[{instance.status}]</span>
            </div>
          )}
        </For>
      </Show>
    </section>
  );
}

function SkillsMcpPanel() {
  return (
    <section>
      <h2>Skills y MCP</h2>
      <p class="muted">El catálogo de Skills llega en la ola 12 y el gestor MCP en la ola 13. Aquí no hay nada que instalar todavía.</p>
    </section>
  );
}

function SettingsShortcutPanel() {
  return (
    <section>
      <h2>Configuración</h2>
      <button class="primary" onClick={() => setView(state.view === "settings" ? "chat" : "settings")}>
        {state.view === "settings" ? "Volver al chat" : "Abrir configuración"}
      </button>
    </section>
  );
}

function Sidebar() {
  const styles = () => layoutStyles(state.layout).sidebar;
  const title = () => WORKBENCH_ACTIVITIES.find((a) => a.id === state.layout.activity)?.label ?? "Sidebar";
  return (
    <aside id="sidebar" style={{ display: styles().display, width: styles().width }} aria-label={title()}>
      <div class="side-head">
        <strong>{title()}</strong>
        <button type="button" title="Ocultar sidebar (Ctrl+B)" aria-label="Ocultar sidebar (Ctrl+B)" onClick={() => void toggleSidebarPanel()}>
          Ocultar
        </button>
      </div>
      <Show when={state.layout.activity === "explorer"}>
        <ExplorerPanel />
      </Show>
      <Show when={state.layout.activity === "chat"}>
        <ThreadsPanel />
      </Show>
      <Show when={state.layout.activity === "plans"}>
        <PlansPanel />
      </Show>
      <Show when={state.layout.activity === "agents"}>
        <AgentsPanel />
      </Show>
      <Show when={state.layout.activity === "skills-mcp"}>
        <SkillsMcpPanel />
      </Show>
      <Show when={state.layout.activity === "settings"}>
        <SettingsShortcutPanel />
      </Show>
    </aside>
  );
}

function InspectorPanel() {
  const styles = () => layoutStyles(state.layout).inspector;
  const session = () => state.sessions.find((s) => s.id === state.activeSessionId);
  const failedTasks = () => state.tasks.filter((t) => t.status === "failed");
  let renameInput: HTMLInputElement | undefined;
  return (
    <aside id="inspector" style={{ display: styles().display, width: styles().width }} aria-label="Inspector">
      <div class="side-head">
        <strong>Inspector</strong>
        <button type="button" title="Ocultar inspector (Ctrl+Alt+I)" aria-label="Ocultar inspector (Ctrl+Alt+I)" onClick={() => void toggleInspectorPanel()}>
          Ocultar
        </button>
      </div>
      <Show when={session()} fallback={<p class="muted">Sin selección. Crea o elige una sesión para verla aquí.</p>}>
        <section>
          <h2>Sesión activa</h2>
          <div class="row">
            <strong>{session()!.title}</strong>
            <span class="profile">[{session()!.profile}]</span>
          </div>
          <p class="muted">{state.busy ? "trabajando…" : "inactiva"} · {state.messages.length} mensajes</p>
          <div class="row">
            <input ref={renameInput} placeholder="Nuevo título" value={session()!.title} aria-label="Nuevo título de sesión" />
            <button id="session-rename" type="button" onClick={() => void renameSession(renameInput?.value ?? "")}>
              Renombrar
            </button>
          </div>
          <div class="row">
            <button id="session-close" type="button" class="danger" onClick={() => void closeSession()}>
              Cerrar sesión
            </button>
            <button id="session-recover" type="button" onClick={() => void recoverActiveSession()}>
              Recuperar sesión
            </button>
          </div>
          <p class="muted">
            Recuperación: {state.recoveryStatus ? `${state.recoveryStatus.pendingOps} ops pendientes` : "desconocida"} ·{" "}
            <button type="button" onClick={() => void reconcileRecovery()}>
              Reconciliar ahora
            </button>
          </p>
        </section>
        <section>
          <h2>Pendientes de ti</h2>
          <p class="muted">
            {state.approvals.length} aprobaciones · {state.permissions.length} permisos · {state.questions.length} preguntas
          </p>
        </section>
        <section>
          <h2>Fallos</h2>
          <Show when={failedTasks().length > 0} fallback={<p class="muted">Sin tareas fallidas.</p>}>
            <For each={failedTasks()}>
              {(task) => (
                <p class="muted">
                  <code>{task.id}</code> {task.title}
                </p>
              )}
            </For>
          </Show>
        </section>
      </Show>
    </aside>
  );
}

function BottomPanel() {
  const styles = () => layoutStyles(state.layout).bottom;
  const projectRoot = () => state.projects.find((p) => p.id === state.activeProjectId)?.rootPath ?? "—";
  const problems = () => {
    const items: string[] = [];
    if (!state.budgetsConfigured) items.push("Presupuestos sin configurar: las llamadas de pago están bloqueadas.");
    for (const task of state.tasks) if (task.status === "failed") items.push(`Tarea fallida ${task.title}: ${task.error ?? "sin detalle"}`);
    for (const integration of state.integrations) if (integration.status === "failed") items.push(`Integración fallida ${integration.integrationBranch}: ${integration.error ?? "sin detalle"}`);
    return items;
  };
  return (
    <section id="bottom-panel" style={{ display: styles().display, height: styles().height }} aria-label="Panel inferior">
      <div class="bottom-tabs" role="tablist">
        <For each={BOTTOM_TABS}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              data-bottom-tab={tab.id}
              aria-selected={state.layout.bottomTab === tab.id}
              class={state.layout.bottomTab === tab.id ? "active" : ""}
              onClick={() => void setLayoutBottomTab(tab.id)}
            >
              {tab.label}
            </button>
          )}
        </For>
        <div class="ab-spacer" />
        <button type="button" title="Ocultar panel inferior (Ctrl+J)" aria-label="Ocultar panel inferior (Ctrl+J)" onClick={() => void toggleBottomPanel()}>
          Ocultar
        </button>
      </div>
      <div class="bottom-body">
        <Show when={state.layout.bottomTab === "terminal"}>
          <p class="muted">La terminal persistente llega en el Todo 32. Directorio del proyecto: <code>{projectRoot()}</code></p>
        </Show>
        <Show when={state.layout.bottomTab === "problems"}>
          <Show when={problems().length > 0} fallback={<p class="muted">Sin problemas.</p>}>
            <ul>
              <For each={problems()}>{(problem) => <li>{problem}</li>}</For>
            </ul>
          </Show>
        </Show>
        <Show when={state.layout.bottomTab === "output"}>
          <Show when={state.usage.length > 0} fallback={<p class="muted">Sin salidas todavía.</p>}>
            <ul>
              <For each={state.usage}>
                {(record) => (
                  <li>
                    <code>{record.providerId}/{record.modelId}</code> in {record.inputTokens.toLocaleString()} / out {record.outputTokens.toLocaleString()} — {record.status}
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
        <Show when={state.layout.bottomTab === "tests"}>
          <Show when={state.testAllowlist.length > 0} fallback={<p class="muted">Sin allowlist de pruebas en este proyecto.</p>}>
            <ul>
              <For each={state.testAllowlist}>
                {(entry) => (
                  <li>
                    <code>{entry.id}</code> {entry.name} — <code>{entry.argv.join(" ")}</code>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
    </section>
  );
}

function ResizeHandle(props: { kind: "sidebar" | "inspector" | "bottom"; hidden: boolean }) {
  const onPointerDown = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    event.preventDefault();
    // Patrón robusto: los movimientos se escuchan en window para no depender de
    // la captura del puntero (ratón, táctil, pluma y entrada sintética de QA).
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Sin captura: window sigue recibiendo los movimientos igualmente.
    }
    let lastX = event.clientX;
    let lastY = event.clientY;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (props.kind === "sidebar") previewWorkbenchLayout(resizeSidebarBy(state.layout, dx));
      else if (props.kind === "inspector") previewWorkbenchLayout(resizeInspectorBy(state.layout, dx));
      else previewWorkbenchLayout(resizeBottomBy(state.layout, dy));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      void saveWorkbenchLayout();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", up, { once: true });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 24 : 8;
    let handled = true;
    if (event.key === "ArrowLeft") {
      if (props.kind === "sidebar") void resizeSidebarPanel(-step);
      else if (props.kind === "inspector") void resizeInspectorPanel(-step);
      else handled = false;
    } else if (event.key === "ArrowRight") {
      if (props.kind === "sidebar") void resizeSidebarPanel(step);
      else if (props.kind === "inspector") void resizeInspectorPanel(step);
      else handled = false;
    } else if (event.key === "ArrowUp" && props.kind === "bottom") {
      void resizeBottomPanel(-step);
    } else if (event.key === "ArrowDown" && props.kind === "bottom") {
      void resizeBottomPanel(step);
    } else {
      handled = false;
    }
    if (handled) event.preventDefault();
  };
  return (
    <Show when={!props.hidden}>
      <div
        class={props.kind === "bottom" ? "wb-resize wb-resize-row" : "wb-resize"}
        data-resize={props.kind}
        role="separator"
        aria-orientation={props.kind === "bottom" ? "horizontal" : "vertical"}
        aria-label={props.kind === "bottom" ? "Redimensionar panel inferior" : props.kind === "sidebar" ? "Redimensionar sidebar" : "Redimensionar inspector"}
        tabindex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
    </Show>
  );
}

/** Marco de streaming con estado visible por marco (N-C-12a/12b). */
function LiveView(props: { live: LiveMessage }) {
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

function FrameStatus(props: { status: "streaming" | "done" }) {
  return (
    <span class="frame-status" data-status={props.status}>
      {props.status === "done" ? "listo" : "en curso…"}
    </span>
  );
}

function Composer() {
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

function PermissionDialogs() {
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

function QuestionDialogs() {
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

function ProviderSettings() {
  const keys: Record<string, HTMLInputElement | undefined> = {};
  return (
    <section>
      <h2>Providers</h2>
      <For each={state.providers}>
        {(provider) => (
          <div class="card">
            <h3>
              {provider.displayName} {provider.configured ? <span class="pill ok">key saved</span> : <span class="pill warn">no key</span>}
            </h3>
            <div class="row">
              <input ref={(el) => (keys[provider.id] = el)} type="password" placeholder="Paste API key" autocomplete="off" />
              <button
                class="primary"
                onClick={() => {
                  const value = keys[provider.id]?.value ?? "";
                  if (!value.trim()) return;
                  void (async () => {
                    const result = await invoke("providers.setKey", { providerId: provider.id, apiKey: value });
                    if (!result.ok) setError(result.error ?? "Could not save key");
                    if (keys[provider.id]) keys[provider.id]!.value = "";
                    await reloadProviders();
                  })();
                }}
              >
                Save key
              </button>
              <button
                onClick={() => {
                  void (async () => {
                    await invoke("providers.removeKey", { providerId: provider.id });
                    await reloadProviders();
                  })();
                }}
              >
                Remove
              </button>
              <button
                onClick={() => {
                  void (async () => {
                    const result = await invoke("providers.test", { providerId: provider.id });
                    setError(result.ok ? undefined : (result.error ?? "Connection failed"));
                    if (result.ok) setError("Connection OK" as never);
                  })();
                }}
              >
                Test
              </button>
            </div>
            <details>
              <summary>Models ({provider.models.length})</summary>
              <ul>
                <For each={provider.models}>
                  {(model) => (
                    <li>
                      <code>{model.modelId}</code> — ctx {model.capabilities.maxContextTokens.toLocaleString()}, efforts:{" "}
                      {model.capabilities.reasoningEfforts.join(", ") || "—"}
                    </li>
                  )}
                </For>
              </ul>
            </details>
          </div>
        )}
      </For>
    </section>
  );
}

function BudgetSettings() {
  let kind: HTMLSelectElement | undefined;
  let ref: HTMLInputElement | undefined;
  let limitUsd: HTMLInputElement | undefined;
  let limitTokens: HTMLInputElement | undefined;
  let action: HTMLSelectElement | undefined;
  return (
    <section>
      <h2>Budgets {state.budgetsConfigured ? <span class="pill ok">configured</span> : <span class="pill warn">not configured — paid calls are blocked</span>}</h2>
      <p class="muted">Octus never runs paid calls without limits you saved here. Warnings fire once per budget and window.</p>
      <ul>
        <For each={state.budgets}>
          {(budget) => (
            <li>
              <code>{budget.scope.kind}:{budget.scope.ref || "*"}</code> —{" "}
              {budget.limitMicroUsd !== undefined ? `$${(budget.limitMicroUsd / 1_000_000).toFixed(2)}` : "no money cap"},{" "}
              {budget.limitTokens !== undefined ? `${budget.limitTokens.toLocaleString()} tokens` : "no token cap"} — {budget.action} — {budget.window}
            </li>
          )}
        </For>
      </ul>
      <div class="card">
        <h3>Replace all budgets</h3>
        <div class="row">
          <select ref={kind}>
            <option value="global">global</option>
            <option value="provider">provider</option>
            <option value="model">model</option>
            <option value="agent">agent</option>
            <option value="session">session</option>
            <option value="run">run</option>
          </select>
          <input ref={ref} placeholder="ref (provider id, provider/model, …; empty for global)" />
          <input ref={limitUsd} type="number" min="0" step="0.5" placeholder="USD limit" />
          <input ref={limitTokens} type="number" min="0" step="1000" placeholder="token limit" />
          <select ref={action}>
            <option value="block">block</option>
            <option value="warn">warn</option>
          </select>
          <button
            class="primary"
            onClick={() => {
              void (async () => {
                const usd = Number.parseFloat(limitUsd?.value ?? "");
                const tokens = Number.parseInt(limitTokens?.value ?? "", 10);
                await invoke("budgets.configure", {
                  budgets: [
                    {
                      scope: { kind: (kind?.value ?? "global") as never, ref: ref?.value.trim() ?? "" },
                      limitMicroUsd: Number.isFinite(usd) && usd > 0 ? Math.round(usd * 1_000_000) : undefined,
                      limitTokens: Number.isFinite(tokens) && tokens > 0 ? tokens : undefined,
                      warnRatio: 0.8,
                      action: (action?.value ?? "block") as never,
                      window: "span",
                      enabled: true,
                    },
                  ],
                });
                setError(undefined);
                await reloadBudgets();
              })();
            }}
          >
            Save budgets
          </button>
        </div>
      </div>
      <h3>Spend by budget</h3>
      <ul>
        <For each={state.budgetUsage}>
          {(usage) => (
            <li>
              <code>{usage.budgetId}</code> —{" "}
              {usage.spentMicroUsd === null ? "cost unknown" : `$${(usage.spentMicroUsd / 1_000_000).toFixed(4)}`}
              {usage.costIncomplete ? " (partial: some calls lack pricing)" : ""} — {usage.spentTokens.toLocaleString()} tokens{" "}
              {usage.exceeded ? <span class="pill warn">exceeded</span> : usage.warned ? <span class="pill warn">warning</span> : null}
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

function PlansSection() {
  return (
    <details class="stage2">
      <summary>
        Plans ({state.plans.length}) — Approvals pending ({state.approvals.length})
      </summary>
      <Show when={state.approvals.length > 0}>
        <div class="card warn">
          <h3>Pending approvals (only you can decide)</h3>
          <For each={orderedApprovals()}>
            {(request) => {
              const gate = () => revisionGate(request.planId, request.revisionId);
              return (
                <div class="row" data-approval-request={request.id} data-approval-status={request.status}>
                  <code>
                    {request.planId} · {request.revisionId}
                  </code>
                  <span class="muted" data-approval-gate>
                    {gate().decidable ? "Solo tú puedes decidir (ningún modelo aprueba)" : gate().reason}
                  </span>
                  <button class="primary" disabled={!gate().decidable} title={gate().reason} onClick={() => void decideApproval(request.id, "approved")}>
                    Approve
                  </button>
                  <button class="danger" disabled={!gate().decidable} title={gate().reason} onClick={() => void decideApproval(request.id, "rejected")}>
                    Reject
                  </button>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
      <Show when={state.plans.length === 0}>
        <p class="muted">No plans in this session yet. Ask in plan profile to create one.</p>
      </Show>
      <For each={state.plans}>
        {(plan) => (
          <div class="card">
            <h3>
              {plan.objective} <span class="muted">[{plan.status}]</span>
            </h3>
            <p class="muted">
              <code>{plan.id}</code> current={plan.currentRevisionId ?? "—"} approved={plan.approvedRevisionId ?? "none"}
            </p>
            <For each={state.planRevisions[plan.id] ?? []}>
              {(revision) => (
                <div class="revision">
                  <div class="row">
                    <strong>v{revision.version}</strong>
                    <span class="pill">{revision.lifecycle}</span>
                    <span class={`pill ${revision.approval === "approved" ? "ok" : revision.approval === "rejected" ? "err" : "warn"}`}>{revision.approval}</span>
                    <code class="muted">{revision.id}</code>
                  </div>
                  <details>
                    <summary>Content</summary>
                    <div class="md" innerHTML={renderMarkdown(revision.contentMarkdown.slice(0, 8000))} />
                  </details>
                  <div class="row">
                    <Show when={revisionGate(plan.id, revision.id).decidable}>
                      <button class="primary" onClick={() => void approveRevision(plan.id, revision.id)}>
                        Approve v{revision.version}
                      </button>
                      <button class="danger" onClick={() => void rejectRevision(plan.id, revision.id)}>
                        Reject
                      </button>
                    </Show>
                    <Show when={state.approvals.some((entry) => entry.revisionId === revision.id && entry.status === "pending")}>
                      <span class="muted" data-approval-pending={revision.id}>
                        Awaiting your decision — ningún modelo puede aprobar.
                      </span>
                    </Show>
                    <Show when={plan.approvedRevisionId === revision.id}>
                      <button onClick={() => void implementRevision(plan.id, revision.id)}>Implement this approved revision</button>
                    </Show>
                    <button onClick={() => void exportRevision(plan.id, revision.id, revision.version)}>Export</button>
                  </div>
                </div>
              )}
            </For>
            <div class="row">
              <Show when={plan.status === "active"}>
                <button onClick={() => void archivePlan(plan.id)}>Archive plan</button>
              </Show>
            </div>
          </div>
        )}
      </For>
    </details>
  );
}

function TasksSection() {
  const active = () => state.tasks.filter((t) => ["ready", "assigned", "running", "blocked"].includes(t.status));
  return (
    <details class="stage2">
      <summary>
        Tasks ({active().length} active / {state.tasks.length} total)
      </summary>
      <Show when={state.tasks.length === 0}>
        <p class="muted">No tasks yet. The coordinator decomposes approved revisions into a task DAG.</p>
      </Show>
      <For each={state.tasks}>
        {(task) => (
          <div class="card">
            <div class="row">
              <strong>{task.title}</strong>
              <span class={`pill ${task.status === "completed" || task.status === "reviewed" ? "ok" : task.status === "failed" ? "err" : "warn"}`}>{task.status}</span>
              <span class="pill">{task.agentRole}</span>
              <span class="muted">attempt {task.attempt}</span>
            </div>
            <p class="muted">
              <code>{task.id}</code> · run <code>{task.runId}</code>
            </p>
            <Show when={(state.taskDeps[task.id] ?? []).length > 0}>
              <p class="muted">depends on: {(state.taskDeps[task.id] ?? []).map((d) => d.dependsOn).join(", ")}</p>
            </Show>
            <Show when={task.status === "blocked"}>
              <p class="muted">
                blocked: {task.blockedReason} <Show when={task.blockedDetails}>· {JSON.stringify(task.blockedDetails).slice(0, 200)}</Show>
              </p>
            </Show>
            <Show when={task.error}>
              <p class="muted">error: {task.error}</p>
            </Show>
            <Show when={(state.taskAttempts[task.id] ?? []).length > 0}>
              <details>
                <summary>Attempts ({(state.taskAttempts[task.id] ?? []).length})</summary>
                <ul>
                  <For each={state.taskAttempts[task.id] ?? []}>
                    {(attempt) => (
                      <li>
                        <code>#{attempt.attempt}</code> {attempt.status}
                        <Show when={attempt.instanceId}> · instance {attempt.instanceId}</Show>
                        <Show when={attempt.errorMessage}> · {attempt.errorMessage}</Show>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <div class="row">
              <Show when={!["completed", "reviewed", "cancelled", "failed"].includes(task.status)}>
                <button class="danger" onClick={() => void cancelTask(task.id)}>
                  Cancel
                </button>
              </Show>
              <Show when={task.status === "failed" || task.status === "interrupted"}>
                <button class="primary" onClick={() => void retryTask(task.id)}>
                  Retry
                </button>
              </Show>
              <Show when={task.agentRole === "reviewer" && task.status === "completed" && task.reviewTargetTaskId}>
                <button class="primary" onClick={() => void reviewTask(task.id, task.reviewTargetTaskId!, "accept")}>
                  Accept target
                </button>
                <button class="danger" onClick={() => void reviewTask(task.id, task.reviewTargetTaskId!, "request-changes")}>
                  Request changes
                </button>
              </Show>
            </div>
          </div>
        )}
      </For>
    </details>
  );
}

function WorktreesSection() {
  const active = () => state.worktrees.filter((w) => ["provisioning", "assigned", "running", "suspended", "cleanup_pending"].includes(w.status));
  const repo = () => state.repoSummary;
  return (
    <details class="stage2">
      <summary>
        Worktrees ({active().length} active / {state.worktrees.length} total)
      </summary>
      <Show when={repo() && !repo()!.isGit}>
        <p class="muted">Project is not inside a git repository: writers use registered isolated directories (legacy path).</p>
      </Show>
      <Show when={repo() && repo()!.isGit}>
        <p class="muted">
          repo <code>{repo()!.rootPath}</code> · branch <code>{repo()!.branch}</code> · {repo()!.status}
          <Show when={(repo()!.staged + repo()!.unstaged + repo()!.untracked) > 0}>
            {" "}· local changes staged:{repo()!.staged} unstaged:{repo()!.unstaged} untracked:{repo()!.untracked} (excluded from new worktrees)
          </Show>
        </p>
      </Show>
      <Show when={state.worktrees.length === 0}>
        <p class="muted">No worktrees yet. Implementer tasks provision one automatically.</p>
      </Show>
      <For each={state.worktrees}>
        {(wt) => (
          <div class="card">
            <div class="row">
              <code>{wt.branchName}</code>
              <span class={`pill ${wt.status === "removed" ? "muted" : wt.status === "orphaned" ? "err" : wt.status === "finished" || wt.status === "retained" ? "ok" : "warn"}`}>{wt.status}</span>
              <span class="muted">attempt {wt.attempt}</span>
            </div>
            <p class="muted">
              <code>{wt.canonicalPath}</code>
            </p>
            <p class="muted">
              base <code>{wt.baseCommit.slice(0, 12)}</code> ({wt.baseSource})
              <Show when={wt.producedCommit != null}> → produced <code>{(wt.producedCommit as string).slice(0, 12)}</code></Show>
            </p>
            <Show when={wt.dirtyExcluded && wt.dirtySummary}>
              <p class="muted">local changes excluded: {wt.dirtySummary}</p>
            </Show>
            <Show when={wt.error}>
              <p class="muted">error: {wt.error}</p>
            </Show>
            <Show when={(state.worktreeOps[wt.id] ?? []).length > 0}>
              <details>
                <summary>Operations ({(state.worktreeOps[wt.id] ?? []).length})</summary>
                <ul>
                  <For each={state.worktreeOps[wt.id] ?? []}>
                    {(op) => (
                      <li>
                        <code>{op.op}</code> {op.status}
                        <Show when={op.step}> · {op.step}</Show>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <div class="row">
              <Show when={["finished", "available", "suspended", "orphaned", "retained"].includes(wt.status)}>
                <button class="danger" onClick={() => void cleanupWorktree(wt.id)}>
                  Clean up
                </button>
              </Show>
              <button onClick={() => void reloadWorktrees()}>Refresh</button>
            </div>
          </div>
        )}
      </For>
    </details>
  );
}

function IntegrationsSection() {
  const [waiver, setWaiver] = createSignal<Record<string, string>>({});
  const [reviewerInstance, setReviewerInstance] = createSignal<Record<string, string>>({});
  const active = () => state.integrations.filter((i) => ["building", "conflicted", "validating", "preview_ready", "approved", "promoting"].includes(i.status));
  return (
    <details class="stage2">
      <summary>
        Integrations ({active().length} active / {state.integrations.length} total)
      </summary>
      <Show when={state.integrations.length === 0}>
        <p class="muted">No integrations yet. Reviewed writer tasks auto-integrate into an intermediate branch.</p>
      </Show>
      <For each={state.integrations}>
        {(integration) => (
          <div class="card">
            <div class="row">
              <code>{integration.integrationBranch}</code>
              <span class={`pill ${integration.status === "promoted" ? "ok" : integration.status === "failed" || integration.status === "conflicted" ? "err" : integration.status === "stale" ? "err" : "warn"}`}>{integration.status}</span>
              <span class="muted">attempt {integration.attempt}</span>
            </div>
            <p class="muted">
              run <code>{integration.runId}</code> · target <code>{integration.targetBranch}</code> @ <code>{integration.targetBaseCommit.slice(0, 12)}</code>
            </p>
            <Show when={integration.head}>
              <p class="muted">
                head <code>{(integration.head as string).slice(0, 12)}</code>
                <Show when={integration.supersedes}> · supersedes <code>{integration.supersedes}</code></Show>
              </p>
            </Show>
            <Show when={integration.error}>
              <p class="muted">error: {integration.error}</p>
            </Show>
            <Show when={(state.integrationCommits[integration.id] ?? []).length > 0}>
              <details>
                <summary>Commits ({(state.integrationCommits[integration.id] ?? []).length})</summary>
                <ul>
                  <For each={state.integrationCommits[integration.id] ?? []}>
                    {(c) => (
                      <li>
                        <code>{c.taskId}</code> #{c.attempt} <code>{c.kind}</code> {c.originalSha.slice(0, 8)}→{c.integratedSha.slice(0, 8)}
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <Show when={(state.integrationValidations[integration.id] ?? []).length > 0}>
              <details>
                <summary>Validations ({(state.integrationValidations[integration.id] ?? []).length})</summary>
                <ul>
                  <For each={state.integrationValidations[integration.id] ?? []}>
                    {(v) => (
                      <li>
                        <code>{v.kind}{v.entryId ? `:${v.entryId}` : ""}</code> {v.status}
                        <Show when={v.detail != null}> · {(v.detail as string).slice(0, 160)}</Show>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <Show when={(state.integrationReviews[integration.id] ?? []).length > 0}>
              <details>
                <summary>Reviews ({(state.integrationReviews[integration.id] ?? []).length})</summary>
                <ul>
                  <For each={state.integrationReviews[integration.id] ?? []}>
                    {(r) => (
                      <li>
                        <code>{r.verdict}</code> @ {r.sha.slice(0, 8)}
                        <Show when={r.summary != null}> · {(r.summary as string).slice(0, 160)}</Show>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <Show when={state.integrationConflicts.filter((c) => c.scopeRef === integration.id).length > 0}>
              <details open>
                <summary>Conflicts ({state.integrationConflicts.filter((c) => c.scopeRef === integration.id).length})</summary>
                <ul>
                  <For each={state.integrationConflicts.filter((c) => c.scopeRef === integration.id)}>
                    {(conflict) => (
                      <li>
                        <code>{conflict.status}</code> {conflict.files.join(", ")}
                        <div class="row">
                          <Show when={conflict.status === "open"}>
                            <button class="primary" onClick={() => void requestConflictResolution(conflict.id)}>
                              Request assisted resolution
                            </button>
                          </Show>
                          <Show when={conflict.status === "resolving" && conflict.resolutionInstanceId}>
                            <button class="primary" onClick={() => void finalizeConflictResolution(conflict.id, conflict.resolutionInstanceId!)}>
                              Finalize resolution
                            </button>
                          </Show>
                          <Show when={conflict.status === "resolved"}>
                            <button class="primary" onClick={() => void incorporateConflictResolution(integration.id, conflict.id)}>
                              Incorporate resolution
                            </button>
                            <button onClick={() => void cleanupConflictResolution(conflict.id)}>Clean up workspace</button>
                          </Show>
                          <Show when={conflict.status === "open" || conflict.status === "resolving"}>
                            <button class="danger" onClick={() => void abortConflict(conflict.id)}>
                              Abort conflict
                            </button>
                          </Show>
                        </div>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <Show when={(state.previews[integration.id] ?? []).length > 0}>
              <details>
                <summary>Previews ({(state.previews[integration.id] ?? []).length})</summary>
                <ul>
                  <For each={state.previews[integration.id] ?? []}>
                    {(preview) => (
                      <li>
                        <code>{preview.status}</code>{" "}
                        <Show when={preview.url} fallback={<span class="muted">no url yet</span>}>
                          <a href={preview.url} target="_blank" rel="noreferrer">{preview.url}</a>
                        </Show>{" "}
                        @ {preview.sha.slice(0, 8)}
                        <div class="row">
                          <Show when={["starting", "stopped", "failed", "completed"].includes(preview.status)}>
                            <button class="primary" onClick={() => void startPreview(preview.id)}>
                              Start
                            </button>
                          </Show>
                          <Show when={["running", "reachable"].includes(preview.status)}>
                            <button class="danger" onClick={() => void stopPreview(preview.id)}>
                              Stop
                            </button>
                          </Show>
                          <button onClick={() => void (async () => { await inspectPreview(preview.id); await loadPreviewLogs(preview.id); })()}>Inspect</button>
                          <button onClick={() => void cleanupPreview(preview.id)}>Clean up</button>
                        </div>
                        <Show when={state.previewLogs[preview.id]}>
                          <pre>{(state.previewLogs[preview.id] ?? "").slice(-4000)}</pre>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <Show when={(state.integrationApprovals[integration.id] ?? []).length > 0}>
              <p class="muted">
                approval: {(state.integrationApprovals[integration.id] ?? []).map((a) => `${a.decision}@${a.candidateSha.slice(0, 8)}`).join(", ")}
              </p>
            </Show>
            <Show when={(state.promotions[integration.id] ?? []).length > 0}>
              <p class="muted">
                promotions: {(state.promotions[integration.id] ?? []).map((p) => `${p.status}@${p.newSha.slice(0, 8)}`).join(", ")}
              </p>
            </Show>
            <div class="row">
              <Show when={["building", "conflicted", "validating"].includes(integration.status)}>
                <button class="primary" onClick={() => void incorporateIntegration(integration.id)}>
                  Incorporate
                </button>
                <button onClick={() => void rerunValidations(integration.id)}>Re-run validations</button>
                <button onClick={() => void createPreview(integration.id)}>Create preview</button>
              </Show>
              <button
                onClick={() =>
                  void (async () => {
                    const instanceId = await spawnIntegrationReviewer(integration.id);
                    if (instanceId) setReviewerInstance((prev) => ({ ...prev, [integration.id]: instanceId }));
                  })()
                }
              >
                Spawn reviewer
              </button>
              <Show when={reviewerInstance()[integration.id]}>
                <button class="primary" onClick={() => void recordIntegrationReview(integration.id, reviewerInstance()[integration.id]!, "accept")}>
                  Accept review
                </button>
                <button class="danger" onClick={() => void recordIntegrationReview(integration.id, reviewerInstance()[integration.id]!, "request-changes")}>
                  Request changes
                </button>
              </Show>
              <Show when={["validating", "preview_ready"].includes(integration.status)}>
                <input
                  placeholder="waiver reason (no server to preview)"
                  value={waiver()[integration.id] ?? ""}
                  onInput={(e) => setWaiver((prev) => ({ ...prev, [integration.id]: e.currentTarget.value }))}
                />
                <button
                  class="primary"
                  onClick={() =>
                    void approveIntegration(integration.id, {
                      previewId: (state.previews[integration.id] ?? []).find((p) => p.sha === integration.head && p.status === "reachable")?.id,
                      waiverReason: (state.previews[integration.id] ?? []).some((p) => p.sha === integration.head && p.status === "reachable") ? undefined : waiver()[integration.id],
                    })
                  }
                >
                  Approve
                </button>
                <button class="danger" onClick={() => void rejectIntegration(integration.id)}>
                  Reject
                </button>
              </Show>
              <Show when={integration.status === "approved"}>
                <button class="primary" onClick={() => void promoteIntegration(integration.id)}>
                  Promote
                </button>
              </Show>
              <Show when={["stale", "failed", "aborted"].includes(integration.status)}>
                <button class="primary" onClick={() => void rebuildIntegration(integration.id)}>
                  Rebuild
                </button>
              </Show>
              <Show when={["building", "conflicted", "validating"].includes(integration.status)}>
                <button class="danger" onClick={() => void abortIntegration(integration.id)}>
                  Abort
                </button>
              </Show>
              <button onClick={() => void reloadIntegrations()}>Refresh</button>
            </div>
          </div>
        )}
      </For>
    </details>
  );
}

function MemorySection() {
  const [form, setForm] = createSignal({ scope: "project", scopeId: "", category: "fact", topic: "", content: "", source: "user" });
  const byScope = () => {
    const groups = new Map<string, typeof state.memories>();
    for (const m of state.memories) {
      const key = `${m.scope}:${m.scopeId.slice(-6)}`;
      const list = groups.get(key);
      if (list) list.push(m);
      else groups.set(key, [m]);
    }
    return [...groups.entries()];
  };
  const pending = () => state.memories.filter((m) => m.status === "proposed").length;
  const conflicts = () => state.memories.filter((m) => m.reviewNote && /contradiction pending/i.test(m.reviewNote));
  return (
    <details class="stage2">
      <summary>
        Memory ({pending()} proposed / {state.memories.length} total{conflicts().length > 0 ? ` · ${conflicts().length} conflicted` : ""})
      </summary>
      <Show when={state.memories.length === 0}>
        <p class="muted">No memory entries yet. Agents propose via memory_propose; governance decides.</p>
      </Show>
      <For each={byScope()}>
        {([scope, entries]) => (
          <details>
            <summary>{scope} ({entries.length})</summary>
            <ul>
              <For each={entries}>
                {(m) => (
                  <li>
                    <code>{m.category}:{m.topic}</code>{" "}
                    <span class={`pill ${m.status === "approved" || m.status === "verified" ? "ok" : m.status === "proposed" ? "warn" : m.status === "stale" ? "err" : "err"}`}>{m.status}</span>{" "}
                    <span class="muted">v{m.version}</span>
                    <p class="muted">{m.content.slice(0, 200)}</p>
                    <Show when={m.reviewNote}>
                      <p class="muted">note: {m.reviewNote}</p>
                    </Show>
                    <div class="row">
                      <Show when={m.status === "proposed"}>
                        <Show when={m.category !== "decision" && m.category !== "instruction"}>
                          <button onClick={() => void validateMemory(m.id)}>Validate</button>
                        </Show>
                        <button class="primary" onClick={() => void decideMemory(m.id, "approved")}>Approve</button>
                        <button class="danger" onClick={() => void decideMemory(m.id, "rejected")}>Reject</button>
                      </Show>
                      <Show when={m.status === "verified" || m.status === "approved"}>
                        <button onClick={() => void revalidateMemory(m.id)}>Revalidate</button>
                      </Show>
                      <Show when={m.reviewNote && /contradiction pending/i.test(m.reviewNote)}>
                        <button class="primary" onClick={() => void resolveMemoryConflict(m.id)}>Keep this</button>
                      </Show>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </details>
        )}
      </For>
      <details>
        <summary>Propose memory</summary>
        <div class="row">
          <select value={form().scope} onChange={(e) => setForm((f) => ({ ...f, scope: e.currentTarget.value }))}>
            <option value="project">project</option>
            <option value="session">session</option>
            <option value="run">run</option>
            <option value="task">task</option>
            <option value="instance">instance</option>
          </select>
          <input placeholder="scopeId" value={form().scopeId} onInput={(e) => setForm((f) => ({ ...f, scopeId: e.currentTarget.value }))} />
          <input placeholder="category" value={form().category} onInput={(e) => setForm((f) => ({ ...f, category: e.currentTarget.value }))} />
          <input placeholder="topic" value={form().topic} onInput={(e) => setForm((f) => ({ ...f, topic: e.currentTarget.value }))} />
        </div>
        <div class="row">
          <input placeholder="content" value={form().content} onInput={(e) => setForm((f) => ({ ...f, content: e.currentTarget.value }))} />
          <input placeholder="source" value={form().source} onInput={(e) => setForm((f) => ({ ...f, source: e.currentTarget.value }))} />
          <button class="primary" onClick={() => void proposeMemory({ scope: form().scope as "project" | "session" | "run" | "task" | "instance", scopeId: form().scopeId, category: form().category, topic: form().topic, content: form().content, source: form().source })}>Propose</button>
        </div>
      </details>
      <details>
        <summary>Recovery ({state.recoveryStatus ? `${state.recoveryStatus.pendingOps} pending ops · ${state.recoveryStatus.staleMemories} stale · ${state.recoveryStatus.pendingContradictions} conflicts` : "unknown"})</summary>
        <div class="row">
          <button onClick={() => void reconcileRecovery()}>Reconcile now</button>
          <button onClick={() => void reloadMemory()}>Refresh</button>
        </div>
      </details>
    </details>
  );
}

function AgentsSection() {  const active = () => state.agentInstances.filter((i) => ["created", "running", "waiting_permission", "waiting_input"].includes(i.status));
  return (
    <details class="stage2" id="agent-activity">
      <summary>
        Agents ({active().length} active / {state.agentInstances.length} total)
      </summary>
      <Show when={state.agentInstances.length === 0}>
        <p class="muted">No subagents in this session yet.</p>
      </Show>
      <For each={state.agentInstances}>
        {(instance) => (
          <div class="card" data-agent-instance={instance.id}>
            <div class="row">
              <code>{instance.definitionId}</code>
              <span
                class={`pill ${instance.status === "completed" ? "ok" : instance.status === "failed" ? "err" : instance.status === "cancelled" ? "" : "warn"}`}
                data-agent-status={instance.status}
              >
                {instance.status}
              </span>
              <code class="muted">{instance.id}</code>
            </div>
            <p class="muted">
              {instance.directory}
              <Show when={instance.taskId}> · task {instance.taskId}</Show>
              <Show when={instance.worktreeId}> · worktree {instance.worktreeId}</Show>
              <Show when={instance.parentInstanceId}> · parent {instance.parentInstanceId}</Show>
              <Show when={instance.status === "waiting_permission"}> · esperando tu permiso</Show>
              <Show when={instance.status === "waiting_input"}> · esperando tu respuesta</Show>
              <Show when={instance.error}> · error: {instance.error}</Show>
            </p>
            <Show when={["created", "running", "waiting_permission", "waiting_input"].includes(instance.status)}>
              <button class="danger" onClick={() => void cancelAgent(instance.id)}>
                Cancel
              </button>
            </Show>
          </div>
        )}
      </For>
    </details>
  );
}

function ChatView() {
  const session = () => state.sessions.find((s) => s.id === state.activeSessionId);
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
          <button onClick={() => dismissSessionNotice()}>×</button>
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
        data-timeline-rendered={state.messages.length}
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
        <For each={state.messages}>{(message) => <MessageView message={message} />}</For>
        <For each={Object.values(state.live)}>{(live) => <LiveView live={live} />}</For>
        <div id="timeline-bottom" ref={bottomAnchor} />
      </div>
      <PlansSection />
      <RunErrorsSection />
      <ModifiedFilesSection />
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

function AgentSettings() {
  let maxSession: HTMLInputElement | undefined;
  let maxProject: HTMLInputElement | undefined;
  let maxDepth: HTMLInputElement | undefined;
  const modelInputs: Record<string, { provider?: HTMLInputElement; model?: HTMLInputElement; effort?: HTMLInputElement }> = {};
  return (
    <section>
      <h2>Agents</h2>
      <div class="card">
        <h3>Concurrency limits</h3>
        <div class="row">
          <label class="muted">
            per session
            <input ref={maxSession} type="number" min="1" max="100" value={state.agentLimits.maxPerSession} />
          </label>
          <label class="muted">
            per project
            <input ref={maxProject} type="number" min="1" max="100" value={state.agentLimits.maxPerProject} />
          </label>
          <label class="muted">
            max depth
            <input ref={maxDepth} type="number" min="1" max="10" value={state.agentLimits.maxDepth} />
          </label>
          <button
            class="primary"
            onClick={() => {
              void (async () => {
                const limits = {
                  maxPerSession: Number.parseInt(maxSession?.value ?? "", 10),
                  maxPerProject: Number.parseInt(maxProject?.value ?? "", 10),
                  maxDepth: Number.parseInt(maxDepth?.value ?? "", 10),
                };
                const result = await invoke("agents.setLimits", { limits });
                if (!result.ok) setError(result.error ?? "Could not save limits");
                else setError(undefined);
              })();
            }}
          >
            Save limits
          </button>
        </div>
      </div>
      <For each={state.definitions}>
        {(definition) => (
          <div class="card">
            <h3>
              <code>{definition.id}</code> <span class="muted">{definition.kind}</span>
            </h3>
            <p class="muted">{definition.description}</p>
            <p class="muted">
              default: <code>{definition.defaultModel.providerId}/{definition.defaultModel.modelId}</code>
              {definition.defaultModel.effort ? ` effort=${definition.defaultModel.effort}` : ""} · tools={definition.tools.length} · prompt v{definition.promptVersion}
            </p>
            <div class="row">
              <input ref={(el) => ((modelInputs[definition.id] ??= {}).provider = el)} placeholder="providerId" value={definition.defaultModel.providerId} />
              <input ref={(el) => ((modelInputs[definition.id] ??= {}).model = el)} placeholder="modelId" value={definition.defaultModel.modelId} />
              <input ref={(el) => ((modelInputs[definition.id] ??= {}).effort = el)} placeholder="effort (optional)" value={definition.defaultModel.effort ?? ""} />
              <button
                onClick={() => {
                  void (async () => {
                    const entry = modelInputs[definition.id] ?? {};
                    const providerId = entry.provider?.value.trim() ?? "";
                    const modelId = entry.model?.value.trim() ?? "";
                    const effort = entry.effort?.value.trim() || undefined;
                    if (!providerId || !modelId) {
                      setError("providerId and modelId are required");
                      return;
                    }
                    const result = await invoke("agents.setDefinitionModel", { definitionId: definition.id, model: { providerId, modelId, effort } });
                    if (!result.ok) setError(result.error ?? "Could not save model");
                    else setError(undefined);
                  })();
                }}
              >
                Save model
              </button>
            </div>
          </div>
        )}
      </For>
    </section>
  );
}

function ProjectSettings() {
  let dirKind: HTMLSelectElement | undefined;
  let testJson: HTMLTextAreaElement | undefined;
  let trustedInput: HTMLInputElement | undefined;
  const projectId = () => state.activeProjectId;
  return (
    <section>
      <h2>Project: {state.projects.find((p) => p.id === state.activeProjectId)?.name ?? "—"}</h2>
      <Show when={!projectId()}>
        <p class="muted">Select a project to manage isolated directories, tests and trusted instructions.</p>
      </Show>
      <Show when={projectId()}>
        <div class="card">
          <h3>Isolated directories (implementer scope)</h3>
          <For each={state.isolatedDirs}>
            {(dir) => (
              <div class="row">
                <code>{dir.path}</code>
                <span class="pill">{dir.kind}</span>
                <Show when={dir.branch}>
                  <span class="muted">{dir.branch}</span>
                </Show>
                <button
                  class="danger"
                  onClick={() => {
                    void (async () => {
                      const result = await invoke("projects.removeIsolatedDir", { id: dir.id });
                      if (!result.ok) setError(result.error ?? "Could not remove directory");
                    })();
                  }}
                >
                  Remove
                </button>
              </div>
            )}
          </For>
          <div class="row">
            <select ref={dirKind}>
              <option value="directory">directory</option>
              <option value="worktree">worktree</option>
            </select>
            <button
              class="primary"
              onClick={() => {
                void (async () => {
                  const picked = await invoke("app.pickDirectory", {});
                  if (!picked.path || !projectId()) return;
                  const result = await invoke("projects.addIsolatedDir", { projectId: projectId()!, path: picked.path, kind: (dirKind?.value ?? "directory") as "directory" | "worktree" });
                  if (!result.ok) setError(result.error ?? "Could not add directory");
                  else setError(undefined);
                })();
              }}
            >
              Add directory
            </button>
          </div>
        </div>
        <div class="card">
          <h3>Reviewer test allowlist (JSON array)</h3>
          <p class="muted">Each entry: {"{ \"id\", \"name\", \"argv\": [\"exe\", \"arg\", …] }"}. Commands run in a disposable copy, never on worker files.</p>
          <textarea ref={testJson} placeholder='[{"id":"unit","name":"unit","argv":["bun","test"]}]' value={JSON.stringify(state.testAllowlist)} />
          <div class="row">
            <button
              class="primary"
              onClick={() => {
                void (async () => {
                  if (!projectId()) return;
                  let entries: Array<{ id: string; name: string; argv: string[] }>;
                  try {
                    entries = JSON.parse(testJson?.value || "[]");
                  } catch {
                    setError("Test allowlist is not valid JSON");
                    return;
                  }
                  const result = await invoke("projects.saveTestAllowlist", { projectId: projectId()!, entries });
                  if (!result.ok) setError(result.error ?? "Could not save allowlist");
                  else setError(undefined);
                })();
              }}
            >
              Save allowlist
            </button>
          </div>
          <ul>
            <For each={state.testAllowlist}>
              {(entry) => (
                <li>
                  <code>{entry.id}</code> {entry.name} — <code>{entry.argv.join(" ")}</code>
                </li>
              )}
            </For>
          </ul>
        </div>
        <div class="card">
          <h3>Trusted instruction files</h3>
          <p class="muted">Only these workspace-relative files become system instructions. Everything else is untrusted.</p>
          <div class="row">
            <input ref={trustedInput} placeholder="OCTUS.md, notes.md" value={state.trustedFiles.join(", ")} />
            <button
              class="primary"
              onClick={() => {
                void (async () => {
                  if (!projectId()) return;
                  const files = (trustedInput?.value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
                  const result = await invoke("projects.saveTrustedInstructions", { projectId: projectId()!, files });
                  if (!result.ok) setError(result.error ?? "Could not save trusted files");
                  else setError(undefined);
                })();
              }}
            >
              Save
            </button>
          </div>
          <p class="muted">Current: {state.trustedFiles.join(", ") || "—"}</p>
        </div>
      </Show>
    </section>
  );
}

function AppearanceSettings() {
  return (
    <section>
      <h2>Appearance</h2>
      <div class="row">
        <label for="prefs-theme">Theme</label>
        <select id="prefs-theme" value={state.prefs.theme} onChange={(e) => void setUiPrefs({ theme: e.currentTarget.value as "light" | "dark" | "system" })}>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="system">System</option>
        </select>
        <label for="prefs-density">Density</label>
        <select id="prefs-density" value={state.prefs.density} onChange={(e) => void setUiPrefs({ density: e.currentTarget.value as "compact" | "normal" | "comfortable" })}>
          <option value="compact">Compact</option>
          <option value="normal">Normal</option>
          <option value="comfortable">Comfortable</option>
        </select>
        <label for="prefs-font-size">Size</label>
        <select id="prefs-font-size" value={state.prefs.fontSize} onChange={(e) => void setUiPrefs({ fontSize: Number(e.currentTarget.value) })}>
          <option value="12">12</option>
          <option value="13">13</option>
          <option value="14">14</option>
          <option value="15">15</option>
          <option value="16">16</option>
          <option value="17">17</option>
          <option value="18">18</option>
        </select>
      </div>
    </section>
  );
}

function SettingsView() {
  return (
    <main class="settings-view">
      <Show when={state.error}>
        <div class="banner err">
          {state.error}
          <button onClick={() => setError(undefined)}>×</button>
        </div>
      </Show>
      <AppearanceSettings />
      <ProviderSettings />
      <BudgetSettings />
      <AgentSettings />
      <ProjectSettings />
    </main>
  );
}

// ---------------------------------------------------------------- bienvenida (Todo 10, F-1/W-01).
// Pantalla inicial sin auto-selección: arrastrar carpeta (rutas propuestas por
// el renderer, validadas en main), selector nativo, recientes con fecha, crear
// y abrir proyectos, continuar sesión y acceso a configuración. No ejecuta
// código del proyecto abierto: solo crea registros y selecciona.
function pathsFromDrop(event: DragEvent): string[] {
  const files = Array.from(event.dataTransfer?.files ?? []);
  const paths: string[] = [];
  for (const file of files) {
    const candidate = (file as unknown as { path?: unknown }).path;
    if (typeof candidate === "string" && candidate.length > 0) paths.push(candidate);
  }
  return paths;
}

function formatRecentDate(updatedAt: number): string {
  return new Date(updatedAt).toLocaleString();
}

function WelcomeView() {
  const [mode, setMode] = createSignal<"choose" | "sessions" | "settings">("choose");
  const [dragging, setDragging] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [pending, setPending] = createSignal<{ id?: string; name: string; rootPath: string } | undefined>(undefined);
  const [pendingSessions, setPendingSessions] = createSignal<Session[]>([]);
  let nameInput: HTMLInputElement | undefined;

  async function enterSessions(proj: { id?: string; name: string; rootPath: string }): Promise<void> {
    setWelcomeError(undefined);
    setPending(proj);
    setPendingSessions([]);
    setMode("sessions");
    if (!proj.id) return;
    try {
      const { sessions } = await invoke("sessions.list", { projectId: proj.id });
      setPendingSessions(sessions);
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handlePath(path: string): Promise<void> {
    setBusy(true);
    try {
      const check = await validateDirectory(path);
      if (!check.ok) {
        setWelcomeError(check.error ?? "La carpeta no es válida.");
        return;
      }
      const real = check.realPath ?? path;
      const existing = state.projects.find((p) => p.rootPath === real || p.rootPath === path);
      if (existing) {
        await enterSessions({ id: existing.id, name: existing.name, rootPath: existing.rootPath });
      } else {
        setWelcomeError(undefined);
        setPending({ name: "", rootPath: real });
        nameInput?.focus();
      }
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function openRecent(project: Project): Promise<void> {
    setBusy(true);
    try {
      const check = await validateDirectory(project.rootPath);
      if (!check.ok) {
        // F-1: reciente con ruta ausente → se marca como roto y se deja elegir otro.
        markProjectBroken(project.id);
        setWelcomeError(`«${project.name}»: ${check.error ?? "ruta no disponible."} Elige otro proyecto.`);
        return;
      }
      await enterSessions({ id: project.id, name: project.name, rootPath: project.rootPath });
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function pickNative(): Promise<void> {
    setBusy(true);
    try {
      const picked = await invoke("app.pickDirectory", {});
      if (picked.path) await handlePath(picked.path);
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function createAndEnter(): Promise<void> {
    const target = pending();
    const name = nameInput?.value.trim() ?? "";
    if (!target || target.id || !name) {
      setWelcomeError("Pon un nombre al proyecto para crearlo.");
      return;
    }
    setBusy(true);
    try {
      // main vuelve a validar la carpeta: si falla, nada se crea.
      await createProject(name, target.rootPath);
      const created = state.projects.find((p) => p.rootPath === target.rootPath);
      if (created) await enterSessions({ id: created.id, name: created.name, rootPath: created.rootPath });
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function continueLatest(): Promise<void> {
    const target = pending();
    if (!target?.id) return;
    setBusy(true);
    try {
      await selectProject(target.id);
      const list = [...pendingSessions()].sort((a, b) => b.updatedAt - a.updatedAt);
      if (list.length > 0) await selectSession(list[0]!.id);
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function startNewSession(): Promise<void> {
    const target = pending();
    if (!target?.id) return;
    setBusy(true);
    try {
      await selectProject(target.id);
      await createSession();
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function openWithoutSession(): Promise<void> {
    const target = pending();
    if (!target?.id) return;
    setBusy(true);
    try {
      await selectProject(target.id);
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function backToChoose(): void {
    setWelcomeError(undefined);
    setPending(undefined);
    setPendingSessions([]);
    setMode("choose");
  }

  return (
    <main id="welcome" aria-label="Bienvenida">
      <div class="welcome-card">
        <div class="welcome-head">
          <h1>Octus</h1>
          <p class="muted">Elige una carpeta para empezar. Nada se selecciona solo.</p>
        </div>
        <Show when={state.welcomeError}>
          <div id="welcome-error" role="alert">
            {state.welcomeError}
            <button type="button" onClick={() => setWelcomeError(undefined)}>×</button>
          </div>
        </Show>
        <Show
          when={mode() === "settings"}
          fallback={
            <Show
              when={mode() === "sessions" && pending()}
              fallback={
                <>
                  <div
                    id="welcome-dropzone"
                    classList={{ dragging: dragging() }}
                    onDragOver={(event: DragEvent) => {
                      event.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event: DragEvent) => {
                      event.preventDefault();
                      setDragging(false);
                      const paths = pathsFromDrop(event);
                      if (paths.length === 0) {
                        setWelcomeError("No se recibió ninguna carpeta (soltado vacío).");
                        return;
                      }
                      void handlePath(paths[0]!);
                    }}
                  >
                    Arrastra una carpeta de Windows aquí
                  </div>
                  <div class="row welcome-actions">
                    <button id="welcome-pick" type="button" disabled={busy()} onClick={() => void pickNative()}>
                      Abrir por explorador…
                    </button>
                    <button id="welcome-settings" type="button" onClick={() => setMode("settings")}>
                      Configuración
                    </button>
                  </div>
                  <Show when={pending() && !pending()!.id}>
                    <div class="welcome-create">
                      <p class="muted">Carpeta: {pending()!.rootPath}</p>
                      <div class="row">
                        <input id="welcome-name" ref={nameInput} placeholder="Nombre del proyecto nuevo" />
                        <button id="welcome-create" type="button" class="primary" disabled={busy()} onClick={() => void createAndEnter()}>
                          Crear proyecto
                        </button>
                      </div>
                    </div>
                  </Show>
                  <section aria-label="Recientes">
                    <h2>Recientes</h2>
                    <Show when={state.projects.length === 0} fallback={<></>}>
                      <p class="muted">Aún no hay proyectos.</p>
                    </Show>
                    <ul id="welcome-recents">
                      <For each={state.projects}>
                        {(project) => (
                          <li>
                            <button
                              type="button"
                              class="recent"
                              data-project-id={project.id}
                              data-broken={isProjectBroken(project.id)}
                              disabled={busy()}
                              onClick={() => void openRecent(project)}
                            >
                              <span class="recent-name">{project.name}</span>
                              <span class="recent-path">{project.rootPath}</span>
                              <span class="recent-date">{formatRecentDate(project.updatedAt)}</span>
                              <Show when={isProjectBroken(project.id)}>
                                <span class="recent-broken">ruta ausente</span>
                              </Show>
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                </>
              }
            >
              <section aria-label="Sesiones del proyecto">
                <h2>{pending()!.name || "Proyecto"}</h2>
                <p class="muted">{pending()!.rootPath}</p>
                <div class="row welcome-actions">
                  <button id="welcome-continue" type="button" class="primary" disabled={busy() || pendingSessions().length === 0} onClick={() => void continueLatest()}>
                    Continuar sesión
                  </button>
                  <button id="welcome-new-session" type="button" disabled={busy()} onClick={() => void startNewSession()}>
                    Nueva sesión
                  </button>
                  <button id="welcome-open" type="button" disabled={busy()} onClick={() => void openWithoutSession()}>
                    Abrir sin sesión
                  </button>
                  <button id="welcome-back" type="button" onClick={backToChoose}>
                    Volver
                  </button>
                </div>
                <Show
                  when={pendingSessions().length > 0}
                  fallback={<p class="muted">Sin sesiones todavía: crea la primera.</p>}
                >
                  <ul class="welcome-sessions">
                    <For each={[...pendingSessions()].sort((a, b) => b.updatedAt - a.updatedAt)}>
                      {(session) => (
                        <li>
                          <span>{session.title}</span> <span class="recent-date">{formatRecentDate(session.updatedAt)}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>
            </Show>
          }
        >
          <div class="row welcome-actions">
            <button id="welcome-back" type="button" onClick={backToChoose}>
              Volver a bienvenida
            </button>
          </div>
          <SettingsView />
        </Show>
      </div>
    </main>
  );
}

export default function App() {
  onMount(() => {
    void initStore().catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
    // Atajos del workbench (Todo 8): no pisan el Enter del composer ni la escritura.
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.altKey && event.code === "KeyB") {
        event.preventDefault();
        void toggleSidebarPanel();
        return;
      }
      if (mod && !event.altKey && event.code === "KeyJ") {
        event.preventDefault();
        void toggleBottomPanel();
        return;
      }
      if (mod && event.altKey && event.code === "KeyI") {
        event.preventDefault();
        void toggleInspectorPanel();
        return;
      }
      if (mod && !event.altKey && event.code === "Digit0") {
        event.preventDefault();
        void resetWorkbenchLayout();
        return;
      }
      if (event.altKey && !mod && !event.shiftKey) {
        const order: ActivityId[] = ["explorer", "chat", "plans", "agents", "skills-mcp", "settings"];
        const index = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6"].indexOf(event.code);
        if (index >= 0) {
          event.preventDefault();
          void setLayoutActivity(order[index]!);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });
  // Catalogo del Todo 7: ruta aditiva solo con ?catalog=1; sin el parametro se
  // renderiza el arbol existente sin cambios de comportamiento ni APIs.
  const showCatalog = () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("catalog") === "1";
  return (
    <Show when={showCatalog()} fallback={
    <Show when={state.activeProjectId} fallback={
      <div class="app" id="welcome-shell">
        <WelcomeView />
      </div>
    }>
    <div class="app" id="workbench">
      <Show when={state.layoutNotice}>
        <div id="layout-notice" role="status">
          <span>{state.layoutNotice}</span>
          <button type="button" onClick={() => dismissLayoutNotice()}>
            Entendido
          </button>
        </div>
      </Show>
      <div class="wb-top">
        <ActivityBar />
        <Sidebar />
        <ResizeHandle kind="sidebar" hidden={!state.layout.sidebarVisible} />
        <div id="center">
          <Show when={state.view === "chat"} fallback={<SettingsView />}>
            <ChatView />
          </Show>
        </div>
        <ResizeHandle kind="inspector" hidden={!state.layout.inspectorVisible} />
        <InspectorPanel />
      </div>
      <ResizeHandle kind="bottom" hidden={!state.layout.bottomVisible} />
      <BottomPanel />
      <PermissionDialogs />
      <QuestionDialogs />
    </div>
    </Show>
    }>
      <div class="app" id="workbench">
        <CatalogView />
      </div>
    </Show>
  );
}
