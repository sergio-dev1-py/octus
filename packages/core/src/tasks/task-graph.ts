/**
 * @octus/core — TaskGraph: DAG determinista de tareas (Etapa 3, ADR-032/037).
 * Lógica pura sobre filas; la persistencia vive en TaskManager.
 * Sin modelos, sin efectos: orden, ciclos, ready-gate y cascada.
 */
import type { Task, TaskDependency } from "@octus/shared";

export interface GraphInput {
  tasks: Pick<Task, "id" | "status" | "needsReview">[];
  deps: TaskDependency[];
}

export function adjacency(input: GraphInput): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const t of input.tasks) adj.set(t.id, []);
  for (const d of input.deps) adj.get(d.taskId)?.push(d.dependsOn);
  return adj;
}

/** Ciclo con camino explícito, o null si el grafo es acíclico. */
export function detectCycle(input: GraphInput): string[] | null {
  const adj = adjacency(input);
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    color.set(id, 1);
    stack.push(id);
    for (const next of adj.get(id) ?? []) {
      const c = color.get(next) ?? 0;
      if (c === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (c === 0) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const t of input.tasks) {
    if ((color.get(t.id) ?? 0) === 0) {
      const found = visit(t.id);
      if (found) return found;
    }
  }
  return null;
}

/** Dependencias transitivas (hacia atrás: lo que taskId requiere, directo e indirecto). */
export function transitiveDeps(input: GraphInput, taskId: string): Set<string> {
  const adj = adjacency(input);
  const out = new Set<string>();
  const visit = (id: string): void => {
    for (const next of adj.get(id) ?? []) {
      if (out.has(next)) continue;
      out.add(next);
      visit(next);
    }
  };
  visit(taskId);
  return out;
}

/** Dependientes transitivos (hacia adelante: lo que depende de taskId). */
export function transitiveDependents(input: GraphInput, taskId: string): Set<string> {
  const rev = new Map<string, string[]>();
  for (const t of input.tasks) rev.set(t.id, []);
  for (const d of input.deps) rev.get(d.dependsOn)?.push(d.taskId);
  const out = new Set<string>();
  const visit = (id: string): void => {
    for (const next of rev.get(id) ?? []) {
      if (out.has(next)) continue;
      out.add(next);
      visit(next);
    }
  };
  visit(taskId);
  return out;
}

export type SatisfiedStatus = "completed" | "reviewed" | "integrated";

/**
 * Una tarea está lista solo si TODAS sus dependencias obligatorias están
 * satisfechas: `completed` sin revisión, o `reviewed`/`integrated` cuando la
 * requieren (integrated implica reviewed + asentado).
 */
export function isDependencySatisfied(depStatus: Task["status"], depNeedsReview: boolean): boolean {
  if (depNeedsReview) return depStatus === "reviewed" || depStatus === "integrated";
  return depStatus === "completed" || depStatus === "reviewed" || depStatus === "integrated";
}

export function unsatisfiedDeps(input: GraphInput): Map<string, string[]> {
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const out = new Map<string, string[]>();
  for (const t of input.tasks) {
    const missing: string[] = [];
    for (const d of input.deps.filter((x) => x.taskId === t.id)) {
      const dep = byId.get(d.dependsOn);
      if (!dep || !isDependencySatisfied(dep.status, dep.needsReview)) {
        missing.push(d.dependsOn);
      }
    }
    if (missing.length > 0) out.set(t.id, missing);
  }
  return out;
}

/**
 * Cascada de cancelación: solo descendientes NO terminales.
 * `completed`/`reviewed` cortan la propagación (se conservan con historial).
 */
export function cascadeCancelSet(input: GraphInput, rootId: string): Set<string> {
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const terminalSuccess = (s: Task["status"]): boolean => s === "completed" || s === "reviewed" || s === "integrated";
  const terminal = (s: Task["status"]): boolean =>
    terminalSuccess(s) || s === "failed" || s === "cancelled" || s === "interrupted";
  const out = new Set<string>();
  // Adyacencia hacia adelante.
  const rev = new Map<string, string[]>();
  for (const t of input.tasks) rev.set(t.id, []);
  for (const d of input.deps) rev.get(d.dependsOn)?.push(d.taskId);
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (out.has(current)) continue;
    const node = byId.get(current);
    if (!node) continue;
    if (terminalSuccess(node.status)) continue; // éxito preservado, corta la propagación
    if (current !== rootId && terminal(node.status)) continue; // historial no terminal-éxito intacto
    out.add(current);
    for (const next of rev.get(current) ?? []) {
      if (!out.has(next)) queue.push(next);
    }
  }
  return out;
}

/** Orden determinista intra-run: prioridad desc, creación asc, id asc. */
export function orderTasks<T extends { id: string; priority: number; createdAt: number }>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
