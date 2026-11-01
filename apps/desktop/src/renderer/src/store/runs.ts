/** Renderer/store — ficha de run para la vista de agentes (Todo 16).
 * Reutiliza canales existentes: sessions.get (lista) y runs.get (detalle con
 * instancias y tool calls). Sin agentes ficticios: todo viene del core.
 * Un run cancelado muestra su estado final real (status + error + completedAt),
 * nunca progreso congelado (W-A4, caso failure del Todo 16). */
import { invoke } from "../api.js";
import { setError, state, setState } from "./state.js";

export async function refreshRunDetail(): Promise<void> {
  if (!state.activeSessionId) {
    setState("selectedRunId", undefined);
    setState("runDetail", undefined);
    return;
  }
  const target = state.selectedRunId ?? state.runs[state.runs.length - 1]?.id;
  if (!target) {
    setState("runDetail", undefined);
    return;
  }
  try {
    const detail = await invoke("runs.get", { runId: target });
    setState("selectedRunId", target);
    setState("runDetail", { run: detail.run, instances: detail.instances, toolCalls: detail.toolCalls });
  } catch {
    setState("runDetail", undefined);
  }
}

export async function selectRun(runId: string): Promise<void> {
  setState("selectedRunId", runId);
  setError(undefined);
  await refreshRunDetail();
}
