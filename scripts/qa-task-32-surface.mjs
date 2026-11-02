// QA Todo 32 (superficie) — TerminalPanel REAL en Chromium headless por CDP contra
// TerminalService REAL (node-pty + ConPTY) puenteado por HTTP (solo el transporte
// IPC está puenteado; la vista, el servicio y el PTY son los de producto).
// Uso: bun scripts/qa-task-32-surface.mjs — exit 0 = verde.
import { register } from "node:module";

register("file:///C:/Users/UserPy/Documents/octus-wt-octus-ux-skills-mcp-w14/scripts/task32-resolve-hook.mjs");

import { spawn, execSync } from "node:child_process";
import { createServer as createHttp } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(root, "apps/desktop");
const distDir = join(root, "scripts", ".task32-dist");
const profileDir = join(root, "scripts", ".task32-profile");
const evidenceDir = join(root, ".omo", "evidence", "octus-ux-skills-mcp");
const CHROME = "C:/Users/UserPy/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe";
const requireDesktop = createRequire(join(desktopDir, "package.json"));

let passes = 0;
let failures = 0;
const failuresList = [];
const progressLog = join(root, "scripts", ".task32-progress.log");
function emit(line) {
  console.log(line);
  try {
    writeFileSync(progressLog, line + "\n", { flag: "a" });
  } catch {}
}
try {
  rmSync(progressLog, { force: true });
} catch {}
function check(name, cond, detail = "") {
  emit(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (cond) passes++;
  else {
    failures++;
    failuresList.push(`${name} ${detail}`);
  }
}

/* --- 1. servicio real + puente --- */
const { TerminalService } = await import(
  pathToFileURL(join(desktopDir, "src/main/terminal-service.ts")).href
);
const qaRoot = mkdtempSync(join(tmpdir(), "octus-term32-surface-"));
const emitted = [];
let emittedSeq = 0;
const service = new TerminalService({
  resolveRoot: async (projectId) => {
    if (projectId !== "prj_qa") throw new Error(`unknown project ${projectId}`);
    return qaRoot;
  },
  onData: (chunk) => {
    emitted.push({ ...chunk, gseq: ++emittedSeq });
    if (emitted.length > 500) emitted.splice(0, emitted.length - 500);
  },
});

async function readBody(req) {
  const parts = [];
  for await (const c of req) parts.push(c);
  return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
}

async function handleInvoke(channel, payload) {
  emit(`bridge: ${channel} ${JSON.stringify(payload).slice(0, 160)}`);
  switch (channel) {
    case "terminal.create":
      return { ok: true, terminal: await service.create({ projectId: payload.projectId, name: payload.name, cols: payload.cols, rows: payload.rows }) };
    case "terminal.list":
      return { terminals: service.list(payload.projectId) };
    case "terminal.write":
      service.write(payload.id, payload.data);
      return { ok: true };
    case "terminal.read": {
      const out = service.read(payload.id, payload.sinceSeq);
      return { ok: true, ...out };
    }
    case "terminal.resize":
      service.resize(payload.id, payload.cols, payload.rows);
      return { ok: true };
    case "terminal.kill": {
      const { restarted, forced, chunks, nextSeq } = await service.kill(payload.id, payload.sinceSeq);
      const full = service.read(payload.id, 0);
      const buf = full.chunks.map((c) => c.data).join("");
      emit(`bridge: tras kill marker=${buf.includes("[terminal]")} forced=${forced} bufSeqs=${full.chunks.map((c) => c.seq).join(",")} respSeqs=${chunks.map((c) => c.seq).join(",")} next=${nextSeq}`);
      return { ok: true, restarted, chunks, nextSeq };
    }
    case "terminal.close":
      service.close(payload.id);
      return { ok: true };
    case "terminal.select":
      service.select(payload.id);
      return { ok: true };
    default:
      throw new Error(`canal no puenteado: ${channel}`);
  }
}

/* --- 2. build vite real de la vista de producto --- */
console.log("## build vite del TerminalPanel real");
const viteMod = await import(pathToFileURL(requireDesktop.resolve("vite")).href);
const solidMod = await import(pathToFileURL(requireDesktop.resolve("vite-plugin-solid")).href);
const solid = solidMod.default ?? solidMod;
rmSync(distDir, { recursive: true, force: true });
await viteMod.build({
  root: desktopDir,
  configFile: false,
  plugins: [solid()],
  logLevel: "warn",
  build: { outDir: distDir, emptyOutDir: true, rollupOptions: { input: join(root, "scripts", "task-32-terminal.entry.tsx") } },
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
const cssFiles = built.filter((f) => extname(f) === ".css");
if (!jsFile) throw new Error("build sin bundle js: " + built.join(","));
console.log(`build OK: ${built.map((f) => f.slice(distDir.length + 1)).join(", ")}`);
writeFileSync(
  join(distDir, "index.html"),
  `<!doctype html><html lang="es"><head><meta charset="utf-8">${cssFiles.map((c) => `<link rel="stylesheet" href="./${c.slice(distDir.length + 1).replace(/\\/g, "/")}">`).join("")}</head><body><div id="oc-qa-root"></div><script type="module" src="./${jsFile.slice(distDir.length + 1).replace(/\\/g, "/")}"></script></body></html>`,
);

/* --- 3. servidor: estático + puente --- */
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const http = createHttp(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (req.method === "POST" && url.pathname === "/api/invoke") {
      const { channel, payload } = await readBody(req);
      const data = await handleInvoke(channel, payload ?? {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, data }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/poll") {
      const since = Number(url.searchParams.get("since") ?? "0") || 0;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const fresh = emitted.filter((c) => c.gseq > since);
        if (fresh.length > 0) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ chunks: fresh.map(({ gseq, ...c }) => c), next: emittedSeq }));
          return;
        }
        await new Promise((r) => setTimeout(r, 120));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ chunks: [], next: emittedSeq }));
      return;
    }
  } catch (err) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const file = join(distDir, rel.split("?")[0]);
  if (!file.startsWith(distDir) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end("nf");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const basePort = http.address().port;
const baseUrl = `http://127.0.0.1:${basePort}/index.html?project=prj_qa`;
console.log(`sirviendo en ${baseUrl}`);

/* --- 4. Chromium por CDP (puerto propio: el Todo 33 puede correr en paralelo) --- */
rmSync(profileDir, { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });
const port = 19432;
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
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
    }, 20000);
  });
}
async function evaluate(fnSource, ...args) {
  const r = await send("Runtime.evaluate", { expression: `(${fnSource})(${args.map((a) => JSON.stringify(a)).join(",")})`, returnByValue: true, awaitPromise: true });
  return r.result?.value;
}
async function goto() {
  const loaded = new Promise((r) => (loadResolve = r));
  emit("qa: navigate...");
  await send("Page.navigate", { url: baseUrl });
  emit("qa: navigate ok, esperando load");
  await Promise.race([
    loaded,
    new Promise((r) => setTimeout(() => {
      emit("qa: load sin evento tras 15s, sigo igual");
      r();
    }, 15000)),
  ]);
  await new Promise((r) => setTimeout(r, 600));
}
async function poll(expr, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await evaluate(`() => (${expr})`);
    if (v) return v;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}
async function setInput(sel, text) {
  const ok = await evaluate(`(s, t) => { const el = document.querySelector(s); if (!el) return false; el.focus(); el.value = t; el.dispatchEvent(new Event("input", { bubbles: true })); return true; }`, sel, text);
  if (!ok) throw new Error("sin input " + sel);
}
async function click(sel) {
  const ok = await evaluate(`(s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }`, sel);
  if (!ok) throw new Error("sin click " + sel);
}
const outText = `(document.querySelector("#terminal-output")?.textContent ?? "")`;
async function diag(label) {
  const dump = await evaluate(`() => document.querySelector("#terminal-panel")?.outerHTML?.slice(0, 1200)`);
  console.log(`diag ${label}: ${dump}`);
}

try {
  emit("qa: goto");
  await goto();
  emit("qa: goto ok");
  check("panel terminal visible", await poll(`!!document.querySelector("#terminal-panel")`, 15000));
  emit("qa: panel ok, creando terminal");
  check("sin terminales al inicio", await poll(`(document.querySelector("#terminal-panel")?.textContent || "").includes("Sin terminales")`));
  await setInput("#terminal-name", "qa-panel");
  await click("#terminal-create");
  check("crear terminal muestra pestaña", await poll(`!!document.querySelector("[data-terminal-id]")`));
  await setInput("#terminal-input", "echo eco-32-panel");
  await click("#terminal-enter");
  check("eco por streaming en la superficie", await poll(`${outText}.includes("eco-32-panel")`, 25000));
  // failure en superficie: proceso largo cancelado, shell reiniciado, reutilizable
  await setInput("#terminal-input", "ping -n 20 127.0.0.1 >nul");
  await click("#terminal-enter");
  await new Promise((r) => setTimeout(r, 1200));
  await click("#terminal-kill");
  const restarted = await poll(`${outText}.includes("shell reiniciado")`, 25000);
  check("kill muestra reinicio del shell", restarted, "marcador [terminal] en la salida");
  if (!restarted) {
    try {
      const seen = await evaluate(`(window.__termSeen || []).slice(-12)`);
      await diag(`sin reinicio; vistos en página: ${JSON.stringify(seen).slice(0, 900)}`);
    } catch (e) {
      await diag(`sin reinicio; CDP evaluate falló: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  check("historial conserva el eco anterior al kill", await poll(`${outText}.includes("eco-32-panel")`));
  await setInput("#terminal-input", "echo eco-32-tras-kill");
  await click("#terminal-enter");
  check("superficie reutilizable tras kill", await poll(`${outText}.includes("eco-32-tras-kill")`, 25000));
  await click("#terminal-close");
  check("cerrar vuelve a Sin terminales", await poll(`(document.querySelector("#terminal-panel")?.textContent || "").includes("Sin terminales")`));
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(evidenceDir, "task-32-surface.png"), Buffer.from(shot.data, "base64"));
  console.log("screenshot: task-32-surface.png");
} finally {
  try {
    ws.close();
  } catch {}
  http.close();
  service.disposeAll();
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
  rmSync(qaRoot, { recursive: true, force: true });
}

console.log(`\nQA Todo 32 (superficie): ${passes} PASS / ${failures} FAIL → ${failures === 0 ? "PASS" : "FAIL"}`);
if (failuresList.length) console.log("FAILs:\n- " + failuresList.join("\n- "));
process.exit(failures === 0 ? 0 : 1);
