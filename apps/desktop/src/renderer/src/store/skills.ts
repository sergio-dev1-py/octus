/** Renderer/store — Skills (Todo 24): catálogo, detalle, importar, habilitar e historial. */
import { invoke } from "../api.js";
import { setState, state } from "./state.js";

export async function refreshSkillsCatalog(): Promise<void> {
  try {
    const { skills, errors } = await invoke("skills.catalog", state.activeProjectId ? { projectId: state.activeProjectId } : {});
    setState("skillsCatalog", skills);
    setState("skillsErrors", errors);
    // La selección sigue viva solo si la skill continúa en el catálogo.
    if (state.skillsSelected && !skills.some((s) => s.name === state.skillsSelected)) {
      setState("skillsSelected", undefined);
      setState("skillsDetail", undefined);
    }
    if (state.skillsSelected) await refreshSkillsDetail(state.skillsSelected);
  } catch {
    setState("skillsCatalog", []);
    setState("skillsErrors", []);
    setState("skillsDetail", undefined);
  }
}

export async function refreshSkillsDetail(name: string): Promise<void> {
  try {
    const { detail } = await invoke("skills.inspect", state.activeProjectId ? { name, projectId: state.activeProjectId } : { name });
    setState("skillsDetail", detail);
  } catch {
    setState("skillsDetail", undefined);
  }
}

export function selectSkill(name: string | undefined): void {
  setState("skillsSelected", name);
  setState("skillsDetail", undefined);
  if (name) void refreshSkillsDetail(name);
}

export function setSkillsFilter(filter: "all" | "installed" | "enabled"): void {
  setState("skillsFilter", filter);
}

export function setSkillsSearch(search: string): void {
  setState("skillsSearch", search);
}

export function setSkillsHistoryRun(runId: string): void {
  setState("skillsHistoryRun", runId);
}

export function skillsNotice(message?: string): void {
  setState("skillsNotice", message);
}

/** Habilitar: el backend bloquea si el SKILL.md no valida (muestra la cláusula). */
export async function enableSkill(name: string, scope?: "global" | "project" | "managed"): Promise<void> {
  if (!state.activeProjectId) {
    skillsNotice("Elige un proyecto para habilitar skills.");
    return;
  }
  const result = await invoke("skills.enable", scope ? { projectId: state.activeProjectId, name, scope } : { projectId: state.activeProjectId, name });
  skillsNotice(result.ok ? `Habilitada ${name} en este proyecto.` : (result.error ?? "No se pudo habilitar."));
  await refreshSkillsCatalog();
}

export async function disableSkill(name: string): Promise<void> {
  if (!state.activeProjectId) {
    skillsNotice("Elige un proyecto para deshabilitar skills.");
    return;
  }
  const result = await invoke("skills.disable", { projectId: state.activeProjectId, name });
  skillsNotice(result.ok ? `Deshabilitada ${name} en este proyecto.` : (result.error ?? "No se pudo deshabilitar."));
  await refreshSkillsCatalog();
}

export async function setSkillScope(name: string, scope: "global" | "project" | "managed"): Promise<void> {
  if (!state.activeProjectId) {
    skillsNotice("Elige un proyecto para cambiar el alcance.");
    return;
  }
  const result = await invoke("skills.setScope", { projectId: state.activeProjectId, name, scope });
  skillsNotice(result.ok ? `Alcance de ${name} → ${scope}.` : (result.error ?? "No se pudo cambiar el alcance."));
  await refreshSkillsCatalog();
}

export async function uninstallSkill(name: string): Promise<void> {
  const result = await invoke("skills.uninstall", { name });
  skillsNotice(result.ok ? `Desinstalada ${name}.` : (result.error ?? "No se pudo desinstalar."));
  if (state.skillsSelected === name) {
    setState("skillsSelected", undefined);
    setState("skillsDetail", undefined);
  }
  await refreshSkillsCatalog();
}

export async function importSkillFromFolder(dirPath: string, scope?: "global" | "project" | "managed"): Promise<void> {
  if (!dirPath.trim()) {
    skillsNotice("Indica la carpeta de la skill.");
    return;
  }
  const result = await invoke("skills.importFolder", scope ? { path: dirPath, scope } : { path: dirPath });
  skillsNotice(result.ok && result.skill ? `Importada ${result.skill.name}@${result.skill.version ?? "?"} desde carpeta.` : (result.error ?? "No se pudo importar."));
  await refreshSkillsCatalog();
}

export async function importSkillFromZip(zipPath: string, scope?: "global" | "project" | "managed"): Promise<void> {
  if (!zipPath.trim()) {
    skillsNotice("Indica la ruta del zip.");
    return;
  }
  const result = await invoke("skills.importZip", scope ? { path: zipPath, scope } : { path: zipPath });
  skillsNotice(result.ok && result.skill ? `Importada ${result.skill.name}@${result.skill.version ?? "?"} desde zip.` : (result.error ?? "No se pudo importar."));
  await refreshSkillsCatalog();
}

export async function installSkillFromGit(repoUrl: string, ref: string, sourceDir?: string, scope?: "global" | "project" | "managed"): Promise<void> {
  if (!repoUrl.trim() || !ref.trim()) {
    skillsNotice("repo y ref son obligatorios (fuente explícita).");
    return;
  }
  const result = await invoke("skills.installGit", { repoUrl, ref, ...(sourceDir?.trim() ? { sourceDir: sourceDir.trim() } : {}), ...(scope ? { scope } : {}) });
  skillsNotice(result.ok && result.skill ? `Instalada ${result.skill.name}@${result.skill.version ?? "?"} desde git.` : (result.error ?? "No se pudo instalar."));
  await refreshSkillsCatalog();
}

/** Historial de uso por run (W-S6): qué skills usó cada run + intentos de evasión. */
export async function loadSkillsHistory(runId: string): Promise<void> {
  if (!runId.trim()) {
    setState("skillsHistory", []);
    setState("skillsHistoryBypass", []);
    return;
  }
  try {
    const { skills, bypass } = await invoke("skills.history", { runId: runId.trim() });
    setState("skillsHistory", skills);
    setState("skillsHistoryBypass", bypass);
  } catch {
    setState("skillsHistory", []);
    setState("skillsHistoryBypass", []);
  }
}

export async function pickSkillDirectory(): Promise<string | undefined> {
  const picked = await invoke("app.pickDirectory", {});
  return picked.path;
}
