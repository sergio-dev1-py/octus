/** Renderer/store — arranque del store y recargas compuestas. */
import { onEvent } from "../api.js";
import { applyUiPrefs, loadUiPrefs } from "../prefs.js";
import { refreshProjects, refreshSessions, refreshProviders, refreshPending } from "./projects.js";
import { refreshPlans, refreshApprovals, refreshAgents } from "./plans.js";
import { refreshDefinitions, refreshLimits, refreshProjectSettings } from "./settings.js";
import { refreshSkillsCatalog } from "./skills.js";
import { loadLayout } from "./prefsLayout.js";
import { applyEvent } from "./events.js";
import { setState } from "./state.js";

export async function reloadStage2(): Promise<void> {
  await Promise.all([refreshPlans(), refreshApprovals(), refreshAgents(), refreshDefinitions(), refreshLimits(), refreshProjectSettings(), refreshSkillsCatalog()]);
}

export async function initStore(): Promise<void> {
  // Todo 34 (§7: arranque frío hasta bienvenida visible, máx. 2,5 s): las
  // lecturas independientes van en paralelo; solo sessions espera a projects
  // (lo necesita para validar el proyecto activo). El estado final es el mismo.
  const prefs = await loadUiPrefs();
  applyUiPrefs(prefs);
  setState("prefs", prefs);
  await loadLayout();
  onEvent(applyEvent);
  await Promise.all([
    refreshProjects().then(() => refreshSessions()),
    refreshProviders(),
    refreshPending(),
  ]);
  await reloadStage2();
}
