/**
 * @octus/core — puerto mínimo que AgentManager necesita de WorktreeManager (Etapa 4).
 * Import type-only: sin ciclos (WorktreeManager nunca importa AgentManager).
 */
import type { WorktreeStatus } from "@octus/shared";

export interface WorktreeAssignment {
  id: string;
  projectId: string;
  taskId: string;
  path: string;
  branch: string;
  baseCommit: string;
  status: WorktreeStatus;
}

export interface WorktreePort {
  getAssignment(worktreeId: string): Promise<WorktreeAssignment | undefined>;
}
