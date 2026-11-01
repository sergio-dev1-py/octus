/** Renderer/store — worktrees y repositorio del proyecto. */
import type { WorktreeOperation } from "@octus/shared";
import { invoke } from "../api.js";
import { setError, state, setState } from "./state.js";

export async function refreshWorktrees(): Promise<void> {
  if (!state.activeProjectId) {
    setState("worktrees", []);
    setState("worktreeOps", {});
    setState("repoSummary", undefined);
    return;
  }
  try {
    const [{ worktrees }, { summary }] = await Promise.all([
      invoke("worktrees.list", { projectId: state.activeProjectId }),
      invoke("repos.inspect", { projectId: state.activeProjectId }),
    ]);
    setState("worktrees", worktrees);
    setState("repoSummary", summary);
    const ops: Record<string, WorktreeOperation[]> = {};
    for (const wt of worktrees) {
      try {
        const detail = await invoke("worktrees.get", { worktreeId: wt.id });
        if (detail.ok) ops[wt.id] = detail.operations ?? [];
        else ops[wt.id] = [];
      } catch {
        ops[wt.id] = [];
      }
    }
    setState("worktreeOps", ops);
  } catch {
    setState("worktrees", []);
    setState("worktreeOps", {});
    setState("repoSummary", undefined);
  }
}

export async function reloadWorktrees(): Promise<void> {
  await refreshWorktrees();
}

export async function cleanupWorktree(worktreeId: string, deleteBranch?: boolean): Promise<void> {
  const result = await invoke("worktrees.cleanup", { worktreeId, deleteBranch });
  if (!result.ok) setError(result.error ?? "Cleanup failed");
  else setError(undefined);
  await refreshWorktrees();
}

export async function setWorktreesRoot(path: string): Promise<void> {
  if (!state.activeProjectId) return;
  const result = await invoke("repos.setWorktreesRoot", { projectId: state.activeProjectId, path });
  if (!result.ok) setError(result.error ?? "Could not set worktrees root");
  else setError(undefined);
  await refreshWorktrees();
}
