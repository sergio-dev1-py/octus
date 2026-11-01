/** Renderer — raíz de vistas: compone el workbench desde views/ por responsabilidad. */
import { Show, onCleanup, onMount } from "solid-js";
import type { ActivityId } from "@octus/shared";
import CatalogView from "./components/catalog.jsx";
import {
  dismissLayoutNotice,
  initStore,
  resetWorkbenchLayout,
  setError,
  setLayoutActivity,
  state,
  toggleBottomPanel,
  toggleInspectorPanel,
  toggleSidebarPanel,
} from "./store.js";
import { ActivityBar, Sidebar, ResizeHandle, InspectorPanel, BottomPanel } from "./views/workbench.jsx";
import { SettingsView } from "./views/settings.jsx";
import { ChatView, PermissionDialogs, QuestionDialogs } from "./views/chat.jsx";
import { WelcomeView } from "./views/welcome.jsx";

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
