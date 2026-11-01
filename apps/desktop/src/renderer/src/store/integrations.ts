/** Renderer/store — integraciones, conflictos, validaciones, previews, aprobaciones y promociones. */
import type { Approval, Integration, IntegrationCommit, IntegrationConflict, IntegrationOperation, IntegrationReview, Preview, Promotion, Validation } from "@octus/shared";
import { invoke } from "../api.js";
import { setError, state, setState } from "./state.js";
import { refreshAgents } from "./plans.js";
import { refreshTasks } from "./tasks.js";

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

export async function refreshIntegrations(): Promise<void> {
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

export async function reloadIntegrations(): Promise<void> {
  await refreshIntegrations();
}
