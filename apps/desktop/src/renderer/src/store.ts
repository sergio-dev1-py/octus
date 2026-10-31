/** Renderer — estado global y aplicación de eventos del core. */
import { createStore } from "solid-js/store";
import type {
  AgentDefinition,
  AgentInstance,
  Approval,
  ApprovalRequest,
  Budget,
  BudgetUsage,
  ConflictResolution,
  CoreEvent,
  Integration,
  IntegrationCommit,
  IntegrationConflict,
  IntegrationOperation,
  IntegrationReview,
  MemoryItem,
  Message,
  PermissionRequest,
  Plan,
  PlanRevision,
  Preview,
  Project,
  Promotion,
  ProviderDescriptor,
  QuestionRequest,
  RepositorySummary,
  Run,
  Session,
  Task,
  TaskDependency,
  TaskAttempt,
  UsageRecord,
  Validation,
  Worktree,
  WorktreeOperation,
} from "@octus/shared";
import { invoke, onEvent } from "./api.js";

export interface LiveMessage {
  id: string;
  text: string;
  reasoning: string;
  toolArgs: Record<string, string>;
}

interface UIState {
  projects: Project[];
  sessions: Session[];
  activeProjectId?: string;
  activeSessionId?: string;
  messages: Message[];
  runs: Run[];
  busy: boolean;
  live: Record<string, LiveMessage>;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  providers: ProviderDescriptor[];
  budgetsConfigured: boolean;
  budgets: Budget[];
  budgetUsage: BudgetUsage[];
  usage: UsageRecord[];
  view: "chat" | "settings";
  error?: string;
  plans: Plan[];
  planRevisions: Record<string, PlanRevision[]>;
  approvals: ApprovalRequest[];
  agentInstances: AgentInstance[];
  definitions: AgentDefinition[];
  agentLimits: { maxPerSession: number; maxPerProject: number; maxDepth: number };
  isolatedDirs: Array<{ id: string; path: string; realPath: string; kind: string; branch?: string }>;
  testAllowlist: Array<{ id: string; name: string; argv: string[] }>;
  trustedFiles: string[];
  tasks: Task[];
  taskDeps: Record<string, TaskDependency[]>;
  taskAttempts: Record<string, TaskAttempt[]>;
  worktrees: Worktree[];
  worktreeOps: Record<string, WorktreeOperation[]>;
  repoSummary?: RepositorySummary;
  integrations: Integration[];
  integrationCommits: Record<string, IntegrationCommit[]>;
  integrationOps: Record<string, IntegrationOperation[]>;
  integrationConflicts: IntegrationConflict[];
  integrationReviews: Record<string, IntegrationReview[]>;
  integrationValidations: Record<string, Validation[]>;
  integrationApprovals: Record<string, Approval[]>;
  previews: Record<string, Preview[]>;
  previewLogs: Record<string, string>;
  promotions: Record<string, Promotion[]>;
  memories: MemoryItem[];
  recoveryStatus?: { pendingOps: number; startedPromotions: number; livePreviews: number; staleMemories: number; pendingContradictions: number };
}

const [state, setState] = createStore<UIState>({
  projects: [],
  sessions: [],
  messages: [],
  runs: [],
  busy: false,
  live: {},
  permissions: [],
  questions: [],
  providers: [],
  budgetsConfigured: false,
  budgets: [],
  budgetUsage: [],
  usage: [],
  view: "chat",
  plans: [],
  planRevisions: {},
  approvals: [],
  agentInstances: [],
  definitions: [],
  agentLimits: { maxPerSession: 4, maxPerProject: 6, maxDepth: 2 },
  isolatedDirs: [],
  testAllowlist: [],
  trustedFiles: [],
  tasks: [],
  taskDeps: {},
  taskAttempts: {},
  worktrees: [],
  worktreeOps: {},
  repoSummary: undefined,
  integrations: [],
  integrationCommits: {},
  integrationOps: {},
  integrationConflicts: [],
  integrationReviews: {},
  integrationValidations: {},
  integrationApprovals: {},
  previews: {},
  previewLogs: {},
  promotions: {},
  memories: [],
  recoveryStatus: undefined,
});

export { state };

export function setView(view: UIState["view"]): void {
  setState("view", view);
}

export function setError(message?: string): void {
  setState("error", message);
}

async function refreshProjects(): Promise<void> {
  const { projects } = await invoke("projects.list", {});
  setState("projects", projects);
  if (!state.activeProjectId && projects.length > 0) {
    await selectProject(projects[0]!.id);
  }
}

async function refreshSessions(): Promise<void> {
  if (!state.activeProjectId) {
    setState("sessions", []);
    return;
  }
  const { sessions } = await invoke("sessions.list", { projectId: state.activeProjectId });
  setState("sessions", sessions);
  if (state.activeSessionId && !sessions.some((s) => s.id === state.activeSessionId)) {
    setState("activeSessionId", undefined);
    setState("messages", []);
  }
  if (!state.activeSessionId && sessions.length > 0) {
    await selectSession(sessions[0]!.id);
  }
}

async function refreshMessages(): Promise<void> {
  if (!state.activeSessionId) {
    setState("messages", []);
    return;
  }
  const { messages } = await invoke("sessions.messages", { sessionId: state.activeSessionId });
  setState("messages", messages);
}

async function refreshProviders(): Promise<void> {
  const { providers } = await invoke("providers.list", {});
  setState("providers", providers);
}

export async function reloadProviders(): Promise<void> {
  await refreshProviders();
}

async function refreshBudgets(): Promise<void> {
  const status = await invoke("budgets.status", {});
  setState("budgetsConfigured", status.configured);
  setState("budgets", status.budgets);
  setState("budgetUsage", status.usage);
}

export async function reloadBudgets(): Promise<void> {
  await refreshBudgets();
}

async function refreshPending(): Promise<void> {
  const [permissions, questions] = await Promise.all([
    invoke("permissions.pending", { sessionId: state.activeSessionId }),
    invoke("questions.pending", { sessionId: state.activeSessionId }),
  ]);
  setState("permissions", permissions.requests);
  setState("questions", questions.requests);
}

async function refreshUsage(): Promise<void> {
  if (!state.activeSessionId) return;
  const { runs } = await invoke("sessions.get", { sessionId: state.activeSessionId });
  setState("runs", runs);
  // Con varios runs activos, busy mientras alguno siga en planning/executing/integrating/promoting.
  setState("busy", runs.some((r) => r.status === "planning" || r.status === "executing" || r.status === "integrating" || r.status === "promoting"));
  const last = runs[runs.length - 1];
  if (last) {
    const { records } = await invoke("runs.usage", { runId: last.id });
    setState("usage", records);
  }
}

export async function selectProject(projectId: string): Promise<void> {
  setState("activeProjectId", projectId);
  setState("activeSessionId", undefined);
  await refreshSessions();
  await refreshProjectSettings();
  await refreshWorktrees();
  await refreshIntegrations();
  await refreshMemory();
}

export async function selectSession(sessionId: string): Promise<void> {
  setState("activeSessionId", sessionId);
  setState("live", {});
  await Promise.all([refreshMessages(), refreshPending(), refreshUsage(), refreshPlans(), refreshApprovals(), refreshAgents(), refreshTasks(), refreshIntegrations(), refreshMemory()]);
}

export async function createProject(name: string, rootPath: string): Promise<void> {
  const { project } = await invoke("projects.create", { name, rootPath });
  await refreshProjects();
  await selectProject(project.id);
}

export async function createSession(): Promise<void> {
  if (!state.activeProjectId) return;
  const { session } = await invoke("sessions.create", { projectId: state.activeProjectId });
  await refreshSessions();
  await selectSession(session.id);
}

export async function sendPrompt(text: string): Promise<void> {
  if (!state.activeSessionId || !text.trim()) return;
  setError(undefined);
  setState("busy", true);
  try {
    await invoke("sessions.prompt", { sessionId: state.activeSessionId, text });
  } catch (error) {
    setState("busy", false);
    setError(error instanceof Error ? error.message : String(error));
  }
}

export async function interrupt(): Promise<void> {
  if (!state.activeSessionId) return;
  await invoke("sessions.interrupt", { sessionId: state.activeSessionId });
}

export async function setProfile(profile: "plan" | "build"): Promise<void> {
  if (!state.activeSessionId) return;
  await invoke("sessions.setProfile", { sessionId: state.activeSessionId, profile });
  await refreshSessions();
}

async function refreshPlans(): Promise<void> {
  if (!state.activeSessionId) {
    setState("plans", []);
    setState("planRevisions", {});
    return;
  }
  try {
    const { plans } = await invoke("plans.list", { sessionId: state.activeSessionId });
    setState("plans", plans);
    const revisions: Record<string, PlanRevision[]> = {};
    for (const plan of plans) {
      try {
        const detail = await invoke("plans.get", { planId: plan.id });
        revisions[plan.id] = detail.revisions;
      } catch {
        revisions[plan.id] = [];
      }
    }
    setState("planRevisions", revisions);
  } catch {
    // Sin sesión o error transitorio: vacía sin romper el chat.
    setState("plans", []);
    setState("planRevisions", {});
  }
}

async function refreshApprovals(): Promise<void> {
  if (!state.activeSessionId) {
    setState("approvals", []);
    return;
  }
  try {
    const { requests } = await invoke("approvals.pending", { sessionId: state.activeSessionId });
    setState("approvals", requests);
  } catch {
    setState("approvals", []);
  }
}

async function refreshAgents(): Promise<void> {
  if (!state.activeSessionId) {
    setState("agentInstances", []);
    return;
  }
  try {
    const { instances } = await invoke("agents.instances", { sessionId: state.activeSessionId });
    setState("agentInstances", instances);
  } catch {
    setState("agentInstances", []);
  }
}

async function refreshDefinitions(): Promise<void> {
  try {
    const { definitions } = await invoke("agents.definitions", {});
    setState("definitions", definitions);
  } catch {
    setState("definitions", []);
  }
}

async function refreshLimits(): Promise<void> {
  try {
    const { limits } = await invoke("agents.limits", {});
    setState("agentLimits", limits);
  } catch {
    // conserva los defaults
  }
}

async function refreshProjectSettings(): Promise<void> {
  if (!state.activeProjectId) {
    setState("isolatedDirs", []);
    setState("testAllowlist", []);
    setState("trustedFiles", []);
    return;
  }
  try {
    const [dirs, tests, trusted] = await Promise.all([
      invoke("projects.isolatedDirs", { projectId: state.activeProjectId }),
      invoke("projects.testAllowlist", { projectId: state.activeProjectId }),
      invoke("projects.trustedInstructions", { projectId: state.activeProjectId }),
    ]);
    setState("isolatedDirs", dirs.directories);
    setState("testAllowlist", tests.entries);
    setState("trustedFiles", trusted.files);
  } catch {
    setState("isolatedDirs", []);
    setState("testAllowlist", []);
    setState("trustedFiles", []);
  }
}

export async function reloadStage2(): Promise<void> {
  await Promise.all([refreshPlans(), refreshApprovals(), refreshAgents(), refreshDefinitions(), refreshLimits(), refreshProjectSettings()]);
}

export async function approveRevision(planId: string, revisionId: string): Promise<void> {
  const result = await invoke("plans.approve", { planId, revisionId });
  if (!result.ok) setError(result.error ?? "Approve failed");
  else setError(undefined);
  await Promise.all([refreshPlans(), refreshApprovals()]);
}

export async function rejectRevision(planId: string, revisionId: string): Promise<void> {
  const result = await invoke("plans.reject", { planId, revisionId });
  if (!result.ok) setError(result.error ?? "Reject failed");
  else setError(undefined);
  await Promise.all([refreshPlans(), refreshApprovals()]);
}

export async function archivePlan(planId: string): Promise<void> {
  const result = await invoke("plans.archive", { planId });
  if (!result.ok) setError(result.error ?? "Archive failed");
  else setError(undefined);
  await refreshPlans();
}

export async function exportRevision(planId: string, revisionId: string, version: number): Promise<void> {
  const picked = await invoke("app.pickDirectory", {});
  if (!picked.path) return;
  const sep = picked.path.endsWith("/") || picked.path.endsWith("\\") ? "" : "/";
  const target = `${picked.path}${sep}${planId}-v${version}.md`;
  const result = await invoke("plans.export", { planId, revisionId, path: target });
  if (!result.ok) setError(result.error ?? "Export failed");
  else setError(undefined);
}

export async function implementRevision(planId: string, revisionId: string): Promise<void> {
  if (!state.activeSessionId) return;
  setError(undefined);
  setState("busy", true);
  try {
    await invoke("plans.implement", { sessionId: state.activeSessionId, planId, revisionId });
  } catch (error) {
    setState("busy", false);
    setError(error instanceof Error ? error.message : String(error));
  }
}

export async function decideApproval(requestId: string, decision: "approved" | "rejected"): Promise<void> {
  const result = await invoke("approvals.decide", { requestId, decision });
  if (!result.ok) setError(result.error ?? "Decision failed");
  else setError(undefined);
  await Promise.all([refreshPlans(), refreshApprovals()]);
}

export async function cancelAgent(instanceId: string): Promise<void> {
  const result = await invoke("agents.cancel", { instanceId });
  if (!result.ok) setError(result.error ?? "Cancel failed");
  else setError(undefined);
  await refreshAgents();
}

async function refreshTasks(): Promise<void> {
  if (!state.activeSessionId) {
    setState("tasks", []);
    setState("taskDeps", {});
    setState("taskAttempts", {});
    return;
  }
  try {
    const { tasks } = await invoke("tasks.list", { sessionId: state.activeSessionId });
    setState("tasks", tasks);
    const deps: Record<string, TaskDependency[]> = {};
    const attempts: Record<string, TaskAttempt[]> = {};
    for (const task of tasks) {
      try {
        const detail = await invoke("tasks.get", { taskId: task.id });
        deps[task.id] = detail.dependencies;
        attempts[task.id] = detail.attempts;
      } catch {
        deps[task.id] = [];
        attempts[task.id] = [];
      }
    }
    setState("taskDeps", deps);
    setState("taskAttempts", attempts);
  } catch {
    setState("tasks", []);
    setState("taskDeps", {});
    setState("taskAttempts", {});
  }
}

export async function cancelTask(taskId: string): Promise<void> {
  const result = await invoke("tasks.cancel", { taskId });
  if (!result.ok) setError(result.error ?? "Cancel failed");
  else setError(undefined);
  await refreshTasks();
}

export async function retryTask(taskId: string): Promise<void> {
  const result = await invoke("tasks.retry", { taskId });
  if (!result.ok) setError(result.error ?? "Retry failed");
  else setError(undefined);
  await refreshTasks();
}

export async function reviewTask(reviewerTaskId: string, targetTaskId: string, verdict: "accept" | "request-changes"): Promise<void> {
  const result = await invoke("tasks.review", { reviewerTaskId, targetTaskId, verdict });
  if (!result.ok) setError(result.error ?? "Review failed");
  else setError(undefined);
  await refreshTasks();
}

async function refreshWorktrees(): Promise<void> {
  if (!state.activeProjectId) {
    setState("worktrees", []);
    setState("worktreeOps", {});
    setState("repoSummary", undefined);
    return;
  }
  try {
    const [{ worktrees }, { summary }] = await Promise.all([
      invoke("worktrees.list", { projectId: state.activeProjectId }),
      invoke("repos.inspect", { projectId: state.activeProjectId }),
    ]);
    setState("worktrees", worktrees);
    setState("repoSummary", summary);
    const ops: Record<string, WorktreeOperation[]> = {};
    for (const wt of worktrees) {
      try {
        const detail = await invoke("worktrees.get", { worktreeId: wt.id });
        if (detail.ok) ops[wt.id] = detail.operations ?? [];
        else ops[wt.id] = [];
      } catch {
        ops[wt.id] = [];
      }
    }
    setState("worktreeOps", ops);
  } catch {
    setState("worktrees", []);
    setState("worktreeOps", {});
    setState("repoSummary", undefined);
  }
}

export async function reloadWorktrees(): Promise<void> {
  await refreshWorktrees();
}

export async function cleanupWorktree(worktreeId: string, deleteBranch?: boolean): Promise<void> {
  const result = await invoke("worktrees.cleanup", { worktreeId, deleteBranch });
  if (!result.ok) setError(result.error ?? "Cleanup failed");
  else setError(undefined);
  await refreshWorktrees();
}

export async function setWorktreesRoot(path: string): Promise<void> {
  if (!state.activeProjectId) return;
  const result = await invoke("repos.setWorktreesRoot", { projectId: state.activeProjectId, path });
  if (!result.ok) setError(result.error ?? "Could not set worktrees root");
  else setError(undefined);
  await refreshWorktrees();
}

export async function reloadIntegrations(): Promise<void> {
  await refreshIntegrations();
}

export async function reloadMemory(): Promise<void> {
  await refreshMemory();
}

async function refreshAfterMemoryAction(ok: boolean, error?: string): Promise<void> {
  if (!ok) setError(error ?? "Memory action failed");
  else setError(undefined);
  await refreshMemory();
}

/** Memorias visibles de la sesión activa (proyecto + sesión + runs/tasks/instancias cargadas). */
async function refreshMemory(): Promise<void> {
  if (!state.activeProjectId) {
    setState("memories", []);
    setState("recoveryStatus", undefined);
    return;
  }
  try {
    const { entries } = await invoke("memory.list", {});
    const known = new Set<string>([state.activeProjectId]);
    if (state.activeSessionId) known.add(state.activeSessionId);
    for (const r of state.runs) known.add(r.id);
    for (const t of state.tasks) known.add(t.id);
    for (const i of state.agentInstances) known.add(i.id);
    setState("memories", entries.filter((e) => known.has(e.scopeId)));
  } catch {
    setState("memories", []);
  }
  try {
    setState("recoveryStatus", await invoke("recovery.status", {}));
  } catch {
    setState("recoveryStatus", undefined);
  }
}

export async function proposeMemory(input: { scope: MemoryItem["scope"]; scopeId: string; category: string; topic: string; content: string; source: string }): Promise<void> {
  const result = await invoke("memory.propose", input);
  await refreshAfterMemoryAction(result.ok, result.error);
}

export async function validateMemory(id: string): Promise<void> {
  const result = await invoke("memory.validate", { id });
  await refreshAfterMemoryAction(result.ok, result.error);
}

export async function decideMemory(id: string, decision: "verified" | "approved" | "rejected"): Promise<void> {
  const result = await invoke("memory.decide", { id, decision });
  await refreshAfterMemoryAction(result.ok, result.error);
}

export async function revalidateMemory(id: string): Promise<void> {
  const result = await invoke("memory.revalidate", { id });
  await refreshAfterMemoryAction(result.ok, result.error);
}

export async function resolveMemoryConflict(winnerId: string): Promise<void> {
  const result = await invoke("memory.resolve", { winnerId });
  await refreshAfterMemoryAction(result.ok, result.error);
}

export async function reconcileRecovery(): Promise<void> {
  const result = await invoke("recovery.reconcile", {});
  if (!result.ok) setError(result.error ?? "Recovery reconcile failed");
  else setError(undefined);
  await Promise.all([refreshMemory(), refreshTasks(), refreshIntegrations()]);
}

async function refreshAfterIntegrationAction(ok: boolean, error?: string): Promise<void> {
  if (!ok) setError(error ?? "Integration action failed");
  else setError(undefined);
  await Promise.all([refreshIntegrations(), refreshTasks()]);
}

export async function incorporateIntegration(integrationId: string): Promise<void> {
  const result = await invoke("integrations.incorporate", { integrationId });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

export async function rebuildIntegration(integrationId: string): Promise<void> {
  const result = await invoke("integrations.rebuild", { integrationId });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

export async function abortIntegration(integrationId: string): Promise<void> {
  const result = await invoke("integrations.abort", { integrationId });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

export async function requestConflictResolution(conflictId: string): Promise<void> {
  const result = await invoke("conflicts.requestResolution", { conflictId });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

export async function finalizeConflictResolution(conflictId: string, instanceId: string): Promise<void> {
  const result = await invoke("conflicts.finalize", { conflictId, instanceId });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

export async function incorporateConflictResolution(integrationId: string, conflictId: string): Promise<void> {
  const result = await invoke("conflicts.incorporate", { integrationId, conflictId });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

export async function abortConflict(conflictId: string): Promise<void> {
  const result = await invoke("conflicts.abort", { conflictId });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

export async function cleanupConflictResolution(conflictId: string): Promise<void> {
  const result = await invoke("conflicts.cleanup", { conflictId });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

export async function rerunValidations(integrationId: string): Promise<void> {
  const result = await invoke("validations.rerun", { integrationId });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

export async function spawnIntegrationReviewer(integrationId: string): Promise<string | undefined> {
  const result = await invoke("integrations.spawnReviewer", { integrationId });
  if (!result.ok) {
    setError(result.error ?? "Could not spawn reviewer");
    return undefined;
  }
  setError(undefined);
  await refreshAgents();
  return result.instanceId;
}

export async function recordIntegrationReview(integrationId: string, instanceId: string, verdict: "accept" | "request-changes"): Promise<void> {
  const result = await invoke("integrations.review", { integrationId, instanceId, verdict });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

export async function createPreview(integrationId: string): Promise<void> {
  const result = await invoke("previews.create", { integrationId });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

export async function startPreview(previewId: string, startEntryId?: string): Promise<void> {
  const result = await invoke("previews.start", { previewId, startEntryId });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

export async function stopPreview(previewId: string): Promise<void> {
  const result = await invoke("previews.stop", { previewId });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

export async function restartPreview(previewId: string, startEntryId?: string): Promise<void> {
  const result = await invoke("previews.restart", { previewId, startEntryId });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

export async function cleanupPreview(previewId: string): Promise<void> {
  const result = await invoke("previews.cleanup", { previewId });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

export async function inspectPreview(previewId: string): Promise<void> {
  const result = await invoke("previews.inspect", { previewId });
  if (result.error) setError(result.error);
  else setError(undefined);
  await refreshIntegrations();
}

export async function loadPreviewLogs(previewId: string): Promise<void> {
  const { logs } = await invoke("previews.logs", { previewId });
  setState("previewLogs", previewId, logs);
}

export async function approveIntegration(integrationId: string, opts?: { previewId?: string; waiverReason?: string }): Promise<void> {
  const result = await invoke("approvals.approve", { integrationId, previewId: opts?.previewId, waiverReason: opts?.waiverReason });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

export async function rejectIntegration(integrationId: string): Promise<void> {
  const result = await invoke("approvals.reject", { integrationId });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

export async function promoteIntegration(integrationId: string): Promise<void> {
  const result = await invoke("promotions.promote", { integrationId });
  await refreshAfterIntegrationAction(result.ok, result.error);
}

async function refreshIntegrations(): Promise<void> {
  if (!state.activeSessionId) {
    setState("integrations", []);
    setState("integrationCommits", {});
    setState("integrationOps", {});
    setState("integrationConflicts", []);
    setState("integrationReviews", {});
    setState("integrationValidations", {});
    setState("integrationApprovals", {});
    setState("previews", {});
    setState("previewLogs", {});
    setState("promotions", {});
    return;
  }
  try {
    const { runs } = await invoke("sessions.get", { sessionId: state.activeSessionId });
    const lists = await Promise.all(runs.map((r) => invoke("integrations.list", { runId: r.id }).catch(() => ({ integrations: [] as Integration[] }))));
    const integrations = lists.flatMap((l) => l.integrations);
    setState("integrations", integrations);
    const commits: Record<string, IntegrationCommit[]> = {};
    const ops: Record<string, IntegrationOperation[]> = {};
    const reviews: Record<string, IntegrationReview[]> = {};
    const validations: Record<string, Validation[]> = {};
    const approvals: Record<string, Approval[]> = {};
    const previews: Record<string, Preview[]> = {};
    const promotions: Record<string, Promotion[]> = {};
    for (const ig of integrations) {
      try {
        const detail = await invoke("integrations.get", { integrationId: ig.id });
        commits[ig.id] = detail.integration ? detail.commits : [];
        ops[ig.id] = detail.integration ? detail.operations : [];
      } catch {
        commits[ig.id] = [];
        ops[ig.id] = [];
      }
      try {
        const v = await invoke("validations.list", { integrationId: ig.id });
        validations[ig.id] = v.validations;
        reviews[ig.id] = v.reviews;
      } catch {
        validations[ig.id] = [];
        reviews[ig.id] = [];
      }
      try {
        const st = await invoke("approvals.status", { integrationId: ig.id });
        approvals[ig.id] = st.approval ? [st.approval] : [];
      } catch {
        approvals[ig.id] = [];
      }
      try {
        const { promotions: proms } = await invoke("promotions.status", { integrationId: ig.id });
        promotions[ig.id] = proms;
      } catch {
        promotions[ig.id] = [];
      }
      try {
        const { previews: list } = await invoke("previews.list", { integrationId: ig.id });
        previews[ig.id] = list;
      } catch {
        previews[ig.id] = [];
      }
    }
    // Previews por integración: la UI los pide bajo demanda (inspect), aquí solo ids conocidos.
    try {
      const conflicts: IntegrationConflict[] = [];
      for (const ig of integrations) {
        const { conflicts: list } = await invoke("conflicts.list", { scopeRef: ig.id });
        conflicts.push(...list);
      }
      setState("integrationConflicts", conflicts);
    } catch {
      setState("integrationConflicts", []);
    }
    setState("integrationCommits", commits);
    setState("integrationOps", ops);
    setState("integrationReviews", reviews);
    setState("integrationValidations", validations);
    setState("integrationApprovals", approvals);
    setState("promotions", promotions);
    setState("previews", previews);
  } catch {
    setState("integrations", []);
    setState("integrationCommits", {});
    setState("integrationOps", {});
    setState("integrationConflicts", []);
    setState("integrationReviews", {});
    setState("integrationValidations", {});
    setState("integrationApprovals", {});
    setState("previews", {});
    setState("previewLogs", {});
    setState("promotions", {});
  }
}

function applyEvent(event: CoreEvent): void {
  if (event.kind === "part.delta") {
    setState("live", event.messageId, (prev: LiveMessage | undefined) => {
      const base = prev ?? { id: event.messageId, text: "", reasoning: "", toolArgs: {} };
      if (event.part === "text") return { ...base, text: base.text + event.delta };
      if (event.part === "reasoning_summary") return { ...base, reasoning: base.reasoning + event.delta };
      const key = event.key ?? "?";
      return { ...base, toolArgs: { ...base.toolArgs, [key]: (base.toolArgs[key] ?? "") + event.delta } };
    });
    return;
  }
  if (event.kind === "part.done") return;
  if (event.kind === "step.retry") {
    setState("live", event.messageId, { id: event.messageId, text: "", reasoning: "", toolArgs: {} });
    return;
  }
  const persisted = event.event;
  switch (persisted.type) {
    case "message.appended": {
      const message = persisted.payload.message as Message;
      if (message.sessionId === state.activeSessionId) {
        setState("messages", (messages) => (messages.some((m) => m.id === message.id) ? messages : [...messages, message]));
        if (message.role === "assistant") {
          const live = { ...state.live };
          delete live[message.id];
          setState("live", live);
        }
      }
      break;
    }
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
      setState("busy", false);
      void refreshMessages();
      void refreshUsage();
      void refreshBudgets();
      void refreshPlans();
      void refreshApprovals();
      void refreshAgents();
      void refreshTasks();
      void refreshIntegrations();
      break;
    case "run.created":
    case "run.started":
      setState("busy", true);
      break;
    case "run.status_changed":
      setState("busy", true);
      void refreshUsage();
      void refreshIntegrations();
      break;
    case "task.created":
    case "task.status_changed":
    case "task.progress":
    case "task_attempt.created":
    case "task_attempt.status_changed":
    case "planning.created":
    case "planning.rejected":
    case "review.recorded":
    case "scheduler.assigned":
      void refreshTasks();
      void refreshAgents();
      break;
    case "session.created":
    case "session.updated":
      void refreshSessions();
      break;
    case "permission.asked":
    case "permission.replied":
      void refreshPending();
      break;
    case "question.asked":
    case "question.replied":
      void refreshPending();
      break;
    case "budget.warning":
    case "budget.exceeded":
    case "budgets.configured":
      void refreshBudgets();
      break;
    case "provider.usage_recorded":
      void refreshUsage();
      void refreshBudgets();
      break;
    case "plan.created":
    case "plan.revision_created":
    case "plan.revision_presented":
    case "plan.revision_orphaned":
    case "plan.approved":
    case "plan.rejected":
    case "plan.archived":
    case "plan.exported":
    case "plan.approval_requested":
    case "plan.approval_decided":
      void refreshPlans();
      void refreshApprovals();
      break;
    case "agent_instance.created":
    case "agent_instance.started":
    case "agent_instance.status_changed":
    case "agent_instance.completed":
    case "agent_instance.failed":
    case "agent_instance.cancelled":
    case "agent.delivery_ready":
      void refreshAgents();
      break;
    case "worktree.created":
    case "worktree.released":
    case "worktree.status_changed":
    case "worktree.removed":
      void refreshWorktrees();
      void refreshAgents();
      break;
    case "workbase.created":
    case "workbase.status_changed":
    case "integration.created":
    case "integration.conflict_opened":
    case "integration.conflict_resolved":
    case "integration.validated":
    case "integration.reviewed":
    case "integration.status_changed":
    case "integration.completed":
    case "preview.created":
    case "preview.ready":
    case "preview.started":
    case "preview.stopped":
    case "approval.granted":
    case "approval.rejected":
    case "approval.invalidated":
    case "promotion.started":
    case "promotion.failed":
    case "promotion.completed":
    case "resolution.requested":
    case "resolution.completed":
      void refreshIntegrations();
      break;
    case "memory.recorded":
    case "memory.status_changed":
      void refreshMemory();
      break;
    default:
      break;
  }
}

export async function initStore(): Promise<void> {
  onEvent(applyEvent);
  await refreshProjects();
  await refreshSessions();
  await refreshProviders();
  await refreshBudgets();
  await refreshPending();
  await reloadStage2();
}
