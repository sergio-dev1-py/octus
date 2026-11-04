/** Renderer/views — secciones de datos del workbench: proveedores, planes, tareas, worktrees, integraciones, memoria y agentes. */
import { For, Show, createSignal } from "solid-js";
import { invoke } from "../api.js";
import { renderMarkdown } from "../markdown.js";
import { INTEGRATION_CARD_WINDOW, capList } from "../perf.js";
import { orderedApprovals, revisionGate } from "../toolcall-widgets.jsx";
import {
  abortConflict,
  abortIntegration,
  approveIntegration,
  approveRevision,
  archivePlan,
  cancelAgent,
  cancelTask,
  cleanupConflictResolution,
  cleanupPreview,
  cleanupWorktree,
  createPreview,
  decideApproval,
  decideMemory,
  exportRevision,
  finalizeConflictResolution,
  implementRevision,
  incorporateConflictResolution,
  incorporateIntegration,
  inspectPreview,
  loadPreviewLogs,
  proposeMemory,
  promoteIntegration,
  revalidateMemory,
  rebuildIntegration,
  recoverRunIntegration,
  rejectIntegration,
  rejectRevision,
  reloadIntegrations,
  reloadProviders,
  reloadProviderModels,
  reloadWorktrees,
  requestConflictResolution,
  resolveMemoryConflict,
  retryTask,
  reviewTask,
  rerunValidations,
  recordIntegrationReview,
  reconcileRecovery,
  reloadMemory,
  setError,
  setState,
  spawnIntegrationReviewer,
  startPreview,
  state,
  stopPreview,
  validateMemory,
} from "../store.js";

export function ProviderSettings() {
  // Activos (con key: punto verde, sin formulario de carga) y Disponibles
  // (sin key: punto rojo + cargar key). El catálogo se actualiza solo al
  // arrancar y al guardar cada key.
  const keys: Record<string, HTMLInputElement | undefined> = {};
  const [notice, setNotice] = createSignal<string | undefined>(undefined);
  const active = () => state.providers.filter((p) => p.configured);
  const available = () => state.providers.filter((p) => !p.configured);
  const dot = (on: boolean): string =>
    on
      ? "display:inline-block;flex-shrink:0;width:10px;height:10px;border-radius:9999px;background:var(--oc-success);"
      : "display:inline-block;flex-shrink:0;width:10px;height:10px;border-radius:9999px;background:var(--oc-danger);";
  const afterKeyChange = async (providerId: string) => {
    const result = await invoke("providers.refreshCatalog", { providerId });
    await reloadProviders();
    const count = await reloadProviderModels(providerId);
    setNotice(
      result.ok
        ? `${count ?? result.count ?? 0} modelos disponibles`
        : (result.error ?? "No se pudo traer el catálogo"),
    );
  };
  const removeKey = async (providerId: string) => {
    await invoke("providers.removeKey", { providerId });
    const next = { ...state.modelsByProvider };
    delete next[providerId];
    setState("modelsByProvider", next);
    await reloadProviders();
  };
  const modelsOf = (providerId: string) =>
    state.modelsByProvider[providerId] ?? state.providers.find((p) => p.id === providerId)?.models ?? [];
  return (
    <section>
      <h2>Proveedores</h2>
      <Show when={notice()}>
        <p class="muted" role="status">{notice()}</p>
      </Show>
      <h3>Activos</h3>
      <Show when={active().length > 0} fallback={<p class="muted">Sin proveedores activos. Carga una API abajo.</p>}>
        <For each={active()}>
          {(provider) => (
            <div class="card">
              <h3>
                <span aria-hidden="true" style={dot(true)} title="Activo" /> {provider.displayName}
              </h3>
              <p class="muted">
                {provider.keyOrigin === "env" ? "Key desde variable de entorno" : "Key guardada en este equipo"}
              </p>
              <Show when={provider.keyOrigin !== "env"}>
                <div class="row">
                  <button type="button" class="danger" title="Quitar la key (pasa a Disponibles)" onClick={() => void removeKey(provider.id)}>
                    Quitar key
                  </button>
                </div>
              </Show>
              <details>
                <summary>Models ({modelsOf(provider.id).length})</summary>
                <ul>
                  <For each={modelsOf(provider.id)}>
                    {(model) => (
                      <li>
                        <code>{model.modelId}</code> — ctx {model.capabilities.maxContextTokens.toLocaleString()}, efforts:{" "}
                        {model.capabilities.reasoningEfforts.join(", ") || "—"}
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </div>
          )}
        </For>
      </Show>
      <h3>Disponibles</h3>
      <Show when={available().length > 0} fallback={<p class="muted">Todos los proveedores están activos.</p>}>
        <For each={available()}>
          {(provider) => (
            <div class="card">
              <h3>
                <span aria-hidden="true" style={dot(false)} title="Sin key" /> {provider.displayName}
              </h3>
              <div class="row oc-provider-actions">
                <input ref={(el) => (keys[provider.id] = el)} type="password" placeholder="Paste API key" autocomplete="off" />
                <button
                  class="primary"
                  onClick={() => {
                    const value = keys[provider.id]?.value ?? "";
                    if (!value.trim()) return;
                    void (async () => {
                      const result = await invoke("providers.setKey", { providerId: provider.id, apiKey: value });
                      if (!result.ok) setError(result.error ?? "Could not save key");
                      if (keys[provider.id]) keys[provider.id]!.value = "";
                      await reloadProviders();
                      await afterKeyChange(provider.id);
                    })();
                  }}
                >
                  Save key
                </button>
                <button
                  onClick={() => {
                    void (async () => {
                      const result = await invoke("providers.test", { providerId: provider.id });
                      setError(result.ok ? undefined : (result.error ?? "Connection failed"));
                      if (result.ok) setError("Connection OK" as never);
                    })();
                  }}
                >
                  Test
                </button>
              </div>
              <details>
                <summary>Models ({modelsOf(provider.id).length})</summary>
                <ul>
                  <For each={modelsOf(provider.id)}>
                    {(model) => (
                      <li>
                        <code>{model.modelId}</code> — ctx {model.capabilities.maxContextTokens.toLocaleString()}, efforts:{" "}
                        {model.capabilities.reasoningEfforts.join(", ") || "—"}
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </div>
          )}
        </For>
      </Show>
    </section>
  );
}

export function PlansSection() {
  return (
    <details class="stage2">
      <summary>
        Plans ({state.plans.length}) — Approvals pending ({state.approvals.length})
      </summary>
      <Show when={state.approvals.length > 0}>
        <div class="card warn">
          <h3>Pending approvals (only you can decide)</h3>
          <For each={orderedApprovals()}>
            {(request) => {
              const gate = () => revisionGate(request.planId, request.revisionId);
              return (
                <div class="row" data-approval-request={request.id} data-approval-status={request.status}>
                  <code>
                    {request.planId} · {request.revisionId}
                  </code>
                  <span class="muted" data-approval-gate>
                    {gate().decidable ? "Solo tú puedes decidir (ningún modelo aprueba)" : gate().reason}
                  </span>
                  <button class="primary" disabled={!gate().decidable} title={gate().reason} onClick={() => void decideApproval(request.id, "approved")}>
                    Approve
                  </button>
                  <button class="danger" disabled={!gate().decidable} title={gate().reason} onClick={() => void decideApproval(request.id, "rejected")}>
                    Reject
                  </button>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
      <Show when={state.plans.length === 0}>
        <p class="muted">No plans in this session yet. Ask in plan profile to create one.</p>
      </Show>
      <For each={state.plans}>
        {(plan) => (
          <div class="card">
            <h3>
              {plan.objective} <span class="muted">[{plan.status}]</span>
            </h3>
            <p class="muted">
              <code>{plan.id}</code> current={plan.currentRevisionId ?? "—"} approved={plan.approvedRevisionId ?? "none"}
            </p>
            <For each={state.planRevisions[plan.id] ?? []}>
              {(revision) => (
                <div class="revision">
                  <div class="row">
                    <strong>v{revision.version}</strong>
                    <span class="pill">{revision.lifecycle}</span>
                    <span class={`pill ${revision.approval === "approved" ? "ok" : revision.approval === "rejected" ? "err" : "warn"}`}>{revision.approval}</span>
                    <code class="muted">{revision.id}</code>
                  </div>
                  <details>
                    <summary>Content</summary>
                    <div class="md" innerHTML={renderMarkdown(revision.contentMarkdown.slice(0, 8000))} />
                  </details>
                  <div class="row">
                    <Show when={revisionGate(plan.id, revision.id).decidable}>
                      <button class="primary" onClick={() => void approveRevision(plan.id, revision.id)}>
                        Approve v{revision.version}
                      </button>
                      <button class="danger" onClick={() => void rejectRevision(plan.id, revision.id)}>
                        Reject
                      </button>
                    </Show>
                    <Show when={state.approvals.some((entry) => entry.revisionId === revision.id && entry.status === "pending")}>
                      <span class="muted" data-approval-pending={revision.id}>
                        Awaiting your decision — ningún modelo puede aprobar.
                      </span>
                    </Show>
                    <Show when={plan.approvedRevisionId === revision.id}>
                      <button onClick={() => void implementRevision(plan.id, revision.id)}>Implement this approved revision</button>
                    </Show>
                    <button onClick={() => void exportRevision(plan.id, revision.id, revision.version)}>Export</button>
                  </div>
                </div>
              )}
            </For>
            <div class="row">
              <Show when={plan.status === "active"}>
                <button onClick={() => void archivePlan(plan.id)}>Archive plan</button>
              </Show>
            </div>
          </div>
        )}
      </For>
    </details>
  );
}

export function TasksSection() {
  const active = () => state.tasks.filter((t) => ["ready", "assigned", "running", "blocked"].includes(t.status));
  // Todo 34 (§7: Agent Manager con 100 tareas en <1 s): diferido por conteo.
  const capped = () => capList("task-cards", state.tasks);
  return (
    <details class="stage2">
      <summary>
        Tasks ({active().length} active / {state.tasks.length} total)
      </summary>
      <Show when={state.tasks.length === 0}>
        <p class="muted">No tasks yet. The coordinator decomposes approved revisions into a task DAG.</p>
      </Show>
      <Show when={capped().over}>
        <p class="muted" data-deferred-panel="task-cards">
          Ventana del DOM: {capped().visible.length} de {state.tasks.length} ({capped().deferred} diferidos por presupuesto).
        </p>
      </Show>
      <For each={capped().visible}>
        {(task) => (
          <div class="card">
            <div class="row">
              <strong>{task.title}</strong>
              <span class={`pill ${task.status === "completed" || task.status === "reviewed" ? "ok" : task.status === "failed" ? "err" : "warn"}`}>{task.status}</span>
              <span class="pill">{task.agentRole}</span>
              <span class="muted">attempt {task.attempt}</span>
            </div>
            <p class="muted">
              <code>{task.id}</code> · run <code>{task.runId}</code>
            </p>
            <Show when={(state.taskDeps[task.id] ?? []).length > 0}>
              <p class="muted">depends on: {(state.taskDeps[task.id] ?? []).map((d) => d.dependsOn).join(", ")}</p>
            </Show>
            <Show when={task.status === "blocked"}>
              <p class="muted">
                blocked: {task.blockedReason} <Show when={task.blockedDetails}>· {JSON.stringify(task.blockedDetails).slice(0, 200)}</Show>
              </p>
            </Show>
            <Show when={task.error}>
              <p class="muted">error: {task.error}</p>
            </Show>
            <Show when={(state.taskAttempts[task.id] ?? []).length > 0}>
              <details>
                <summary>Attempts ({(state.taskAttempts[task.id] ?? []).length})</summary>
                <ul>
                  <For each={state.taskAttempts[task.id] ?? []}>
                    {(attempt) => (
                      <li>
                        <code>#{attempt.attempt}</code> {attempt.status}
                        <Show when={attempt.instanceId}> · instance {attempt.instanceId}</Show>
                        <Show when={attempt.errorMessage}> · {attempt.errorMessage}</Show>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <div class="row">
              <Show when={!["completed", "reviewed", "cancelled", "failed"].includes(task.status)}>
                <button class="danger" onClick={() => void cancelTask(task.id)}>
                  Cancel
                </button>
              </Show>
              <Show when={task.status === "failed" || task.status === "interrupted"}>
                <button class="primary" onClick={() => void retryTask(task.id)}>
                  Retry
                </button>
              </Show>
              <Show when={task.agentRole === "reviewer" && task.status === "completed" && task.reviewTargetTaskId}>
                <button class="primary" onClick={() => void reviewTask(task.id, task.reviewTargetTaskId!, "accept")}>
                  Accept target
                </button>
                <button class="danger" onClick={() => void reviewTask(task.id, task.reviewTargetTaskId!, "request-changes")}>
                  Request changes
                </button>
              </Show>
            </div>
          </div>
        )}
      </For>
    </details>
  );
}

export function WorktreesSection() {
  const active = () => state.worktrees.filter((w) => ["provisioning", "assigned", "running", "suspended", "cleanup_pending"].includes(w.status));
  const repo = () => state.repoSummary;
  return (
    <details class="stage2">
      <summary>
        Worktrees ({active().length} active / {state.worktrees.length} total)
      </summary>
      <Show when={repo() && !repo()!.isGit}>
        <p class="muted">Project is not inside a git repository: writers use registered isolated directories (legacy path).</p>
      </Show>
      <Show when={repo() && repo()!.isGit}>
        <p class="muted">
          repo <code>{repo()!.rootPath}</code> · branch <code>{repo()!.branch}</code> · {repo()!.status}
          <Show when={(repo()!.staged + repo()!.unstaged + repo()!.untracked) > 0}>
            {" "}· local changes staged:{repo()!.staged} unstaged:{repo()!.unstaged} untracked:{repo()!.untracked} (excluded from new worktrees)
          </Show>
        </p>
      </Show>
      <Show when={state.worktrees.length === 0}>
        <p class="muted">No worktrees yet. Implementer tasks provision one automatically.</p>
      </Show>
      <For each={state.worktrees}>
        {(wt) => (
          <div class="card">
            <div class="row">
              <code>{wt.branchName}</code>
              <span class={`pill ${wt.status === "removed" ? "muted" : wt.status === "orphaned" ? "err" : wt.status === "finished" || wt.status === "retained" ? "ok" : "warn"}`}>{wt.status}</span>
              <span class="muted">attempt {wt.attempt}</span>
            </div>
            <p class="muted">
              <code>{wt.canonicalPath}</code>
            </p>
            <p class="muted">
              base <code>{wt.baseCommit.slice(0, 12)}</code> ({wt.baseSource})
              <Show when={wt.producedCommit != null}> → produced <code>{(wt.producedCommit as string).slice(0, 12)}</code></Show>
            </p>
            <Show when={wt.dirtyExcluded && wt.dirtySummary}>
              <p class="muted">local changes excluded: {wt.dirtySummary}</p>
            </Show>
            <Show when={wt.error}>
              <p class="muted">error: {wt.error}</p>
            </Show>
            <Show when={(state.worktreeOps[wt.id] ?? []).length > 0}>
              <details>
                <summary>Operations ({(state.worktreeOps[wt.id] ?? []).length})</summary>
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
                  Clean up
                </button>
              </Show>
              <button onClick={() => void reloadWorktrees()}>Refresh</button>
            </div>
          </div>
        )}
      </For>
    </details>
  );
}

export function IntegrationsSection() {
  const [waiver, setWaiver] = createSignal<Record<string, string>>({});
  const [reviewerInstance, setReviewerInstance] = createSignal<Record<string, string>>({});
  const active = () => state.integrations.filter((i) => ["building", "conflicted", "validating", "preview_ready", "approved", "promoting"].includes(i.status));
  const ordered = () =>
    [...state.integrations].sort((a, b) => {
      const activeA = ["building", "conflicted", "validating", "preview_ready", "approved", "promoting"].includes(a.status) ? 0 : 1;
      const activeB = ["building", "conflicted", "validating", "preview_ready", "approved", "promoting"].includes(b.status) ? 0 : 1;
      return activeA - activeB || b.createdAt - a.createdAt;
    });
  const latestRun = () => state.runs[state.runs.length - 1];
  const latestRunHasIntegration = () => {
    const run = latestRun();
    return Boolean(run && state.integrations.some((integration) => integration.runId === run.id));
  };
  // Todo 34: las tarjetas de integración son las más pesadas del chat; diferido por conteo.
  const capped = () => capList("integration-cards", ordered(), INTEGRATION_CARD_WINDOW);
  return (
    <details class="stage2">
      <summary>
        Integrations ({active().length} active / {state.integrations.length} total)
      </summary>
      <Show when={state.integrations.length === 0}>
        <p class="muted">No integrations yet. Reviewed writer tasks auto-integrate into an intermediate branch.</p>
      </Show>
      <Show when={latestRun() && !latestRunHasIntegration()}>
        <div class="row">
          <button
            class="primary"
            onClick={() => void recoverRunIntegration(latestRun()!.id)}
          >
            Recuperar integración del último run (incluye commits no revisados)
          </button>
          <span class="muted">Crea un worktree de prueba; no toca la rama principal.</span>
        </div>
      </Show>
      <Show when={capped().over}>
        <p class="muted" data-deferred-panel="integration-cards">
          Ventana del DOM: {capped().visible.length} de {state.integrations.length} ({capped().deferred} diferidos por presupuesto).
        </p>
      </Show>
      <For each={capped().visible}>
        {(integration) => (
          <div class="card">
            <div class="row">
              <code>{integration.integrationBranch}</code>
              <span class={`pill ${integration.status === "promoted" ? "ok" : integration.status === "failed" || integration.status === "conflicted" ? "err" : integration.status === "stale" ? "err" : "warn"}`}>{integration.status}</span>
              <span class="muted">attempt {integration.attempt}</span>
            </div>
            <p class="muted">
              run <code>{integration.runId}</code> · target <code>{integration.targetBranch}</code> @ <code>{integration.targetBaseCommit.slice(0, 12)}</code>
            </p>
            <Show when={integration.head}>
              <p class="muted">
                head <code>{(integration.head as string).slice(0, 12)}</code>
                <Show when={integration.supersedes}> · supersedes <code>{integration.supersedes}</code></Show>
              </p>
            </Show>
            <Show when={integration.error}>
              <p class="muted">error: {integration.error}</p>
            </Show>
            <Show when={integration.excludedTaskIds.length > 0}>
              <p class="muted">
                Sin commit integrado:{" "}
                <For each={integration.excludedTaskIds}>{(taskId) => <code>{taskId} </code>}</For>
              </p>
            </Show>
            <Show when={(state.integrationCommits[integration.id] ?? []).length > 0}>
              <details>
                <summary>Commits ({(state.integrationCommits[integration.id] ?? []).length})</summary>
                <ul>
                  <For each={state.integrationCommits[integration.id] ?? []}>
                    {(c) => (
                      <li>
                        <code>{c.taskId}</code> #{c.attempt} <code>{c.kind}</code> {c.originalSha.slice(0, 8)}→{c.integratedSha.slice(0, 8)}
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <Show when={(state.integrationValidations[integration.id] ?? []).length > 0}>
              <details>
                <summary>Validations ({(state.integrationValidations[integration.id] ?? []).length})</summary>
                <ul>
                  <For each={state.integrationValidations[integration.id] ?? []}>
                    {(v) => (
                      <li>
                        <code>{v.kind}{v.entryId ? `:${v.entryId}` : ""}</code> {v.status}
                        <Show when={v.detail != null}> · {(v.detail as string).slice(0, 160)}</Show>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <Show when={(state.integrationReviews[integration.id] ?? []).length > 0}>
              <details>
                <summary>Reviews ({(state.integrationReviews[integration.id] ?? []).length})</summary>
                <ul>
                  <For each={state.integrationReviews[integration.id] ?? []}>
                    {(r) => (
                      <li>
                        <code>{r.verdict}</code> @ {r.sha.slice(0, 8)}
                        <Show when={r.summary != null}> · {(r.summary as string).slice(0, 160)}</Show>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <Show when={state.integrationConflicts.filter((c) => c.scopeRef === integration.id).length > 0}>
              <details open>
                <summary>Conflicts ({state.integrationConflicts.filter((c) => c.scopeRef === integration.id).length})</summary>
                <ul>
                  <For each={state.integrationConflicts.filter((c) => c.scopeRef === integration.id)}>
                    {(conflict) => (
                      <li>
                        <code>{conflict.status}</code> {conflict.files.join(", ")}
                        <div class="row">
                          <Show when={conflict.status === "open"}>
                            <button class="primary" onClick={() => void requestConflictResolution(conflict.id)}>
                              Request assisted resolution
                            </button>
                          </Show>
                          <Show when={conflict.status === "resolving" && conflict.resolutionInstanceId}>
                            <button class="primary" onClick={() => void finalizeConflictResolution(conflict.id, conflict.resolutionInstanceId!)}>
                              Finalize resolution
                            </button>
                          </Show>
                          <Show when={conflict.status === "resolved"}>
                            <button class="primary" onClick={() => void incorporateConflictResolution(integration.id, conflict.id)}>
                              Incorporate resolution
                            </button>
                            <button onClick={() => void cleanupConflictResolution(conflict.id)}>Clean up workspace</button>
                          </Show>
                          <Show when={conflict.status === "open" || conflict.status === "resolving"}>
                            <button class="danger" onClick={() => void abortConflict(conflict.id)}>
                              Abort conflict
                            </button>
                          </Show>
                        </div>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <Show when={(state.previews[integration.id] ?? []).length > 0}>
              <details>
                <summary>Previews ({(state.previews[integration.id] ?? []).length})</summary>
                <ul>
                  <For each={state.previews[integration.id] ?? []}>
                    {(preview) => (
                      <li>
                        <code>{preview.status}</code>{" "}
                        <Show when={preview.url} fallback={<span class="muted">no url yet</span>}>
                          <a href={preview.url} target="_blank" rel="noreferrer">{preview.url}</a>
                        </Show>{" "}
                        @ {preview.sha.slice(0, 8)}
                        <div class="row">
                          <Show when={["starting", "stopped", "failed", "completed"].includes(preview.status)}>
                            <button class="primary" onClick={() => void startPreview(preview.id)}>
                              Start
                            </button>
                          </Show>
                          <Show when={["running", "reachable"].includes(preview.status)}>
                            <button class="danger" onClick={() => void stopPreview(preview.id)}>
                              Stop
                            </button>
                          </Show>
                          <button onClick={() => void (async () => { await inspectPreview(preview.id); await loadPreviewLogs(preview.id); })()}>Inspect</button>
                          <button onClick={() => void cleanupPreview(preview.id)}>Clean up</button>
                        </div>
                        <Show when={state.previewLogs[preview.id]}>
                          <pre>{(state.previewLogs[preview.id] ?? "").slice(-4000)}</pre>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <Show when={(state.integrationApprovals[integration.id] ?? []).length > 0}>
              <p class="muted">
                approval: {(state.integrationApprovals[integration.id] ?? []).map((a) => `${a.decision}@${a.candidateSha.slice(0, 8)}`).join(", ")}
              </p>
            </Show>
            <Show when={(state.promotions[integration.id] ?? []).length > 0}>
              <p class="muted">
                promotions: {(state.promotions[integration.id] ?? []).map((p) => `${p.status}@${p.newSha.slice(0, 8)}`).join(", ")}
              </p>
            </Show>
            <div class="row">
              <Show when={["building", "conflicted", "validating"].includes(integration.status)}>
                <button class="primary" onClick={() => void incorporateIntegration(integration.id)}>
                  Incorporate
                </button>
                <button onClick={() => void rerunValidations(integration.id)}>Re-run validations</button>
                <button onClick={() => void createPreview(integration.id)}>Create preview</button>
              </Show>
              <button
                onClick={() =>
                  void (async () => {
                    const instanceId = await spawnIntegrationReviewer(integration.id);
                    if (instanceId) setReviewerInstance((prev) => ({ ...prev, [integration.id]: instanceId }));
                  })()
                }
              >
                Spawn reviewer
              </button>
              <Show when={reviewerInstance()[integration.id]}>
                <button class="primary" onClick={() => void recordIntegrationReview(integration.id, reviewerInstance()[integration.id]!, "accept")}>
                  Accept review
                </button>
                <button class="danger" onClick={() => void recordIntegrationReview(integration.id, reviewerInstance()[integration.id]!, "request-changes")}>
                  Request changes
                </button>
              </Show>
              <Show when={["validating", "preview_ready"].includes(integration.status)}>
                <input
                  placeholder="waiver reason (no server to preview)"
                  value={waiver()[integration.id] ?? ""}
                  onInput={(e) => setWaiver((prev) => ({ ...prev, [integration.id]: e.currentTarget.value }))}
                />
                <button
                  class="primary"
                  onClick={() =>
                    void approveIntegration(integration.id, {
                      previewId: (state.previews[integration.id] ?? []).find((p) => p.sha === integration.head && p.status === "reachable")?.id,
                      waiverReason: (state.previews[integration.id] ?? []).some((p) => p.sha === integration.head && p.status === "reachable") ? undefined : waiver()[integration.id],
                    })
                  }
                >
                  Approve
                </button>
                <button class="danger" onClick={() => void rejectIntegration(integration.id)}>
                  Reject
                </button>
              </Show>
              <Show when={integration.status === "approved"}>
                <button class="primary" onClick={() => void promoteIntegration(integration.id)}>
                  Promote
                </button>
              </Show>
              <Show when={["stale", "failed", "aborted"].includes(integration.status)}>
                <button class="primary" onClick={() => void rebuildIntegration(integration.id)}>
                  Rebuild
                </button>
              </Show>
              <Show when={["building", "conflicted", "validating"].includes(integration.status)}>
                <button class="danger" onClick={() => void abortIntegration(integration.id)}>
                  Abort
                </button>
              </Show>
              <button onClick={() => void reloadIntegrations()}>Refresh</button>
            </div>
          </div>
        )}
      </For>
    </details>
  );
}

export function MemorySection() {
  const [form, setForm] = createSignal({ scope: "project", scopeId: "", category: "fact", topic: "", content: "", source: "user" });
  // Todo 34: diferido por conteo para gobernanza con muchas entradas.
  const capped = () => capList("memory-cards", state.memories);
  const byScope = () => {
    const groups = new Map<string, typeof state.memories>();
    for (const m of capped().visible) {
      const key = `${m.scope}:${m.scopeId.slice(-6)}`;
      const list = groups.get(key);
      if (list) list.push(m);
      else groups.set(key, [m]);
    }
    return [...groups.entries()];
  };
  const pending = () => state.memories.filter((m) => m.status === "proposed").length;
  const conflicts = () => state.memories.filter((m) => m.reviewNote && /contradiction pending/i.test(m.reviewNote));
  return (
    <details class="stage2">
      <summary>
        Memory ({pending()} proposed / {state.memories.length} total{conflicts().length > 0 ? ` · ${conflicts().length} conflicted` : ""})
      </summary>
      <Show when={state.memories.length === 0}>
        <p class="muted">No memory entries yet. Agents propose via memory_propose; governance decides.</p>
      </Show>
      <Show when={capped().over}>
        <p class="muted" data-deferred-panel="memory-cards">
          Ventana del DOM: {capped().visible.length} de {state.memories.length} ({capped().deferred} diferidos por presupuesto).
        </p>
      </Show>
      <For each={byScope()}>
        {([scope, entries]) => (
          <details>
            <summary>{scope} ({entries.length})</summary>
            <ul>
              <For each={entries}>
                {(m) => (
                  <li>
                    <code>{m.category}:{m.topic}</code>{" "}
                    <span class={`pill ${m.status === "approved" || m.status === "verified" ? "ok" : m.status === "proposed" ? "warn" : m.status === "stale" ? "err" : "err"}`}>{m.status}</span>{" "}
                    <span class="muted">v{m.version}</span>
                    <p class="muted">{m.content.slice(0, 200)}</p>
                    <Show when={m.reviewNote}>
                      <p class="muted">note: {m.reviewNote}</p>
                    </Show>
                    <div class="row">
                      <Show when={m.status === "proposed"}>
                        <Show when={m.category !== "decision" && m.category !== "instruction"}>
                          <button onClick={() => void validateMemory(m.id)}>Validate</button>
                        </Show>
                        <button class="primary" onClick={() => void decideMemory(m.id, "approved")}>Approve</button>
                        <button class="danger" onClick={() => void decideMemory(m.id, "rejected")}>Reject</button>
                      </Show>
                      <Show when={m.status === "verified" || m.status === "approved"}>
                        <button onClick={() => void revalidateMemory(m.id)}>Revalidate</button>
                      </Show>
                      <Show when={m.reviewNote && /contradiction pending/i.test(m.reviewNote)}>
                        <button class="primary" onClick={() => void resolveMemoryConflict(m.id)}>Keep this</button>
                      </Show>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </details>
        )}
      </For>
      <details>
        <summary>Propose memory</summary>
        <div class="row">
          <select value={form().scope} onChange={(e) => setForm((f) => ({ ...f, scope: e.currentTarget.value }))}>
            <option value="project">project</option>
            <option value="session">session</option>
            <option value="run">run</option>
            <option value="task">task</option>
            <option value="instance">instance</option>
          </select>
          <input placeholder="scopeId" value={form().scopeId} onInput={(e) => setForm((f) => ({ ...f, scopeId: e.currentTarget.value }))} />
          <input placeholder="category" value={form().category} onInput={(e) => setForm((f) => ({ ...f, category: e.currentTarget.value }))} />
          <input placeholder="topic" value={form().topic} onInput={(e) => setForm((f) => ({ ...f, topic: e.currentTarget.value }))} />
        </div>
        <div class="row">
          <input placeholder="content" value={form().content} onInput={(e) => setForm((f) => ({ ...f, content: e.currentTarget.value }))} />
          <input placeholder="source" value={form().source} onInput={(e) => setForm((f) => ({ ...f, source: e.currentTarget.value }))} />
          <button class="primary" onClick={() => void proposeMemory({ scope: form().scope as "project" | "session" | "run" | "task" | "instance", scopeId: form().scopeId, category: form().category, topic: form().topic, content: form().content, source: form().source })}>Propose</button>
        </div>
      </details>
      <details>
        <summary>Recovery ({state.recoveryStatus ? `${state.recoveryStatus.pendingOps} pending ops · ${state.recoveryStatus.staleMemories} stale · ${state.recoveryStatus.pendingContradictions} conflicts` : "unknown"})</summary>
        <div class="row">
          <button onClick={() => void reconcileRecovery()}>Reconcile now</button>
          <button onClick={() => void reloadMemory()}>Refresh</button>
        </div>
      </details>
    </details>
  );
}

export function AgentsSection() {
  const active = () => state.agentInstances.filter((i) => ["created", "running", "waiting_permission", "waiting_input"].includes(i.status));
  // Todo 34: diferido por conteo.
  const capped = () => capList("agent-cards", state.agentInstances);
  return (
    <details class="stage2" id="agent-activity">
      <summary>
        Agents ({active().length} active / {state.agentInstances.length} total)
      </summary>
      <Show when={state.agentInstances.length === 0}>
        <p class="muted">No subagents in this session yet.</p>
      </Show>
      <Show when={capped().over}>
        <p class="muted" data-deferred-panel="agent-cards">
          Ventana del DOM: {capped().visible.length} de {state.agentInstances.length} ({capped().deferred} diferidos por presupuesto).
        </p>
      </Show>
      <For each={capped().visible}>
        {(instance) => (
          <div class="card" data-agent-instance={instance.id}>
            <div class="row">
              <code>{instance.definitionId}</code>
              <span
                class={`pill ${instance.status === "completed" ? "ok" : instance.status === "failed" ? "err" : instance.status === "cancelled" ? "" : "warn"}`}
                data-agent-status={instance.status}
              >
                {instance.status}
              </span>
              <code class="muted">{instance.id}</code>
            </div>
            <p class="muted">
              {instance.directory}
              <Show when={instance.taskId}> · task {instance.taskId}</Show>
              <Show when={instance.worktreeId}> · worktree {instance.worktreeId}</Show>
              <Show when={instance.parentInstanceId}> · parent {instance.parentInstanceId}</Show>
              <Show when={instance.status === "waiting_permission"}> · esperando tu permiso</Show>
              <Show when={instance.status === "waiting_input"}> · esperando tu respuesta</Show>
              <Show when={instance.error}> · error: {instance.error}</Show>
            </p>
            <Show when={["created", "running", "waiting_permission", "waiting_input"].includes(instance.status)}>
              <button class="danger" onClick={() => void cancelAgent(instance.id)}>
                Cancel
              </button>
            </Show>
          </div>
        )}
      </For>
    </details>
  );
}
