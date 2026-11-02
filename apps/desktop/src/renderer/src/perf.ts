/** Renderer — presupuestos de rendimiento del Todo 5 §7 y mecanismos de
 * conteo/diferido del Todo 34. Sin Solid ni DOM: lógica pura consumida por
 * las vistas y por el script de presupuesto (`scripts/verify-task-34-budget.mjs`).
 *
 * Las 11 cifras viven en `.omo/design/octus-ux-skills-mcp/task-5-contracts.md` §7;
 * este módulo las fija como constantes afirmables en Windows.
 */

/** Las 11 cifras del presupuesto (§7), en las unidades indicadas. */
export const PERF_BUDGETS = {
  /** Arranque frío hasta bienvenida visible. */
  coldStartMs: 2500,
  /** Bienvenida → workbench interactivo (paneles diferidos). */
  welcomeToWorkbenchMs: 1500,
  /** Memoria total (main + renderer + worker) en reposo. */
  totalMemoryMb: 450,
  /** Memoria del worker SQLite bajo carga de chat. */
  workerMemoryMb: 100,
  /** Memoria por terminal PTY abierta. */
  terminalMemoryMb: 25,
  /** Scroll de conversación larga (5.000 mensajes): 60 fps con ventana virtualizada. */
  longScrollFps: 60,
  /** Primer token tras prompt (simulado local). */
  firstTokenMs: 800,
  /** Cancelación de stream hasta estado final. */
  cancelMs: 300,
  /** Apertura de la vista Agent Manager (100 tareas). */
  agentDagMs: 1000,
  /** Arranque con preferencias corruptas (defecto aplicado). */
  corruptPrefsMs: 3000,
  /** Crecimiento de `events` por run típico. */
  maxEventsPerRun: 2000,
} as const;

/** Ventana del DOM del timeline: como máximo estos mensajes pintados
 * (N-C-06: el historial pagina en el servidor de 100 en 100; el DOM nunca
 * crece con la conversación). Dos páginas visibles. */
export const CHAT_DOM_WINDOW = 200;
/** Tarjetas por lista del chat/workbench (tareas, agentes, memoria). */
export const TASK_CARD_WINDOW = 100;
/** Nodos del DAG de dependencias (agentes y chat). Paginado con 100 nodos (§7). */
export const DAG_NODE_WINDOW = 100;
/** Tarjetas de integraciones visibles a la vez (las más pesadas). */
export const INTEGRATION_CARD_WINDOW = 20;

/** Presupuesto de nodos por panel (lo que el DOM puede pintar sin jank). */
export function budgetForPanel(panel: string): number {
  switch (panel) {
    case "chat-messages":
      return CHAT_DOM_WINDOW;
    case "dag-nodes":
    case "agent-dag":
      return DAG_NODE_WINDOW;
    case "integration-cards":
      return INTEGRATION_CARD_WINDOW;
    default:
      return TASK_CARD_WINDOW;
  }
}

/** Conteo de renders por panel (el script de presupuesto lo usa para el caso
 * failure: un panel que renderiza de más se detecta por conteo y se difiere). */
const renderCounts = new Map<string, number>();

export function noteRender(panel: string, rendered: number): { rendered: number; budget: number; over: boolean } {
  renderCounts.set(panel, (renderCounts.get(panel) ?? 0) + 1);
  const budget = budgetForPanel(panel);
  return { rendered, budget, over: rendered > budget };
}

export function renderTimes(panel: string): number {
  return renderCounts.get(panel) ?? 0;
}

export function resetRenderCounts(): void {
  renderCounts.clear();
}

export interface Capped<T> {
  visible: T[];
  deferred: number;
  over: boolean;
}

/** Carga diferida por conteo: si la lista supera el presupuesto del panel,
 * solo se pintan los primeros `window` y el resto queda diferido (el caso
 * failure del Todo 34: el exceso se detecta y no se pinta). */
export function capList<T>(panel: string, items: readonly T[], window?: number): Capped<T> {
  const limit = window ?? budgetForPanel(panel);
  const list = [...items];
  if (list.length <= limit) return { visible: list, deferred: 0, over: false };
  noteRender(panel, list.length);
  return { visible: list.slice(0, limit), deferred: list.length - limit, over: true };
}
