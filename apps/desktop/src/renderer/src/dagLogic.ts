/** Renderer — lógica pura del Todo 17 (DAG, previews, conflictos, diff e historial).
 * Sin Solid ni dependencias de runtime: la vista (dag.tsx) la consume y el
 * script de verificación la ejecuta de verdad con datos simulados.
 * Solo tokens var(--oc-*): este módulo no emite estilos.
 */

export interface DagTask {
  id: string;
  title: string;
  status: string;
  needsReview?: boolean;
}

export interface DagDep {
  taskId: string;
  dependsOn: string;
}

export interface DagNode extends DagTask {
  depth: number;
  x: number;
  y: number;
}

export interface DagEdge {
  from: string;
  to: string;
}

export interface DagLayout {
  nodes: DagNode[];
  edges: DagEdge[];
  /** Camino del ciclo si el grafo no es acíclico, null en el caso válido. */
  cycle: string[] | null;
}

const X_STEP = 220;
const Y_STEP = 64;
const PAD_X = 88;
const PAD_Y = 32;

/** Profundidad por camino más largo desde las raíces (Kahn inverso, determinista). */
export function layoutDag(tasks: DagTask[], deps: DagDep[]): DagLayout {
  const ids = tasks.map((t) => t.id).sort();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const requires = new Map<string, string[]>();
  for (const id of ids) requires.set(id, []);
  for (const d of deps) {
    if (byId.has(d.taskId) && byId.has(d.dependsOn)) requires.get(d.taskId)!.push(d.dependsOn);
  }
  for (const list of requires.values()) list.sort();
  // Ciclo con camino explícito (DFS determinista por id).
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let cycle: string[] | null = null;
  const visit = (id: string): void => {
    if (cycle) return;
    color.set(id, 1);
    stack.push(id);
    for (const next of requires.get(id) ?? []) {
      const c = color.get(next) ?? 0;
      if (c === 1) {
        cycle = [...stack.slice(stack.indexOf(next)), next];
        return;
      }
      if (c === 0) visit(next);
      if (cycle) return;
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const id of ids) {
    if ((color.get(id) ?? 0) === 0) visit(id);
    if (cycle) break;
  }
  // Profundidad: 0 para raíces, max(profundidad de dependencias) + 1.
  const depth = new Map<string, number>();
  const compute = (id: string, seen: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0; // ciclo: corta sin romper el layout
    seen.add(id);
    let d = 0;
    for (const parent of requires.get(id) ?? []) d = Math.max(d, compute(parent, seen) + 1);
    seen.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of ids) compute(id, new Set());
  const layers = new Map<number, string[]>();
  for (const id of ids) {
    const d = depth.get(id) ?? 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)!.push(id);
  }
  const nodes: DagNode[] = ids.map((id) => {
    const task = byId.get(id)!;
    const d = depth.get(id) ?? 0;
    const row = (layers.get(d) ?? [id]).indexOf(id);
    return { ...task, depth: d, x: PAD_X + d * X_STEP, y: PAD_Y + row * Y_STEP };
  });
  const edges: DagEdge[] = deps
    .filter((d) => byId.has(d.taskId) && byId.has(d.dependsOn))
    .map((d) => ({ from: d.dependsOn, to: d.taskId }))
    .sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) : a.from < b.from ? -1 : 1));
  return { nodes, edges, cycle };
}

/** Preview alcanzable: solo el estado verificado cuenta (sin suponer "running" como listo). */
export function isPreviewReachable(preview: { status: string }): boolean {
  return preview.status === "reachable";
}

/** Conflictos visibles en la vista: el flujo de resolución asistida (open/resolving/resolved). */
export function visibleConflicts<T extends { status: string }>(conflicts: T[]): T[] {
  return conflicts.filter((c) => c.status === "open" || c.status === "resolving" || c.status === "resolved");
}

export interface DiffFile {
  file: string;
  changes: string;
}

/** Extrae archivos de un `git diff --stat` (formato de getWorktreeDiff, N-A-DIFF-1). */
export function parseDiffStat(stat: string): DiffFile[] {
  const out: DiffFile[] = [];
  for (const line of stat.split("\n")) {
    const m = /^\s*(.+?)\s*\|\s*(\d+)\s*[+-]*\s*$/.exec(line.trimEnd());
    if (m) out.push({ file: m[1]!.trim(), changes: m[2]!.trim() });
  }
  return out;
}

export interface Promotable {
  status: string;
  head?: string;
}

export interface PinnedApproval {
  candidateSha: string;
  decision: string;
}

/**
 * Puerta de promoción espejo de PromotionManager: solo aprobada con SHA fijado
 * al head actual. La UI deshabilita Promote en cualquier otro caso; main
 * rechaza de todos modos (el failure del Todo 17 lo ejecuta de verdad).
 */
export function canPromote(integration: Promotable, approval?: PinnedApproval): { ok: boolean; reason: string } {
  if (integration.status !== "approved") return { ok: false, reason: `integration is ${integration.status}, not approved` };
  if (!integration.head) return { ok: false, reason: "integration has no head to promote" };
  if (!approval || approval.decision !== "approved") return { ok: false, reason: "no approved decision for this integration" };
  if (approval.candidateSha !== integration.head) {
    return { ok: false, reason: "approval is pinned to a different SHA (rebuild for a new decision)" };
  }
  return { ok: true, reason: "approved at the current head" };
}
