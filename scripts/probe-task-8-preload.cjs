/**
 * Preload de mentira SOLO para la sonda Todo 8 (scripts/probe-task-8-surface.mjs).
 * Expone window.octus con respuestas fijas; jamás toca disco ni red.
 * Con ?probe=corrupt, layout.get devuelve basura con repaired:true para
 * ejercer el aviso de degradación del renderer.
 */
const { contextBridge } = require("electron");

const DEFAULT_LAYOUT = {
  activity: "explorer",
  sidebarVisible: true,
  sidebarWidth: 264,
  inspectorVisible: true,
  inspectorWidth: 248,
  bottomVisible: true,
  bottomHeight: 180,
  bottomTab: "terminal",
};

const routes = {
  "prefs.get": async () => ({ prefs: { theme: "system", fontSize: 14, density: "normal" } }),
  "prefs.set": async (payload) => ({ prefs: payload.prefs }),
  "layout.get": async () => {
    if (new URLSearchParams(window.location.search).get("probe") === "corrupt") {
      return { layout: { activity: "x", sidebarWidth: "ancha" }, repaired: true };
    }
    return { layout: { ...DEFAULT_LAYOUT }, repaired: false };
  },
  "layout.set": async (payload) => ({ layout: payload.layout }),
  "projects.list": async () => ({ projects: [] }),
  "sessions.list": async () => ({ sessions: [] }),
  "providers.list": async () => ({ providers: [] }),
  "budgets.status": async () => ({ configured: false, budgets: [], usage: [] }),
  "permissions.pending": async () => ({ requests: [] }),
  "questions.pending": async () => ({ requests: [] }),
  "plans.list": async () => ({ plans: [] }),
  "approvals.pending": async () => ({ requests: [] }),
  "agents.instances": async () => ({ instances: [] }),
  "agents.definitions": async () => ({ definitions: [] }),
  "agents.limits": async () => ({ limits: { maxPerSession: 4, maxPerProject: 6, maxDepth: 2 } }),
  "tasks.list": async () => ({ tasks: [] }),
  "sessions.get": async () => ({ session: { id: "probe", title: "Probe", profile: "build" }, runs: [] }),
};

contextBridge.exposeInMainWorld("octus", {
  invoke: async (channel, payload) => {
    const fn = routes[channel];
    if (!fn) throw new Error(`probe: sin stub para ${channel}`);
    return fn(payload);
  },
  onEvent: () => () => {},
});
