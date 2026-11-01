/** Fixture compartido sonda Todo 13 (stub window.octus determinista). */
const TOTAL_MESSAGES = 600;
const PAGE = 100;

/** Fixture determinista: 600 mensajes alternos con markdown/código/tool calls. */
function buildMessages() {
  const out = [];
  for (let i = 0; i < TOTAL_MESSAGES; i += 1) {
    const user = i % 2 === 0;
    const parts = user
      ? [{ type: "text", text: `Pregunta ${i}: revisa el módulo **${i}**` }]
      : i % 20 === 19
        ? [
            { type: "text", text: `Respuesta ${i} con llamada` },
            { type: "tool_call", toolCallId: `tc_${i}`, name: "fs.read", argumentsJson: `{"path":"a${i}.txt"}` },
            { type: "tool_result", toolCallId: `tc_${i}`, providerCallId: `call_${i}`, ok: true, text: "contenido" },
          ]
        : [{ type: "text", text: i % 5 === 4 ? `Respuesta ${i}:\n\n\`\`\`ts\nconst x_${i} = 1;\n\`\`\`` : `Respuesta ${i} en *markdown*.` }];
    out.push({
      id: `m${i}`,
      sessionId: "s1",
      runId: `run${Math.floor(i / 2)}`,
      instanceId: "i1",
      role: user ? "user" : "assistant",
      mode: "build",
      parts,
      trust: user ? "user" : "tool",
      seq: i,
      createdAt: i,
    });
  }
  return out;
}

function buildStubInit() {
return `
(() => {
  const MESSAGES = ${JSON.stringify(buildMessages()).replaceAll("</", "<\\u002f")};
  const PROJECTS = [{ id: "p1", name: "QA", rootPath: "C:/tmp/octus-qa-proj" }];
  const SESSION = { id: "s1", projectId: "p1", title: "QA chat", directory: "C:/tmp/octus-qa-proj", profile: "build", model: { providerId: "fake", modelId: "b" }, createdAt: 1, updatedAt: 1 };
  const MODELS = [
    { providerId: "fake", modelId: "a", displayName: "Fake A", capabilities: { toolCall: true, reasoningEfforts: ["low"], maxContextTokens: 1000, maxOutputTokens: 100, supportsImages: false } },
    { providerId: "fake", modelId: "b", displayName: "Fake B", capabilities: { toolCall: true, reasoningEfforts: ["low"], maxContextTokens: 1000, maxOutputTokens: 100, supportsImages: false } },
  ];
  const PROVIDERS = [{ id: "fake", displayName: "Fake", configured: true, models: MODELS }];
  const calls = [];
  const handlers = [];
  function page(sessionId, runId, limit, beforeId) {
    let all = MESSAGES.filter((m) => m.sessionId === sessionId && (!runId || m.runId === runId));
    if (beforeId !== undefined && beforeId !== null) {
      const idx = all.findIndex((m) => m.id === beforeId);
      if (idx >= 0) all = all.slice(0, idx);
    }
    const total = all.length;
    const lim = typeof limit === "number" && limit >= 1 ? Math.floor(limit) : total;
    const messages = all.slice(Math.max(0, all.length - lim));
    return { messages, total, hasOlder: messages.length < total };
  }
  window.__octusCalls = calls;
  window.__octusEmit = (event) => { for (const h of handlers) h(event); };
  const mirror = () => {
    let el = document.getElementById("probe-calls");
    if (!el) { el = document.createElement("div"); el.id = "probe-calls"; el.style.display = "none"; document.documentElement.appendChild(el); }
    el.textContent = JSON.stringify(calls);
  };
  window.octus = {
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      try { mirror(); } catch {}
      switch (channel) {
        case "app.validateDirectory": return { ok: true, realPath: "C:/tmp/octus-qa-proj" };
        case "prefs.get": return { prefs: { theme: "system", fontSize: 14, density: "normal" } };
        case "prefs.set": return { prefs: payload.prefs };
        case "layout.get": return { layout: { activity: "chat", sidebarVisible: true, sidebarWidth: 264, inspectorVisible: true, inspectorWidth: 248, bottomVisible: false, bottomHeight: 180, bottomTab: "terminal" }, repaired: false };
        case "layout.set": return { layout: payload.layout };
        case "projects.list": return { projects: PROJECTS };
        case "sessions.list": return { sessions: [SESSION] };
        case "sessions.get": return { session: SESSION, runs: [] };
        case "sessions.create": return { session: SESSION };
        case "sessions.delete": return { ok: true };
        case "sessions.rename": return { ok: true };
        case "sessions.setProfile": return { ok: true };
        case "sessions.setModel": return { ok: true };
        case "sessions.recover": return { session: SESSION, messages: [], recovered: false, skippedMessages: [], skippedEvents: 0 };
        case "sessions.messages": return page(payload.sessionId, payload.runId, payload.limit, payload.beforeId);
        case "sessions.prompt": return { runId: "run_new" };
        case "sessions.interrupt": return { ok: true };
        case "providers.list": return { providers: PROVIDERS };
        case "providers.models": return { models: MODELS };
        case "budgets.status": return { configured: true, budgets: [], usage: [] };
        case "permissions.pending": return { requests: [] };
        case "questions.pending": return { requests: [] };
        case "plans.list": return { plans: [] };
        case "approvals.pending": return { requests: [] };
        case "agents.instances": return { instances: [] };
        case "agents.definitions": return { definitions: [] };
        case "agents.limits": return { limits: { maxPerSession: 4, maxPerProject: 6, maxDepth: 2 } };
        case "projects.isolatedDirs": return { directories: [] };
        case "projects.testAllowlist": return { entries: [] };
        case "projects.trustedInstructions": return { files: [] };
        case "runs.usage": return { records: [] };
        case "tasks.list": return { tasks: [] };
        case "worktrees.list": return { worktrees: [] };
        case "repos.inspect": return { summary: undefined };
        case "integrations.list": return { integrations: [] };
        case "memory.list": return { entries: [] };
        case "recovery.status": return { pendingOps: 0, startedPromotions: 0, livePreviews: 0, staleMemories: 0, pendingContradictions: 0 };
        default: throw new Error("probe: sin stub para " + channel);
      }
    },
    onEvent: (handler) => { handlers.push(handler); return () => {}; },
  };
})();
`;;
}

module.exports = { buildStubInit, buildMessages, TOTAL_MESSAGES, PAGE };
