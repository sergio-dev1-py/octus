/** Renderer/views — vista de agentes, tareas, runs y worktrees (Todo 16, W-A1 a W-A5).
 * Reutiliza servicios existentes: agents.*, tasks.* (+ task-graph vía tasks.get),
 * runs.get/sessions.get y worktrees.*. Sin agentes ficticios ni progreso inventado:
 * cada lista tiene su vacío honesto y un run cancelado muestra su estado final real.
 * Diff, previews, conflictos y promoción pertenecen al Todo 17: aquí no se tocan. */
import { For, Show } from "solid-js";
import type { Task } from "@octus/shared";
import {
  cancelAgent,
  cancelTask,
  cleanupWorktree,
  reloadWorktrees,
  retryTask,
  reviewTask,
  selectRun,
  state,
} from "../store.js";
import { DAG_NODE_WINDOW, capList } from "../perf.js";

export interface DagEdge {
  from: string;
  to: string;
}

export interface DagLayout {
  edges: DagEdge[];
  /** Camino explícito del ciclo, o null si el grafo es acíclico. */
  cycle: string[] | null;
  /** Profundidad topológica por tarea (columna de la vista). */
  depth: Record<string, number>;
}

/** Adyacencia tarea -> dependencias (misma semántica que task-graph.adjacency del core). */
export function dagAdjacency(tasks: Pick<Task, "id">[], deps: Record<string, Array<{ dependsOn: string }>>): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const t of tasks) adj.set(t.id, []);
  for (const t of tasks) {
    const list = deps[t.id] ?? [];
    for (const d of list) {
      if (adj.has(d.dependsOn)) adj.get(t.id)?.push(d.dependsOn);
    }
  }
  return adj;
}

/** Ciclo con camino explícito, o null (misma semántica que task-graph.detectCycle). */
export function dagDetectCycle(tasks: Pick<Task, "id">[], deps: Record<string, Array<{ dependsOn: string }>>): string[] | null {
  const adj = dagAdjacency(tasks, deps);
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
  for (const t of tasks) {
    if ((color.get(t.id) ?? 0) === 0) {
      const found = visit(t.id);
      if (found) return found;
    }
  }
  return null;
}

export function dagLayout(tasks: Pick<Task, "id">[], deps: Record<string, Array<{ dependsOn: string }>>): DagLayout {
  const adj = dagAdjacency(tasks, deps);
  const edges: DagEdge[] = [];
  for (const [to, froms] of adj) for (const from of froms) edges.push({ from, to });
  const cycle = dagDetectCycle(tasks, deps);
  const depth: Record<string, number> = {};
  const compute = (id: string, visiting: string[] = []): number => {
    if (depth[id] !== undefined) return depth[id]!;
    if (visiting.includes(id)) return 0;
    const ds = adj.get(id) ?? [];
    const d = ds.length === 0 ? 0 : 1 + Math.max(...ds.map((n) => compute(n, [...visiting, id])));
    depth[id] = d;
    return d;
  };
  for (const t of tasks) compute(t.id);
  return { edges, cycle, depth };
}

function pillClass(status: string): string {
  if (["completed", "reviewed", "integrated", "done", "finished", "retained", "available"].includes(status)) return "ok";
  if (["failed", "rejected", "orphaned"].includes(status)) return "err";
  if (["removed", "cancelled", "interrupted"].includes(status)) return "muted";
  return "warn";
}

export function AgentDefinitionsSection() {
  // Todo 34: diferido por conteo.
  const cappedInstances = () => capList("agent-cards", state.agentInstances);
  return (
    <section aria-label="Definiciones de agentes">
      <h2>Agentes ({state.agentInstances.length} instancias / {state.definitions.length} definiciones)</h2>
      <p class="muted">
        Límites: {state.agentLimits.maxPerSession} por sesión · {state.agentLimits.maxPerProject} por proyecto · profundidad {state.agentLimits.maxDepth}
      </p>
      <Show when={state.definitions.length === 0}>
        <p class="muted">Sin definiciones registradas.</p>
      </Show>
      <For each={state.definitions}>
        {(definition) => (
          <div class="card">
            <div class="row">
              <strong>{definition.name}</strong>
              <span class="pill">{definition.kind}</span>
              <span class="muted">
                {definition.defaultModel.providerId}/{definition.defaultModel.modelId}
              </span>
            </div>
            <p class="muted">
              <code>{definition.id}</code> · pasos {definition.maxSteps} · herramientas {definition.tools.length}
              <Show when={definition.deniedTools.length > 0}> · denegadas {definition.deniedTools.length}</Show>
            </p>
          </div>
        )}
      </For>
      <Show when={state.agentInstances.length === 0}>
        <p class="muted">Sin agentes en esta sesión. El coordinador los crea al ejecutar un run.</p>
      </Show>
      <Show when={cappedInstances().over}>
        <p class="muted" data-deferred-panel="agent-cards">
          Ventana del DOM: {cappedInstances().visible.length} de {state.agentInstances.length} ({cappedInstances().deferred} diferidos por presupuesto).
        </p>
      </Show>
      <For each={cappedInstances().visible}>
        {(instance) => (
          <div class="card">
            <div class="row">
              <code>{instance.definitionId}</code>
              <span class={`pill ${pillClass(instance.status)}`}>{instance.status}</span>
              <Show when={state.definitions.find((d) => d.id === instance.definitionId)}>
                {(def) => (
                  <span class={`pill ${def().kind === "coordinator" ? "warn" : "ok"}`}>
                    {def().kind === "coordinator" ? "coordinador" : "subagente"}
                  </span>
                )}
              </Show>
              <code class="muted">{instance.id}</code>
            </div>
            <p class="muted">
              run <code>{instance.runId}</code>
              <Show when={instance.taskId}> · tarea <code>{instance.taskId}</code></Show>
              <Show when={instance.worktreeId}> · worktree <code>{instance.worktreeId}</code></Show>
              <Show when={instance.parentInstanceId}> · padre {instance.parentInstanceId}</Show>
              <Show when={instance.error}> · error: {instance.error}</Show>
            </p>
            <Show when={["created", "running", "waiting_permission", "waiting_input"].includes(instance.status)}>
              <button class="danger" onClick={() => void cancelAgent(instance.id)}>
                Cancelar
              </button>
            </Show>
          </div>
        )}
      </For>
    </section>
  );
}

export function AgentTasksSection() {
  // Todo 34 (§7: Agent Manager con 100 tareas en <1 s): diferido por conteo.
  const capped = () => capList("agent-tasks", state.tasks);
  return (
    <section aria-label="Tareas del DAG">
      <h2>Tareas ({state.tasks.length})</h2>
      <Show when={state.tasks.length === 0}>
        <p class="muted">Sin tareas. El coordinador descompone las revisiones aprobadas en un DAG de tareas.</p>
      </Show>
      <Show when={capped().over}>
        <p class="muted" data-deferred-panel="agent-tasks">
          Ventana del DOM: {capped().visible.length} de {state.tasks.length} ({capped().deferred} diferidos por presupuesto).
        </p>
      </Show>
      <For each={capped().visible}>
        {(task) => (
          <div class="card" data-task-id={task.id}>
            <div class="row">
              <strong>{task.title}</strong>
              <span class={`pill ${pillClass(task.status)}`}>{task.status}</span>
              <span class="pill">{task.agentRole}</span>
              <span class="muted">intento {task.attempt}</span>
            </div>
            <p class="muted">
              <code>{task.id}</code> · run <code>{task.runId}</code>
              <Show when={task.needsReview}> · requiere revisión</Show>
            </p>
            <Show when={(state.taskDeps[task.id] ?? []).length > 0}>
              <p class="muted">depende de: {(state.taskDeps[task.id] ?? []).map((d) => d.dependsOn).join(", ")}</p>
            </Show>
            <Show when={task.status === "blocked"}>
              <p class="muted">
                bloqueada: {task.blockedReason}{" "}
                <Show when={task.blockedDetails}>· {JSON.stringify(task.blockedDetails).slice(0, 200)}</Show>
              </p>
            </Show>
            <Show when={task.error}>
              <p class="muted">error: {task.error}</p>
            </Show>
            <div class="row">
              <Show when={!["completed", "reviewed", "integrated", "cancelled", "failed"].includes(task.status)}>
                <button class="danger" onClick={() => void cancelTask(task.id)}>
                  Cancelar
                </button>
              </Show>
              <Show when={task.status === "failed" || task.status === "interrupted"}>
                <button class="primary" onClick={() => void retryTask(task.id)}>
                  Reintentar
                </button>
              </Show>
              <Show when={task.agentRole === "reviewer" && task.status === "completed" && task.reviewTargetTaskId}>
                <button class="primary" onClick={() => void reviewTask(task.id, task.reviewTargetTaskId!, "accept")}>
                  Aceptar objetivo
                </button>
                <button class="danger" onClick={() => void reviewTask(task.id, task.reviewTargetTaskId!, "request-changes")}>
                  Pedir cambios
                </button>
              </Show>
            </div>
          </div>
        )}
      </For>
    </section>
  );
}

export function AgentDagSection() {
  const layout = () => dagLayout(state.tasks, state.taskDeps);
  // Todo 34 (§7: DAG paginado con 100 nodos): el ciclo se detecta sobre el
  // grafo completo, pero el DOM pinta como máximo DAG_NODE_WINDOW nodos.
  const capped = () => capList("agent-dag", state.tasks, DAG_NODE_WINDOW);
  const columns = () => {
    const byDepth = new Map<number, Task[]>();
    for (const task of capped().visible) {
      const d = layout().depth[task.id] ?? 0;
      const list = byDepth.get(d) ?? [];
      list.push(task);
      byDepth.set(d, list);
    }
    return [...byDepth.entries()].sort((a, b) => a[0] - b[0]);
  };
  return (
    <section aria-label="Grafo de dependencias">
      <h2>Dependencias</h2>
      <div id="agent-dag" role="group" aria-label="Grafo de dependencias de tareas">
        <Show when={state.tasks.length === 0}>
          <p class="muted">Sin nodos: crea un run para generar el DAG.</p>
        </Show>
        <Show when={capped().over}>
          <p class="muted" data-deferred-panel="agent-dag">
            Ventana del DOM: {capped().visible.length} de {state.tasks.length} nodos ({capped().deferred} diferidos por presupuesto).
          </p>
        </Show>
        <Show when={layout().cycle}>
          <p class="banner err" role="alert">
            Ciclo en el DAG: {layout().cycle!.join(" → ")}. Revisa las dependencias antes de continuar.
          </p>
        </Show>
        <Show when={state.tasks.length > 0 && !layout().cycle}>
          <div class="dag-columns">
            <For each={columns()}>
              {([depth, nodes]) => (
                <div class="dag-column" data-dag-depth={depth}>
                  <For each={nodes}>
                    {(node) => (
                      <div class={`dag-node ${pillClass(node.status)}`} data-dag-node={node.id} title={`${node.title} [${node.status}]`}>
                        <code>{node.id}</code>
                        <span>{node.title}</span>
                        <span class={`pill ${pillClass(node.status)}`}>{node.status}</span>
                        <Show when={(state.taskDeps[node.id] ?? []).length > 0}>
                          <span class="muted">← {(state.taskDeps[node.id] ?? []).map((d) => d.dependsOn).join(", ")}</span>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </section>
  );
}

export function AgentRunsSection() {
  const detail = () => state.runDetail;
  return (
    <section aria-label="Runs de la sesión">
      <h2>Runs ({state.runs.length})</h2>
      <Show when={state.runs.length === 0}>
        <p class="muted">Sin runs en esta sesión. Envía un prompt para iniciar el primero.</p>
      </Show>
      <div class="row" role="listbox" aria-label="Runs">
        <For each={state.runs}>
          {(run) => (
            <button
              type="button"
              role="option"
              aria-selected={run.id === (state.selectedRunId ?? state.runDetail?.run.id)}
              data-run-id={run.id}
              class={run.id === (state.selectedRunId ?? state.runDetail?.run.id) ? "active" : ""}
              onClick={() => void selectRun(run.id)}
            >
              <code>{run.id}</code> <span class={`pill ${pillClass(run.status)}`}>{run.status}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={detail()}>
        <div class="card" id="run-detail">
          <div class="row">
            <strong>Run {detail()!.run.id}</strong>
            <span class={`pill ${pillClass(detail()!.run.status)}`} data-run-status={detail()!.run.status}>
              {detail()!.run.status}
            </span>
            <span class="muted">[{detail()!.run.mode}]</span>
          </div>
          <p class="muted">{detail()!.run.prompt}</p>
          <Show when={detail()!.run.status === "cancelled"}>
            <p class="muted" data-run-final="cancelled">
              Run cancelado: estado final real, sin progreso pendiente.
              <Show when={detail()!.run.error}> Motivo: {detail()!.run.error}</Show>
              <Show when={detail()!.run.completedAt}> Fin: {new Date(detail()!.run.completedAt!).toLocaleString()}</Show>
            </p>
          </Show>
          <Show when={detail()!.run.error && detail()!.run.status !== "cancelled"}>
            <p class="muted">error: {detail()!.run.error}</p>
          </Show>
          <p class="muted">
            {detail()!.instances.length} instancias · {detail()!.toolCalls.length} tool calls
          </p>
          <Show when={detail()!.toolCalls.length > 0}>
            <details>
              <summary>Tool calls ({detail()!.toolCalls.length})</summary>
              <ul>
                <For each={detail()!.toolCalls}>
                  {(tc) => (
                    <li>
                      <code>{tc.name}</code> <span class={`pill ${pillClass(tc.status)}`}>{tc.status}</span>
                      <Show when={tc.error}> · {tc.error}</Show>
                    </li>
                  )}
                </For>
              </ul>
            </details>
          </Show>
        </div>
      </Show>
    </section>
  );
}

export function AgentWorktreesSection() {
  const runOf = (runId: string) => state.runs.find((r) => r.id === runId);
  const taskOf = (taskId: string) => state.tasks.find((t) => t.id === taskId);
  return (
    <section aria-label="Worktrees con su run">
      <h2>Worktrees ({state.worktrees.length})</h2>
      <Show when={state.worktrees.length === 0}>
        <p class="muted">Sin worktrees. Las tareas de implementación aprovisionan uno automáticamente.</p>
      </Show>
      <For each={state.worktrees}>
        {(wt) => (
          <div class="card" data-worktree-id={wt.id}>
            <div class="row">
              <code>{wt.branchName}</code>
              <span class={`pill ${pillClass(wt.status)}`}>{wt.status}</span>
              <span class="muted">intento {wt.attempt}</span>
            </div>
            <p class="muted">
              <code>{wt.canonicalPath}</code>
            </p>
            <p class="muted">
              base <code>{wt.baseCommit.slice(0, 12)}</code> ({wt.baseSource})
              <Show when={wt.producedCommit != null}>
                {" "}→ producido <code>{(wt.producedCommit as string).slice(0, 12)}</code>
              </Show>
            </p>
            <p class="muted" data-worktree-run={wt.runId}>
              run <code>{wt.runId}</code>{" "}
              <Show when={runOf(wt.runId)} fallback={<span class="pill muted">run no cargado</span>}>
                <span class={`pill ${pillClass(runOf(wt.runId)!.status)}`}>{runOf(wt.runId)!.status}</span>
              </Show>{" "}
              · tarea <code>{wt.taskId}</code>{" "}
              <Show when={taskOf(wt.taskId)} fallback={<span class="pill muted">tarea no cargada</span>}>
                <span class={`pill ${pillClass(taskOf(wt.taskId)!.status)}`}>{taskOf(wt.taskId)!.status}</span>
              </Show>
            </p>
            <Show when={wt.error}>
              <p class="muted">error: {wt.error}</p>
            </Show>
            <Show when={(state.worktreeOps[wt.id] ?? []).length > 0}>
              <details>
                <summary>Operaciones ({(state.worktreeOps[wt.id] ?? []).length})</summary>
                <ul>
                  <For each={state.worktreeOps[wt.id] ?? []}>
                    {(op) => (
                      <li>
                        <code>{op.op}</code> {op.status}
                        <Show when={op.step}> · {op.step}</Show>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <div class="row">
              <Show when={["finished", "available", "suspended", "orphaned", "retained"].includes(wt.status)}>
                <button class="danger" onClick={() => void cleanupWorktree(wt.id)}>
                  Limpiar
                </button>
              </Show>
              <button onClick={() => void reloadWorktrees()}>Actualizar</button>
            </div>
          </div>
        )}
      </For>
    </section>
  );
}

/** Vista completa del Agent Manager (Todo 16): agentes, tareas, DAG, runs y worktrees. */
export function AgentsView() {
  return (
    <main class="agents" id="agents-view" aria-label="Agentes">
      <header>
        <button type="button" onClick={() => void import("../store.js").then((m) => m.setLayoutActivity("chat"))}>
          ← Volver al chat
        </button>
        <h2>Agentes</h2>
        <Show when={!state.activeSessionId}>
          <p class="muted">Crea o elige una sesión para ver sus agentes, tareas, runs y worktrees.</p>
        </Show>
      </header>
      <AgentDefinitionsSection />
      <AgentTasksSection />
      <AgentDagSection />
      <AgentRunsSection />
      <AgentWorktreesSection />
    </main>
  );
}
