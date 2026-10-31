/** Renderer — vistas de la Etapa 1: sesiones, chat, permisos, preguntas y ajustes. */
import { For, Show, createSignal, onMount } from "solid-js";
import type { Message, MessagePart } from "@octus/shared";
import { invoke } from "./api.js";
import { renderMarkdown } from "./markdown.js";
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
  createProject,
  createSession,
  decideApproval,
  decideMemory,
  exportRevision,
  finalizeConflictResolution,
  implementRevision,
  incorporateConflictResolution,
  incorporateIntegration,
  initStore,
  inspectPreview,
  interrupt,
  loadPreviewLogs,
  proposeMemory,
  promoteIntegration,
  revalidateMemory,
  rebuildIntegration,
  rejectIntegration,
  rejectRevision,
  reloadBudgets,
  reloadIntegrations,
  reloadProviders,
  reloadWorktrees,
  requestConflictResolution,
  resolveMemoryConflict,
  restartPreview,
  retryTask,
  reviewTask,
  rerunValidations,
  recordIntegrationReview,
  reconcileRecovery,
  reloadMemory,
  selectProject,
  selectSession,
  sendPrompt,
  setError,
  setProfile,
  setView,
  setWorktreesRoot,
  spawnIntegrationReviewer,
  startPreview,
  state,
  stopPreview,
  validateMemory,
} from "./store.js";

function PartView(props: { part: MessagePart }) {
  const part = () => props.part;
  return (
    <>
      {part().type === "text" && <div class="md" innerHTML={renderMarkdown((part() as { text: string }).text)} />}
      {part().type === "reasoning_summary" && (
        <details class="reasoning">
          <summary>Reasoning summary</summary>
          <div class="md" innerHTML={renderMarkdown((part() as { text: string }).text)} />
        </details>
      )}
      {part().type === "tool_call" && (
        <div class="toolcall">
          <span class="toolname">{(part() as { name: string }).name}</span>
          <code>{(part() as { argumentsJson: string }).argumentsJson.slice(0, 500)}</code>
        </div>
      )}
      {part().type === "tool_result" && (
        <div class={`toolresult ${(part() as { ok: boolean }).ok ? "ok" : "err"}`}>
          <pre>{(part() as { text: string }).text.slice(0, 4000)}</pre>
        </div>
      )}
    </>
  );
}

function MessageView(props: { message: Message }) {
  const message = () => props.message;
  return (
    <div class={`message ${message().role}`}>
      <div class="role">
        {message().role}
        <Show when={message().mode}>
          <span class={`pill mode ${message().mode}`}>[{message().mode}]</span>
        </Show>
      </div>
      <For each={message().parts}>{(part) => <PartView part={part} />}</For>
    </div>
  );
}

function Sidebar() {
  let projectName: HTMLInputElement | undefined;
  return (
    <aside class="sidebar">
      <h1>Octus</h1>
      <section>
        <h2>Projects</h2>
        <For each={state.projects}>
          {(project) => (
            <button class={project.id === state.activeProjectId ? "active" : ""} onClick={() => void selectProject(project.id)}>
              {project.name}
            </button>
          )}
        </For>
        <div class="row">
          <input ref={projectName} placeholder="New project name" />
          <button
            onClick={() => {
              void (async () => {
                const picked = await invoke("app.pickDirectory", {});
                if (picked.path && projectName?.value.trim()) {
                  await createProject(projectName.value.trim(), picked.path);
                  projectName.value = "";
                }
              })();
            }}
          >
            Add
          </button>
        </div>
      </section>
      <section>
        <h2>Sessions</h2>
        <button class="primary" disabled={!state.activeProjectId} onClick={() => void createSession()}>
          New session
        </button>
        <For each={state.sessions}>
          {(session) => (
            <button class={session.id === state.activeSessionId ? "active" : ""} onClick={() => void selectSession(session.id)}>
              {session.title} <span class="profile">[{session.profile}]</span>
            </button>
          )}
        </For>
      </section>
      <button class="settings" onClick={() => setView(state.view === "settings" ? "chat" : "settings")}>
        {state.view === "settings" ? "Back to chat" : "Settings"}
      </button>
    </aside>
  );
}

function Composer() {
  let input: HTMLTextAreaElement | undefined;
  const send = () => {
    if (input && input.value.trim()) {
      void sendPrompt(input.value);
      input.value = "";
    }
  };
  return (
    <div class="composer">
      <textarea
        ref={input}
        placeholder={state.activeSessionId ? "Type a request… (Enter to send)" : "Create or select a session first"}
        disabled={!state.activeSessionId || state.busy}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div class="row">
        <button class="primary" disabled={!state.activeSessionId || state.busy} onClick={send}>
          Send
        </button>
        <Show when={state.busy}>
          <button onClick={() => void interrupt()}>Interrupt</button>
        </Show>
      </div>
    </div>
  );
}

function PermissionDialogs() {
  const [feedback, setFeedback] = createSignal("");
  return (
    <For each={state.permissions}>
      {(request) => (
        <div class="modal">
          <div class="dialog">
            <h3>Permission requested</h3>
            <p>
              <strong>{request.action}</strong>
            </p>
            <pre>{request.resources.join("\n")}</pre>
            <Show when={request.detail}>
              <pre class="detail">{request.detail}</pre>
            </Show>
            <input placeholder="Feedback for reject (optional)" value={feedback()} onInput={(e) => setFeedback(e.currentTarget.value)} />
            <div class="row">
              <button class="primary" onClick={() => void invoke("permissions.reply", { requestId: request.id, decision: "once" })}>
                Allow once
              </button>
              <Show when={request.action !== "shell"}>
                <button onClick={() => void invoke("permissions.reply", { requestId: request.id, decision: "always" })}>Always</button>
              </Show>
              <button
                class="danger"
                onClick={() => void invoke("permissions.reply", { requestId: request.id, decision: "reject", message: feedback() })}
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      )}
    </For>
  );
}

function QuestionDialogs() {
  return (
    <For each={state.questions}>
      {(request) => (
        <div class="modal">
          <div class="dialog">
            <h3>Octus asks</h3>
            <For each={request.questions}>
              {(question, qi) => (
                <div class="question">
                  <p>
                    <strong>{question.header}</strong>: {question.question}
                  </p>
                  <For each={question.options}>
                    {(option, oi) => (
                      <label>
                        <input
                          type={question.multiple ? "checkbox" : "radio"}
                          name={request.id + qi()}
                          value={option.label}
                          data-question={question.question}
                          data-multiple={question.multiple ? "1" : ""}
                        />
                        {option.label} <span class="muted">{option.description ?? ""}</span>
                      </label>
                    )}
                  </For>
                  <input type="text" placeholder="Or type your own answer" data-custom={question.question} />
                </div>
              )}
            </For>
            <div class="row">
              <button
                class="primary"
                onClick={(event) => {
                  const dialog = (event.currentTarget as HTMLElement).closest(".dialog")!;
                  const answers = request.questions.map((question) => {
                    const checked = [...dialog.querySelectorAll<HTMLInputElement>(`input[data-question="${CSS.escape(question.question)}"]:checked`)].map(
                      (el) => el.value,
                    );
                    const custom = dialog.querySelector<HTMLInputElement>(`input[data-custom="${CSS.escape(question.question)}"]`)?.value.trim();
                    if (custom) checked.push(custom);
                    return { question: question.question, answers: checked };
                  });
                  void invoke("questions.reply", { requestId: request.id, answers });
                }}
              >
                Answer
              </button>
            </div>
          </div>
        </div>
      )}
    </For>
  );
}

function ProviderSettings() {
  const keys: Record<string, HTMLInputElement | undefined> = {};
  return (
    <section>
      <h2>Providers</h2>
      <For each={state.providers}>
        {(provider) => (
          <div class="card">
            <h3>
              {provider.displayName} {provider.configured ? <span class="pill ok">key saved</span> : <span class="pill warn">no key</span>}
            </h3>
            <div class="row">
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
                  })();
                }}
              >
                Save key
              </button>
              <button
                onClick={() => {
                  void (async () => {
                    await invoke("providers.removeKey", { providerId: provider.id });
                    await reloadProviders();
                  })();
                }}
              >
                Remove
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
              <summary>Models ({provider.models.length})</summary>
              <ul>
                <For each={provider.models}>
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
    </section>
  );
}

function BudgetSettings() {
  let kind: HTMLSelectElement | undefined;
  let ref: HTMLInputElement | undefined;
  let limitUsd: HTMLInputElement | undefined;
  let limitTokens: HTMLInputElement | undefined;
  let action: HTMLSelectElement | undefined;
  return (
    <section>
      <h2>Budgets {state.budgetsConfigured ? <span class="pill ok">configured</span> : <span class="pill warn">not configured — paid calls are blocked</span>}</h2>
      <p class="muted">Octus never runs paid calls without limits you saved here. Warnings fire once per budget and window.</p>
      <ul>
        <For each={state.budgets}>
          {(budget) => (
            <li>
              <code>{budget.scope.kind}:{budget.scope.ref || "*"}</code> —{" "}
              {budget.limitMicroUsd !== undefined ? `$${(budget.limitMicroUsd / 1_000_000).toFixed(2)}` : "no money cap"},{" "}
              {budget.limitTokens !== undefined ? `${budget.limitTokens.toLocaleString()} tokens` : "no token cap"} — {budget.action} — {budget.window}
            </li>
          )}
        </For>
      </ul>
      <div class="card">
        <h3>Replace all budgets</h3>
        <div class="row">
          <select ref={kind}>
            <option value="global">global</option>
            <option value="provider">provider</option>
            <option value="model">model</option>
            <option value="agent">agent</option>
            <option value="session">session</option>
            <option value="run">run</option>
          </select>
          <input ref={ref} placeholder="ref (provider id, provider/model, …; empty for global)" />
          <input ref={limitUsd} type="number" min="0" step="0.5" placeholder="USD limit" />
          <input ref={limitTokens} type="number" min="0" step="1000" placeholder="token limit" />
          <select ref={action}>
            <option value="block">block</option>
            <option value="warn">warn</option>
          </select>
          <button
            class="primary"
            onClick={() => {
              void (async () => {
                const usd = Number.parseFloat(limitUsd?.value ?? "");
                const tokens = Number.parseInt(limitTokens?.value ?? "", 10);
                await invoke("budgets.configure", {
                  budgets: [
                    {
                      scope: { kind: (kind?.value ?? "global") as never, ref: ref?.value.trim() ?? "" },
                      limitMicroUsd: Number.isFinite(usd) && usd > 0 ? Math.round(usd * 1_000_000) : undefined,
                      limitTokens: Number.isFinite(tokens) && tokens > 0 ? tokens : undefined,
                      warnRatio: 0.8,
                      action: (action?.value ?? "block") as never,
                      window: "span",
                      enabled: true,
                    },
                  ],
                });
                setError(undefined);
                await reloadBudgets();
              })();
            }}
          >
            Save budgets
          </button>
        </div>
      </div>
      <h3>Spend by budget</h3>
      <ul>
        <For each={state.budgetUsage}>
          {(usage) => (
            <li>
              <code>{usage.budgetId}</code> —{" "}
              {usage.spentMicroUsd === null ? "cost unknown" : `$${(usage.spentMicroUsd / 1_000_000).toFixed(4)}`}
              {usage.costIncomplete ? " (partial: some calls lack pricing)" : ""} — {usage.spentTokens.toLocaleString()} tokens{" "}
              {usage.exceeded ? <span class="pill warn">exceeded</span> : usage.warned ? <span class="pill warn">warning</span> : null}
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

function PlansSection() {
  return (
    <details class="stage2">
      <summary>
        Plans ({state.plans.length}) — Approvals pending ({state.approvals.length})
      </summary>
      <Show when={state.approvals.length > 0}>
        <div class="card warn">
          <h3>Pending approvals (only you can decide)</h3>
          <For each={state.approvals}>
            {(request) => (
              <div class="row">
                <code>
                  {request.planId} · {request.revisionId}
                </code>
                <button class="primary" onClick={() => void decideApproval(request.id, "approved")}>
                  Approve
                </button>
                <button class="danger" onClick={() => void decideApproval(request.id, "rejected")}>
                  Reject
                </button>
              </div>
            )}
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
                    <Show when={revision.lifecycle === "presented" && revision.approval === "pending"}>
                      <button class="primary" onClick={() => void approveRevision(plan.id, revision.id)}>
                        Approve v{revision.version}
                      </button>
                      <button class="danger" onClick={() => void rejectRevision(plan.id, revision.id)}>
                        Reject
                      </button>
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

function TasksSection() {
  const active = () => state.tasks.filter((t) => ["ready", "assigned", "running", "blocked"].includes(t.status));
  return (
    <details class="stage2">
      <summary>
        Tasks ({active().length} active / {state.tasks.length} total)
      </summary>
      <Show when={state.tasks.length === 0}>
        <p class="muted">No tasks yet. The coordinator decomposes approved revisions into a task DAG.</p>
      </Show>
      <For each={state.tasks}>
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

function WorktreesSection() {
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

function IntegrationsSection() {
  const [waiver, setWaiver] = createSignal<Record<string, string>>({});
  const [reviewerInstance, setReviewerInstance] = createSignal<Record<string, string>>({});
  const active = () => state.integrations.filter((i) => ["building", "conflicted", "validating", "preview_ready", "approved", "promoting"].includes(i.status));
  return (
    <details class="stage2">
      <summary>
        Integrations ({active().length} active / {state.integrations.length} total)
      </summary>
      <Show when={state.integrations.length === 0}>
        <p class="muted">No integrations yet. Reviewed writer tasks auto-integrate into an intermediate branch.</p>
      </Show>
      <For each={state.integrations}>
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

function MemorySection() {
  const [form, setForm] = createSignal({ scope: "project", scopeId: "", category: "fact", topic: "", content: "", source: "user" });
  const byScope = () => {
    const groups = new Map<string, typeof state.memories>();
    for (const m of state.memories) {
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

function AgentsSection() {  const active = () => state.agentInstances.filter((i) => ["created", "running", "waiting_permission", "waiting_input"].includes(i.status));
  return (
    <details class="stage2">
      <summary>
        Agents ({active().length} active / {state.agentInstances.length} total)
      </summary>
      <Show when={state.agentInstances.length === 0}>
        <p class="muted">No subagents in this session yet.</p>
      </Show>
      <For each={state.agentInstances}>
        {(instance) => (
          <div class="card">
            <div class="row">
              <code>{instance.definitionId}</code>
              <span class={`pill ${instance.status === "completed" ? "ok" : instance.status === "failed" ? "err" : "warn"}`}>{instance.status}</span>
              <code class="muted">{instance.id}</code>
            </div>
            <p class="muted">
              {instance.directory}
              <Show when={instance.parentInstanceId}> · parent {instance.parentInstanceId}</Show>
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

function ChatView() {
  const session = () => state.sessions.find((s) => s.id === state.activeSessionId);
  return (
    <main class="chat">
      <Show when={!state.budgetsConfigured}>
        <div class="banner warn">Budgets are not configured: paid calls are blocked until you save limits in Settings → Budgets.</div>
      </Show>
      <Show when={state.error}>
        <div class="banner err">
          {state.error}
          <button onClick={() => setError(undefined)}>×</button>
        </div>
      </Show>
      <header>
        <h2>{session()?.title ?? "No session"}</h2>
        <Show when={session()}>
          <div class="row">
            <select value={session()!.profile} onChange={(e) => void setProfile(e.currentTarget.value as "plan" | "build")}>
              <option value="build">build</option>
              <option value="plan">plan</option>
            </select>
            <span class="muted">{state.busy ? "working…" : "idle"}</span>
          </div>
        </Show>
      </header>
      <div class="timeline">
        <For each={state.messages}>{(message) => <MessageView message={message} />}</For>
        <For each={Object.values(state.live)}>
          {(live) =>
            live.text || live.reasoning || Object.keys(live.toolArgs).length > 0 ? (
              <div class="message assistant live">
                <div class="role">assistant (streaming)</div>
                <Show when={live.text}>
                  <div class="md" innerHTML={renderMarkdown(live.text)} />
                </Show>
                <Show when={live.reasoning}>
                  <details class="reasoning" open>
                    <summary>Reasoning summary</summary>
                    <div class="md" innerHTML={renderMarkdown(live.reasoning)} />
                  </details>
                </Show>
                <For each={Object.entries(live.toolArgs)}>
                  {([key, args]) => (
                    <div class="toolcall">
                      <span class="toolname">tool {key}</span>
                      <code>{args.slice(0, 500)}</code>
                    </div>
                  )}
                </For>
              </div>
            ) : null
          }
        </For>
      </div>
      <PlansSection />
      <TasksSection />
      <WorktreesSection />
      <IntegrationsSection />
      <MemorySection />
      <AgentsSection />
      <Composer />
      <details>
        <summary>Usage of the last run ({state.usage.length} calls)</summary>
        <ul>
          <For each={state.usage}>
            {(record) => (
              <li>
                <code>
                  {record.providerId}/{record.modelId}
                </code>{" "}
                in {record.inputTokens.toLocaleString()} / out {record.outputTokens.toLocaleString()} / reason{" "}
                {record.reasoningTokens.toLocaleString()} / cached {record.cachedTokens.toLocaleString()} —{" "}
                {record.costMicroUsd === null ? "cost unknown (no pricing)" : `$${(record.costMicroUsd / 1_000_000).toFixed(4)}`} — {record.status}
              </li>
            )}
          </For>
        </ul>
      </details>
    </main>
  );
}

function AgentSettings() {
  let maxSession: HTMLInputElement | undefined;
  let maxProject: HTMLInputElement | undefined;
  let maxDepth: HTMLInputElement | undefined;
  const modelInputs: Record<string, { provider?: HTMLInputElement; model?: HTMLInputElement; effort?: HTMLInputElement }> = {};
  return (
    <section>
      <h2>Agents</h2>
      <div class="card">
        <h3>Concurrency limits</h3>
        <div class="row">
          <label class="muted">
            per session
            <input ref={maxSession} type="number" min="1" max="100" value={state.agentLimits.maxPerSession} />
          </label>
          <label class="muted">
            per project
            <input ref={maxProject} type="number" min="1" max="100" value={state.agentLimits.maxPerProject} />
          </label>
          <label class="muted">
            max depth
            <input ref={maxDepth} type="number" min="1" max="10" value={state.agentLimits.maxDepth} />
          </label>
          <button
            class="primary"
            onClick={() => {
              void (async () => {
                const limits = {
                  maxPerSession: Number.parseInt(maxSession?.value ?? "", 10),
                  maxPerProject: Number.parseInt(maxProject?.value ?? "", 10),
                  maxDepth: Number.parseInt(maxDepth?.value ?? "", 10),
                };
                const result = await invoke("agents.setLimits", { limits });
                if (!result.ok) setError(result.error ?? "Could not save limits");
                else setError(undefined);
              })();
            }}
          >
            Save limits
          </button>
        </div>
      </div>
      <For each={state.definitions}>
        {(definition) => (
          <div class="card">
            <h3>
              <code>{definition.id}</code> <span class="muted">{definition.kind}</span>
            </h3>
            <p class="muted">{definition.description}</p>
            <p class="muted">
              default: <code>{definition.defaultModel.providerId}/{definition.defaultModel.modelId}</code>
              {definition.defaultModel.effort ? ` effort=${definition.defaultModel.effort}` : ""} · tools={definition.tools.length} · prompt v{definition.promptVersion}
            </p>
            <div class="row">
              <input ref={(el) => ((modelInputs[definition.id] ??= {}).provider = el)} placeholder="providerId" value={definition.defaultModel.providerId} />
              <input ref={(el) => ((modelInputs[definition.id] ??= {}).model = el)} placeholder="modelId" value={definition.defaultModel.modelId} />
              <input ref={(el) => ((modelInputs[definition.id] ??= {}).effort = el)} placeholder="effort (optional)" value={definition.defaultModel.effort ?? ""} />
              <button
                onClick={() => {
                  void (async () => {
                    const entry = modelInputs[definition.id] ?? {};
                    const providerId = entry.provider?.value.trim() ?? "";
                    const modelId = entry.model?.value.trim() ?? "";
                    const effort = entry.effort?.value.trim() || undefined;
                    if (!providerId || !modelId) {
                      setError("providerId and modelId are required");
                      return;
                    }
                    const result = await invoke("agents.setDefinitionModel", { definitionId: definition.id, model: { providerId, modelId, effort } });
                    if (!result.ok) setError(result.error ?? "Could not save model");
                    else setError(undefined);
                  })();
                }}
              >
                Save model
              </button>
            </div>
          </div>
        )}
      </For>
    </section>
  );
}

function ProjectSettings() {
  let dirKind: HTMLSelectElement | undefined;
  let testJson: HTMLTextAreaElement | undefined;
  let trustedInput: HTMLInputElement | undefined;
  const projectId = () => state.activeProjectId;
  return (
    <section>
      <h2>Project: {state.projects.find((p) => p.id === state.activeProjectId)?.name ?? "—"}</h2>
      <Show when={!projectId()}>
        <p class="muted">Select a project to manage isolated directories, tests and trusted instructions.</p>
      </Show>
      <Show when={projectId()}>
        <div class="card">
          <h3>Isolated directories (implementer scope)</h3>
          <For each={state.isolatedDirs}>
            {(dir) => (
              <div class="row">
                <code>{dir.path}</code>
                <span class="pill">{dir.kind}</span>
                <Show when={dir.branch}>
                  <span class="muted">{dir.branch}</span>
                </Show>
                <button
                  class="danger"
                  onClick={() => {
                    void (async () => {
                      const result = await invoke("projects.removeIsolatedDir", { id: dir.id });
                      if (!result.ok) setError(result.error ?? "Could not remove directory");
                    })();
                  }}
                >
                  Remove
                </button>
              </div>
            )}
          </For>
          <div class="row">
            <select ref={dirKind}>
              <option value="directory">directory</option>
              <option value="worktree">worktree</option>
            </select>
            <button
              class="primary"
              onClick={() => {
                void (async () => {
                  const picked = await invoke("app.pickDirectory", {});
                  if (!picked.path || !projectId()) return;
                  const result = await invoke("projects.addIsolatedDir", { projectId: projectId()!, path: picked.path, kind: (dirKind?.value ?? "directory") as "directory" | "worktree" });
                  if (!result.ok) setError(result.error ?? "Could not add directory");
                  else setError(undefined);
                })();
              }}
            >
              Add directory
            </button>
          </div>
        </div>
        <div class="card">
          <h3>Reviewer test allowlist (JSON array)</h3>
          <p class="muted">Each entry: {"{ \"id\", \"name\", \"argv\": [\"exe\", \"arg\", …] }"}. Commands run in a disposable copy, never on worker files.</p>
          <textarea ref={testJson} placeholder='[{"id":"unit","name":"unit","argv":["bun","test"]}]' value={JSON.stringify(state.testAllowlist)} />
          <div class="row">
            <button
              class="primary"
              onClick={() => {
                void (async () => {
                  if (!projectId()) return;
                  let entries: Array<{ id: string; name: string; argv: string[] }>;
                  try {
                    entries = JSON.parse(testJson?.value || "[]");
                  } catch {
                    setError("Test allowlist is not valid JSON");
                    return;
                  }
                  const result = await invoke("projects.saveTestAllowlist", { projectId: projectId()!, entries });
                  if (!result.ok) setError(result.error ?? "Could not save allowlist");
                  else setError(undefined);
                })();
              }}
            >
              Save allowlist
            </button>
          </div>
          <ul>
            <For each={state.testAllowlist}>
              {(entry) => (
                <li>
                  <code>{entry.id}</code> {entry.name} — <code>{entry.argv.join(" ")}</code>
                </li>
              )}
            </For>
          </ul>
        </div>
        <div class="card">
          <h3>Trusted instruction files</h3>
          <p class="muted">Only these workspace-relative files become system instructions. Everything else is untrusted.</p>
          <div class="row">
            <input ref={trustedInput} placeholder="OCTUS.md, notes.md" value={state.trustedFiles.join(", ")} />
            <button
              class="primary"
              onClick={() => {
                void (async () => {
                  if (!projectId()) return;
                  const files = (trustedInput?.value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
                  const result = await invoke("projects.saveTrustedInstructions", { projectId: projectId()!, files });
                  if (!result.ok) setError(result.error ?? "Could not save trusted files");
                  else setError(undefined);
                })();
              }}
            >
              Save
            </button>
          </div>
          <p class="muted">Current: {state.trustedFiles.join(", ") || "—"}</p>
        </div>
      </Show>
    </section>
  );
}

function SettingsView() {
  return (
    <main class="settings-view">
      <Show when={state.error}>
        <div class="banner err">
          {state.error}
          <button onClick={() => setError(undefined)}>×</button>
        </div>
      </Show>
      <ProviderSettings />
      <BudgetSettings />
      <AgentSettings />
      <ProjectSettings />
    </main>
  );
}

export default function App() {
  onMount(() => {
    void initStore().catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
  });
  return (
    <div class="app">
      <Sidebar />
      <Show when={state.view === "chat"} fallback={<SettingsView />}>
        <ChatView />
      </Show>
      <PermissionDialogs />
      <QuestionDialogs />
    </div>
  );
}
