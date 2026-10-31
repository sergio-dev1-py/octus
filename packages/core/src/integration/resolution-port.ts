/**
 * @octus/core — puerto mínimo que AgentManager necesita de ConflictManager (Etapa 5).
 * Import type-only: sin ciclos (ConflictManager nunca importa AgentManager como valor).
 */
export type ResolutionWorkspaceStatus = "open" | "resolving" | "resolved" | "aborted";

export interface ResolutionWorkspace {
  id: string;
  projectId: string;
  path: string;
  branchName: string;
  status: ResolutionWorkspaceStatus;
}

export interface ResolutionPort {
  getResolutionWorkspace(conflictId: string): Promise<ResolutionWorkspace | undefined>;
}
