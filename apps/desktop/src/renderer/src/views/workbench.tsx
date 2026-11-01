/** Renderer/views — armazón del workbench: activity bar, sidebar, inspector, panel inferior y redimensión. */
import { For, Show } from "solid-js";
import type { ActivityId, BottomTab } from "@octus/shared";
import { layoutStyles, resizeBottomBy, resizeInspectorBy, resizeSidebarBy } from "@octus/shared";
import { invoke } from "../api.js";
import {
  closeSession,
  createProject,
  createSession,
  previewWorkbenchLayout,
  reconcileRecovery,
  recoverActiveSession,
  renameSession,
  resetWorkbenchLayout,
  resizeBottomPanel,
  resizeInspectorPanel,
  resizeSidebarPanel,
  saveWorkbenchLayout,
  selectProject,
  selectSession,
  setLayoutActivity,
  setLayoutBottomTab,
  setView,
  state,
  toggleBottomPanel,
  toggleInspectorPanel,
  toggleSidebarPanel,
} from "../store.js";

export function ExplorerPanel() {
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

export function ActivityIcon(props: { id: ActivityId }) {
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

export function ActivityBar() {
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

export function ThreadsPanel() {
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

export function PlansPanel() {
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

export function AgentsPanel() {
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

export function SkillsMcpPanel() {
  return (
    <section>
      <h2>Skills y MCP</h2>
      <p class="muted">El catálogo de Skills llega en la ola 12 y el gestor MCP en la ola 13. Aquí no hay nada que instalar todavía.</p>
    </section>
  );
}

export function SettingsShortcutPanel() {
  return (
    <section>
      <h2>Configuración</h2>
      <button class="primary" onClick={() => setView(state.view === "settings" ? "chat" : "settings")}>
        {state.view === "settings" ? "Volver al chat" : "Abrir configuración"}
      </button>
    </section>
  );
}

export function Sidebar() {
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

export function InspectorPanel() {
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

export function BottomPanel() {
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

export function ResizeHandle(props: { kind: "sidebar" | "inspector" | "bottom"; hidden: boolean }) {
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
