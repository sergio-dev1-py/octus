/** QA Todo 11 — entrada standalone: monta la App REAL con un backend
 * contract-shaped (mismo OctusIPC que el main) sembrado con 2 proyectos,
 * sesiones y una sesión corrupta. Sin Electron: window.octus se fija aquí. */
import { render } from "solid-js/web";
import App from "../apps/desktop/src/renderer/src/App.jsx";
import "../apps/desktop/src/renderer/src/styles.css";

interface Session {
  id: string;
  projectId: string;
  title: string;
  directory: string;
  profile: string;
  createdAt: number;
  updatedAt: number;
}

const projects = [
  { id: "prj_A", name: "Proyecto A", rootPath: "C:/tmp/octus-qa-A", createdAt: 1, updatedAt: 1 },
  { id: "prj_B", name: "Proyecto B", rootPath: "C:/tmp/octus-qa-B", createdAt: 1, updatedAt: 1 },
];

const sessions = new Map<string, Session>([
  ["ses_A1", { id: "ses_A1", projectId: "prj_A", title: "A-uno", directory: "C:/tmp/octus-qa-A", profile: "build", createdAt: 1, updatedAt: 1 }],
  ["ses_A2", { id: "ses_A2", projectId: "prj_A", title: "A-dos", directory: "C:/tmp/octus-qa-A", profile: "plan", createdAt: 2, updatedAt: 2 }],
  ["ses_B1", { id: "ses_B1", projectId: "prj_B", title: "B-uno", directory: "C:/tmp/octus-qa-B", profile: "build", createdAt: 3, updatedAt: 3 }],
  ["ses_fragil", { id: "ses_fragil", projectId: "prj_A", title: "frágil", directory: "C:/tmp/octus-qa-A", profile: "build", createdAt: 4, updatedAt: 4 }],
]);

const messages: Record<string, Array<{ id: string; text: string }>> = {
  ses_A1: [{ id: "m1", text: "hola en A1" }],
  ses_A2: [{ id: "m2", text: "hola en A2" }],
  ses_B1: [{ id: "m3", text: "hola en B1" }],
};

let seq = 100;
const handlers: Record<string, (p: Record<string, never>) => unknown> = {
  "prefs.get": () => ({ prefs: { theme: "light", fontSize: 14, density: "normal" } }),
  "prefs.set": (p) => ({ prefs: (p as { prefs: unknown }).prefs }),
  "layout.get": () => ({
    layout: { activity: "explorer", sidebarVisible: true, sidebarWidth: 264, inspectorVisible: true, inspectorWidth: 248, bottomVisible: true, bottomHeight: 180, bottomTab: "terminal" },
    repaired: false,
  }),
  "layout.set": (p) => ({ layout: (p as { layout: unknown }).layout }),
  "projects.list": () => ({ projects }),
  "projects.create": () => ({ project: projects[0] }),
  "sessions.list": (p) => ({ sessions: [...sessions.values()].filter((s) => s.projectId === (p as { projectId?: string }).projectId) }),
  "sessions.create": (p) => {
    const id = `ses_new_${seq++}`;
    const s: Session = { id, projectId: (p as { projectId: string }).projectId, title: "New session", directory: "C:/tmp/x", profile: "build", createdAt: 5, updatedAt: 5 };
    sessions.set(id, s);
    return { session: s };
  },
  "sessions.get": (p) => {
    const s = sessions.get((p as { sessionId: string }).sessionId);
    if (!s) throw new Error("Session not found");
    return { session: s, runs: [] };
  },
  "sessions.delete": (p) => {
    sessions.delete((p as { sessionId: string }).sessionId);
    return { ok: true };
  },
  "sessions.rename": (p) => {
    const s = sessions.get((p as { sessionId: string; title: string }).sessionId);
    if (s) s.title = (p as { title: string }).title;
    return { ok: true };
  },
  "sessions.messages": (p) => {
    const id = (p as { sessionId: string }).sessionId;
    if (id === "ses_fragil") throw new Error("Unexpected token '¡', \"¡corrupto{\" is not valid JSON");
    return {
      messages: (messages[id] ?? []).map((m) => ({
        id: m.id, sessionId: id, runId: "run_x", instanceId: "ins_x", role: "user", mode: "build",
        parts: [{ type: "text", text: m.text }], trust: "user", seq: 0, createdAt: 1,
      })),
    };
  },
  "sessions.recover": (p) => {
    const id = (p as { sessionId: string }).sessionId;
    const s = sessions.get(id);
    if (!s) throw new Error("Session not found");
    if (id === "ses_fragil") {
      return { session: s, messages: [], recovered: true, skippedMessages: ["msg_corrupto_1"], skippedEvents: 1 };
    }
    return {
      session: s, recovered: false, skippedMessages: [], skippedEvents: 0,
      messages: (messages[id] ?? []).map((m) => ({
        id: m.id, sessionId: id, runId: "run_x", instanceId: "ins_x", role: "user", mode: "build",
        parts: [{ type: "text", text: m.text }], trust: "user", seq: 0, createdAt: 1,
      })),
    };
  },
  "sessions.setProfile": (p) => {
    const s = sessions.get((p as { sessionId: string }).sessionId);
    if (s) s.profile = (p as { profile: string }).profile;
    return { ok: true };
  },
  "app.validateDirectory": (p) => ({ ok: true, realPath: (p as { path: string }).path }),
  "sessions.prompt": () => ({ runId: "run_stub" }),
  "sessions.interrupt": () => ({ ok: true }),
  "providers.list": () => ({ providers: [] }),
  "budgets.status": () => ({ configured: true, budgets: [], usage: [] }),
  "permissions.pending": () => ({ requests: [] }),
  "questions.pending": () => ({ requests: [] }),
  "agents.instances": () => ({ instances: [] }),
  "agents.definitions": () => ({ definitions: [] }),
  "agents.limits": () => ({ limits: { maxPerSession: 4, maxPerProject: 6, maxDepth: 2, maxImplementers: 2, maxReaders: 2, maxReviewers: 1 } }),
  "plans.list": () => ({ plans: [] }),
  "approvals.pending": () => ({ requests: [] }),
  "projects.isolatedDirs": () => ({ directories: [] }),
  "projects.testAllowlist": () => ({ entries: [] }),
  "projects.trustedInstructions": () => ({ files: [] }),
  "tasks.list": () => ({ tasks: [] }),
  "worktrees.list": () => ({ worktrees: [] }),
  "repos.inspect": (p) => ({ summary: { rootPath: "C:/tmp/x", isGit: false, branch: "", status: "clean", staged: 0, unstaged: 0, untracked: 0 } }),
  "memory.list": () => ({ entries: [] }),
  "recovery.status": () => ({ pendingOps: 2, startedPromotions: 0, livePreviews: 0, staleMemories: 1, pendingContradictions: 0 }),
  "recovery.reconcile": () => ({
    ok: true,
    summary: {
      tasks: { interrupted: 0, released: 0 }, worktrees: { suspended: 0, orphaned: 0, resumed: 0 },
      integrations: { resolved: 0, interrupted: 0, stale: 0 }, previews: { orphaned: 0 },
      promotions: { resolved: 0, diverged: 0 }, orphanedPlans: 0, memory: { checked: 0, markedStale: [] },
    },
  }),
};

const eventHandlers = new Set<(e: unknown) => void>();
const callLog: Array<{ channel: string; payload: unknown }> = [];
(window as unknown as { octus: unknown }).octus = {
  invoke: async (channel: string, payload: unknown) => {
    const h = handlers[channel];
    if (!h) throw new Error(`canal no sembrado en QA: ${channel}`);
    callLog.push({ channel, payload: JSON.parse(JSON.stringify(payload ?? {})) });
    if (callLog.length > 400) callLog.shift();
    // Fidelidad IPC: el puente real clona por serialización; sin clon, el
    // store no vería cambios (misma referencia) y el QA mentiría.
    return JSON.parse(JSON.stringify(await h((payload ?? {}) as Record<string, never>)));
  },
  onEvent: (handler: (e: unknown) => void) => {
    eventHandlers.add(handler);
    return () => { eventHandlers.delete(handler); };
  },
};

import { selectSession as qaSelectSession } from "../apps/desktop/src/renderer/src/store.jsx";
(window as unknown as { __t11: unknown }).__t11 = { tryForeign: (id: string) => qaSelectSession(id), calls: callLog };

const root = document.getElementById("oc-qa-root");
if (!root) throw new Error("sin root");
render(() => App(), root);
