/** Renderer/store — bienvenida (Todo 10, F-1/W-01): error visible, rutas rotas y validación en main. */
import { invoke } from "../api.js";
import { setState, state } from "./state.js";

export function setWelcomeError(message?: string): void {
  setState("welcomeError", message);
}

export function markProjectBroken(projectId: string): void {
  if (!state.brokenProjectIds.includes(projectId)) {
    setState("brokenProjectIds", [...state.brokenProjectIds, projectId]);
  }
}

export function isProjectBroken(projectId: string): boolean {
  return state.brokenProjectIds.includes(projectId);
}

export async function validateDirectory(path: string): Promise<{ ok: boolean; error?: string; realPath?: string }> {
  return invoke("app.validateDirectory", { path });
}
