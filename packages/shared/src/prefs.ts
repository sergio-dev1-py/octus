/**
 * @octus/shared — preferencias de UI del Todo 6 (ola 8).
 * Única definición de forma, valores válidos y degradación de `ui.prefs.v1`.
 * Main valida en escritura; la lectura degrada campo a campo al valor por
 * defecto para que una preferencia corrupta en disco nunca rompa el arranque.
 */

export type UiTheme = "light" | "dark" | "system";
export type UiDensity = "compact" | "normal" | "comfortable";

export interface UiPrefs {
  theme: UiTheme;
  /** Tamaño base en px, entero entre 12 y 18 (escala del Todo 3). */
  fontSize: number;
  density: UiDensity;
}

/** Clave `kv` aprobada en el contrato C-01 del Todo 5. */
export const UI_PREFS_KEY = "ui.prefs.v1";

export const DEFAULT_UI_PREFS: UiPrefs = {
  theme: "system",
  fontSize: 14,
  density: "normal",
};

const THEMES: readonly UiTheme[] = ["light", "dark", "system"];
const DENSITIES: readonly UiDensity[] = ["compact", "normal", "comfortable"];

export function isUiTheme(value: unknown): value is UiTheme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

export function isUiDensity(value: unknown): value is UiDensity {
  return typeof value === "string" && (DENSITIES as readonly string[]).includes(value);
}

export function isUiFontSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 12 && value <= 18;
}

/** Validación estricta para `prefs.set`: todo el objeto debe ser válido. */
export function isUiPrefs(value: unknown): value is UiPrefs {
  if (typeof value !== "object" || value === null) return false;
  const prefs = value as Record<string, unknown>;
  return isUiTheme(prefs.theme) && isUiFontSize(prefs.fontSize) && isUiDensity(prefs.density);
}

/**
 * Lectura tolerante: acepta objetos parciales o corruptos y degrada cada
 * campo inválido a su valor por defecto. Nunca lanza.
 */
export function parseUiPrefs(value: unknown): UiPrefs {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_UI_PREFS };
  const prefs = value as Record<string, unknown>;
  return {
    theme: isUiTheme(prefs.theme) ? prefs.theme : DEFAULT_UI_PREFS.theme,
    fontSize: isUiFontSize(prefs.fontSize) ? prefs.fontSize : DEFAULT_UI_PREFS.fontSize,
    density: isUiDensity(prefs.density) ? prefs.density : DEFAULT_UI_PREFS.density,
  };
}

/** Deserializa el texto guardado en `kv`; cualquier corrupción → defecto. */
export function parseStoredUiPrefs(stored: string | null | undefined): UiPrefs {
  if (typeof stored !== "string" || stored.length === 0) return { ...DEFAULT_UI_PREFS };
  try {
    return parseUiPrefs(JSON.parse(stored) as unknown);
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}
