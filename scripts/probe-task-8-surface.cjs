/**
 * Sonda Todo 8 — superficie REAL del workbench (no dry-run, no estática).
 * Arranca Electron con el bundle construido (apps/desktop/out), lo maneja con
 * entrada de verdad (clicks y teclado de confianza) y afirma ocultar,
 * redimensionar por arrastre, restaurar y degradación ante layout corrupto.
 *
 * Uso (desde la raíz del repo, tras `bun run --cwd apps/desktop build`):
 *   ./apps/desktop/node_modules/.bin/electron.exe scripts/probe-task-8-surface.cjs
 * Exit 0 = todo verde; exit 1 = fallo. Vuelca PNGs a .omo/evidence/octus-ux-skills-mcp/.
 */
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.dirname(__dirname);
const INDEX = path.join(ROOT, "apps/desktop/out/renderer/index.html");
const PRELOAD = path.join(ROOT, "scripts/probe-task-8-preload.cjs");
const EVIDENCE = path.join(ROOT, ".omo/evidence/octus-ux-skills-mcp");

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function js(win, expr) {
  return win.webContents.executeJavaScript(expr);
}

async function waitFor(win, expr, timeout = 20000) {
  await win.webContents.executeJavaScript(`(async () => {
    const t0 = Date.now();
    for (;;) {
      let ok = false;
      try { ok = !!(${expr}); } catch {}
      if (ok) return true;
      if (Date.now() - t0 > ${timeout}) throw new Error("probe waitFor timeout");
      await new Promise((r) => setTimeout(r, 100));
    }
  })()`);
}

async function key(win, keyCode, modifiers = []) {
  await win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  await win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await sleep(350);
}

async function main() {
  if (!fs.existsSync(INDEX)) {
    console.log(`FAIL bundle construido ausente (${INDEX}): ejecuta el build antes de la sonda`);
    process.exit(1);
  }
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await app.whenReady();
  const win = new BrowserWindow({
    width: 1366,
    height: 900,
    show: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${sourceId}:${line} ${String(message).slice(0, 300)}`);
  });
  win.webContents.on("did-fail-load", (_event, code, desc, url) => {
    console.log(`[did-fail-load] ${code} ${desc} ${url}`);
  });
  await win.loadFile(INDEX);
  await waitFor(win, `document.getElementById("bottom-panel") && document.getElementById("sidebar")`);

  // A. Selectores fijos presentes en la superficie real.
  const ids = await js(win, `["activity-bar","sidebar","center","inspector","bottom-panel","composer","layout-reset","toggle-sidebar","toggle-inspector","toggle-bottom"].map((id) => [id, !!document.getElementById(id)])`);
  for (const [id, present] of ids) check(`superficie: #${id} presente`, present === true);
  const counts = await js(win, `({ acts: document.querySelectorAll("[data-activity]").length, tabs: document.querySelectorAll("[data-bottom-tab]").length, handles: document.querySelectorAll("[data-resize]").length, timeline: !!document.querySelector(".message-timeline") })`);
  check("superficie: 6 actividades", counts.acts === 6, `got ${counts.acts}`);
  check("superficie: 4 pestañas inferiores", counts.tabs === 4, `got ${counts.tabs}`);
  check("superficie: 3 tiradores", counts.handles === 3, `got ${counts.handles}`);
  check("superficie: .message-timeline intacto", counts.timeline === true);

  // B. Visibles con tamaños del defecto + no en blanco.
  const geo = await js(win, `({ side: document.getElementById("sidebar").style.width, insp: document.getElementById("inspector").style.width, bottom: document.getElementById("bottom-panel").style.height, sideD: getComputedStyle(document.getElementById("sidebar")).display, text: document.body.innerText.length })`);
  check("sidebar visible a 264px", geo.sideD !== "none" && geo.side === "264px", JSON.stringify(geo));
  check("inspector visible a 248px", geo.insp === "248px", geo.insp);
  check("panel inferior visible a 180px", geo.bottom === "180px", geo.bottom);
  check("no hay pantalla en blanco", geo.text > 200, `chars=${geo.text}`);

  // C. Ocultar sidebar con click real y reabrir con actividad.
  await js(win, `document.getElementById("toggle-sidebar").click()`);
  await sleep(400);
  check("click oculta sidebar", (await js(win, `getComputedStyle(document.getElementById("sidebar")).display`)) === "none");
  await js(win, `document.querySelector('[data-activity="plans"]').click()`);
  await sleep(400);
  const afterAct = await js(win, `({ d: getComputedStyle(document.getElementById("sidebar")).display })`);
  check("actividad reabre sidebar", afterAct.d !== "none");
  await key(win, "0", ["control"]); // Ctrl+0: defecto
  const def = await js(win, `({ side: document.getElementById("sidebar").style.width, acts: document.querySelector('[data-activity="explorer"]').getAttribute("aria-pressed") })`);
  check("Ctrl+0 restaura defecto", def.side === "264px" && def.acts === "true", JSON.stringify(def));

  // D. Arrastre real del tirador (+40px).
  // El tirador mide 4px y se desplaza con el cursor: como un usuario real, la sonda
  // relee su posición antes de cada paso para no perderlo (sin depender de la captura).
  const gripY = await js(win, `(() => { const r = document.querySelector('[data-resize="sidebar"]').getBoundingClientRect(); return r.y + r.height / 2; })()`);
  const gripX = await js(win, `(() => { const r = document.querySelector('[data-resize="sidebar"]').getBoundingClientRect(); return r.x + r.width / 2; })()`);
  win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(gripX), y: Math.round(gripY) });
  await sleep(200);
  win.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(gripX), y: Math.round(gripY), button: "left", clickCount: 1 });
  for (let i = 0; i < 20; i += 1) {
    const at = await js(win, `(() => { const r = document.querySelector('[data-resize="sidebar"]').getBoundingClientRect(); return r.x + r.width / 2; })()`);
    win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(at) + 2, y: Math.round(gripY), button: "left" });
    await sleep(60);
  }
  const gripEnd = await js(win, `(() => { const r = document.querySelector('[data-resize="sidebar"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(gripEnd.x), y: Math.round(gripEnd.y), button: "left" });
  await sleep(600);
  const dragged = await js(win, `document.getElementById("sidebar").style.width`);
  const draggedPx = Number.parseInt(dragged, 10);
  check("arrastre ensancha sidebar ≈304px", Math.abs(draggedPx - 304) <= 4, dragged);
  await key(win, "0", ["control"]);
  check("Ctrl+0 tras arrastre vuelve a 264px", (await js(win, `document.getElementById("sidebar").style.width`)) === "264px");

  // E. Teclado: panel inferior e inspector.
  await key(win, "J", ["control"]);
  check("Ctrl+J oculta panel inferior", (await js(win, `getComputedStyle(document.getElementById("bottom-panel")).display`)) === "none");
  await key(win, "0", ["control"]);
  check("Ctrl+0 restaura panel inferior", (await js(win, `getComputedStyle(document.getElementById("bottom-panel")).display`)) !== "none");
  await key(win, "I", ["control", "alt"]);
  check("Ctrl+Alt+I oculta inspector", (await js(win, `getComputedStyle(document.getElementById("inspector")).display`)) === "none");
  await key(win, "0", ["control"]);
  check("Ctrl+0 restaura inspector", (await js(win, `getComputedStyle(document.getElementById("inspector")).display`)) !== "none");

  // F. Pestaña con click real.
  await js(win, `document.querySelector('[data-bottom-tab="problems"]').click()`);
  await sleep(400);
  check(
    "click selecciona pestaña Problemas",
    (await js(win, `document.querySelector('[data-bottom-tab="problems"]').getAttribute("aria-selected")`)) === "true",
  );

  // G. Captura: píxeles no en blanco (misma superficie que ve el usuario).
  const png = await win.capturePage();
  const pngPath = path.join(EVIDENCE, "task-8-surface.png");
  fs.writeFileSync(pngPath, png.toPNG());
  const bitmap = png.getBitmap();
  const seen = new Set();
  for (let i = 0; i < bitmap.length && seen.size < 8; i += 4096) {
    seen.add(bitmap.readUInt32LE(i));
  }
  check("píxeles de la superficie no en blanco", seen.size > 2, `colores=${seen.size}`);
  console.log(`captura: ${pngPath} (${png.getSize().width}x${png.getSize().height})`);

  // H. Failure: layout corrupto → defecto + aviso, sin pantalla en blanco.
  await win.loadFile(INDEX, { query: { probe: "corrupt" } });
  await waitFor(win, `document.getElementById("layout-notice") && document.getElementById("layout-notice").offsetParent !== null`);
  const notice = await js(win, `({ text: document.getElementById("layout-notice").innerText.slice(0, 120), sideD: getComputedStyle(document.getElementById("sidebar")).display, bottomD: getComputedStyle(document.getElementById("bottom-panel")).display, body: document.body.innerText.length })`);
  check("layout corrupto muestra aviso", /dañado/i.test(notice.text), notice.text);
  check("layout corrupto restaura paneles visibles", notice.sideD !== "none" && notice.bottomD !== "none" && notice.body > 200);
  const pngBad = await win.capturePage();
  fs.writeFileSync(path.join(EVIDENCE, "task-8-surface-corrupt.png"), pngBad.toPNG());

  console.log(failures === 0 ? "probe-task-8-surface: OK" : `probe-task-8-surface: FAIL (${failures})`);
  app.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`probe-task-8-surface: ERROR ${error instanceof Error ? error.stack : String(error)}`);
  app.exit(1);
});
