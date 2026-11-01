/** Renderer/store — preferencias de UI y layout persistente del workbench. */
import { DEFAULT_LAYOUT, parseWorkbenchLayout, resetLayout, resizeBottomBy, resizeInspectorBy, resizeSidebarBy, setActivity, setBottomTab, toggleBottom, toggleInspector, toggleSidebar } from "@octus/shared";
import type { ActivityId, BottomTab, WorkbenchLayout, UiPrefs } from "@octus/shared";
import { invoke } from "../api.js";
import { applyUiPrefs, saveUiPrefs } from "../prefs.js";
import { setError, state, setState } from "./state.js";

export async function setUiPrefs(patch: Partial<UiPrefs>): Promise<void> {
  const next = { ...state.prefs, ...patch };
  applyUiPrefs(next);
  setState("prefs", next);
  try {
    const saved = await saveUiPrefs(next);
    applyUiPrefs(saved);
    setState("prefs", saved);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

export async function loadLayout(): Promise<void> {
  try {
    const { layout, repaired } = await invoke("layout.get", {});
    setState("layout", parseWorkbenchLayout(layout));
    setState("layoutNotice", repaired ? "El layout guardado estaba dañado y se restauró al defecto." : undefined);
  } catch {
    // Sin main o error transitorio: defecto sin romper el arranque (nunca pantalla en blanco).
    setState("layout", { ...DEFAULT_LAYOUT });
    setState("layoutNotice", undefined);
  }
}

async function persistLayout(next: WorkbenchLayout): Promise<void> {
  setState("layout", next);
  try {
    const { layout } = await invoke("layout.set", { layout: next });
    setState("layout", parseWorkbenchLayout(layout));
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

export function dismissLayoutNotice(): void {
  setState("layoutNotice", undefined);
}

/** Actualiza el layout en memoria sin persistir (arrastre de redimensión). */
export function previewWorkbenchLayout(next: WorkbenchLayout): void {
  setState("layout", parseWorkbenchLayout(next));
}

/** Persiste el layout en memoria (soltar tras arrastrar). */
export async function saveWorkbenchLayout(): Promise<void> {
  await persistLayout(state.layout);
}

export async function toggleSidebarPanel(): Promise<void> {
  await persistLayout(toggleSidebar(state.layout));
}

export async function toggleInspectorPanel(): Promise<void> {
  await persistLayout(toggleInspector(state.layout));
}

export async function toggleBottomPanel(): Promise<void> {
  await persistLayout(toggleBottom(state.layout));
}

export async function setLayoutActivity(activity: ActivityId): Promise<void> {
  await persistLayout(setActivity(state.layout, activity));
}

export async function setLayoutBottomTab(tab: BottomTab): Promise<void> {
  await persistLayout(setBottomTab(state.layout, tab));
}

export async function resizeSidebarPanel(deltaX: number): Promise<void> {
  await persistLayout(resizeSidebarBy(state.layout, deltaX));
}

export async function resizeInspectorPanel(deltaX: number): Promise<void> {
  await persistLayout(resizeInspectorBy(state.layout, deltaX));
}

export async function resizeBottomPanel(deltaY: number): Promise<void> {
  await persistLayout(resizeBottomBy(state.layout, deltaY));
}

export async function resetWorkbenchLayout(): Promise<void> {
  setState("layoutNotice", undefined);
  await persistLayout(resetLayout());
}
