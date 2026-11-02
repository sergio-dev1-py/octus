// QA Todo 30 — MCP Manager UI sobre el servicio REAL (McpClientManager del
// Todo 26) con servidores simulados STDIO (mcp-qa-stdio bueno + roto).
// 1) fixture real en tmpdir (SQLite + MemorySecretStore + manager + mocks),
// 2) puente HTTP que expone McpClient a la página,
// 3) build vite real de scripts/task-30-mcp.entry.tsx (vista REAL de producto),
// 4) Chromium headless por CDP: agregar, importar JSON, conectar, ver
//    herramientas y revocar confianza + caso failure (protocolo roto con
//    reintento sin bloquear). Dos pasadas (clase flaky).
// Uso: bun scripts/qa-task-30.mjs — exit 0 = verde. Sin servidores reales,
// sin secretos reales (tokens de juguete en memoria).
import { spawn, execSync } from "node:child_process";
import { createServer as createHttp } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PersistenceService } from "../packages/core/src/persistence/persistence-service.ts";
import { MemorySecretStore } from "../packages/core/src/secrets/secret-store.ts";
import { McpClientManager, mcpSecretRef } from "../packages/core/src/mcp/mcp-client-manager.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(root, "apps/desktop");
const distDir = join(root, "scripts", ".task30-dist");
const profileDir = join(root, "scripts", ".task30-profile");
const evidenceDir = join(root, ".omo", "evidence", "octus-ux-skills-mcp");
const CHROME = "C:/Users/UserPy/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe";
const PROJECT = "prj_qa";
const requireCore = createRequire(join(root, "packages/core/package.json"));
const requireDesktop = createRequire(join(desktopDir, "package.json"));
/* Mocks y lector QA usan el build CJS del SDK (mismo patrón que verifica el
   Todo 26 en packages/core/test/mcp-trust.test.ts): el build ESM por file://
   no resuelve bajo el mock spawneado por bun en Windows. */
const SERVER_URL = pathToFileURL(requireCore.resolve("@modelcontextprotocol/sdk/server/index.js")).href;
const STDIO_SERVER_URL = pathToFileURL(requireCore.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
const TYPES_URL = pathToFileURL(requireCore.resolve("@modelcontextprotocol/sdk/types.js")).href;
const { Client: SdkClient } = requireCore("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport: SdkStdio } = requireCore("@modelcontextprotocol/sdk/client/stdio.js");

let passes = 0;
let failures = 0;
const failuresList = [];
function check(pass, name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} [p${pass}] ${name}${detail ? " — " + detail : ""}`);
  if (cond) passes++;
  else { failures++; failuresList.push(`[p${pass}] ${name} ${detail}`); }
}

/* --- 0. fixture real --- */
function goodMockSource() {
  return `import { Server } from ${JSON.stringify(SERVER_URL)};
import { StdioServerTransport } from ${JSON.stringify(STDIO_SERVER_URL)};
import { ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListResourceTemplatesRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from ${JSON.stringify(TYPES_URL)};
const server = new Server({ name: "mcp-qa-stdio", version: "1.0.0" }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "qa_echo", description: "Devuelve el texto recibido", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "qa_ping", description: "Sonda sin argumentos", inputSchema: { type: "object", properties: {} } },
] }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [
  { uri: "qa://logs/build.log", name: "build.log", mimeType: "text/plain" },
] }));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [
  { uriTemplate: "qa://logs/{name}", name: "logs" },
] }));
server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== "qa://logs/build.log") throw new Error("unknown resource " + req.params.uri);
  return { contents: [{ uri: req.params.uri, mimeType: "text/plain", text: "linea1\\nlinea2\\nlinea3\\nlinea4\\nlinea5\\nlinea6\\nlinea7\\nlinea8\\nlinea9\\nlinea10\\nlinea11\\nlinea12\\n" }] };
});
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [
  { name: "qa-review", description: "Revision de cambios", arguments: [{ name: "text", required: true }, { name: "tone", required: false }] },
] }));
server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  if (req.params.name !== "qa-review") throw new Error("unknown prompt " + req.params.name);
  return { messages: [{ role: "user", content: { type: "text", text: "revisa: " + String(req.params.arguments?.text ?? "") } }] };
});
const transport = new StdioServerTransport();
await server.connect(transport);
`;
}
const BROKEN_MOCK = `process.stdout.write("esto-no-es-jsonrpc\\n");\nsetTimeout(() => process.exit(1), 300);\n`;

let fx = null;
async function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "octus-mcp30-"));
  const goodPath = join(dir, "mock-qa-stdio.ts");
  const brokenPath = join(dir, "mock-qa-broken.ts");
  writeFileSync(goodPath, goodMockSource());
  writeFileSync(brokenPath, BROKEN_MOCK);
  const db = await PersistenceService.open({ dbPath: join(dir, "test.db") });
  const secrets = new MemorySecretStore();
  const manager = new McpClientManager(db, secrets, { connectTimeoutMs: 8000, reconnectBaseMs: 50 });
  return { dir, db, secrets, manager, goodPath, brokenPath };
}
/* Barrido de hijos huérfanos (clase dirty_worktree): en Windows un mock roto
   puede quedar arrancando mientras se borra el tmpdir; se caza por línea de
   comando y se liquida. Devuelve cuántos mató. */
function sweepStrays() {
  let killed = 0;
  try {
    const list = execSync('wmic process where "commandline like \'%mock-qa-%\'" get processid /value', { encoding: "utf8", timeout: 15000 });
    const pids = [...list.matchAll(/ProcessId=(\d+)/g)].map((m) => m[1]).filter((p) => Number(p) !== process.pid);
    for (const pid of new Set(pids)) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); killed++; } catch {}
    }
  } catch {}
  return killed;
}
async function dropFixture(f) {
  if (!f) return;
  try { await f.manager.close(); } catch {}
  try { await f.db.close(); } catch {}
  await new Promise((r) => setTimeout(r, 800));
  sweepStrays();
  for (let i = 0; i < 10; i++) {
    try { await rm(f.dir, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  sweepStrays();
}

/* Lector directo del protocolo (harness QA): abre su PROPIA conexión al mismo
   mock para listar herramientas/recursos/prompts con datos reales del
   protocolo. La puerta de confianza la aplica el puente (tools ocultas si no
   autorizado), igual que hará el main en producción. */
async function directList(cfg) {
  if (cfg.transport !== "stdio" || !cfg.command) throw new Error("solo stdio en el harness");
  const transport = new SdkStdio({ command: cfg.command, args: cfg.args ?? [] });
  const client = new SdkClient({ name: "octus-qa-reader", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: 8000 });
    const out = { tools: [], resources: [], prompts: [] };
    try { out.tools = (await client.listTools(undefined, { timeout: 5000 })).tools ?? []; } catch {}
    try {
      out.resources = (await client.listResources(undefined, { timeout: 5000 })).resources ?? [];
      try {
        const tmpl = (await client.listResourceTemplates(undefined, { timeout: 5000 })).resourceTemplates ?? [];
        for (const t of tmpl) out.resources.push({ uri: t.uriTemplate, name: (t.name ?? "") + " (plantilla)" });
      } catch {}
    } catch {}
    try { out.prompts = (await client.listPrompts(undefined, { timeout: 5000 })).prompts ?? []; } catch {}
    return out;
  } finally {
    try { await client.close(); } catch {}
  }
}

async function summarize(id, projectId) {
  const { manager, secrets } = fx;
  const cfg = await manager.getServer(id);
  if (!cfg) throw new Error(`Unknown MCP server '${id}'`);
  const st = manager.status(id);
  const global = await manager.isTrusted(id);
  return {
    id: cfg.id, name: cfg.name, transport: cfg.transport,
    command: cfg.command, args: cfg.args, url: cfg.url, enabled: cfg.enabled,
    configured: true,
    connection: st.status, lastError: st.lastError, attempts: st.attempts,
    serverName: st.serverName, serverVersion: st.serverVersion,
    capabilities: Object.keys(st.capabilities ?? {}),
    tools: st.tools ?? [], hasResources: st.hasResources, hasPrompts: st.hasPrompts,
    trustedGlobal: global,
    trustedWorkspace: (await manager.isTrusted(id, projectId)) && !global,
    hasSecret: (await secrets.get(mcpSecretRef(id))) !== undefined,
  };
}

/* --- 1. puente HTTP McpClient --- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
async function handleApi(op, body) {
  const { manager } = fx;
  const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : PROJECT;
  switch (op) {
    case "list": {
      const servers = await manager.listServers();
      return Promise.all(servers.map((s) => summarize(s.id, projectId)));
    }
    case "add": {
      if (!body.name || typeof body.name !== "string") throw new Error("name requerido");
      const server = await manager.addServer({
        name: body.name,
        transport: body.transport === "http" ? "http" : "stdio",
        command: body.command || undefined,
        args: typeof body.argsText === "string" && body.argsText.trim() ? body.argsText.trim().split(/\s+/) : undefined,
        url: body.url || undefined,
        connectTimeoutMs: typeof body.connectTimeoutMs === "number" ? body.connectTimeoutMs : undefined,
      });
      if (body.token) await manager.setServerSecret(server.id, { token: String(body.token) });
      return { id: server.id };
    }
    case "import": {
      let arr;
      try { arr = JSON.parse(String(body.jsonText ?? "")); } catch { throw new Error("JSON inválido"); }
      if (!Array.isArray(arr)) throw new Error("se esperaba un arreglo de servidores");
      const added = [];
      const errors = [];
      for (let i = 0; i < arr.length; i++) {
        const e = arr[i] ?? {};
        try {
          if (!e.name || typeof e.name !== "string") throw new Error("name requerido");
          if (e.transport !== "stdio" && e.transport !== "http") throw new Error("transport debe ser stdio|http");
          if (e.transport === "stdio" && !e.command) throw new Error("command requerido para stdio");
          if (e.transport === "http" && !e.url) throw new Error("url requerida para http");
          const s = await manager.addServer({
            name: e.name, transport: e.transport,
            command: e.command ?? undefined,
            args: Array.isArray(e.args) ? e.args.map(String) : undefined,
            cwd: e.cwd ?? undefined, url: e.url ?? undefined,
          });
          if (e.token) await manager.setServerSecret(s.id, { token: String(e.token) });
          added.push(s.id);
        } catch (err) { errors.push({ index: i, error: err instanceof Error ? err.message : String(err) }); }
      }
      return { added, errors };
    }
    case "update": {
      const patch = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.command !== undefined) patch.command = body.command;
      if (body.argsText !== undefined) patch.args = String(body.argsText).trim() ? String(body.argsText).trim().split(/\s+/) : [];
      if (body.url !== undefined) patch.url = body.url;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      await manager.updateServer(body.id, patch);
      return {};
    }
    case "remove": await manager.removeServer(body.id); return {};
    case "verify": {
      const cfg = await manager.getServer(body.id);
      if (!cfg) throw new Error(`Unknown MCP server '${body.id}'`);
      if (!cfg.enabled) return { ok: false, error: "servidor deshabilitado" };
      return { ok: true };
    }
    case "connect": {
      try { await manager.connect(body.id, { projectId, timeoutMs: 8000 }); return { ok: true }; }
      catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
    }
    case "disconnect": await manager.disconnect(body.id, projectId); return {};
    case "retry": {
      try { await manager.reconnect(body.id, { projectId, maxAttempts: 2, baseMs: 50, timeoutMs: 6000 }); return { ok: true }; }
      catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
    }
    case "setTrust":
      await manager.setTrust(body.id, body.scope === "global" ? { scope: "global" } : { scope: "workspace", projectId }, !!body.trusted);
      return {};
    case "setSecret": await manager.setServerSecret(body.id, { token: String(body.token) }); return {};
    case "tools": {
      const trusted = await manager.isTrusted(body.id, projectId);
      if (!trusted) return { authorized: false, items: [] };
      const cfg = await manager.getServer(body.id);
      const listed = await directList(cfg);
      return {
        authorized: true,
        items: listed.tools.map((t) => ({ name: t.name, isolated: `${cfg.id}:${t.name}`, description: t.description ?? "" })),
      };
    }
    case "resources": {
      const cfg = await manager.getServer(body.id);
      const st = manager.status(body.id);
      if (!st.hasResources) return { supported: false, items: [] };
      const listed = await directList(cfg);
      return {
        supported: listed.resources.length > 0,
        items: listed.resources.map((r) => ({
          uri: r.uri, name: r.name ?? "",
          sensitive: String(r.uri).startsWith("qa://logs/"),
        })),
      };
    }
    case "prompts": {
      const cfg = await manager.getServer(body.id);
      const st = manager.status(body.id);
      if (!st.hasPrompts) return { supported: false, items: [] };
      const listed = await directList(cfg);
      return {
        supported: listed.prompts.length > 0,
        items: listed.prompts.map((p) => ({ name: p.name, description: p.description ?? "", args: (p.arguments ?? []).map((a) => a.name) })),
      };
    }
    case "audit": {
      const entries = await manager.auditLog(body.id || undefined, 200);
      return entries.map((e) => ({ id: e.id, serverId: e.serverId, projectId: e.projectId, action: e.action, reason: e.reason, occurredAt: e.occurredAt }));
    }
    default: throw new Error(`op desconocida ${op}`);
  }
}

/* --- 2. build vite real de la vista de producto --- */
console.log("## build vite de la vista MCP real");
const viteMod = await import(pathToFileURL(requireDesktop.resolve("vite")).href);
const solidMod = await import(pathToFileURL(requireDesktop.resolve("vite-plugin-solid")).href);
const solid = solidMod.default ?? solidMod;
rmSync(distDir, { recursive: true, force: true });
await viteMod.build({
  root: desktopDir,
  configFile: false,
  plugins: [solid()],
  logLevel: "warn",
  build: { outDir: distDir, emptyOutDir: true, rollupOptions: { input: join(root, "scripts", "task-30-mcp.entry.tsx") } },
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
  `<!doctype html><html lang="es" data-theme="light" data-density="normal" data-font-size="14"><head><meta charset="utf-8">${cssFiles.map((c) => `<link rel="stylesheet" href="./${c.slice(distDir.length + 1).replace(/\\/g, "/")}">`).join("")}</head><body><div id="oc-qa-root"></div><script type="module" src="./${jsFile.slice(distDir.length + 1).replace(/\\/g, "/")}"></script></body></html>`,
);

/* --- 3. servidor: estático + puente --- */
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const http = createHttp(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    try {
      const data = await handleApi(url.pathname.slice("/api/".length), await readBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, data }));
    } catch (err) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const file = join(distDir, rel.split("?")[0]);
  if (!file.startsWith(distDir) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404); res.end("nf"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const basePort = http.address().port;
const baseUrl = `http://127.0.0.1:${basePort}/index.html?project=${PROJECT}`;
console.log(`sirviendo en ${baseUrl}`);

/* --- 4. Chromium por CDP --- */
rmSync(profileDir, { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });
const port = 19431;
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
async function cdpGet(path) {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}${path}`); if (r.ok) return await r.json(); } catch {}
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
    const f = loadResolve; loadResolve = null; f();
  }
});
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("CDP timeout " + method)); } }, 20000);
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
  await new Promise((r) => setTimeout(r, 400));
}
async function poll(expr, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await evaluate(`() => (${expr})`);
    if (v) return v;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 120));
  }
}
const q = async (sel) => evaluate(`() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { visible: r.width > 0 && r.height > 0, text: (el.textContent || "").trim().slice(0, 120) }; }`);
const cssProp = (sel, prop) => evaluate(`() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? getComputedStyle(el).getPropertyValue(${JSON.stringify(prop)}).trim() : null; }`);
const includesText = (sel, sub) => evaluate(`(sel, sub) => (document.querySelector(sel)?.textContent || "").includes(sub)`, sel, sub);
async function diag(n, label) {
  const banner = await q("#mcp-banner-error");
  const notice = await q("#mcp-banner-notice");
  const servers = (await fx.manager.listServers()).map((s) => `${s.name}=${fx.manager.status(s.id).status}`);
  console.log(`[p${n}] DIAG ${label} | banner=${JSON.stringify(banner?.text ?? null)} | notice=${JSON.stringify(notice?.text ?? null)} | servers=${servers.join(",")}`);
}
async function setInput(sel, value) {
  await evaluate(`(sel, value) => { const el = document.querySelector(sel); el.focus(); el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }`, sel, value);
}
async function setText(sel, value) {
  await evaluate(`(sel, value) => { const el = document.querySelector(sel); el.focus(); el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); }`, sel, value);
}
async function click(sel) { await evaluate(`(sel) => document.querySelector(sel).click()`, sel); }
async function serverIdByName(name) {
  const servers = await fx.manager.listServers();
  const s = servers.find((x) => x.name === name);
  if (!s) throw new Error("sin id para " + name);
  return s.id;
}
await send("Page.enable");
await send("Runtime.enable");

/* --- 5. flujo por pasada --- */
async function runPass(n) {
  console.log(`## pasada ${n}`);
  // reset de fixture entre pasadas (hermético)
  await dropFixture(fx);
  fx = await makeFixture();
  await goto();

  check(n, "badge SIMULADO visible (pantalla QA, no producto)", ((await q("#mcp-sim-badge"))?.visible === true));
  check(n, "gestor vacío honesto al inicio", (await q("#mcp-empty"))?.visible === true && ((await q("#mcp-count"))?.text ?? "").includes("0 servidor"));
  check(n, "sin rastro de la palabra instalar en el gestor", await evaluate(`() => !/instal/i.test(document.querySelector("#mcp-manager").textContent || "")`));

  // AGREGAR mcp-qa-stdio por formulario
  await setInput("#mcp-add-name", "mcp-qa-stdio");
  await setInput("#mcp-add-command", process.execPath);
  await setInput("#mcp-add-args", fx.goodPath);
  await click("#mcp-add-submit");
  check(n, "agregar informa pendiente de confianza", await poll(`(document.querySelector("#mcp-add-result")?.textContent || "").includes("pendiente de confianza")`));
  /* El aviso se fija antes del refresh: esperar a que la lista asiente (anti stale_state). */
  await poll(`(document.querySelector("#mcp-count")?.textContent || "").includes("1 servidor")`);
  const id = await serverIdByName("mcp-qa-stdio");
  console.log(`[p${n}] id real del servidor: ${id}`);
  check(n, "píldora configurado visible y distinta", (await q(`#mcp-config-${id}`))?.text === "configurado");
  check(n, "píldora conexión desconectado", (await q(`#mcp-conn-${id}`))?.text === "desconectado");
  check(n, "píldora autorización no autorizado", (await q(`#mcp-auth-${id}`))?.text === "no autorizado");
  check(n, "manager: desconectado y sin confianza (anti estado rancio)", fx.manager.status(id).status === "disconnected" && (await fx.manager.isTrusted(id, PROJECT)) === false);

  // CONECTAR sin confianza → denegado, sin bloquear
  await click(`#mcp-connect-${id}`);
  const deniedVisible = await poll(`(document.querySelector("#mcp-banner-error")?.textContent || "").toLowerCase().includes("trust")`);
  if (!deniedVisible) await diag(n, "denegación sin confianza");
  check(n, "conectar sin confianza muestra error visible", deniedVisible);
  check(n, "manager sigue desconectado tras denegar", fx.manager.status(id).status === "disconnected");
  await evaluate(`() => document.querySelector('#mcp-banner-error button').click()`);

  // DETALLE con herramientas ocultas (puerta de autorización)
  await click(`#mcp-select-${id}`);
  check(n, "detalle con puerta: herramientas ocultas", await poll(`!!document.querySelector("#mcp-tools-gated")`));
  check(n, "confianza workspace en no", (await q(`#mcp-trust-ws-state-${id}`))?.text.includes("no") === true);

  // CONFIANZA por workspace
  await click(`#mcp-trust-ws-${id}`);
  check(n, "otorgar confianza marca autorizado", await poll(`(document.querySelector("#mcp-auth-${id}")?.textContent || "").trim() === "autorizado"`));
  check(n, "manager: confiable en workspace", (await fx.manager.isTrusted(id, PROJECT)) === true);

  // CONECTAR con confianza
  await click(`#mcp-connect-${id}`);
  const connOk = await poll(`(document.querySelector("#mcp-conn-${id}")?.textContent || "").trim() === "conectado"`, 25000);
  if (!connOk) console.log(`[p${n}] DIAG banner=${JSON.stringify((await q("#mcp-banner-error"))?.text ?? null)} manager=${fx.manager.status(id).status} err=${fx.manager.status(id).lastError ?? null}`);
  check(n, "conectar con confianza: píldora conectado (igualdad exacta)", connOk);
  const st = fx.manager.status(id);
  check(n, "manager: conectado con handshake real", st.status === "connected" && st.serverName === "mcp-qa-stdio", `${st.status}/${st.serverName}`);

  // HERRAMIENTAS / RECURSOS / PROMPTS reales del protocolo
  await click(`#mcp-select-${id}`);
  check(n, "herramienta aislada servidor:herramienta", await poll(`!!document.querySelector('[data-tool="${id}:qa_echo"]')`, 20000));
  check(n, "segunda herramienta anunciada", await poll(`!!document.querySelector('[data-tool="${id}:qa_ping"]')`));
  check(n, "recurso sensible con aprobación", await poll(`!!document.querySelector('[data-resource="qa://logs/build.log"]')`) && await includesText(`#mcp-detail-${id}`, "sensible"));
  check(n, "prompt con 2 argumentos", await poll(`!!document.querySelector('[data-prompt="qa-review"]')`) && await includesText(`#mcp-detail-${id}`, "text, tone"));

  // Tres estados siempre distinguibles por color (en positivo: los tres activos)
  const cardText = String(await evaluate(`(sel) => document.querySelector(sel)?.textContent ?? ""`, `#mcp-server-${id}`));
  const capsShown = cardText.includes("capacidades:") && cardText.includes("tools") && cardText.includes("resources") && cardText.includes("prompts");
  if (!capsShown) console.log(`[p${n}] DIAG tarjeta=${JSON.stringify(cardText.slice(0, 400))}`);
  check(n, "capacidades negociadas visibles (tools+resources+prompts)", capsShown);
  const [cCfg, cConn, cAuth] = [await cssProp(`#mcp-config-${id}`, "color"), await cssProp(`#mcp-conn-${id}`, "color"), await cssProp(`#mcp-auth-${id}`, "color")];
  check(n, "configurado≠conectado≠autorizado por color", new Set([cCfg, cConn, cAuth]).size === 3, `${cCfg} / ${cConn} / ${cAuth}`);
  if (n === 1) {
    await click(`#mcp-select-${id}`);
    await poll(`!!document.querySelector('[data-tool="${id}:qa_echo"]')`);
    await evaluate(`(sel) => document.querySelector(sel)?.scrollIntoView({ block: "start" })`, `#mcp-detail-${id}`);
    await new Promise((r) => setTimeout(r, 300));
    const shot1 = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(evidenceDir, "task-30-surface.png"), Buffer.from(shot1.data, "base64"));
    console.log("screenshot: task-30-surface.png");
  }

  // IMPORTAR JSON
  const importDoc = JSON.stringify([{ name: "mcp-qa-imported", transport: "stdio", command: process.execPath, args: [fx.goodPath] }]);
  await setText("#mcp-import-json", importDoc);
  await click("#mcp-import-submit");
  check(n, "importar JSON informa pendientes", await poll(`(document.querySelector("#mcp-import-result")?.textContent || "").includes("Pendiente de confianza")`));
  await poll(`(document.querySelector("#mcp-count")?.textContent || "").includes("2 servidor")`);
  const id2 = await serverIdByName("mcp-qa-imported");
  check(n, "importado configurado pero no autorizado", (await q(`#mcp-config-${id2}`))?.text === "configurado" && (await q(`#mcp-auth-${id2}`))?.text === "no autorizado");
  check(n, "contador en 2 servidores", ((await q("#mcp-count"))?.text ?? "").includes("2 servidor"));

  // CREDENCIALES: guardar sin mostrar
  await click(`#mcp-select-${id}`);
  await setInput(`#mcp-secret-input-${id}`, "tok-juguete-30");
  await click(`#mcp-secret-save-${id}`);
  check(n, "credencial guardada (solo indicador)", await poll(`(document.querySelector("#mcp-secret-state-${id}")?.textContent || "").includes("guardada")`));
  const stored = await fx.secrets.get(mcpSecretRef(id));
  check(n, "secreto solo en almacén, nunca en SQLite", (stored ?? "").includes("tok-juguete-30") && !JSON.stringify(await fx.db.query("SELECT * FROM mcp_servers WHERE id = ?", [id])).includes("tok-juguete-30"));
  check(n, "el valor del token nunca aparece en el DOM", await evaluate(`(id) => !(document.querySelector("#mcp-manager").textContent || "").includes("tok-juguete-30")`, id));

  // REVOCAR confianza corta y oculta (anti stale_state: sin recarga)
  await click(`#mcp-trust-ws-${id}`);
  check(n, "revocar marca no autorizado", await poll(`(document.querySelector("#mcp-auth-${id}")?.textContent || "").includes("no autorizado")`));
  check(n, "revocar desconecta en caliente", await poll(`(document.querySelector("#mcp-conn-${id}")?.textContent || "").trim() === "desconectado"`) && fx.manager.status(id).status === "disconnected");
  await click(`#mcp-select-${id}`);
  check(n, "tras revocar, herramientas ocultas sin recargar", await poll(`!!document.querySelector("#mcp-tools-gated")`));
  const audit = await fx.manager.auditLog(id, 50);
  /* El manager del Todo 26 audita la revocación (trust.revoked) y desconecta en
     caliente en silencio (disconnectQuiet no emite entrada propia: no hay
     conexión que cerrar con ruido). Se afirma revocación auditada + corte real. */
  check(n, "auditoría registra revocación y corte real", audit.some((e) => e.action === "trust.revoked") && fx.manager.status(id).status === "disconnected", audit.map((e) => e.action).join(","));

  // FAILURE: servidor con error de protocolo
  await setInput("#mcp-add-name", "mcp-qa-broken");
  await setInput("#mcp-add-command", process.execPath);
  await setInput("#mcp-add-args", fx.brokenPath);
  await click("#mcp-add-submit");
  const brokenAdded = await poll(`(document.querySelector("#mcp-add-result")?.textContent || "").includes("pendiente de confianza")`);
  if (!brokenAdded) await diag(n, "alta de servidor roto");
  check(n, "servidor roto agregado y pendiente de confianza", brokenAdded);
  const bid = await serverIdByName("mcp-qa-broken");
  await click(`#mcp-trust-ws-${bid}`);
  await poll(`(document.querySelector("#mcp-auth-${bid}")?.textContent || "").trim() === "autorizado"`);
  await click(`#mcp-connect-${bid}`);
  /* El failure implica spawnear un proceso en una caja lenta y cargada (decenas
     de bun por corrida): deadline amplio, lo que se afirma es el estado final. */
  const brokeDown = await poll(`(document.querySelector("#mcp-conn-${bid}")?.textContent || "").trim() === "falló"`, 60000);
  if (!brokeDown) await diag(n, `protocolo roto sin fallar status=${fx.manager.status(bid).status} err=${fx.manager.status(bid).lastError ?? null}`);
  check(n, "protocolo roto: píldora falló", brokeDown);
  check(n, "error visible con role=alert y reintento", (await q(`#mcp-error-${bid}`))?.visible === true && (await q(`#mcp-error-${bid}-retry`))?.visible === true);
  check(n, "manager: failed con lastError real", fx.manager.status(bid).status === "failed" && !!fx.manager.status(bid).lastError, fx.manager.status(bid).lastError ?? "");
  check(n, "la lista sigue viva: servidor sano seleccionable", (await q(`#mcp-server-${id}`))?.visible === true);
  await click(`#mcp-retry-${bid}`);
  check(n, "reintento no bloquea (vuelve a falló)", await poll(`(document.querySelector("#mcp-conn-${bid}")?.textContent || "").trim() === "falló"`, 60000));
  await click(`#mcp-select-${id}`);
  check(n, "tras el fallo, el otro servidor sigue operable", await poll(`!!document.querySelector("#mcp-tools-gated") || !!document.querySelector("#mcp-tools")`));

  if (n === 1) {
    await evaluate(`(sel) => document.querySelector(sel)?.scrollIntoView({ block: "center" })`, `#mcp-server-${bid}`);
    await new Promise((r) => setTimeout(r, 300));
    const shot2 = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(evidenceDir, "task-30-failure.png"), Buffer.from(shot2.data, "base64"));
    console.log("screenshot: task-30-failure.png");
  }
}

try {
  fx = await makeFixture();
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
  rmSync(distDir, { recursive: true, force: true });
  await dropFixture(fx);
  fx = null;
}

console.log(`\nQA Todo 30: ${passes} PASS / ${failures} FAIL → ${failures === 0 ? "PASS" : "FAIL"}`);
if (failuresList.length) console.log("FAILs:\n- " + failuresList.join("\n- "));
process.exit(failures === 0 ? 0 : 1);
