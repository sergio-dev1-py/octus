/**
 * @octus/shared — estado del workbench del Todo 8 (ola 8).
 * Definición única de forma, rangos válidos y degradación de `ui.layout.v1`.
 *
 * Nota de diseño (desvío documentado de C-01 del Todo 5): el contrato C-01
 * nombraba el layout dentro de `ui.prefs.v1`, pero el Todo 6 aterrizó prefs
 * como trío estricto (tema, tamaño, densidad) con tests que fijan la forma
 * exacta. Ampliar ese objeto invalidaría el contrato aterrizado y obligaría
 * una migración; por eso el layout vive en su propia clave `kv`
 * `ui.layout.v1` con el mismo mecanismo y la misma semántica de degradación
 * (corrupto → defecto, sin romper el arranque).
 * Main valida en escritura; la lectura degrada campo a campo.
 */

export type ActivityId = "explorer" | "chat" | "plans" | "agents" | "skills-mcp" | "settings";

export type BottomTab = "terminal" | "problems" | "output" | "tests";

export interface WorkbenchLayout {
  activity: ActivityId;
  sidebarVisible: boolean;
  /** Ancho del sidebar en px, recortado a [SIDEBAR_MIN, SIDEBAR_MAX]. */
  sidebarWidth: number;
  inspectorVisible: boolean;
  /** Ancho del inspector en px, recortado a [INSPECTOR_MIN, INSPECTOR_MAX]. */
  inspectorWidth: number;
  bottomVisible: boolean;
  /** Alto del panel inferior en px, recortado a [BOTTOM_MIN, BOTTOM_MAX]. */
  bottomHeight: number;
  bottomTab: BottomTab;
}

/** Clave `kv` del layout (mecanismo existente, clave nueva del Todo 8). */
export const UI_LAYOUT_KEY = "ui.layout.v1";

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const INSPECTOR_MIN = 220;
export const INSPECTOR_MAX = 480;
export const BOTTOM_MIN = 120;
export const BOTTOM_MAX = 400;

export const DEFAULT_LAYOUT: WorkbenchLayout = {
  activity: "explorer",
  sidebarVisible: true,
  sidebarWidth: 264,
  inspectorVisible: true,
  inspectorWidth: 248,
  bottomVisible: true,
  bottomHeight: 180,
  bottomTab: "terminal",
};

const ACTIVITIES: readonly ActivityId[] = ["explorer", "chat", "plans", "agents", "skills-mcp", "settings"];
const BOTTOM_TABS: readonly BottomTab[] = ["terminal", "problems", "output", "tests"];

export function isActivityId(value: unknown): value is ActivityId {
  return typeof value === "string" && (ACTIVITIES as readonly string[]).includes(value);
}

export function isBottomTab(value: unknown): value is BottomTab {
  return typeof value === "string" && (BOTTOM_TABS as readonly string[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampSidebarWidth(value: unknown): number {
  return isFiniteNumber(value) ? clamp(value, SIDEBAR_MIN, SIDEBAR_MAX) : DEFAULT_LAYOUT.sidebarWidth;
}

export function clampInspectorWidth(value: unknown): number {
  return isFiniteNumber(value) ? clamp(value, INSPECTOR_MIN, INSPECTOR_MAX) : DEFAULT_LAYOUT.inspectorWidth;
}

export function clampBottomHeight(value: unknown): number {
  return isFiniteNumber(value) ? clamp(value, BOTTOM_MIN, BOTTOM_MAX) : DEFAULT_LAYOUT.bottomHeight;
}

/** Validación estricta para `layout.set`: tipos válidos (los tamaños se recortan al aplicar). */
export function isWorkbenchLayout(value: unknown): value is WorkbenchLayout {
  if (typeof value !== "object" || value === null) return false;
  const layout = value as Record<string, unknown>;
  return (
    isActivityId(layout.activity) &&
    typeof layout.sidebarVisible === "boolean" &&
    isFiniteNumber(layout.sidebarWidth) &&
    typeof layout.inspectorVisible === "boolean" &&
    isFiniteNumber(layout.inspectorWidth) &&
    typeof layout.bottomVisible === "boolean" &&
    isFiniteNumber(layout.bottomHeight) &&
    isBottomTab(layout.bottomTab)
  );
}

/**
 * Lectura tolerante: acepta objetos parciales y degrada cada campo inválido
 * a su valor por defecto. Nunca lanza. Garantiza el invariante del Todo 2:
 * un layout corrupto vuelve al defecto, nunca a una pantalla en blanco.
 */
export function parseWorkbenchLayout(value: unknown): WorkbenchLayout {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_LAYOUT };
  const layout = value as Record<string, unknown>;
  return {
    activity: isActivityId(layout.activity) ? layout.activity : DEFAULT_LAYOUT.activity,
    sidebarVisible: typeof layout.sidebarVisible === "boolean" ? layout.sidebarVisible : DEFAULT_LAYOUT.sidebarVisible,
    sidebarWidth: clampSidebarWidth(layout.sidebarWidth),
    inspectorVisible: typeof layout.inspectorVisible === "boolean" ? layout.inspectorVisible : DEFAULT_LAYOUT.inspectorVisible,
    inspectorWidth: clampInspectorWidth(layout.inspectorWidth),
    bottomVisible: typeof layout.bottomVisible === "boolean" ? layout.bottomVisible : DEFAULT_LAYOUT.bottomVisible,
    bottomHeight: clampBottomHeight(layout.bottomHeight),
    bottomTab: isBottomTab(layout.bottomTab) ? layout.bottomTab : DEFAULT_LAYOUT.bottomTab,
  };
}

/** Deserializa el texto guardado en `kv`; cualquier corrupción → defecto. */
export function parseStoredLayout(stored: string | null | undefined): WorkbenchLayout {
  if (typeof stored !== "string" || stored.length === 0) return { ...DEFAULT_LAYOUT };
  try {
    return parseWorkbenchLayout(JSON.parse(stored) as unknown);
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

/** Restaura el defecto (botón #layout-reset y atajo Ctrl+0). */
export function resetLayout(): WorkbenchLayout {
  return { ...DEFAULT_LAYOUT };
}

// --- Operaciones puras: ocultar, mostrar, redimensionar ---

function withLayout(layout: WorkbenchLayout, patch: Partial<WorkbenchLayout>): WorkbenchLayout {
  return parseWorkbenchLayout({ ...layout, ...patch });
}

export function toggleSidebar(layout: WorkbenchLayout): WorkbenchLayout {
  return withLayout(layout, { sidebarVisible: !layout.sidebarVisible });
}

export function toggleInspector(layout: WorkbenchLayout): WorkbenchLayout {
  return withLayout(layout, { inspectorVisible: !layout.inspectorVisible });
}

export function toggleBottom(layout: WorkbenchLayout): WorkbenchLayout {
  return withLayout(layout, { bottomVisible: !layout.bottomVisible });
}

export function setActivity(layout: WorkbenchLayout, activity: ActivityId): WorkbenchLayout {
  if (!isActivityId(activity)) return { ...layout };
  return withLayout(layout, { activity, sidebarVisible: true });
}

export function setBottomTab(layout: WorkbenchLayout, tab: BottomTab): WorkbenchLayout {
  if (!isBottomTab(tab)) return { ...layout };
  return withLayout(layout, { bottomTab: tab, bottomVisible: true });
}

export function resizeSidebarBy(layout: WorkbenchLayout, deltaX: number): WorkbenchLayout {
  if (!isFiniteNumber(deltaX)) return { ...layout };
  return withLayout(layout, { sidebarWidth: clamp(layout.sidebarWidth + deltaX, SIDEBAR_MIN, SIDEBAR_MAX) });
}

export function resizeInspectorBy(layout: WorkbenchLayout, deltaX: number): WorkbenchLayout {
  // El inspector está a la derecha: arrastrar a la izquierda (deltaX<0) lo ensancha.
  if (!isFiniteNumber(deltaX)) return { ...layout };
  return withLayout(layout, { inspectorWidth: clamp(layout.inspectorWidth - deltaX, INSPECTOR_MIN, INSPECTOR_MAX) });
}

export function resizeBottomBy(layout: WorkbenchLayout, deltaY: number): WorkbenchLayout {
  // El panel está abajo: arrastrar hacia arriba (deltaY<0) lo agranda.
  if (!isFiniteNumber(deltaY)) return { ...layout };
  return withLayout(layout, { bottomHeight: clamp(layout.bottomHeight - deltaY, BOTTOM_MIN, BOTTOM_MAX) });
}

// --- Estilos en línea: la única traducción layout→DOM (la usan App y el QA) ---

export interface PanelStyle {
  display: string;
  width?: string;
  height?: string;
}

/** Estilos exactos que el renderer aplica a #sidebar, #inspector y #bottom-panel. */
export function layoutStyles(layout: WorkbenchLayout): { sidebar: PanelStyle; inspector: PanelStyle; bottom: PanelStyle } {
  return {
    sidebar: { display: layout.sidebarVisible ? "" : "none", width: `${layout.sidebarWidth}px` },
    inspector: { display: layout.inspectorVisible ? "" : "none", width: `${layout.inspectorWidth}px` },
    bottom: { display: layout.bottomVisible ? "" : "none", height: `${layout.bottomHeight}px` },
  };
}
