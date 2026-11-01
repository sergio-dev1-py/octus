/** Renderer/store — proyectos, sesiones, mensajes, proveedores, presupuestos y prompts. */
import { invoke } from "../api.js";
import { setError, state, setState } from "./state.js";
import { refreshPlans, refreshApprovals, refreshAgents } from "./plans.js";
import { refreshProjectSettings } from "./settings.js";
import { refreshTasks } from "./tasks.js";
import { refreshWorktrees } from "./worktrees.js";
import { refreshIntegrations } from "./integrations.js";
import { refreshMemory } from "./memory.js";

export async function refreshProjects(): Promise<void> {
  const { projects } = await invoke("projects.list", {});
  setState("projects", projects);
  if (!state.activeProjectId && projects.length > 0) {
    await selectProject(projects[0]!.id);
  }
}

export async function refreshSessions(): Promise<void> {
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

export async function refreshMessages(): Promise<void> {
  if (!state.activeSessionId) {
    setState("messages", []);
    return;
  }
  const { messages } = await invoke("sessions.messages", { sessionId: state.activeSessionId });
  setState("messages", messages);
}

export async function refreshProviders(): Promise<void> {
  const { providers } = await invoke("providers.list", {});
  setState("providers", providers);
}

export async function reloadProviders(): Promise<void> {
  await refreshProviders();
}

export async function refreshBudgets(): Promise<void> {
  const status = await invoke("budgets.status", {});
  setState("budgetsConfigured", status.configured);
  setState("budgets", status.budgets);
  setState("budgetUsage", status.usage);
}

export async function reloadBudgets(): Promise<void> {
  await refreshBudgets();
}

export async function refreshPending(): Promise<void> {
  const [permissions, questions] = await Promise.all([
    invoke("permissions.pending", { sessionId: state.activeSessionId }),
    invoke("questions.pending", { sessionId: state.activeSessionId }),
  ]);
  setState("permissions", permissions.requests);
  setState("questions", questions.requests);
}

export async function refreshUsage(): Promise<void> {
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
