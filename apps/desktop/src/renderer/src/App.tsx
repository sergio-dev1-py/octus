/** Renderer — raíz de vistas: compone el workbench desde views/ por responsabilidad. */
import { Show, onCleanup, onMount } from "solid-js";
import CatalogView from "./components/catalog.jsx";
import {
  dismissLayoutNotice,
  initStore,
  resetWorkbenchLayout,
  setError,
  setView,
  state,
  toggleBottomPanel,
  toggleInspectorPanel,
  toggleSidebarPanel,
} from "./store.js";
import { Sidebar, ResizeHandle, InspectorPanel, BottomPanel, TopBar } from "./views/workbench.jsx";
import { SettingsView } from "./views/settings.jsx";
import { AgentsView } from "./views/agents.jsx";
import { McpManagerView } from "./views/mcp.jsx";
import { ChatView, PermissionDialogs, QuestionDialogs } from "./views/chat.jsx";
import { WelcomeView } from "./views/welcome.jsx";

export default function App() {
  onMount(() => {
    void initStore().catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
    // Atajos del workbench: no pisan el Enter del composer ni la escritura.
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const mod = event.ctrlKey || event.metaKey;
      const hasProject = Boolean(state.activeProjectId);
      if (mod && !event.altKey && event.code === "KeyB") {
        if (!hasProject) return;
        event.preventDefault();
        void toggleSidebarPanel();
        return;
      }
      if (mod && !event.altKey && event.code === "KeyJ") {
        if (!hasProject) return;
        event.preventDefault();
        void toggleBottomPanel();
        return;
      }
      if (mod && event.altKey && event.code === "KeyI") {
        if (!hasProject) return;
        event.preventDefault();
        void toggleInspectorPanel();
        return;
      }
      if (mod && !event.altKey && event.code === "Digit0") {
        event.preventDefault();
        void resetWorkbenchLayout();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });
  // Catalogo aditivo: ruta solo con ?catalog=1.
  const showCatalog = () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("catalog") === "1";
  return (
    <Show when={showCatalog()} fallback={
    <Show when={state.activeProjectId} fallback={
      <div class="app" id="welcome-shell">
        <TopBar disabled />
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
      <TopBar />
      <div class="wb-top">
        <Sidebar />
        <ResizeHandle kind="sidebar" hidden={!state.layout.sidebarVisible} />
        <div id="center">
          <Show when={state.view === "chat"} fallback={<></>}>
            <Show when={state.layout.activity === "agents"} fallback={<Show when={state.layout.activity === "skills-mcp"} fallback={<ChatView />}><McpManagerView /></Show>}>
              <AgentsView />
            </Show>
          </Show>
          <ResizeHandle kind="bottom" hidden={!state.layout.bottomVisible} />
          <BottomPanel />
        </div>
        <ResizeHandle kind="inspector" hidden={!state.layout.inspectorVisible} />
        <InspectorPanel />
      </div>
      <Show when={state.view === "settings"}>
        <SettingsView onClose={() => setView("chat")} />
      </Show>
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
