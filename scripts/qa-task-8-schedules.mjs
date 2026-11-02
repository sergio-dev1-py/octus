// QA Todo 8 — superficie real de programadas en Chromium (sin Playwright):
// 1) compila scripts/task-8-schedules.entry.tsx con vite + vite-plugin-solid,
// 2) sirve el bundle por HTTP local, 3) lo abre en headless Chromium por CDP,
// 4) afirma sección sidebar (#schedules-count/#schedules-open), modal con
//    validación visible de cron, CRUD contra IPC stubbed e historial,
// 5) captura .omo/evidence/octus-workbench-chat-terminal/task-8.png y el
//    transcript de esta salida es task-8.log. Exit 0 = verde.
// Uso: node scripts/qa-task-8-schedules.mjs
import { execSync, spawn } from "node:child_process";
import { createServer as createHttp } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(root, "apps/desktop");
const distDir = join(root, "scripts", ".task8-dist");
const profileDir = join(root, "scripts", ".task8-profile");
const evidenceDir = join(root, ".omo", "evidence", "octus-workbench-chat-terminal");
const CHROME = "C:/Users/UserPy/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe";
const requireDesktop = createRequire(join(desktopDir, "package.json"));

let passes = 0;
let failures = 0;
const failuresList = [];
function check(pass, name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} [p${pass}] ${name}${detail ? " — " + detail : ""}`);
  if (cond) passes++;
  else {
    failures++;
    failuresList.push(`[p${pass}] ${name} ${detail}`);
  }
}

/* --- 1. build vite de la entrada real --- */
console.log("## build vite de programadas");
const viteMod = await import(pathToFileURL(requireDesktop.resolve("vite")).href);
const solidMod = await import(pathToFileURL(requireDesktop.resolve("vite-plugin-solid")).href);
const solid = solidMod.default ?? solidMod;
rmSync(distDir, { recursive: true, force: true });
await viteMod.build({
  root: desktopDir,
  configFile: false,
  plugins: [solid()],
  logLevel: "warn",
  build: {
    outDir: distDir,
    emptyOutDir: true,
    rollupOptions: { input: join(root, "scripts", "task-8-schedules.entry.tsx") },
  },
});
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const built = walk(distDir);
const jsFile = built.find((f) => extname(f) === ".js");
const cssFile = built.find((f) => extname(f) === ".css");
if (!jsFile || !cssFile) throw new Error("build sin bundle js/css: " + built.join(","));
console.log(`build OK: ${built.map((f) => f.slice(distDir.length + 1)).join(", ")}`);
writeFileSync(
  join(distDir, "index.html"),
  `<!doctype html><html lang="es" data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="./${cssFile.slice(distDir.length + 1).replace(/\\/g, "/")}"></head><body><div id="oc-qa-root"></div><script type="module" src="./${jsFile.slice(distDir.length + 1).replace(/\\/g, "/")}"></script></body></html>`,
);

/* --- 2. servidor estatico local --- */
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const http = createHttp((req, res) => {
  const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "") || "index.html";
  const file = join(distDir, rel);
  if (!file.startsWith(distDir) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end("nf");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${http.address().port}/index.html`;
console.log(`sirviendo en ${baseUrl}`);

/* --- 3. Chromium por CDP --- */
rmSync(profileDir, { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });
const port = 19378;
const chrome = spawn(CHROME, [`--headless=new`, "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
async function cdpGet(path) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("CDP no responde en puerto " + port);
}
const targets = await cdpGet("/json/list");
const pageTarget = targets.find((t) => t.type === "page");
if (!pageTarget) throw new Error("sin target page: " + JSON.stringify(targets).slice(0, 300));
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl, []);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let msgId = 0;
const pending = new Map();
let loadResolve = null;
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  } else if (msg.method === "Page.loadEventFired" && loadResolve) {
    const f = loadResolve;
    loadResolve = null;
    f();
  }
});
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("CDP timeout " + method));
      }
    }, 15000);
  });
}
async function evaluate(fnSource) {
  const r = await send("Runtime.evaluate", { expression: `(${fnSource})()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("evaluate: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
}
async function goto() {
  const loaded = new Promise((r) => (loadResolve = r));
  await send("Page.navigate", { url: baseUrl });
  await loaded;
}
async function poll(expr, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await evaluate(`() => (${expr})`);
    if (v) return v;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 60));
  }
}
await send("Page.enable");
await send("Runtime.enable");

/* --- 4. aserciones (superficie real, selectores fijos) --- */
async function runPass(n) {
  await goto();
  const q = async (sel) => evaluate(`() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { visible: r.width > 0 && r.height > 0, text: (el.textContent || "").trim().slice(0, 120) }; }`);
  const cssProp = (sel, prop) => evaluate(`() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? getComputedStyle(el).getPropertyValue(${JSON.stringify(prop)}).trim() : null; }`);

  check(n, "seccion #scheduled-tasks visible", (await q("#scheduled-tasks"))?.visible === true);
  check(n, "contador vivo 2 programadas · 1 activa", await poll(`(document.querySelector("#schedules-count")?.textContent || "").includes("2 programada(s)") && (document.querySelector("#schedules-count")?.textContent || "").includes("1 activa(s)")`), await q("#schedules-count").then((v) => v?.text ?? "ausente"));
  check(n, "#schedules-open habilitado", await evaluate(`() => { const b = document.querySelector("#schedules-open"); return !!b && !b.disabled; }`));
  check(n, "dos filas con toggle e historial", await evaluate(`() => document.querySelectorAll("[data-schedule]").length === 2 && document.querySelectorAll("[data-schedule-toggle]").length === 2`));
  check(n, "pausada muestra fallos seguidos", await poll(`(document.querySelector('[data-schedule="sch-noche"]')?.textContent || "").includes("2 fallo(s)")`));
  check(n, "modal role=dialog aria-modal abierto", await poll(`(() => { const d = document.querySelector("#schedules-modal"); if (!d) return false; const r = d.getBoundingClientRect(); return d.getAttribute("role") === "dialog" && d.getAttribute("aria-modal") === "true" && r.width > 0; })()`));
  check(n, "modal usa panel del tema navy", (await cssProp("#schedules-modal", "background-color")) === "rgb(42, 48, 66)", await cssProp("#schedules-modal", "background-color"));

  // malformed_input: cron malo muestra error visible y NO invoca create.
  await evaluate(`() => { const i = document.querySelector("#schedules-cron"); i.focus(); document.execCommand("selectAll", false, null); document.execCommand("insertText", false, "mal"); i.dispatchEvent(new Event("input", { bubbles: true })); }`);
  check(n, "cron malo muestra #schedules-cron-error role=alert", await poll(`(() => { const e = document.querySelector("#schedules-cron-error"); if (!e) return false; const r = e.getBoundingClientRect(); return e.getAttribute("role") === "alert" && r.width > 0; })()`));
  await evaluate(`() => { const set = (sel, v) => { const el = document.querySelector(sel); el.focus(); document.execCommand("selectAll", false, null); document.execCommand("insertText", false, v); el.dispatchEvent(new Event("input", { bubbles: true })); }; set("#schedules-name", "QA"); set("#schedules-prompt", "hacer QA"); }`);
  await evaluate(`() => document.querySelector("#schedules-save").click()`);
  check(n, "guardar con cron malo no llama a schedules.create", await evaluate(`() => window.__qaCalls.filter((c) => c.channel === "schedules.create").length === 0`));
  check(n, "fallo de validación deja banner en el modal", await poll(`(() => { const e = document.querySelector("#schedules-form-error"); return !!e && e.getAttribute("role") === "alert"; })()`));

  // Cerrar modal: cron válido + guardar crea de verdad (misleading_success: ok→cierra).
  await evaluate(`() => document.querySelector("#schedules-cancel").click()`);
  check(n, "cancelar cierra el modal", await poll(`document.querySelector("#schedules-modal") === null`));
  await evaluate(`() => document.querySelector("#schedules-open").click()`);
  await poll(`document.querySelector("#schedules-modal") !== null`);
  await evaluate(`() => { const set = (sel, v) => { const el = document.querySelector(sel); el.focus(); document.execCommand("selectAll", false, null); document.execCommand("insertText", false, v); el.dispatchEvent(new Event("input", { bubbles: true })); const ev = new Event("change", { bubbles: true }); el.dispatchEvent(ev); }; set("#schedules-name", "QA ok"); set("#schedules-prompt", "hacer QA"); set("#schedules-cron", "0 9 * * *"); }`);
  await evaluate(`() => document.querySelector("#schedules-save").click()`);
  check(n, "guardar válido invoca schedules.create y cierra", await poll(`window.__qaCalls.some((c) => c.channel === "schedules.create") && document.querySelector("#schedules-modal") === null`));

  // stale_state + historial: toggle refresca lista; historial muestra runs reales.
  await evaluate(`() => document.querySelector('[data-schedule-toggle="sch-manana"]').click()`);
  check(n, "toggle invoca setEnabled + relectura", await poll(`window.__qaCalls.some((c) => c.channel === "schedules.setEnabled") && window.__qaCalls.filter((c) => c.channel === "schedules.list").length >= 2`));
  await evaluate(`() => document.querySelector('[data-schedule-history="sch-manana"] summary').click()`);
  check(n, "historial expande 2 runs (fired + omitida)", await poll(`document.querySelectorAll('[data-history-run^="sch-manana:"]').length === 2`));
  // dirty_worktree/remover: doble clic (confirmar) invoca remove.
  await evaluate(`() => document.querySelector('[data-schedule-remove="sch-noche"]').click()`);
  await evaluate(`() => document.querySelector('[data-schedule-confirm="sch-noche"]').click()`);
  check(n, "eliminar con confirmación invoca schedules.remove", await poll(`window.__qaCalls.some((c) => c.channel === "schedules.remove")`));

  if (n === 1) {
    await evaluate(`() => document.querySelector("#schedules-open").click()`);
    await poll(`document.querySelector("#schedules-modal") !== null`);
    await new Promise((r) => setTimeout(r, 400));
    const shot = await send("Page.captureScreenshot", { format: "png" });
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, "task-8.png"), Buffer.from(shot.data, "base64"));
    console.log("screenshot en .omo/evidence/octus-workbench-chat-terminal/task-8.png");
  }
}

try {
  await runPass(1);
  await runPass(2);
} finally {
  try {
    ws.close();
  } catch {}
  http.close();
  if (chrome && chrome.exitCode === null) {
    try {
      execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: "ignore" });
    } catch {}
    await new Promise((r) => {
      chrome.on("exit", r);
      setTimeout(r, 8000);
    });
  }
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  rmSync(distDir, { recursive: true, force: true });
}

console.log(`\nQA Todo 8: ${passes} PASS / ${failures} FAIL → ${failures === 0 ? "PASS" : "FAIL"}`);
process.exit(failures === 0 ? 0 : 1);
