/** Renderer/store — memorias visibles y reconciliación de recuperación. */
import type { MemoryItem } from "@octus/shared";
import { invoke } from "../api.js";
import { setError, state, setState } from "./state.js";
import { refreshTasks } from "./tasks.js";
import { refreshIntegrations } from "./integrations.js";

async function refreshAfterMemoryAction(ok: boolean, error?: string): Promise<void> {
  if (!ok) setError(error ?? "Memory action failed");
  else setError(undefined);
  await refreshMemory();
}

/** Memorias visibles de la sesión activa (proyecto + sesión + runs/tasks/instancias cargadas). */
export async function refreshMemory(): Promise<void> {
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

export async function reloadMemory(): Promise<void> {
  await refreshMemory();
}
