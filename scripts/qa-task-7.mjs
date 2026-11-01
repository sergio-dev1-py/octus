// QA Todo 7 — render real del catalogo en Chromium (sin Playwright paquete):
// 1) compila scripts/task-7-catalog.entry.tsx con vite + vite-plugin-solid,
// 2) sirve el bundle por HTTP local, 3) lo abre en headless Chromium por CDP,
// 4) afirma selectores fijos, estilos computados, interactividad y temas,
// 5) captura screenshot. Dos pasadas (clase flaky). Exit 0 = verde.
// Uso: node scripts/qa-task-7.mjs
import { execSync, spawn } from "node:child_process";
import { createServer as createHttp } from "node:http";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(root, "apps/desktop");
const distDir = join(root, "scripts", ".task7-dist");
const profileDir = join(root, "scripts", ".task7-profile");
const evidenceDir = join(root, ".omo", "evidence", "octus-ux-skills-mcp");
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

/* --- 1. build vite del catalogo real --- */
console.log("## build vite del catalogo");
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
    rollupOptions: { input: join(root, "scripts", "task-7-catalog.entry.tsx") },
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
  `<!doctype html><html lang="es" data-theme="light" data-density="normal" data-font-size="14"><head><meta charset="utf-8"><link rel="stylesheet" href="./${cssFile.slice(distDir.length + 1).replace(/\\/g, "/")}"></head><body><div id="oc-qa-root"></div><script type="module" src="./${jsFile.slice(distDir.length + 1).replace(/\\/g, "/")}"></script></body></html>`,
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

/* --- 3. Chromium por CDP (WebSocket global de Node, sin deps) --- */
rmSync(profileDir, { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });
let port = 19377;
let chrome = null;
for (let i = 0; i < 5; i++) {
  try {
    chrome = spawn(CHROME, [`--headless=new`, "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
    break;
  } catch (e) {
    port++;
  }
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
async function evaluate(fnSource, ...args) {
  const r = await send("Runtime.evaluate", { expression: `(${fnSource})(${args.map((a) => JSON.stringify(a)).join(",")})`, returnByValue: true, awaitPromise: true });
  return r.result?.value;
}
async function goto() {
  const loaded = new Promise((r) => (loadResolve = r));
  await send("Page.navigate", { url: baseUrl });
  await loaded;
}
async function poll(expr, timeoutMs = 5000) {
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

/* --- 4. aserciones por pasada (superficie real, selectores fijos) --- */
async function runPass(n) {
  await goto();
  const q = async (sel) => evaluate(`() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { visible: r.width > 0 && r.height > 0, text: (el.textContent || "").trim().slice(0, 80) }; }`);
  const cssProp = (sel, prop) => evaluate(`() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? getComputedStyle(el).getPropertyValue(${JSON.stringify(prop)}).trim() : null; }`);

  check(n, "superficie #oc-catalog visible", (await q("#oc-catalog"))?.visible === true);
  for (const [id, label] of [["#oc-btn-primary", "Primary"], ["#oc-btn-secondary", "Secondary"], ["#oc-btn-danger", "Danger"], ["#oc-btn-ghost", "Ghost"], ["#oc-btn-disabled", "Disabled"]]) {
    const got = await q(id);
    check(n, `boton ${id} con etiqueta`, got?.visible === true && (got.text ?? "").includes(label), got?.text ?? "ausente");
  }
  check(n, "boton deshabilitado bloqueado", await evaluate(`() => document.querySelector("#oc-btn-disabled").disabled === true`));
  check(n, "dialogo role=dialog aria-modal", await evaluate(`() => { const d = document.querySelector("#oc-dialog"); return !!d && d.getAttribute("role") === "dialog" && d.getAttribute("aria-modal") === "true"; }`));
  check(n, "dialogo con confirmar y cancelar", (await q("#oc-dialog-ok"))?.visible === true && (await q("#oc-dialog-cancel"))?.visible === true);
  check(n, "menu cerrado sin items en DOM", await evaluate(`() => document.querySelector("#oc-menu [role=menuitem]") === null`));
  check(n, "trigger menu cerrado aria-expanded=false", await evaluate(`() => document.querySelector("#oc-menu-trigger").getAttribute("aria-expanded") === "false"`));
  check(n, "menu abierto con 2 items (1 deshabilitado)", await evaluate(`() => { const items = [...document.querySelectorAll("#oc-menu-open [role=menuitem]")]; return items.length === 2 && document.querySelector("#oc-menu-open-item-b").disabled === true && document.querySelector("#oc-menu-open-item-a").disabled === false; }`));
  check(n, "8 iconos monocromaticos", await evaluate(`() => { const sv = [...document.querySelectorAll("#oc-icons .oc-icon")]; return sv.length === 8 && sv.every((s) => s.getAttribute("stroke") === "currentColor" && s.getAttribute("fill") === "none"); }`));
  check(n, "tabla con 2 filas y caption", await evaluate(`() => document.querySelectorAll("#oc-table tbody [data-oc-row]").length === 2 && (document.querySelector("#oc-table caption")?.textContent || "").includes("QA rows")`));
  check(n, "tabla vacia muestra estado vacio", (await q("#oc-table-empty-empty"))?.visible === true);
  check(n, "estado vacio con accion", (await q("#oc-empty-action"))?.text.includes("Create entry") === true);
  check(n, "estado error role=alert con reintento", await evaluate(`() => { const e = document.querySelector("#oc-error"); return !!e && e.getAttribute("role") === "alert" && (document.querySelector("#oc-error-retry")?.textContent || "").includes("Retry load"); }`));

  // Estilos computados reales sobre tokens (tema claro)
  check(n, "computado: primario usa acento", (await cssProp("#oc-btn-primary", "background-color")) === "rgb(31, 95, 168)", await cssProp("#oc-btn-primary", "background-color"));
  check(n, "computado: error usa danger-wash", (await cssProp("#oc-error", "background-color")) === "rgb(251, 231, 228)", await cssProp("#oc-error", "background-color"));
  check(n, "computado: fondo catalogo usa bg", (await cssProp("#oc-catalog", "background-color")) === "rgb(246, 245, 242)", await cssProp("#oc-catalog", "background-color"));
  check(n, "computado: th tabla en mayusculas", (await cssProp("#oc-table th", "text-transform")) === "uppercase");

  // Interactividad SolidJS real: menu, dialogo, reabrir, confirmar
  await evaluate(`() => document.querySelector("#oc-menu-trigger").click()`);
  check(n, "click abre menu cerrado", await poll(`[...document.querySelectorAll("#oc-menu [role=menuitem]")].length === 2`));
  await evaluate(`() => document.querySelector("#oc-dialog-close").click()`);
  check(n, "click cierra dialogo", await poll(`document.querySelector("#oc-dialog") === null`));
  await evaluate(`() => document.querySelector("#oc-dialog-reopen").click()`);
  check(n, "reabrir muestra dialogo", await poll(`(() => { const d = document.querySelector("#oc-dialog"); if (!d) return false; const r = d.getBoundingClientRect(); return r.width > 0; })()`));
  await evaluate(`() => document.querySelector("#oc-dialog-ok").click()`);
  check(n, "confirmar cierra y registra", await poll(`document.querySelector("#oc-dialog") === null && (document.querySelector("[data-oc-dialog-note]")?.textContent || "").includes("confirmed")`));

  // Tema oscuro conmutado: la cascada de tokens responde
  await evaluate(`() => { document.documentElement.dataset.theme = "dark"; }`);
  check(n, "oscuro: secundario usa panel oscuro", (await cssProp("#oc-btn-secondary", "background-color")) === "rgb(38, 37, 32)", await cssProp("#oc-btn-secondary", "background-color"));
  check(n, "oscuro: fondo catalogo #1b1a17", (await cssProp("#oc-catalog", "background-color")) === "rgb(27, 26, 23)", await cssProp("#oc-catalog", "background-color"));
  await evaluate(`() => { document.documentElement.dataset.theme = "light"; }`);
  check(n, "claro restaurado tras conmutar", (await cssProp("#oc-catalog", "background-color")) === "rgb(246, 245, 242)");

  if (n === 1) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(root, "scripts", ".task7-shot.png"), Buffer.from(shot.data, "base64"));
    console.log("screenshot en scripts/.task7-shot.png");
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
}

console.log(`\nQA Todo 7: ${passes} PASS / ${failures} FAIL → ${failures === 0 ? "PASS" : "FAIL"}`);
process.exit(failures === 0 ? 0 : 1);
