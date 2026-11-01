/** Renderer/store — tareas, dependencias, intentos y revisiones. */
import type { TaskDependency, TaskAttempt } from "@octus/shared";
import { invoke } from "../api.js";
import { setError, state, setState } from "./state.js";

export async function refreshTasks(): Promise<void> {
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
