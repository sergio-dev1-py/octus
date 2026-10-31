/**
 * @octus/core — puerto mínimo que WorktreeManager necesita de IntegrationManager (Etapa 5).
 * Import type-only: sin ciclos (IntegrationManager nunca importa WorktreeManager como valor).
 */
import type { WorkBaseStatus } from "@octus/shared";

export interface WorkBaseAssignment {
  id: string;
  projectId: string;
  taskId: string;
  tipSha: string;
  branchName: string;
  path: string;
  status: WorkBaseStatus;
  reused: boolean;
}

export interface IntegrationWorkspace {
  id: string;
  projectId: string;
  path: string;
  branchName: string;
  status: string;
}

export type EnsureWorkBaseResult =
  | { ok: true; workBaseId: string; tipSha: string; branch: string; path: string; reused: boolean }
  | { ok: false; blockedReason: "deps-unavailable" | "repo-blocked" | "no-capacity"; details: Record<string, unknown> };

export interface IntegrationPort {
  ensureWorkBaseForTask(input: { projectId: string; runId: string; taskId: string; predecessorIds: string[] }): Promise<EnsureWorkBaseResult>;
  getWorkBase(taskId: string): Promise<WorkBaseAssignment | undefined>;
  getIntegrationWorkspace(integrationId: string): Promise<IntegrationWorkspace | undefined>;
}
