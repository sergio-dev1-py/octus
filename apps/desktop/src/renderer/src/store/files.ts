/** Renderer/store — Todo 33: explorador paginado, diff, modificados, pruebas y diagnósticos. */
import type { DiagnosticProblem, ExplorerEntry, ExplorerPage } from "@octus/shared";
import { invoke } from "../api.js";
import { setError, state, setState } from "./state.js";

/**
 * Clonación en la frontera del store (Todo 33): SolidJS fusiona in-place los
 * objetos guardados y mutaría la respuesta IPC si se almacenara por referencia
 * (aliasing stale_state: el mismo objeto respondería distinto en la 2.ª lectura).
 * En producción cada respuesta IPC ya es fresca, pero el store nunca confía en eso.
 */
function clonePage(page: ExplorerPage): ExplorerPage {
  return { ...page, entries: page.entries.map((e: ExplorerEntry) => ({ ...e })) };
}

function cloneProblems(problems: DiagnosticProblem[]): DiagnosticProblem[] {
  return problems.map((p) => ({ ...p }));
}

export async function refreshExplorer(relDir?: string, page?: number): Promise<void> {
  if (!state.activeProjectId) {
    setState("explorerPage", undefined);
    return;
  }
  const dir = relDir ?? state.explorerRelDir;
  try {
    const result = await invoke("files.list", { projectId: state.activeProjectId, relDir: dir, page: page ?? 1, pageSize: 50 });
    if (!result.ok) {
      setState("explorerError", result.error ?? "List failed");
      return;
    }
    setState("explorerRelDir", dir);
    setState("explorerPage", result.page ? clonePage(result.page) : undefined);
    setState("explorerError", undefined);
  } catch (error) {
    setState("explorerError", error instanceof Error ? error.message : String(error));
  }
}

export async function openExplorerFile(relPath: string): Promise<void> {
  if (!state.activeProjectId) return;
  try {
    const result = await invoke("files.read", { projectId: state.activeProjectId, relPath });
    if (!result.ok) {
      setState("explorerError", result.error ?? "Read failed");
      return;
    }
    setState("explorerFile", result.file ? { ...result.file } : undefined);
    setState("explorerError", undefined);
  } catch (error) {
    setState("explorerError", error instanceof Error ? error.message : String(error));
  }
}

export async function refreshRepoDiff(opts?: { staged?: boolean; stat?: boolean }): Promise<void> {
  if (!state.activeProjectId) return;
  try {
    const result = await invoke("repos.diff", { projectId: state.activeProjectId, staged: opts?.staged, stat: opts?.stat });
    if (!result.ok) {
      setState("repoDiffError", result.error ?? "Diff failed");
      return;
    }
    setState("repoDiff", result.diff ?? "");
    setState("repoDiffTruncated", result.truncated ?? false);
    setState("repoDiffError", undefined);
  } catch (error) {
    setState("repoDiffError", error instanceof Error ? error.message : String(error));
  }
}

export async function refreshModified(): Promise<void> {
  if (!state.activeProjectId) {
    setState("modifiedFiles", []);
    return;
  }
  try {
    const result = await invoke("repos.modified", { projectId: state.activeProjectId });
    if (!result.ok) {
      setError(result.error ?? "Modified list failed");
      return;
    }
    setState("modifiedFiles", (result.files ?? []).map((f) => ({ ...f })));
    setState("modifiedIsGit", result.isGit ?? false);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

export async function runProjectTest(entryId: string): Promise<void> {
  if (!state.activeProjectId) return;
  setState("testRunning", true);
  setState("testRunError", undefined);
  try {
    const result = await invoke("tests.run", { projectId: state.activeProjectId, entryId });
    if (!result.ok) {
      setState("testRunError", result.error ?? "Test run failed");
      setState("testRunResult", undefined);
      return;
    }
    setState("testRunResult", { entryId: result.entryId ?? entryId, exitCode: result.exitCode ?? 0, output: result.output ?? "", truncated: result.truncated ?? false, durationMs: result.durationMs ?? 0 });
  } catch (error) {
    setState("testRunError", error instanceof Error ? error.message : String(error));
    setState("testRunResult", undefined);
  } finally {
    setState("testRunning", false);
  }
}

export async function refreshDiagnostics(): Promise<void> {
  if (!state.activeProjectId) {
    setState("diagnostics", []);
    return;
  }
  try {
    const result = await invoke("diagnostics.list", { projectId: state.activeProjectId });
    if (!result.ok) return;
    setState("diagnostics", cloneProblems(result.problems ?? []));
  } catch {
    setState("diagnostics", []);
  }
}

/** Refresco conjunto del Todo 33 tras seleccionar proyecto. */
export async function refreshFilesWorkspace(): Promise<void> {
  await Promise.all([refreshExplorer("." , 1), refreshModified(), refreshDiagnostics()]);
}
