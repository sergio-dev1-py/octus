/** Renderer/store — arranque del store y recargas compuestas. */
import { onEvent } from "../api.js";
import { applyUiPrefs, loadUiPrefs } from "../prefs.js";
import { refreshProjects, refreshSessions, refreshProviders, refreshBudgets, refreshPending } from "./projects.js";
import { refreshPlans, refreshApprovals, refreshAgents } from "./plans.js";
import { refreshDefinitions, refreshLimits, refreshProjectSettings } from "./settings.js";
import { loadLayout } from "./prefsLayout.js";
import { applyEvent } from "./events.js";
import { setState } from "./state.js";

export async function reloadStage2(): Promise<void> {
  await Promise.all([refreshPlans(), refreshApprovals(), refreshAgents(), refreshDefinitions(), refreshLimits(), refreshProjectSettings()]);
}

export async function initStore(): Promise<void> {
  const prefs = await loadUiPrefs();
  applyUiPrefs(prefs);
  setState("prefs", prefs);
  await loadLayout();
  onEvent(applyEvent);
  await refreshProjects();
  await refreshSessions();
  await refreshProviders();
  await refreshBudgets();
  await refreshPending();
  await reloadStage2();
}
