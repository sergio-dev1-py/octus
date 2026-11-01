// QA Todo 11 — superficie real del gestor de proyectos y sesiones:
// 1) sonda runtime del núcleo (bun, SQLite real) vía probe-task-11-core.ts,
// 2) aserciones sobre los artefactos construidos out/main y out/renderer,
// 3) Chromium headless por CDP sobre un bundle vite de la App REAL con un
//    backend contract-shaped (mismos canales OctusIPC), 2 pasadas + screenshot.
// Uso: node scripts/qa-task-11-manual.mjs (exit 0 = verde).
import { execSync, spawn } from "node:child_process";
import { createServer as createHttp } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(root, "apps/desktop");
const distDir = join(root, "scripts", ".task11-dist");
const profileDir = join(root, "scripts", ".task11-profile");
const evidenceDir = join(root, ".omo", "evidence", "octus-ux-skills-mcp");
const CHROME = "C:/Users/UserPy/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe";
const requireDesktop = createRequire(join(desktopDir, "package.json"));

let passes = 0;
let failures = 0;
const failuresList = [];
function check(pass, name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} [p${pass}] ${name}${detail ? " — " + detail : ""}`);
  if (cond) passes++;
  else { failures++; failuresList.push(`[p${pass}] ${name} ${detail}`); }
}

/* --- 1. sonda runtime del núcleo (proceso bun real, SQLite real) --- */
console.log("## 1. sonda runtime del núcleo");
try {
  const out = execSync("bun ../../scripts/probe-task-11-core.ts", { cwd: join(root, "packages/core"), encoding: "utf8", timeout: 120000 });
  const lines = out.trim().split("\n");
  for (const line of lines) console.log("  " + line);
  check(1, "sonda runtime del núcleo en verde", out.includes("PROBE-CORE: OK"), `${lines.filter((l) => l.startsWith("PASS")).length} PASS`);
} catch (e) {
  console.log("  " + String((e.stdout ?? e.message)).slice(-1200));
  check(1, "sonda runtime del núcleo en verde", false, "exit != 0");
}

/* --- 2. artefactos construidos (lo que el usuario ejecuta) --- */
console.log("## 2. artefactos construidos");
const mainBundle = join(root, "apps/desktop/out/main/index.js");
const rendDir = join(root, "apps/desktop/out/renderer/assets");
let rendJs = "";
try {
  const files = readdirSync(rendDir);
  const js = files.find((f) => f.endsWith(".js"));
  rendJs = js ? readFileSync(join(rendDir, js), "utf8") : "";
} catch {}
const mainSrc = existsSync(mainBundle) ? readFileSync(mainBundle, "utf8") : "";
check(1, "main bundle expone sessions.recover", mainSrc.includes("sessions.recover"), mainBundle);
check(1, "renderer trae #project-nav", rendJs.includes("project-nav"));
check(1, "renderer trae #session-list", rendJs.includes("session-list"));
check(1, "renderer trae #session-recover", rendJs.includes("session-recover"));
check(1, "renderer trae #session-notice", rendJs.includes("session-notice"));
check(1, "renderer invoca sessions.recover", rendJs.includes("sessions.recover"));
check(1, "renderer trae cierre por sesión", rendJs.includes("data-session-close") || rendJs.includes("session-close"));

/* --- 3. bundle vite de la App real + Chromium por CDP --- */
console.log("## 3. superficie en Chromium (App real)");
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
    rollupOptions: { input: join(root, "scripts", "task-11-sessions.entry.tsx") },
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
if (!jsFile) throw new Error("build QA sin bundle js: " + built.join(","));
console.log(`build QA OK: ${built.map((f) => f.slice(distDir.length + 1)).join(", ")}`);
writeFileSync(
  join(distDir, "index.html"),
  `<!doctype html><html lang="es"><head><meta charset="utf-8"></head><body><div id="oc-qa-root"></div><script type="module" src="./${jsFile.slice(distDir.length + 1).replace(/\\/g, "/")}"></script></body></html>`,
);

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

for (let i = 0; i < 10; i++) {
  try { rmSync(profileDir, { recursive: true, force: true }); break; }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}
mkdirSync(profileDir, { recursive: true });
let port = 19450 + (process.pid % 400);
let chrome = null;
for (let i = 0; i < 5; i++) {
  try {
    chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
    break;
  } catch { port++; }
}
if (!chrome) throw new Error("no se pudo lanzar chromium");
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
if (!pageTarget) throw new Error("sin target page");
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("CDP timeout " + method)); } }, 15000);
  });
}
async function evaluate(fnSource, ...args) {
  const r = await send("Runtime.evaluate", { expression: `(${fnSource})(${args.map((a) => JSON.stringify(a)).join(",")})`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("evaluate: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
}
async function goto() {
  const loaded = new Promise((r) => (loadResolve = r));
  await send("Page.navigate", { url: baseUrl });
  await loaded;
}
async function poll(expr, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await evaluate(`() => (${expr})`);
    if (v) return v;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 80));
  }
}
await send("Page.enable");
await send("Runtime.enable");

async function runPass(n) {
  await goto();
  // Bienvenida primero (Todo 10, sin auto-selección): la App arranca en welcome.
  check(n, "bienvenida visible sin auto-selección", await poll(`!!document.querySelector("#welcome-shell") && !!document.querySelector("#welcome-dropzone") && !document.querySelector("#workbench")`));
  check(n, "recientes con fecha (2 proyectos)", await poll(`document.querySelectorAll("#welcome-recents .recent").length === 2 && (document.querySelector('#welcome-recents')?.textContent || "").includes("Proyecto A")`));
  // Abrir proyecto A por reciente → modo sesiones → abrir sin sesión.
  await evaluate(`() => document.querySelector('#welcome-recents [data-project-id="prj_A"]').click()`);
  check(n, "modo sesiones del proyecto A", await poll(`!!document.querySelector("#welcome-open") && document.querySelectorAll(".welcome-sessions li").length === 3`));
  await evaluate(`() => document.querySelector("#welcome-open").click()`);
  check(n, "workbench visible tras abrir", await poll(`!!document.querySelector("#workbench") && !document.querySelector("#welcome-shell")`));
  check(n, "#project-nav con sesiones del proyecto A", await poll(`(document.querySelectorAll("#session-list [data-session-id]").length === 3)`), "A1, A2, frágil");
  check(n, "aislamiento visual: B-uno no está en la lista", await evaluate(`() => ![...document.querySelectorAll("#session-list [data-session-id]")].some((el) => el.getAttribute("data-session-id") === "ses_B1")`));
  // Cambiar de sesión con click real (nada seleccionado al abrir).
  await evaluate(`() => document.querySelector('#session-list [data-session-id="ses_A2"] button').click()`);
  check(n, "cambiar a A-dos actualiza selección y cabecera", await poll(`document.querySelector('#session-list [data-session-id="ses_A2"]')?.getAttribute("aria-selected") === "true" && (document.querySelector(".chat header h2")?.textContent || "").includes("A-dos")`));
  check(n, "inspector muestra recuperación pendiente", await poll(`(document.querySelector("#inspector")?.textContent || "").includes("2 ops pendientes")`));

  // Renombrar desde el inspector (espera a que el input refleje A-dos: quiescente).
  check(n, "inspector refleja A-dos", await poll(`document.querySelector("#inspector input[aria-label='Nuevo título de sesión']")?.value === "A-dos"`));
  const setValue = await evaluate(`(t) => { const i = document.querySelector("#inspector input[aria-label='Nuevo título de sesión']"); i.focus(); i.value = t; i.dispatchEvent(new Event("input", { bubbles: true })); return i.value; }`, "A-dos-qa");
  await evaluate(`() => document.querySelector("#session-rename").click()`);
  const renameCalls = await evaluate(`() => window.__t11.calls.filter((c) => c.channel === "sessions.rename").map((c) => JSON.stringify(c.payload))`);
  const listText = await evaluate(`() => document.querySelector('#session-list [data-session-id="ses_A2"] button')?.textContent ?? "SIN-NODO"`);
  check(n, "renombrar persiste en la lista", await poll(`(document.querySelector('#session-list [data-session-id="ses_A2"] button')?.textContent || "").includes("A-dos-qa")`), `set=${setValue} calls=${renameCalls} lista=${listText}`);

  // Cerrar sesión activa: desaparece y el vecino continúa seleccionado.
  await evaluate(`() => document.querySelector('[data-session-close="ses_A2"]').click()`);
  check(n, "cerrar elimina A-dos y continúa en otra", await poll(`document.querySelector('#session-list [data-session-id="ses_A2"]') === null && document.querySelectorAll("#session-list [data-session-id]").length === 2 && !!document.querySelector("#session-list [aria-selected='true']")`));

  // Guarda de aislamiento: seleccionar sesión de otro proyecto se rechaza.
  const before = await evaluate(`() => document.querySelector("#session-list [aria-selected='true']")?.getAttribute("data-session-id")`);
  await evaluate(`(id) => window.__t11.tryForeign(id)`, "ses_B1");
  const guardExpr = "(document.querySelector('.chat .banner.err')?.textContent || '').includes('does not belong')" +
    " && document.querySelector(\"#session-list [aria-selected='true']\")?.getAttribute('data-session-id') === '" + before + "'";
  check(n, "guarda de aislamiento rechaza sesión foránea", await poll(guardExpr), `activa=${before}`);

  // Sesión corrupta: el banner ofrece recuperación, sin pantalla en blanco.
  await evaluate(`() => document.querySelector('#session-list [data-session-id="ses_fragil"] button').click()`);
  check(n, "sesión corrupta muestra aviso de recuperación", await poll(`!!document.querySelector("#session-notice") && (document.querySelector("#session-notice")?.textContent || "").includes("Recuperar")`));
  check(n, "sin pantalla en blanco ante corrupción", await evaluate(`() => (document.querySelector("#workbench")?.textContent || "").length > 200`));
  await evaluate(`() => document.querySelector("#session-recover").click()`);
  check(n, "recuperar degrada a vacía registrada con conteo", await poll(`(document.querySelector("#session-notice")?.textContent || "").includes("1 mensaje(s) y 1 evento(s)")`));

  // Sesión sana: verificación sin incidente.
  await evaluate(`() => document.querySelector('#session-list [data-session-id="ses_A1"] button').click()`);
  await evaluate(`() => document.querySelector("#session-recover").click()`);
  check(n, "recuperar sana informa sin incidente", await poll(`(document.querySelector("#session-notice")?.textContent || "").includes("sin filas corruptas")`));

  if (n === 1) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, "task-11-surface.png"), Buffer.from(shot.data, "base64"));
    console.log("screenshot en .omo/evidence/octus-ux-skills-mcp/task-11-surface.png");
  }
}

try {
  await runPass(1);
  await runPass(2);
} finally {
  try { ws.close(); } catch {}
  http.close();
  if (chrome && chrome.exitCode === null) {
    try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {}
    await new Promise((r) => { chrome.on("exit", r); setTimeout(r, 8000); });
  }
  for (let i = 0; i < 20; i++) {
    try { rmSync(profileDir, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  try { rmSync(distDir, { recursive: true, force: true }); } catch {}
}

console.log(`\nQA Todo 11: ${passes} PASS / ${failures} FAIL → ${failures === 0 ? "PASS" : "FAIL"}`);
if (failuresList.length > 0) console.log("Fallos:\n- " + failuresList.join("\n- "));
process.exit(failures === 0 ? 0 : 1);
