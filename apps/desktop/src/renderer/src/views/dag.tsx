/** Renderer/views — Todo 17: DAG de dependencias, diff de worktrees e historial.
 * Componentes aditivos sobre los servicios reales (sin agentes ficticios ni
 * progreso inventado). Solo tokens var(--oc-*) y patrones .card/.pill/.row.
 */
import { For, Show, createSignal } from "solid-js";
import type { IntegrationOperation } from "@octus/shared";
import { invoke } from "../api.js";
import { setError, state } from "../store.js";
import { isPreviewReachable, layoutDag, parseDiffStat, visibleConflicts } from "../dagLogic.js";
import { DAG_NODE_WINDOW, capList } from "../perf.js";

function nodeStroke(status: string): string {
  if (status === "completed" || status === "reviewed" || status === "integrated") return "var(--oc-success)";
  if (status === "failed" || status === "blocked") return "var(--oc-danger)";
  if (status === "running") return "var(--oc-accent)";
  return "var(--oc-border-strong)";
}

/** Grafo de dependencias intra-run (SVG determinista por profundidad). */
export function DagSection() {
  const layout = () => {
    const tasks = state.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, needsReview: t.needsReview })); 
    const deps = Object.entries(state.taskDeps).flatMap(([taskId, list]) => list.map((d) => ({ taskId, dependsOn: d.dependsOn })));
    return layoutDag(tasks, deps);
  };
  // Todo 34 (§7: DAG paginado con 100 nodos, apertura <1 s): diferido por conteo.
  const cappedNodes = () => capList("dag-nodes", layout().nodes, DAG_NODE_WINDOW);
  const visibleIds = () => new Set(cappedNodes().visible.map((n) => n.id));
  const visibleEdges = () => layout().edges.filter((e) => visibleIds().has(e.from) && visibleIds().has(e.to));
  const width = () => Math.max(...layout().nodes.map((n) => n.x), 88) + 112;
  const height = () => Math.max(...layout().nodes.map((n) => n.y), 32) + 48;
  return (
    <details class="stage2" id="integration-dag" open>
      <summary>
        Dependency graph ({layout().nodes.length} tasks, {layout().edges.length} dependencies)
      </summary>
      <Show when={layout().cycle} fallback={<p class="muted">Acyclic: every edge points from a dependency to its dependent.</p>}>
        <p class="banner err" role="alert">
          Dependency cycle: <code>{(layout().cycle ?? []).join(" → ")}</code>
        </p>
      </Show>
      <Show when={layout().nodes.length > 0} fallback={<p class="muted">No tasks yet. The coordinator decomposes approved revisions into a task DAG.</p>}>
        <Show when={cappedNodes().over}>
          <p class="muted" data-deferred-panel="dag-nodes">
            Ventana del DOM: {cappedNodes().visible.length} de {layout().nodes.length} nodos ({cappedNodes().deferred} diferidos por presupuesto).
          </p>
        </Show>
        <svg id="dag-svg" width={width()} height={height()} role="img" aria-label="Task dependency graph">
          <For each={visibleEdges()}>
            {(edge) => {
              const from = () => layout().nodes.find((n) => n.id === edge.from)!;
              const to = () => layout().nodes.find((n) => n.id === edge.to)!;
              return <line x1={from().x + 80} y1={from().y} x2={to().x - 80} y2={to().y} stroke="var(--oc-text-faint)" stroke-width="1.5" data-dag-edge={`${edge.from}->${edge.to}`} />;
            }}
          </For>
          <For each={cappedNodes().visible}>
            {(node) => (
              <g data-dag-node={node.id}>
                <rect x={node.x - 80} y={node.y - 20} width="160" height="40" rx="6" fill="var(--oc-panel)" stroke={nodeStroke(node.status)} stroke-width="1.5" />
                <text x={node.x} y={node.y - 2} text-anchor="middle" font-size="12" fill="var(--oc-text)">
                  {node.title.slice(0, 22)}
                </text>
                <text x={node.x} y={node.y + 12} text-anchor="middle" font-size="12" fill="var(--oc-text-muted)">
                  {node.id.slice(0, 14)} · {node.status}
                </text>
              </g>
            )}
          </For>
        </svg>
        <ul class="muted">
          <For each={visibleEdges()}>{(edge) => <li data-dag-dep={`${edge.from}->${edge.to}`}><code>{edge.to}</code> depends on <code>{edge.from}</code></li>}</For>
        </ul>
      </Show>
      <Show when={state.integrationConflicts.length > 0 || visibleConflicts(state.integrationConflicts).length > 0}>
        <p class="muted" id="conflict-list">
          {visibleConflicts(state.integrationConflicts).length} conflict(s) in assisted resolution:{" "}
          {visibleConflicts(state.integrationConflicts).map((c) => `${c.id.slice(0, 8)}[${c.status}]`).join(", ")}
        </p>
      </Show>
      <Show when={visibleConflicts(state.integrationConflicts).length === 0}>
        <p class="muted" id="conflict-list">No conflicts in assisted resolution.</p>
      </Show>
      <Show when={Object.values(state.previews).flat().some((p) => isPreviewReachable(p))}>
        <p class="muted" id="preview-status">
          Reachable preview(s):{" "}
          {Object.values(state.previews).flat().filter((p) => isPreviewReachable(p)).map((p) => `${p.id.slice(0, 8)}@${p.url}`).join(", ")}
        </p>
      </Show>
      <Show when={!Object.values(state.previews).flat().some((p) => isPreviewReachable(p))}>
        <p class="muted" id="preview-status">No reachable preview.</p>
      </Show>
    </details>
  );
}

interface DiffState {
  loading: boolean;
  diff?: string;
  head?: string;
  branch?: string;
  error?: string;
}

/** Diff acotado del worktree vía el canal N-A-DIFF-1 (solo lectura). */
export function WorktreeDiffSection() {
  const [selected, setSelected] = createSignal<string | undefined>(undefined);
  const [diffs, setDiffs] = createSignal<Record<string, DiffState>>({});
  const load = async (worktreeId: string) => {
    setSelected(worktreeId);
    setDiffs((prev) => ({ ...prev, [worktreeId]: { loading: true } }));
    try {
      const result = await invoke("worktrees.diff", { worktreeId });
      if (result.ok) {
        setError(undefined);
        setDiffs((prev) => ({ ...prev, [worktreeId]: { loading: false, diff: result.diff, head: result.head, branch: result.branch } }));
      } else {
        setDiffs((prev) => ({ ...prev, [worktreeId]: { loading: false, error: result.error } }));
      }
    } catch (error) {
      setDiffs((prev) => ({ ...prev, [worktreeId]: { loading: false, error: error instanceof Error ? error.message : String(error) } }));
    }
  };
  const current = () => (selected() ? diffs()[selected()!] : undefined);
  return (
    <details class="stage2" id="worktree-diff" open>
      <summary>Worktree diff ({state.worktrees.length} worktrees)</summary>
      <Show when={state.worktrees.length > 0} fallback={<p class="muted">No worktrees yet. Implementer tasks provision one automatically.</p>}>
        <div class="row">
          <For each={state.worktrees}>
            {(wt) => (
              <button type="button" class={selected() === wt.id ? "active" : ""} data-diff-worktree={wt.id} onClick={() => void load(wt.id)}>
                {wt.branchName}
              </button>
            )}
          </For>
        </div>
        <Show when={current()?.loading}>
          <p class="muted">Loading diff…</p>
        </Show>
        <Show when={current()?.error}>
          <p class="banner err" role="alert">{current()!.error}</p>
        </Show>
        <Show when={current()?.diff !== undefined}>
          <p class="muted">
            head <code>{(current()!.head ?? "?").slice(0, 12)}</code> · branch <code>{current()!.branch ?? "?"}</code> · {parseDiffStat(current()!.diff ?? "").length} file(s)
          </p>
          <ul class="muted">
            <For each={parseDiffStat(current()!.diff ?? "")}>{(f) => <li data-diff-file={f.file}><code>{f.file}</code> · {f.changes} change(s)</li>}</For>
          </ul>
          <pre data-diff-stat>{(current()!.diff ?? "").slice(0, 60000)}</pre>
        </Show>
      </Show>
    </details>
  );
}

/** Historial de ejecución por integración (operaciones del journal, ordenadas). */
export function IntegrationHistorySection() {
  const opsOf = (integrationId: string): IntegrationOperation[] =>
    [...(state.integrationOps[integrationId] ?? [])].sort((a, b) => a.createdAt - b.createdAt);
  return (
    <details class="stage2" id="integration-history" open>
      <summary>Execution history ({state.integrations.length} integrations)</summary>
      <Show when={state.integrations.length > 0} fallback={<p class="muted">No integrations yet. Reviewed writer tasks auto-integrate into an intermediate branch.</p>}>
        <For each={state.integrations}>
          {(integration) => (
            <div class="card">
              <div class="row">
                <code>{integration.integrationBranch}</code>
                <span class="muted">attempt {integration.attempt}</span>
              </div>
              <Show when={opsOf(integration.id).length > 0} fallback={<p class="muted">No operations recorded for this integration.</p>}>
                <ol>
                  <For each={opsOf(integration.id)}>
                    {(op) => (
                      <li data-history-op={`${integration.id}:${op.op}`}>
                        <code>{op.op}</code> <span class={`pill ${op.status === "done" ? "ok" : op.status === "failed" ? "err" : "warn"}`}>{op.status}</span>
                        <Show when={op.step}> · {op.step}</Show>
                        <Show when={op.detail}> · <span class="muted">{(op.detail as string).slice(0, 160)}</span></Show>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </details>
  );
}
