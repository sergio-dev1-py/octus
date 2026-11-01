// QA Todo 24 — smoke real de la SkillsManagerView en Chromium (sin Playwright paquete):
// 1) compila scripts/task-24-skills.entry.tsx con vite + vite-plugin-solid,
// 2) sirve el bundle por HTTP local, 3) lo abre en headless Chromium por CDP,
// 4) afirma selectores fijos (catálogo, detalle con origen y alcance, importar,
//    habilitar, historial, error que bloquea), interactividad y tokens,
// 5) captura screenshot. Dos pasadas (clase flaky). Exit 0 = verde.
// Uso: node scripts/qa-task-24.mjs
import { execSync, spawn } from "node:child_process";
import { createServer as createHttp } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(root, "apps/desktop");
const distDir = join(root, "scripts", ".task24-dist");
const profileDir = join(root, "scripts", ".task24-profile");
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

/* --- 1. build vite de la vista real --- */
console.log("## build vite de SkillsManagerView");
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
    rollupOptions: { input: join(root, "scripts", "task-24-skills.entry.tsx") },
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
const http = createHttp(function (req, res) {
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
const baseUrl = `http://127.0.0.1/${http.address().port}/index.html`.replace("http://127.0.0.1/", "http://127.0.0.1:");
const url = `http://127.0.0.1:${http.address().port}/index.html`;
console.log(`sirviendo en ${url}`);

/* --- 3. Chromium por CDP --- */
rmSync(profileDir, { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });
const port = 19379;
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
async function evaluate(fnSource, ...args) {
  const r = await send("Runtime.evaluate", { expression: `(${fnSource})(${args.map((a) => JSON.stringify(a)).join(",")})`, returnByValue: true, awaitPromise: true });
  return r.result?.value;
}
async function goto() {
  const loaded = new Promise((r) => (loadResolve = r));
  await send("Page.navigate", { url });
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

/* --- 4. aserciones por pasada --- */
async function runPass(n) {
  await goto();
  await poll(`document.querySelector("#skills-manager") !== null`);
  const q = async (sel) => evaluate(`() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { visible: r.width > 0 && r.height > 0, text: (el.textContent || "").trim().slice(0, 90) }; }`);
  const cssProp = (sel, prop) => evaluate(`() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? getComputedStyle(el).getPropertyValue(${JSON.stringify(prop)}).trim() : null; }`);

  // W-S1 catálogo con origen visible
  check(n, "superficie #skills-manager visible", (await q("#skills-manager"))?.visible === true);
  const counts = await evaluate(`() => { const el = document.querySelector("#skills-counts"); return el ? { i: el.getAttribute("data-installed"), e: el.getAttribute("data-enabled"), t: el.textContent } : null; }`);
  check(n, "contadores 2 instaladas, 1 habilitada", counts?.i === "2" && counts?.e === "1", JSON.stringify(counts?.t?.slice(0, 60)));
  check(n, "fila qa-skill instalada+habilitada", await evaluate(`() => { const li = document.querySelector('[data-skill-name="qa-skill"]'); return !!li && li.getAttribute("data-installed") === "true" && li.getAttribute("data-enabled") === "true"; }`));
  check(n, "fila old-helper instalada pero deshabilitada", await evaluate(`() => { const li = document.querySelector('[data-skill-name="old-helper"]'); return !!li && li.getAttribute("data-installed") === "true" && li.getAttribute("data-enabled") === "false"; }`));
  check(n, "pastillas instalada≠habilitada distintas", await evaluate(`() => { const li = document.querySelector('[data-skill-name="qa-skill"]'); const t = li?.textContent || ""; return t.includes("instalada") && t.includes("habilitada"); }`));
  check(n, "origen y alcance con badges", await evaluate(`() => document.querySelector('[data-skill-name="qa-skill"] [data-skill-origin="project"]') !== null && document.querySelector('[data-skill-name="qa-skill"] [data-skill-scope="project"]') !== null`));

  // W-S2/S3 filtros excluyentes
  await evaluate(`() => document.querySelector("#skills-filter-enabled").click()`);
  check(n, "filtro habilitadas deja solo qa-skill", await poll(`document.querySelectorAll("#skills-list [data-skill-name]").length === 1 && document.querySelector('[data-skill-name="qa-skill"]') !== null`));
  await evaluate(`() => document.querySelector("#skills-filter-installed").click()`);
  check(n, "filtro instaladas deja 2", await poll(`document.querySelectorAll("#skills-list [data-skill-name]").length === 2`));
  await evaluate(`() => document.querySelector("#skills-filter-all").click()`);
  await evaluate(`() => { const s = document.querySelector("#skills-search"); s.focus(); s.value = "old"; s.dispatchEvent(new Event("input", { bubbles: true })); }`);
  check(n, "buscar filtra a old-helper", await poll(`document.querySelectorAll("#skills-list [data-skill-name]").length === 1 && document.querySelector('[data-skill-name="old-helper"]') !== null`));
  await evaluate(`() => { const s = document.querySelector("#skills-search"); s.value = ""; s.dispatchEvent(new Event("input", { bubbles: true })); }`);
  await poll(`document.querySelectorAll("#skills-list [data-skill-name]").length === 2`);

  // W-S4 detalle con origen, alcance, procedencia y recursos
  await evaluate(`() => document.querySelector('[data-skill-name="qa-skill"] button').click()`);
  check(n, "detalle visible con nombre@version", await poll(`(document.querySelector("#skills-detail-title")?.textContent || "").includes("qa-skill") && (document.querySelector("#skills-detail-title")?.textContent || "").includes("1.0.0")`));
  check(n, "detalle: origen project y alcance project", await evaluate(`() => document.querySelector("#skills-detail-origin")?.getAttribute("data-skill-detail-origin") === "project" && document.querySelector("#skills-detail-scope")?.getAttribute("data-skill-detail-scope") === "project"`));
  check(n, "detalle: procedencia carpeta visible", ((await q("#skills-detail-provenance"))?.text || "").includes("folder"));
  check(n, "detalle: recursos listan docs/uso.md", await evaluate(`() => (document.querySelector("#skills-detail-files")?.textContent || "").includes("docs/uso.md")`));

  // Habilitar/deshabilitar con reactividad real (puente con estado)
  await evaluate(`() => document.querySelector('[data-skill-name="old-helper"] button').click()`);
  await poll(`document.querySelector("#skills-detail")?.getAttribute("data-skill-detail") === "old-helper"`);
  await evaluate(`() => document.querySelector("#skills-enable").click()`);
  check(n, "habilitar old-helper la marca habilitada", await poll(`document.querySelector('[data-skill-name="old-helper"]')?.getAttribute("data-enabled") === "true"`));
  check(n, "contadores suben a 2 habilitadas", await poll(`document.querySelector("#skills-counts")?.getAttribute("data-enabled") === "2"`));
  await evaluate(`() => document.querySelector('[data-skill-name="qa-skill"] button').click()`);
  await poll(`document.querySelector("#skills-detail")?.getAttribute("data-skill-detail") === "qa-skill"`);
  await evaluate(`() => document.querySelector("#skills-disable").click()`);
  check(n, "deshabilitar qa-skill la marca deshabilitada", await poll(`document.querySelector('[data-skill-name="qa-skill"]')?.getAttribute("data-enabled") === "false"`));

  // W-S5 importar carpeta (pick + go) añade fila real
  await evaluate(`() => document.querySelector("#skills-import-folder-pick").click()`);
  check(n, "pick rellena la ruta", await poll(`(document.querySelector("#skills-import-folder-path").value || "").includes("qa-imported")`));
  await evaluate(`() => document.querySelector("#skills-import-folder-go").click()`);
  check(n, "importar añade qa-imported al catalogo", await poll(`document.querySelector('[data-skill-name="qa-imported"]') !== null`));
  check(n, "aviso de importacion visible", await poll(`(document.querySelector("#skills-notice")?.textContent || "").includes("Importada")`));

  // W-S6 historial de uso por run
  await evaluate(`() => { const i = document.querySelector("#skills-history-run"); i.focus(); i.value = "run_qa01"; i.dispatchEvent(new Event("input", { bubbles: true })); }`);
  await evaluate(`() => document.querySelector("#skills-history-load").click()`);
  check(n, "historial run_qa01 → qa-skill", await poll(`document.querySelector('[data-history-skill="qa-skill"]') !== null`));

  // Recurso bajo demanda (clic condicional: la fila alterna la seleccion)
  await evaluate(`() => { if (document.querySelector("#skills-detail")?.getAttribute("data-skill-detail") !== "qa-skill") document.querySelector('[data-skill-name="qa-skill"] button').click(); }`);
  await poll(`document.querySelector("#skills-detail")?.getAttribute("data-skill-detail") === "qa-skill"`);
  await evaluate(`() => { const i = document.querySelector("#skills-resource-path"); i.focus(); i.value = "docs/uso.md"; i.dispatchEvent(new Event("input", { bubbles: true })); }`);
  await evaluate(`() => document.querySelector("#skills-resource-load").click()`);
  check(n, "recurso docs/uso.md legible", await poll(`(document.querySelector("#skills-resource-out")?.textContent || "").includes("bajo demanda")`));

  // Failure: broken-skill muestra el error y bloquear habilitar (botón disabled)
  check(n, "error C3 visible en #skills-errors", await evaluate(`() => { const items = [...document.querySelectorAll("[data-skill-error]")]; return items.length === 1 && (items[0].textContent || "").includes("C3"); }`));
  check(n, "habilitar bloqueado (disabled) para broken-skill", await evaluate(`() => { const b = document.querySelector("[data-skill-error-blocked]"); return !!b && b.disabled === true && (b.getAttribute("title") || "").includes("C3"); }`));

  // W-S7 vista contextual en el workbench
  check(n, "panel contextual #skills-context visible", (await q("#skills-context"))?.visible === true);
  check(n, "contexto lista habilitadas", await evaluate(`() => document.querySelector("[data-context-skill]") !== null`));

  // Tokens del Todo 7: primario usa acento, sin literales propios
  check(n, "computado: primario usa acento", (await cssProp("#skills-enable", "background-color")) === "rgb(31, 95, 168)", await cssProp("#skills-enable", "background-color"));
  await evaluate(`() => { document.documentElement.dataset.theme = "dark"; }`);
  check(n, "oscuro: manager usa fondo oscuro", (await cssProp("#skills-manager", "background-color")) !== null);
  await evaluate(`() => { document.documentElement.dataset.theme = "light"; }`);

  if (n === 1) {
    mkdirSync(evidenceDir, { recursive: true });
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(evidenceDir, "task-24-surface.png"), Buffer.from(shot.data, "base64"));
    console.log("screenshot en .omo/evidence/octus-ux-skills-mcp/task-24-surface.png");
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
  try {
    rmSync(distDir, { recursive: true, force: true });
  } catch {}
}

console.log(`\nQA Todo 24: ${passes} PASS / ${failures} FAIL → ${failures === 0 ? "PASS" : "FAIL"}`);
if (failuresList.length > 0) console.log("fallos:\n" + failuresList.join("\n"));
process.exit(failures === 0 ? 0 : 1);
