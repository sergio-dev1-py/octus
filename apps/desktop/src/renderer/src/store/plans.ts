/** Renderer/store — planes, revisiones, aprobaciones humanas y agentes. */
import type { PlanRevision } from "@octus/shared";
import { invoke } from "../api.js";
import { setError, state, setState } from "./state.js";

export async function refreshPlans(): Promise<void> {
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

export async function refreshApprovals(): Promise<void> {
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

export async function refreshAgents(): Promise<void> {
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
