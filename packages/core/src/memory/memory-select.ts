/**
 * @octus/core — selección de memoria para contexto (Etapa 6, FINAL-1/FINAL-3).
 * Función pura: cadena de scopes autorizados, puerta por categoría+estado,
 * checkpoints ligados a la recuperación en curso, exclusión de grupos en
 * contradicción pendiente, topes de entradas/antigüedad (recientes primero).
 * Sin vectores, sin acceso a DB: la recuperación de filas vive en
 * ContextBuilder; aquí solo decide qué entra.
 */
import type { MemoryItem } from "@octus/shared";

export interface MemoryContextIds {
  projectId?: string;
  sessionId?: string;
  runId?: string;
  taskId?: string;
  instanceId?: string;
}

export interface MemorySelectOptions {
  /** Máximo de entradas inyectadas (defecto 20). */
  maxEntries?: number;
  /** Tope de caracteres acumulados (defecto 8000). */
  maxChars?: number;
}

/** Categorías que exigen `approved` (gobernanza del usuario). */
export const APPROVAL_REQUIRED_CATEGORIES = new Set(["decision", "instruction"]);

const CONTRADICTION_RE = /contradiction pending/i;

export interface MemorySelection {
  selected: MemoryItem[];
  /** Candidatas válidas descartadas por topes. */
  dropped: number;
}

export function selectForContext(entries: MemoryItem[], ctx: MemoryContextIds, opts: MemorySelectOptions = {}): MemorySelection {
  if (!ctx.projectId) return { selected: [], dropped: 0 };
  const maxEntries = opts.maxEntries ?? 20;
  const maxChars = opts.maxChars ?? 8000;
  const chain = new Map<MemoryItem["scope"], Set<string>>();
  const add = (scope: MemoryItem["scope"], id?: string): void => {
    if (!id) return;
    let set = chain.get(scope);
    if (!set) {
      set = new Set();
      chain.set(scope, set);
    }
    set.add(id);
  };
  add("project", ctx.projectId);
  add("session", ctx.sessionId);
  add("run", ctx.runId);
  add("task", ctx.taskId);
  add("instance", ctx.instanceId);

  // 1+2. Cadena autorizada + puerta por categoría/estado. Checkpoints solo
  // ligados al run/task/instance en curso (los de proyecto/sesión no son
  // puntos de recuperación y no se inyectan).
  const eligible = entries.filter((e) => {
    if (!chain.get(e.scope)?.has(e.scopeId)) return false;
    if (APPROVAL_REQUIRED_CATEGORIES.has(e.category)) return e.status === "approved";
    if (e.category === "checkpoint") {
      if (e.status !== "approved" && e.status !== "verified") return false;
      return (e.scope === "run" || e.scope === "task" || e.scope === "instance") && !!chain.get(e.scope)?.has(e.scopeId);
    }
    return e.status === "approved" || e.status === "verified";
  });

  // 3. Exclusión por contradicción pendiente (FINAL-3): grupo completo fuera.
  const groups = new Map<string, MemoryItem[]>();
  for (const e of eligible) {
    if (e.status !== "approved" && e.status !== "verified") continue;
    const key = `${e.scope}|${e.scopeId}|${e.topic}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  const conflicted = new Set<string>();
  for (const list of groups.values()) {
    if (list.length > 1 && list.some((e) => e.reviewNote && CONTRADICTION_RE.test(e.reviewNote))) {
      for (const e of list) conflicted.add(e.id);
    }
  }
  const clean = eligible.filter((e) => !conflicted.has(e.id));

  // 4. Recientes primero + topes.
  clean.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
  const selected: MemoryItem[] = [];
  let chars = 0;
  for (const e of clean) {
    if (selected.length >= maxEntries) break;
    if (chars + e.content.length > maxChars) continue;
    selected.push(e);
    chars += e.content.length;
  }
  // Determinismo ante empates de updatedAt ya ordenado por id arriba; la
  // salida conserva ese orden para inyección estable.
  return { selected, dropped: clean.length - selected.length };
}
