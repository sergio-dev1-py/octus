/** Renderer/views — armazón del workbench: sidebar estilo OpenOrch, inspector,
 *  terminal inferior bajo la columna del chat y redimensión.
 *  El ActivityBar se eliminó: el sidebar es un único panel contextual con
 *  botones separados (Nueva sesión, Chat, Agentes, Programadas, MCP,
 *  workspaces con papelera) y ajustes con engranaje abajo. */
import { For, Show, createEffect, createSignal, untrack } from "solid-js";
import type { Session } from "@octus/shared";
import { SkillsContextPanel } from "./skills.jsx";
import { layoutStyles, resizeBottomBy, resizeInspectorBy, resizeSidebarBy } from "@octus/shared";
import { invoke } from "../api.js";
import { OcIcon } from "../components/oc.jsx";
import { TerminalPanel } from "./terminal-panel.jsx";
import { mcpRefresh, mcpState } from "../store/mcp.js";
import {
  closeSession,
  createProject,
  createSession,
  hideProject,
  recoverActiveSession,
  reconcileRecovery,
  refreshProjectSessions,
  previewWorkbenchLayout,
  renameSession,
  resetWorkbenchLayout,
  resizeBottomPanel,
  resizeInspectorPanel,
  resizeSidebarPanel,
  saveWorkbenchLayout,
  selectProject,
  selectSession,
  setLayoutActivity,
  setView,
  openSettings,
  state,
  toggleBottomPanel,
  toggleInspectorPanel,
  toggleSidebarPanel,
} from "../store.js";

function basename(directory: string): string {
  const parts = directory.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? directory;
}

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "ahora";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Barra superior estilo Antigravity: toggles de ventanas, título y ajustes.
 *  Con `disabled` se muestra en la bienvenida sin permitir pulsaciones. */
export function TopBar(props: { disabled?: boolean } = {}) {
  const session = () => state.sessions.find((s) => s.id === state.activeSessionId);
  const title = () => (props.disabled ? "Octus" : (session()?.title ?? "Octus"));
  const gated = () => props.disabled || !state.activeProjectId;
  return (
    <header id="topbar" aria-label="Barra superior">
      <div class="topbar-group" role="group" aria-label="Ventanas">
        <button
          type="button"
          id="toggle-sidebar"
          class="icon-button"
          title="Panel lateral (Ctrl+B)"
          aria-label="Panel lateral (Ctrl+B)"
          aria-pressed={state.layout.sidebarVisible}
          disabled={gated()}
          onClick={() => void toggleSidebarPanel()}
        >
          <OcIcon name="panel-left" />
        </button>
        <button
          type="button"
          id="toggle-bottom"
          class="icon-button"
          title="Terminal (Ctrl+J)"
          aria-label="Terminal (Ctrl+J)"
          aria-pressed={state.layout.bottomVisible}
          disabled={gated()}
          onClick={() => void toggleBottomPanel()}
        >
          <OcIcon name="panel-bottom" />
        </button>
        <button
          type="button"
          id="toggle-inspector"
          class="icon-button"
          title="Inspector (Ctrl+Alt+I)"
          aria-label="Inspector (Ctrl+Alt+I)"
          aria-pressed={state.layout.inspectorVisible}
          disabled={gated()}
          onClick={() => void toggleInspectorPanel()}
        >
          <OcIcon name="panel-right" />
        </button>
      </div>
      <span class="topbar-center">
        <span class="topbar-title">{title()}</span>
        <Show when={!props.disabled && session()}>
          <span class="muted">{state.busy ? "working…" : "idle"}</span>
        </Show>
      </span>
      <span class="topbar-group topbar-right">
        <button
          type="button"
          id="topbar-settings"
          class="icon-button"
          title="Ajustes"
          aria-label="Ajustes"
          disabled={props.disabled}
          onClick={() => setView(state.view === "settings" ? "chat" : "settings")}
        >
          <OcIcon name="gear" />
        </button>
      </span>
    </header>
  );
}

export function Sidebar() {
  const styles = () => layoutStyles(state.layout).sidebar;
  // Frescura del dot MCP: relectura por proyecto activo.
  createEffect(() => {
    const pid = state.activeProjectId;
    if (pid) void mcpRefresh(pid);
  });
  // Conteos de TODOS los proyectos (sessions.list por proyecto, sin working).
  createEffect(() => {
    for (const p of state.projects) {
      if (!(p.id in state.sessionsByProject)) void refreshProjectSessions(p.id);
    }
  });
  // Activo siempre con working fresco (untrack: sin tormentas IPC).
  createEffect(() => {
    const pid = state.activeProjectId;
    if (!pid) return;
    untrack(() => {
      if (!isExpanded(pid)) setExpanded({ ...expanded(), [pid]: true });
    });
    void refreshProjectSessions(pid, { withWorking: true });
  });
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});
  const [groupError, setGroupError] = createSignal<Record<string, boolean>>({});
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [sortMode, setSortMode] = createSignal<"recent" | "name">("recent");
  const [confirmingId, setConfirmingId] = createSignal<string | undefined>(undefined);
  const [confirmingSessionId, setConfirmingSessionId] = createSignal<string | undefined>(undefined);
  const isExpanded = (pid: string): boolean => expanded()[pid] ?? pid === state.activeProjectId;
  const toggleProject = (pid: string) => {
    const next = !isExpanded(pid);
    setExpanded({ ...expanded(), [pid]: next });
    if (next) {
      void refreshProjectSessions(pid, { withWorking: true }).then((ok) => {
        if (!ok) setGroupError({ ...groupError(), [pid]: true });
        else setGroupError({ ...groupError(), [pid]: false });
      });
    }
  };
  // Verde en CUALQUIER sesión con agente trabajando: vive en
  // state.agentInstances (reactivo) o en el caché working (resto de sesiones).
  const sessionDot = (sessionId: string): "working" | "active" | "idle" => {
    const live = state.agentInstances.some((i) => i.sessionId === sessionId && ["created", "running", "waiting_permission", "waiting_input"].includes(i.status));
    if (live || state.workingBySession[sessionId]) return "working";
    return sessionId === state.activeSessionId ? "active" : "idle";
  };
  const openSession = (pid: string, sid: string) =>
    void (async () => {
      if (pid !== state.activeProjectId) await selectProject(pid);
      await selectSession(sid);
      await setLayoutActivity("chat");
    })();
  const mcpActive = () => mcpState.servers.some((s) => s.enabled && s.connection === "connected");
  const mcpError = () => mcpState.servers.some((s) => s.enabled && s.connection !== "connected" && s.connection !== "connecting");
  const dot = (on: boolean): string =>
    on
      ? "display:inline-block;flex-shrink:0;width:var(--oc-space-3);height:var(--oc-space-3);border-radius:var(--oc-radius-pill);background:var(--oc-success);"
      : "display:inline-block;flex-shrink:0;width:var(--oc-space-3);height:var(--oc-space-3);border-radius:var(--oc-radius-pill);background:transparent;border:1px solid var(--oc-border-strong);";
  const newSessionIn = (projectId: string) =>
    void (async () => {
      if (projectId !== state.activeProjectId) await selectProject(projectId);
      await createSession();
      await setLayoutActivity("chat");
    })();
  const openFolder = () =>
    void (async () => {
      const picked = await invoke("app.pickDirectory", {});
      if (picked.path) await createProject(basename(picked.path), picked.path);
    })();
  const sessionsOf = (projectId: string): Session[] =>
    state.sessionsByProject[projectId] ?? (projectId === state.activeProjectId ? state.sessions : []);
  const groups = () => {
    const needle = query().trim().toLowerCase();
    const list = state.projects.map((p) => ({ project: p, sessions: sessionsOf(p.id) }));
    const filtered = needle
      ? list
          .map((g) => ({
            ...g,
            sessions: g.sessions.filter(
              (s) => (s.title || "").toLowerCase().includes(needle) || g.project.rootPath.toLowerCase().includes(needle),
            ),
          }))
          .filter((g) => g.sessions.length > 0 || g.project.name.toLowerCase().includes(needle) || g.project.rootPath.toLowerCase().includes(needle))
      : list;
    for (const g of filtered) {
      g.sessions =
        sortMode() === "name"
          ? [...g.sessions].sort((a, b) => (a.title || "").localeCompare(b.title || ""))
          : [...g.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return filtered;
  };
  const chatActive = () => state.layout.activity === "chat" || state.layout.activity === "explorer";
  void chatActive;
  return (
    <aside id="sidebar" style={{ display: styles().display, width: styles().width }} aria-label="Proyectos y sesiones">
      <div class="side-head">
        <span class="side-title">Octus</span>
        <button type="button" id="sidebar-hide" class="icon-button" title="Ocultar panel (Ctrl+B)" aria-label="Ocultar panel (Ctrl+B)" onClick={() => void toggleSidebarPanel()}>
          <OcIcon name="panel-left" />
        </button>
      </div>
      <button type="button" id="session-new" class="new-session" disabled={!state.activeProjectId && state.projects.length === 0} onClick={() => void (state.activeProjectId ? newSessionIn(state.activeProjectId) : openFolder())}>
        <OcIcon name="plus" /> Nueva sesión
      </button>
      <button type="button" id="sidebar-schedules" class="mcp-button" title="Abrir Tareas programadas" onClick={() => openSettings("schedules")}>
        <OcIcon name="clock" />
        <span class="mcp-button-label">Tareas programadas</span>
      </button>
      <button type="button" id="sidebar-mcp" class="mcp-button" data-mcp-dot={mcpActive() ? "active" : "idle"} title="Abrir Conectores MCP" onClick={() => openSettings("mcp")}>
        <OcIcon name="gear" />
        <span class="mcp-button-label">MCP</span>
        <span class="spacer" />
        <span aria-hidden="true" style={dot(mcpActive())} />
        <span class="mcp-button-status">{mcpActive() ? "Conectado" : mcpError() ? "Error" : "Sin conexión"}</span>
      </button>
      <div class="workspace-section">
        <span class="workspace-section-title">Espacio de trabajo</span>
        <span class="workspace-section-actions">
          <button type="button" class="icon-button" title="Buscar" aria-label="Buscar" onClick={() => { setSearchOpen(!searchOpen()); if (searchOpen()) setQuery(""); }}>
            <OcIcon name="search" />
          </button>
          <button type="button" class="icon-button" title={sortMode() === "recent" ? "Orden: recientes" : "Orden: nombre"} aria-label="Cambiar orden" onClick={() => setSortMode(sortMode() === "recent" ? "name" : "recent")}>
            <OcIcon name="sort" />
          </button>
          <button type="button" class="icon-button" title="Abrir carpeta" aria-label="Abrir carpeta" onClick={openFolder}>
            <OcIcon name="folder-open" />
          </button>
        </span>
      </div>
      <Show when={searchOpen()}>
        <input class="workspace-search" type="text" placeholder="Buscar…" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} aria-label="Buscar workspaces" />
      </Show>
      <div class="session-list">
        <Show when={state.projects.length > 0} fallback={<p class="muted">Aún no hay proyectos. Abre una carpeta para empezar.</p>}>
          <For each={groups()}>
            {(group) => (
              <div class="workspace-group" data-project-section={group.project.id}>
                <div
                  class={`workspace-entry ${group.project.id === state.activeProjectId ? "active" : ""}`}
                  title={group.project.rootPath}
                  data-directory={group.project.rootPath}
                  onClick={() => void (async () => { await selectProject(group.project.id); toggleProject(group.project.id); })()}
                >
                  <span class="workspace-entry-icon" aria-hidden="true"><OcIcon name="folder" /></span>
                  <span class="workspace-entry-name">{group.project.name}</span>
                  <span class="workspace-entry-count">{group.sessions.length}</span>
                  <span class="workspace-entry-actions">
                    <button
                      type="button"
                      class="icon-button"
                      title={`Nueva sesión en ${group.project.name}`}
                      aria-label={`Nueva sesión en ${group.project.name}`}
                      onClick={(event) => { event.stopPropagation(); newSessionIn(group.project.id); }}
                    >
                      <OcIcon name="plus" />
                    </button>
                    <Show when={confirmingId() === group.project.id} fallback={
                      <button
                        type="button"
                        class="icon-button"
                        title={`Quitar ${group.project.name} de la vista`}
                        aria-label={`Quitar ${group.project.name} de la vista`}
                        onClick={(event) => { event.stopPropagation(); setConfirmingId(group.project.id); }}
                      >
                        <OcIcon name="trash" />
                      </button>
                    }>
                      <span class="confirm-inline" onClick={(event) => event.stopPropagation()}>
                        ¿Seguro?
                        <button type="button" onClick={() => { setConfirmingId(undefined); void hideProject(group.project.id); }}>Sí</button>
                        <button type="button" onClick={() => setConfirmingId(undefined)}>No</button>
                      </span>
                    </Show>
                    <button
                      type="button"
                      class="icon-button"
                      title={isExpanded(group.project.id) ? "Contraer" : "Expandir"}
                      aria-label={isExpanded(group.project.id) ? "Contraer" : "Expandir"}
                      aria-expanded={isExpanded(group.project.id)}
                      onClick={(event) => { event.stopPropagation(); toggleProject(group.project.id); }}
                    >
                      <OcIcon name={isExpanded(group.project.id) ? "chevron-down" : "chevron-right"} />
                    </button>
                  </span>
                </div>
                <Show when={isExpanded(group.project.id)}>
                  <Show when={!groupError()[group.project.id]} fallback={<p class="muted">No se pudieron cargar las sesiones.</p>}>
                    <Show when={group.sessions.length > 0} fallback={<p class="muted workspace-empty-small">Sin sesiones. Crea una para empezar.</p>}>
                      <div class="workspace-sessions" data-session-list={group.project.id} role="listbox" aria-label={`Sesiones de ${group.project.name}`}>
                        <For each={group.sessions}>
                          {(session) => {
                            const kind = () => sessionDot(session.id);
                            return (
                              <div class="session-item" role="option" aria-selected={session.id === state.activeSessionId} data-session-id={session.id} data-session-dot={kind()}>
                                <span aria-hidden="true" style={dot(kind() !== "idle")} title={kind() === "idle" ? "inactiva" : kind() === "working" ? "trabajando" : "activa"} />
                                <button type="button" class={session.id === state.activeSessionId ? "title active" : "title"} title={session.title} onClick={() => openSession(group.project.id, session.id)}>
                                  <span class="title">{session.title}</span>
                                </button>
                                <span class="meta">{relativeTime(session.updatedAt)}</span>
                                <Show when={confirmingSessionId() === session.id} fallback={
                                  <button type="button" class="icon-button" title={`Cerrar sesión ${session.title}`} aria-label={`Cerrar sesión ${session.title}`} data-session-close={session.id} onClick={() => setConfirmingSessionId(session.id)}>
                                    <OcIcon name="x" />
                                  </button>
                                }>
                                  <span class="confirm-inline" onClick={(event) => event.stopPropagation()}>
                                    ¿Borrar?
                                    <button type="button" onClick={() => { setConfirmingSessionId(undefined); void closeSession(session.id); }}>Sí</button>
                                    <button type="button" onClick={() => setConfirmingSessionId(undefined)}>No</button>
                                  </span>
                                </Show>
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </Show>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
    </aside>
  );
}

export function ThreadsPanel() {
  return (
    <section>
      <h2>Hilos</h2>
      <Show when={state.sessions.length > 0} fallback={<p class="muted">Sin hilos. Crea una sesión desde el panel.</p>}>
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
  // Vista contextual: el mismo catálogo del manager, en compacto.
  return <SkillsContextPanel />;
}

export function InspectorPanel() {
  const styles = () => layoutStyles(state.layout).inspector;
  const session = () => state.sessions.find((s) => s.id === state.activeSessionId);
  const failedTasks = () => state.tasks.filter((t) => t.status === "failed");
  const [confirmClose, setConfirmClose] = createSignal(false);
  let renameInput: HTMLInputElement | undefined;
  return (
    <aside id="inspector" style={{ display: styles().display, width: styles().width }} aria-label="Inspector">
      <div class="side-head">
        <strong>Inspector</strong>
        <button type="button" class="icon-button" id="inspector-hide" title="Ocultar inspector (Ctrl+Alt+I)" aria-label="Ocultar inspector (Ctrl+Alt+I)" onClick={() => void toggleInspectorPanel()}>
          <OcIcon name="panel-right" />
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
            <button type="button" onClick={() => void setLayoutActivity("agents")}>
              Ver agentes
            </button>
            <button id="session-close" type="button" class="danger" onClick={() => setConfirmClose(true)}>
              Cerrar sesión
            </button>
            <button id="session-recover" type="button" onClick={() => void recoverActiveSession()}>
              Recuperar sesión
            </button>
          </div>
          <Show when={confirmClose()}>
            <div class="row" role="alertdialog" aria-label="Confirmar cierre de sesión">
              <span class="muted">¿Borrar «{session()!.title}» para siempre? No se puede recuperar.</span>
              <button type="button" class="danger" onClick={() => { setConfirmClose(false); void closeSession(); }}>
                Sí, borrar
              </button>
              <button type="button" onClick={() => setConfirmClose(false)}>
                No
              </button>
            </div>
          </Show>
          <p class="muted">
            Recuperación: {state.recoveryStatus ? `${state.recoveryStatus.pendingOps} ops pendientes` : "desconocida"} ·{" "}
            <button type="button" onClick={() => void reconcileRecovery()}>
              Reconciliar ahora
            </button>
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
  return (
    <section id="bottom-panel" style={{ display: styles().display, height: styles().height }} aria-label="Terminal">
      <TerminalPanel projectId={state.activeProjectId} projectRoot={projectRoot()} />
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
        aria-label={props.kind === "bottom" ? "Redimensionar terminal" : props.kind === "sidebar" ? "Redimensionar panel" : "Redimensionar inspector"}
        tabindex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
    </Show>
  );
}

// Reexportado para compatibilidad: el layout ya no usa panel inferior múltiple.
export { resetWorkbenchLayout, toggleBottomPanel };
