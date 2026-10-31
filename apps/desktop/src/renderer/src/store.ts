/** Renderer — estado global y aplicación de eventos del core. */
import { createStore } from "solid-js/store";
import type {
  AgentDefinition,
  AgentInstance,
  ApprovalRequest,
  Budget,
  BudgetUsage,
  CoreEvent,
  Message,
  PermissionRequest,
  Plan,
  PlanRevision,
  Project,
  ProviderDescriptor,
  QuestionRequest,
  Run,
  Session,
  Task,
  TaskDependency,
  TaskAttempt,
  UsageRecord,
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
  // Con varios runs activos, busy mientras alguno siga en planning/executing.
  setState("busy", runs.some((r) => r.status === "planning" || r.status === "executing"));
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
}

export async function selectSession(sessionId: string): Promise<void> {
  setState("activeSessionId", sessionId);
  setState("live", {});
  await Promise.all([refreshMessages(), refreshPending(), refreshUsage(), refreshPlans(), refreshApprovals(), refreshAgents(), refreshTasks()]);
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
      break;
    case "run.created":
    case "run.started":
      setState("busy", true);
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
