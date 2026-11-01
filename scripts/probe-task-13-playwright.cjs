/**
 * Sonda Todo 13 — superficie REAL del chat (no dry-run, no estática).
 * Playwright (Chromium) sobre el bundle construido (apps/desktop/out/renderer),
 * con window.octus sustituido por un stub determinista vía addInitScript:
 * 600 mensajes fijos, paginación real por cursor, streaming/eventos a demanda.
 *
 * Uso (desde la raíz del repo, tras `bun run --cwd apps/desktop build`):
 *   node scripts/probe-task-13-playwright.cjs
 * Exit 0 = todo verde; vuelca PNGs a .omo/evidence/octus-ux-skills-mcp/.
 */
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { chromium } = require("playwright-core");

/** Espera acotada por condición (sin waitForFunction: el CSP del bundle lo veta).
 *  Devuelve bool; el llamador registra el check. En fallo vuelca diagnóstico. */
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
async function timelineDiag(page, tag) {
  try {
    const info = await page.evaluate(() => ({
      total: document.querySelector(".message-timeline")?.getAttribute("data-timeline-total"),
      rendered: document.querySelector(".message-timeline")?.getAttribute("data-timeline-rendered"),
      older: document.querySelector(".message-timeline")?.getAttribute("data-timeline-older"),
      live: document.querySelectorAll("[data-live]").length,
      notice: !!document.getElementById("cancel-notice"),
    }));
    console.log(`diag ${tag}: ${JSON.stringify(info)}`);
  } catch (error) {
    console.log(`diag ${tag}: ERROR ${String(error).slice(0, 120)}`);
  }
}

/** Sirve el bundle por http://localhost (file:// bloquea módulos por CORS). */
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

const ROOT = path.dirname(__dirname);
const INDEX = path.join(ROOT, "apps/desktop/out/renderer/index.html");
const EVIDENCE = path.join(ROOT, ".omo/evidence/octus-ux-skills-mcp");
const ATTACH_DIR = "C:/tmp/octus-qa-attach-13";


let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

const { buildStubInit, TOTAL_MESSAGES, PAGE } = require("./probe-task-13-fixture.cjs");

async function main() {
  if (!fs.existsSync(INDEX)) {
    console.log(`FAIL bundle construido ausente (${INDEX}): ejecuta el build antes de la sonda`);
    process.exit(1);
  }
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.mkdirSync(ATTACH_DIR, { recursive: true });
  const attachFile = path.join(ATTACH_DIR, "notas.txt");
  fs.writeFileSync(attachFile, "contenido del adjunto para el prompt");

  const server = await serveStatic(path.dirname(INDEX));
  const serverBase = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
  await page.addInitScript({ content: buildStubInit() });
  await page.goto(serverBase);

  // B primero: bienvenida → proyecto reciente → continuar sesión (Todo 10, sin auto-selección).
  await page.locator('button[data-project-id="p1"]').waitFor({ timeout: 20000 });
  await page.locator('button[data-project-id="p1"]').click();
  await page.locator("#welcome-continue").click();

  const timeline = page.locator(".message-timeline");
  const composer = page.locator("#composer");
  await composer.waitFor({ timeout: 20000 });

  // A. Superficie fija.
  check("superficie: .message-timeline presente", (await timeline.count()) === 1);
  check("superficie: #composer presente", (await composer.count()) === 1);
  for (const id of ["#composer-files", "#composer-provider", "#composer-model", "#composer-attach"]) {
    check(`superficie: ${id} presente`, (await page.locator(id).count()) === 1);
  }
  async function lastCall(channel) {
    const raw = await page.locator("#probe-calls").innerText();
    const found = JSON.parse(raw).filter((c) => c.channel === channel);
    return found[found.length - 1];
  }
  if (!await waitForCond(async () => (await timeline.getAttribute("data-timeline-total")) === "600")) await timelineDiag(page, "total");
  check("larga: total 600", (await timeline.getAttribute("data-timeline-total")) === "600");
  const rendered0 = await timeline.getAttribute("data-timeline-rendered");
  const dom0 = await timeline.locator(":scope > .message").count();
  check("larga: total 600 con ventana de 100", rendered0 === "100" && dom0 === 100, `rendered=${rendered0} dom=${dom0}`);
  check("larga: DOM acotado (virtualizado)", dom0 < TOTAL_MESSAGES, `dom=${dom0}`);
  check("larga: hay más antiguos", (await timeline.getAttribute("data-timeline-older")) === "true");
  await page.screenshot({ path: path.join(EVIDENCE, "task-13-timeline-long.png") });

  // C. Centinela: subir arriba autocarga la página anterior (200).
  await page.evaluate(() => document.querySelector(".message-timeline")?.scrollTo(0, 0));
  check("virtualización: centinela autocarga anteriores", await waitForCond(async () => (await timeline.getAttribute("data-timeline-rendered")) === "200"));

  // D. Botón explícito: 200 → 300.
  await timeline.locator("#timeline-older").click();
  check("virtualización: botón carga anteriores", await waitForCond(async () => (await timeline.getAttribute("data-timeline-rendered")) === "300"));

  // E. Streaming en curso con tool call visible (N-C-12b).
  const emit = (event) => page.evaluate((ev) => window.__octusEmit(ev), event);
  const base = { sessionId: "s1", runId: "r-stream", instanceId: "i1", messageId: "live1" };
  await emit({ ...base, kind: "part.delta", part: "text", delta: "Escribiendo " });
  await emit({ ...base, kind: "part.delta", part: "text", delta: "respuesta." });
  await emit({ ...base, kind: "part.delta", part: "reasoning_summary", delta: "resumen" });
  await emit({ ...base, kind: "part.delta", part: "tool_arguments", key: "call_1", delta: "" });
  await emit({ ...base, kind: "part.delta", part: "tool_arguments", key: "call_1", delta: '{"path":"a"}' });
  const live = page.locator('[data-live="live1"]');
  await live.waitFor({ timeout: 10000 });
  check("streaming: marco visible", true);
  check("streaming: texto en curso", (await live.getAttribute("data-text-status")) === "streaming");
  check("streaming: píldora en curso…", ((await live.locator('.frame-status[data-status="streaming"]').count()) >= 1));
  check("streaming: tool call en vuelo visible", (await live.locator('.toolcall[data-tool-status="streaming"]').count()) === 1);
  await live.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(EVIDENCE, "task-13-streaming.png") });

  // F. part.done cierra marcos (N-C-12a).
  await emit({ ...base, kind: "part.done", part: "tool_arguments", key: "call_1" });
  await emit({ ...base, kind: "part.done", part: "text" });
  check("part.done: texto listo", await waitForCond(async () => (await live.getAttribute("data-text-status")) === "done"));
  check("part.done: tool lista", (await live.locator('.toolcall[data-tool-status="done"]').count()) === 1);
  check("part.done: píldora listo", ((await live.locator('.frame-status[data-status="done"]').count()) >= 1));

  // G. message.appended integra sin fantasma ni duplicado.
  const persistedSel = ":scope > .message:not(.live)";
  const beforeAppend = await timeline.locator(persistedSel).count();
  await emit({
    kind: "event",
    event: {
      id: "e1", type: "message.appended", aggregate: { kind: "session", id: "s1" }, seq: 1,
      occurredAt: 1, correlationId: "c", idempotencyKey: "k",
      payload: { message: { id: "live1", sessionId: "s1", runId: "r-stream", instanceId: "i1", role: "assistant", mode: "build", parts: [{ type: "text", text: "Escribiendo respuesta." }], trust: "tool", seq: 601, createdAt: 601 } },
    },
  });
  check("append: live retirado", await waitForCond(async () => (await page.locator('[data-live="live1"]').count()) === 0));
  if ((await page.locator('[data-live="live1"]').count()) !== 0) await timelineDiag(page, "live");
  const afterAppend = await timeline.locator(persistedSel).count();
  check("append: +1 mensaje", afterAppend === beforeAppend + 1, `${beforeAppend}→${afterAppend}`);
  const ids = await timeline.locator(":scope > .message").evaluateAll((els) => els.map((el) => el.getAttribute("data-message-id") ?? el.getAttribute("data-live")));
  check("append: sin duplicados", ids.length === new Set(ids).size, `n=${ids.length}`);

  // H. Composer con adjunto: chip + envío con bloque cercado.
  await page.locator("#composer-files").setInputFiles(attachFile);
  await page.waitForSelector('[data-attachment]', { timeout: 10000 });
  check("composer: chip de adjunto", (await page.locator("[data-attachment]").count()) === 1);
  await composer.locator("textarea").fill("revisa esto");
  await composer.locator("textarea").press("Enter");
  check("llamada sessions.prompt registrada", await waitForCond(async () => (await page.locator("#probe-calls").innerText()).includes('"channel":"sessions.prompt"'), 10000));
  const promptCall = await lastCall("sessions.prompt");
  check("composer: prompt con adjunto cercado", typeof promptCall.payload.text === "string" && promptCall.payload.text.includes("revisa esto") && promptCall.payload.text.includes("Adjunto notas.txt:") && promptCall.payload.text.includes("contenido del adjunto"), promptCall.payload.text.slice(0, 80));
  check("composer: chips limpios tras enviar", (await page.locator("[data-attachment]").count()) === 0);
  // El run del stub termina: busy vuelve a false (sin esto el composer queda bloqueado, correcto).

  await emit({
    kind: "event",
    event: {
      id: "eH", type: "run.completed", aggregate: { kind: "run", id: "run_new" }, seq: 3,
      occurredAt: 3, correlationId: "c", idempotencyKey: "kH", payload: { status: "done" },
    },
  });
  check("busy liberado tras run.completed", await waitForCond(async () => (await page.locator("#composer-cancel").count()) === 0, 10000));

  // I. Selector de modelos: sessions.setModel con ids reales.
  await page.locator("#composer-model").selectOption("a");
  check("llamada sessions.setModel registrada", await waitForCond(async () => (await page.locator("#probe-calls").innerText()).includes('"channel":"sessions.setModel"'), 10000));
  const modelCall = await lastCall("sessions.setModel");
  check("modelos: setModel registrado", modelCall.payload.model.providerId === "fake" && modelCall.payload.model.modelId === "a", JSON.stringify(modelCall.payload.model));

  // J. FAILURE: cancelar a mitad de stream detiene el run sin fantasma ni duplicado.
  const idsBefore = await timeline.locator(":scope > .message").evaluateAll((els) => els.map((el) => el.getAttribute("data-message-id") ?? el.getAttribute("data-live")));
  await composer.locator("textarea").fill("segunda petición");
  await composer.locator("textarea").press("Enter");
  await page.locator("#composer-cancel").waitFor({ timeout: 10000 });
  check("cancelación: botón Interrupt visible en busy", true);
  const cancelBase = { sessionId: "s1", runId: "run_new", instanceId: "i1", messageId: "live2" };
  await emit({ ...cancelBase, kind: "part.delta", part: "text", delta: "a medias…" });
  await page.locator('[data-live="live2"]').waitFor({ timeout: 10000 });
  await page.locator("#composer-cancel").click();
  check("llamada sessions.interrupt registrada", await waitForCond(async () => (await page.locator("#probe-calls").innerText()).includes('"channel":"sessions.interrupt"'), 10000));
  const interruptCalls = JSON.parse(await page.locator("#probe-calls").innerText()).filter((c) => c.channel === "sessions.interrupt").length;
  check("cancelación: interrupt llega al core", interruptCalls >= 1, `calls=${interruptCalls}`);
  await emit({
    kind: "event",
    event: {
      id: "e2", type: "run.cancelled", aggregate: { kind: "run", id: "run_new" }, seq: 2,
      occurredAt: 2, correlationId: "c", idempotencyKey: "k2", payload: { status: "cancelled" },
    },
  });
  await page.locator("#cancel-notice").waitFor({ timeout: 10000 });
  const notice = await page.locator("#cancel-notice").innerText();
  check("cancelación: aviso con motivo", /Cancelado por el usuario/.test(notice), notice.slice(0, 80));
  check("failure: sin marco fantasma", (await page.locator("[data-live]").count()) === 0);
  const idsAfter = await timeline.locator(":scope > .message").evaluateAll((els) => els.map((el) => el.getAttribute("data-message-id") ?? el.getAttribute("data-live")));
  check("failure: sin mensaje fantasma", idsAfter.every((id) => idsBefore.includes(id)), `nuevos=${idsAfter.filter((id) => !idsBefore.includes(id)).length}`);
  check("failure: sin duplicados", idsAfter.length === new Set(idsAfter).size, `n=${idsAfter.length}`);
  await page.screenshot({ path: path.join(EVIDENCE, "task-13-cancel.png") });
  await page.locator("#cancel-notice button").click();
  check("cancelación: aviso descartable", (await page.locator("#cancel-notice").count()) === 0);

  // K. cancel_resume: recarga limpia sin restos.
  await page.reload();
  await page.locator('button[data-project-id="p1"]').waitFor({ timeout: 20000 });
  await page.locator('button[data-project-id="p1"]').click();
  await page.locator("#welcome-continue").click();
  if (!await waitForCond(async () => (await page.locator(".message-timeline").getAttribute("data-timeline-total")) === "600")) await timelineDiag(page, "resume");
  check("resume: total recargado", (await page.locator(".message-timeline").getAttribute("data-timeline-total")) === "600");
  check("resume: sin live tras recarga", (await page.locator("[data-live]").count()) === 0);
  check("resume: sin aviso tras recarga", (await page.locator("#cancel-notice").count()) === 0);

  console.log(failures === 0 ? "probe-task-13-playwright: OK" : `probe-task-13-playwright: FAIL (${failures})`);
  await browser.close();
  server.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`probe-task-13-playwright: ERROR ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
