/** Renderer — preferencias de UI (Todo 6): carga, aplicación y guardado. */
import { DEFAULT_UI_PREFS, parseUiPrefs, type UiPrefs } from "@octus/shared";
import { invoke } from "./api.js";

export type { UiPrefs };

/** Aplica tema, densidad y tamaño sobre el elemento raíz (selectores del Todo 3). */
export function applyUiPrefs(prefs: UiPrefs): void {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.dataset.density = prefs.density;
  root.dataset.fontSize = String(prefs.fontSize);
}

/** Lee desde main (`kv ui.prefs.v1`); sin main o con error, defecto. */
export async function loadUiPrefs(): Promise<UiPrefs> {
  try {
    const { prefs } = await invoke("prefs.get", {});
    return parseUiPrefs(prefs);
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

/** Guarda en main tras validar; devuelve lo guardado. */
export async function saveUiPrefs(prefs: UiPrefs): Promise<UiPrefs> {
  const { prefs: saved } = await invoke("prefs.set", { prefs });
  return parseUiPrefs(saved);
}
