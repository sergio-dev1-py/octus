/** Renderer/store — definiciones y límites de agentes y ajustes de proyecto. */
import { invoke } from "../api.js";
import { state, setState } from "./state.js";

export async function refreshDefinitions(): Promise<void> {
  try {
    const { definitions } = await invoke("agents.definitions", {});
    setState("definitions", definitions);
  } catch {
    setState("definitions", []);
  }
}

export async function refreshLimits(): Promise<void> {
  try {
    const { limits } = await invoke("agents.limits", {});
    setState("agentLimits", limits);
  } catch {
    // conserva los defaults
  }
}

export async function refreshAgentModelSettings(): Promise<void> {
  try {
    const { settings } = await invoke("agents.modelSettings", {});
    setState("agentModelSettings", settings);
  } catch {
    // conserva el valor previo
  }
}

export async function saveAgentModelAssignments(
  enabled: boolean,
  assignments: NonNullable<typeof state.agentModelSettings>["assignments"],
  imageModel?: NonNullable<typeof state.agentModelSettings>["imageModel"],
): Promise<boolean> {
  const result = await invoke("agents.setModelAssignments", { enabled, assignments, imageModel });
  if (!result.ok) return false;
  await Promise.all([refreshAgentModelSettings(), refreshDefinitions()]);
  return true;
}

export async function refreshProjectSettings(): Promise<void> {
  if (!state.activeProjectId) {
    setState("isolatedDirs", []);
    setState("testAllowlist", []);
    setState("trustedFiles", []);
    return;
  }
  try {
    const [dirs, tests, trusted] = await Promise.all([
      invoke("projects.isolatedDirs", { projectId: state.activeProjectId }),
      invoke("projects.testAllowlist", { projectId: state.activeProjectId }),
      invoke("projects.trustedInstructions", { projectId: state.activeProjectId }),
    ]);
    setState("isolatedDirs", dirs.directories);
    setState("testAllowlist", tests.entries);
    setState("trustedFiles", trusted.files);
  } catch {
    setState("isolatedDirs", []);
    setState("testAllowlist", []);
    setState("trustedFiles", []);
  }
}
