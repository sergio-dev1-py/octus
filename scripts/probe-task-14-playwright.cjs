/**
 * Sonda Todo 14 — superficie REAL de los widgets de conversación (no dry-run).
 * Playwright (Chromium) sobre el bundle construido (apps/desktop/out/renderer),
 * con window.octus sustituido por un stub determinista: datos fijos de run
 * simulado (tc_qa01, apr_qa01, que_qa01, ins_qa_impl, run_qa02 failed).
 *
 * Uso (desde la raíz del repo, tras `bun run --cwd apps/desktop build`):
 *   node scripts/probe-task-14-playwright.cjs
 * Exit 0 = todo verde; vuelca PNGs a .omo/evidence/octus-ux-skills-mcp/.
 */
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { chromium } = require("playwright-core");

const ROOT = path.dirname(__dirname);
const INDEX = path.join(ROOT, "apps/desktop/out/renderer/index.html");
const EVIDENCE = path.join(ROOT, ".omo/evidence/octus-ux-skills-mcp");

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

async function waitForCond(fn, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try { ok = await fn(); } catch {}
    if (ok) return true;
    if (Date.now() - t0 > timeout) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function serveStatic(root) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\//, "");
    const file = path.join(root, urlPath === "" ? "index.html" : urlPath);
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404); res.end("nope"); return; }
      res.writeHead(200, { "Content-Type": types[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function buildStubInit() {
return `
(() => {
  const PROJECTS = [{ id: "p1", name: "QA", rootPath: "C:/tmp/octus-qa-proj" }];
  const SESSION = { id: "s1", projectId: "p1", title: "QA chat", directory: "C:/tmp/octus-qa-proj", profile: "build", model: { providerId: "fake", modelId: "b" }, createdAt: 1, updatedAt: 1 };
  const MODELS = [
    { providerId: "fake", modelId: "a", displayName: "Fake A", capabilities: { toolCall: true, reasoningEfforts: ["low"], maxContextTokens: 1000, maxOutputTokens: 100, supportsImages: false } },
    { providerId: "fake", modelId: "b", displayName: "Fake B", capabilities: { toolCall: true, reasoningEfforts: ["low"], maxContextTokens: 1000, maxOutputTokens: 100, supportsImages: false } },
  ];
  const PROVIDERS = [{ id: "fake", displayName: "Fake", configured: true, models: MODELS }];
  const MESSAGES = [
    { id: "msg_qa01", sessionId: "s1", runId: "run_qa01", instanceId: "ins_qa01", role: "user", mode: "build",
      parts: [{ type: "text", text: "Añade validación de email al formulario de alta" }], trust: "user", seq: 1, createdAt: 1 },
    { id: "msg_qa02", sessionId: "s1", runId: "run_qa01", instanceId: "ins_qa01", role: "assistant", mode: "build",
      parts: [
        { type: "text", text: "Voy a añadir la validación con zod." },
        { type: "tool_call", toolCallId: "tc_qa01", name: "read", argumentsJson: "{\\"path\\":\\"src/form.ts\\"}" },
      ], trust: "tool", seq: 2, createdAt: 2 },
    { id: "msg_qa03", sessionId: "s1", runId: "run_qa01", instanceId: "ins_qa01", role: "tool",
      parts: [{ type: "tool_result", toolCallId: "tc_qa01", providerCallId: "call_1", ok: true, text: "42 líneas, exporta validateForm" }],
      trust: "tool", seq: 3, createdAt: 3 },
  ];
  const RUNS = [
    { id: "run_qa01", sessionId: "s1", prompt: "Lee note", status: "executing", mode: "build", createdAt: 1, updatedAt: 2 },
    { id: "run_qa02", sessionId: "s1", prompt: "Falla", status: "failed", mode: "build", error: "provider timeout tras 30 s", createdAt: 1, updatedAt: 9 },
  ];
  const TOOLCALLS = {
    run_qa01: [{ id: "tc_qa01", sessionId: "s1", runId: "run_qa01", instanceId: "ins_qa01", name: "read",
      argumentsJson: "{\\"path\\":\\"src/form.ts\\"}", status: "completed", providerCallId: "call_1",
      idempotencyKey: "idem_qa01", permission: { decision: "allow" },
      resultText: "42 líneas, exporta validateForm", artifactId: "art_qa01", startedAt: 1000, completedAt: 1320 }],
    run_qa02: [],
  };
  const PLAN = { id: "plan_qa01", projectId: "p1", sessionId: "s1", objective: "Añade validación de email",
    status: "active", currentRevisionId: "rev_qa03", createdAt: 1, updatedAt: 2 };
  const REVISIONS = { plan_qa01: [{ id: "rev_qa03", planId: "plan_qa01", version: 3,
    structuredContent: { objective: "x", steps: [{ title: "leer form.ts" }], acceptanceCriteria: ["email válido pasa"] },
    contentMarkdown: "# Plan\\n\\n- leer form.ts", createdInRunId: "run_qa01", createdBy: "ins_qa01",
    lifecycle: "presented", approval: "pending", createdAt: 2 }] };
  let approvals = [{ id: "apr_qa01", planId: "plan_qa01", revisionId: "rev_qa03", sessionId: "s1", runId: "run_qa01", status: "pending", createdAt: 3 }];
  let QUESTIONS = [{ id: "que_qa01", sessionId: "s1", runId: "run_qa01", instanceId: "ins_qa01", toolCallId: "tc_qa01",
    questions: [{ question: "¿Con qué librería valido?", header: "Validación", options: [{ label: "zod", description: "recomendada" }, { label: "yup" }] }],
    createdAt: Date.now() - 60 * 1000 }];
  const INSTANCES = [
    { id: "ins_qa_impl", sessionId: "s1", runId: "run_qa01", taskId: "tsk_qa02", definitionId: "implementer",
      status: "running", model: { providerId: "fake", modelId: "b" }, directory: "C:/tmp/octus-qa-proj",
      definitionVersion: 1, promptHash: "h", definitionSnapshot: {}, createdAt: 1, updatedAt: 2 },
    { id: "ins_qa_done", sessionId: "s1", runId: "run_qa01", definitionId: "explorer",
      status: "completed", model: { providerId: "fake", modelId: "b" }, directory: "C:/tmp/octus-qa-proj",
      definitionVersion: 1, promptHash: "h", definitionSnapshot: {}, createdAt: 1, updatedAt: 2 },
  ];
  const TASKS = [
    { id: "tsk_qa02", runId: "run_qa01", planningId: "p", planId: "plan_qa01", revisionId: "rev_qa03", title: "implementar",
      description: "d", agentRole: "implementer", priority: 1, acceptanceCriteria: [], requiredTools: [], writeScope: [],
      validationCommands: [], needsReview: false, status: "running", attempt: 1, createdAt: 1, updatedAt: 2 },
    { id: "tsk_qa03", runId: "run_qa01", planningId: "p", planId: "plan_qa01", revisionId: "rev_qa03", title: "revisar",
      description: "d", agentRole: "reviewer", priority: 2, acceptanceCriteria: [], requiredTools: [], writeScope: [],
      validationCommands: [], needsReview: true, status: "blocked", blockedReason: "needs-approval", attempt: 0, createdAt: 1, updatedAt: 8 },
  ];
  const ATTEMPTS = {
    tsk_qa02: [{ taskId: "tsk_qa02", attempt: 1, instanceId: "ins_qa_impl", status: "running",
      artifacts: [{ kind: "diff", path: "src/form.ts", summary: "+38, -4" }], createdAt: 1 }],
    tsk_qa03: [],
  };
  const calls = [];
  const handlers = [];
  window.__octusCalls = calls;
  window.__octusEmit = (event) => { for (const h of handlers) h(event); };
  const mirror = () => {
    let el = document.getElementById("probe-calls");
    if (!el) { el = document.createElement("div"); el.id = "probe-calls"; el.style.display = "none"; document.documentElement.appendChild(el); }
    el.textContent = JSON.stringify(calls);
  };
  const decided = new Set();
  const replied = new Set();
  const QUE2 = { id: "que_qa02", sessionId: "s1", runId: "run_qa01", instanceId: "ins_qa01", toolCallId: "tc_qa01",
    questions: [{ question: "¿Reintento?", header: "Vencida", options: [{ label: "sí" }] }],
    createdAt: Date.now() - 400 * 1000 }; // vencida: el canal la rechaza
  window.octus = {
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      try { mirror(); } catch {}
      switch (channel) {
        case "app.validateDirectory": return { ok: true, realPath: "C:/tmp/octus-qa-proj" };
        case "app.versions": return { octus: "qa", electron: "qa", node: "qa" };
        case "app.pickDirectory": return {};
        case "prefs.get": return { prefs: { theme: "system", fontSize: 14, density: "normal" } };
        case "prefs.set": return { prefs: payload.prefs };
        case "layout.get": return { layout: { activity: "chat", sidebarVisible: true, sidebarWidth: 264, inspectorVisible: true, inspectorWidth: 248, bottomVisible: false, bottomHeight: 180, bottomTab: "terminal" }, repaired: false };
        case "layout.set": return { layout: payload.layout };
        case "projects.list": return { projects: PROJECTS };
        case "projects.create": return { project: PROJECTS[0] };
        case "sessions.list": return { sessions: [SESSION] };
        case "sessions.get": return { session: SESSION, runs: RUNS };
        case "sessions.create": return { session: SESSION };
        case "sessions.delete": return { ok: true };
        case "sessions.rename": return { ok: true };
        case "sessions.setProfile": return { ok: true };
        case "sessions.setModel": return { ok: true };
        case "sessions.recover": return { session: SESSION, messages: [], recovered: false, skippedMessages: [], skippedEvents: 0 };
        case "sessions.messages": return { messages: MESSAGES, total: MESSAGES.length, hasOlder: false };
        case "sessions.prompt": return { runId: "run_new" };
        case "sessions.interrupt": return { ok: true };
        case "providers.list": return { providers: PROVIDERS };
        case "providers.models": return { models: MODELS };
        case "providers.setKey": return { ok: true };
        case "providers.removeKey": return { ok: true };
        case "providers.test": return { ok: true, models: 1 };
        case "budgets.status": return { configured: true, budgets: [], usage: [] };
        case "budgets.configure": return { ok: true };
        case "permissions.pending": return { requests: [] };
        case "permissions.reply": return { ok: true };
        case "permissions.saved": return { rules: [] };
        case "permissions.revokeSaved": return { ok: true };
        case "questions.pending": return { requests: window.__probeSecondRound ? [QUE2] : QUESTIONS };
        case "questions.reply": {
          if (payload.requestId === "que_qa02") return { ok: false };
          if (replied.has(payload.requestId)) return { ok: false };
          replied.add(payload.requestId);
          QUESTIONS = QUESTIONS.filter((q) => q.id !== payload.requestId);
          for (const h of handlers) h({ kind: "event", event: { id: "e_qr", type: "question.replied",
            aggregate: { kind: "tool_call", id: "tc_qa01" }, seq: 1, occurredAt: Date.now(),
            correlationId: "c", idempotencyKey: "k", payload: { requestId: payload.requestId, answers: payload.answers } } });
          return { ok: true };
        }
        case "agents.definitions": return { definitions: [] };
        case "agents.instances": return { instances: INSTANCES };
        case "agents.cancel": return { ok: true };
        case "agents.limits": return { limits: { maxPerSession: 4, maxPerProject: 6, maxDepth: 2 } };
        case "agents.setLimits": return { ok: true };
        case "agents.setDefinitionModel": return { ok: true };
        case "plans.list": return { plans: [PLAN] };
        case "plans.get": return { plan: PLAN, revisions: REVISIONS[payload.planId] ?? [] };
        case "plans.approve": return { ok: true };
        case "plans.reject": return { ok: true };
        case "plans.archive": return { ok: true };
        case "plans.export": return { ok: true };
        case "plans.implement": return { runId: "run_new" };
        case "approvals.pending": return { requests: approvals.filter((r) => r.status === "pending") };
        case "approvals.decide": {
          const req = approvals.find((r) => r.id === payload.requestId);
          if (!req || req.status !== "pending" || decided.has(payload.requestId)) return { ok: false, error: "Approval request is no longer pending" };
          decided.add(payload.requestId);
          req.status = "decided";
          return { ok: true };
        }
        case "projects.isolatedDirs": return { directories: [] };
        case "projects.addIsolatedDir": return { ok: true };
        case "projects.removeIsolatedDir": return { ok: true };
        case "projects.testAllowlist": return { entries: [] };
        case "projects.saveTestAllowlist": return { ok: true };
        case "projects.trustedInstructions": return { files: [] };
        case "projects.saveTrustedInstructions": return { files: [] };
        case "tasks.list": return { tasks: TASKS };
        case "tasks.get": {
          const task = TASKS.find((t) => t.id === payload.taskId);
          return { task, dependencies: [], attempts: ATTEMPTS[payload.taskId] ?? [] };
        }
        case "tasks.cancel": return { ok: true, cancelled: [] };
        case "tasks.retry": return { ok: true };
        case "tasks.review": return { ok: true };
        case "tasks.scheduler": return { lastRunId: "run_qa01", active: { tasks: 1, reservations: 0 } };
        case "runs.get": {
          const run = RUNS.find((r) => r.id === payload.runId);
          if (!run) throw new Error("run not found");
          return { run, instances: INSTANCES.filter((i) => i.runId === run.id), toolCalls: TOOLCALLS[run.id] ?? [] };
        }
        case "runs.usage": return { records: [] };
        case "worktrees.list": return { worktrees: [] };
        case "worktrees.get": return { worktree: undefined, operations: [] };
        case "worktrees.cleanup": return { ok: true };
        case "repos.inspect": return { summary: undefined };
        case "repos.setWorktreesRoot": return { ok: true };
        case "integrations.create": return { integration: undefined, error: "n/a" };
        case "integrations.get": return { integration: undefined, commits: [], operations: [], error: "n/a" };
        case "integrations.list": return { integrations: [] };
        case "integrations.rebuild": return { ok: false, error: "n/a" };
        case "integrations.abort": return { ok: true };
        case "integrations.incorporate": return { ok: true };
        case "integrations.spawnReviewer": return { ok: true };
        case "integrations.review": return { ok: true };
        case "conflicts.list": return { conflicts: [] };
        case "conflicts.get": return { conflict: undefined, resolutions: [], error: "n/a" };
        case "conflicts.requestResolution": return { ok: true };
        case "conflicts.finalize": return { ok: true };
        case "conflicts.incorporate": return { ok: true };
        case "conflicts.abort": return { ok: true };
        case "conflicts.cleanup": return { ok: true };
        case "validations.list": return { validations: [], reviews: [] };
        case "validations.rerun": return { ok: true };
        case "previews.create": return { ok: true };
        case "previews.list": return { previews: [] };
        case "previews.start": return { ok: true };
        case "previews.stop": return { ok: true };
        case "previews.restart": return { ok: true };
        case "previews.inspect": return { preview: undefined };
        case "previews.logs": return { logs: "" };
        case "previews.cleanup": return { ok: true };
        case "previews.allowlist": return { entries: [] };
        case "previews.saveAllowlist": return { ok: true };
        case "approvals.approve": return { ok: true };
        case "approvals.reject": return { ok: true };
        case "approvals.status": return { ok: false, reasons: [] };
        case "promotions.promote": return { ok: true };
        case "promotions.status": return { ok: false };
        case "memory.list": return { entries: [] };
        case "memory.get": return { entry: undefined };
        case "memory.propose": return { ok: true };
        case "memory.validate": return { ok: true };
        case "memory.decide": return { ok: true };
        case "memory.revalidate": return { ok: true };
        case "memory.resolve": return { ok: true };
        case "recovery.status": return { pendingOps: 0, startedPromotions: 0, livePreviews: 0, staleMemories: 0, pendingContradictions: 0 };
        case "recovery.reconcile": return { ok: true };
        default: throw new Error("probe14: sin stub para " + channel);
      }
    },
    onEvent: (handler) => { handlers.push(handler); return () => {}; },
  };
})();
`;
}

async function main() {
  if (!fs.existsSync(INDEX)) {
    console.log(`FAIL bundle construido ausente (${INDEX}): ejecuta el build antes de la sonda`);
    process.exit(1);
  }
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const server = await serveStatic(path.dirname(INDEX));
  const serverBase = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
  await page.addInitScript({ content: buildStubInit() });
  await page.goto(serverBase);

  await page.locator('button[data-project-id="p1"]').waitFor({ timeout: 20000 });
  await page.locator('button[data-project-id="p1"]').click();
  await page.locator("#welcome-continue").click();
  await page.locator("#composer").waitFor({ timeout: 20000 });

  async function lastCall(channel) {
    const raw = await page.locator("#probe-calls").innerText();
    const found = JSON.parse(raw).filter((c) => c.channel === channel);
    return found[found.length - 1];
  }

  // 1. Tool call visible (el modal de pregunta bloquea clics: se responde primero).
  const tc = page.locator('[data-toolcall="tc_qa01"]');
  await tc.waitFor({ timeout: 10000 });
  check("toolcall: tarjeta visible", (await tc.count()) === 1);
  check("toolcall: estado completed", (await tc.getAttribute("data-tc-status")) === "completed", await tc.getAttribute("data-tc-status"));
  check("toolcall: píldora completed", (await tc.locator('[data-tc-status-pill="completed"]').count()) === 1);

  // 2. Pregunta (el modal bloquea el resto: se responde primero).
  const que = page.locator('[data-question-request="que_qa01"]');
  await que.waitFor({ timeout: 10000 });
  check("pregunta: diálogo visible", (await que.count()) === 1);
  check("pregunta: timeout visible", ((await que.locator("[data-question-timeout]").innerText()).includes("Timeout:")));
  await que.locator('input[type="radio"][value="zod"]').check();
  await que.locator("button", { hasText: "Answer" }).click();
  await waitForCond(async () => (await lastCall("questions.reply")) !== undefined, 10000);
  const reply = await lastCall("questions.reply");
  check("pregunta: respuesta registra zod", JSON.stringify(reply.payload).includes("zod"), JSON.stringify(reply.payload.answers));
  check("pregunta: diálogo cerrado tras responder", await waitForCond(async () => (await que.count()) === 0, 10000));

  // 1b. Expandir tool call ya sin modal por encima.
  await tc.locator("[data-toolcall-toggle]").click();
  check("toolcall: args visibles al expandir", ((await tc.locator("[data-toolcall-args]").innerText()).includes("src/form.ts")));
  check("toolcall: resultado inline visible", ((await tc.locator("[data-toolcall-result]").innerText()).includes("42 líneas")));
  check("toolcall: artifact referenciado", (await tc.locator('[data-toolcall-artifact="art_qa01"]').count()) === 1);
  check("toolcall: duración 320 ms", ((await tc.innerText()).includes("320 ms")));
  await page.screenshot({ path: path.join(EVIDENCE, "task-14-toolcall.png") });

  // 3. Aprobación humana: gate visible, click aprueba, duplicada imposible en UI.
  await page.locator("details.stage2 summary", { hasText: "Approvals pending" }).click();
  const apr = page.locator('[data-approval-request="apr_qa01"]');
  await apr.waitFor({ timeout: 10000 });
  check("approval: solicitud visible", (await apr.count()) === 1);
  check("approval: gate solo-humano", ((await apr.locator("[data-approval-gate]").innerText()).includes("Solo tú puedes decidir")));
  const approveBtn = apr.locator("button", { hasText: "Approve" });
  check("approval: botón habilitado en revisión", await approveBtn.isEnabled());
  await approveBtn.click();
  await waitForCond(async () => (await lastCall("approvals.decide"))?.payload?.decision === "approved", 10000);
  check("approval: decide llamado", true);
  check("approval: duplicada imposible (solicitud decidida desaparece)", await waitForCond(async () => (await apr.count()) === 0, 10000));
  const dup = await page.evaluate(() => window.octus.invoke("approvals.decide", { requestId: "apr_qa01", decision: "approved" }));
  check("approval failure: duplicada rechazada por idempotencia", dup.ok === false, JSON.stringify(dup));

  // 4. Actividad de agentes con estados y cancelación.
  await page.locator("details.stage2 summary", { hasText: "Agents" }).first().click();
  const act = page.locator("#agent-activity");
  await act.waitFor({ timeout: 10000 });
  check("actividad: sección visible", (await act.count()) === 1);
  check("actividad: instancia running", (await act.locator('[data-agent-instance="ins_qa_impl"] [data-agent-status="running"]').count()) === 1);
  check("actividad: tarea vinculada", ((await act.locator('[data-agent-instance="ins_qa_impl"]').innerText()).includes("tsk_qa02")));
  check("actividad: cancelar disponible", (await act.locator('[data-agent-instance="ins_qa_impl"] button', { hasText: "Cancel" }).count()) === 1);

  // 5. Errores unificados con acción de reintento.
  const errs = page.locator("#run-errors");
  await errs.waitFor({ timeout: 10000 });
  check("errores: banda visible", (await errs.count()) === 1);
  check("errores: run fallido real", (await errs.locator('[data-error-item="run-run_qa02"]').count()) === 1);
  check("errores: causa real", ((await errs.locator('[data-error-item="run-run_qa02"]').innerText()).includes("provider timeout tras 30 s")));
  check("errores: tarea bloqueada", (await errs.locator('[data-error-item="task-tsk_qa03"]').count()) === 1);
  check("errores: reintento disponible", (await errs.locator('[data-error-retry="tsk_qa03"]').count()) === 1);

  // 6. Archivos modificados desde artifacts reales.
  await page.locator("details.stage2 summary", { hasText: "Archivos modificados" }).click();
  const files = page.locator("#modified-files");
  await files.waitFor({ timeout: 10000 });
  check("archivos: sección visible", (await files.count()) === 1);
  check("archivos: src/form.ts real", (await files.locator('[data-modified-file="src/form.ts"]').count()) === 1);

  // 3b. Pregunta failure al final (su modal bloquea clics: réplica duplicada y vencida).
  const dupQ = await page.evaluate(() => window.octus.invoke("questions.reply", { requestId: "que_qa01", answers: [] }));
  check("pregunta failure: réplica duplicada rechazada por el canal", dupQ.ok === false, JSON.stringify(dupQ));
  await page.evaluate((ev) => { window.__probeSecondRound = true; window.__octusEmit(ev); },
    { kind: "event", event: { id: "e_qa", type: "question.asked", aggregate: { kind: "tool_call", id: "tc_qa01" },
      seq: 2, occurredAt: Date.now(), correlationId: "c", idempotencyKey: "k2", payload: { requestId: "que_qa02" } } });
  const que2 = page.locator('[data-question-request="que_qa02"]');
  await que2.waitFor({ timeout: 10000 });
  check("pregunta failure: segunda pregunta visible", (await que2.count()) === 1);
  check("pregunta failure: timeout vencido visible", ((await que2.locator("[data-question-timeout]").innerText()).includes("expired")));
  await que2.locator('input[type="radio"]').check();
  await que2.locator("button", { hasText: "Answer" }).click();
  check("pregunta failure: error visible al responder vencida", await waitForCond(async () => (await page.locator(".banner.err").count()) >= 1, 10000));
  check("pregunta failure: diálogo vencido sigue abierto para reintentar", (await que2.count()) === 1);
  await page.screenshot({ path: path.join(EVIDENCE, "task-14-surface.png") });

  await browser.close();
  server.close();
  console.log(`\nSONDA PLAYWRIGHT TODO 14: ${failures === 0 ? "todo PASS" : failures + " FALLOS"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("FATAL " + String(error && error.stack || error).slice(0, 1000));
  process.exit(1);
});
