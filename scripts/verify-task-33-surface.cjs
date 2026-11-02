/**
 * Sonda Todo 33 — superficie REAL del explorador, diff, modificados, pruebas y
 * problemas (no dry-run). Playwright (Chromium) sobre el bundle construido
 * (apps/desktop/out/renderer), con window.octus sustituido por un stub
 * determinista: proyecto C:\tmp\octus-qa-proj con datos fijos.
 *
 * Uso (desde la raíz del worktree, tras el build):
 *   node scripts/verify-task-33-surface.cjs
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
  const PROJECTS = [{ id: "p1", name: "QA", rootPath: "C:/tmp/octus-qa-proj", createdAt: 1, updatedAt: 1 }];
  const SESSION = { id: "s1", projectId: "p1", title: "QA chat", directory: "C:/tmp/octus-qa-proj", profile: "build", model: { providerId: "fake", modelId: "b" }, createdAt: 1, updatedAt: 1 };
  const PAGE1 = { rootPath: "C:/tmp/octus-qa-proj", relDir: ".", total: 4, page: 1, pageSize: 50, pageCount: 2, entries: [
    { name: "src", relPath: "src", kind: "dir" },
    { name: "README.md", relPath: "README.md", kind: "file", size: 20 },
    { name: "notes.txt", relPath: "notes.txt", kind: "file", size: 10 },
  ]};
  const PAGE2 = { rootPath: "C:/tmp/octus-qa-proj", relDir: ".", total: 4, page: 2, pageSize: 50, pageCount: 2, entries: [
    { name: "extra2.txt", relPath: "extra2.txt", kind: "file", size: 5 },
  ]};
  const SRC = { rootPath: "C:/tmp/octus-qa-proj", relDir: "src", total: 2, page: 1, pageSize: 50, pageCount: 1, entries: [
    { name: "app.ts", relPath: "src/app.ts", kind: "file", size: 80 },
    { name: "util.ts", relPath: "src/util.ts", kind: "file", size: 40 },
  ]};
  async function invoke(channel, payload) {
    if (window.__t33failFiles && (channel === "files.list" || channel === "files.read")) {
      return { ok: false, error: "boom simulado (failure QA)" };
    }
    switch (channel) {
      case "prefs.get": return { prefs: { theme: "system", fontSize: 14, density: "normal" } };
      case "layout.get": return { layout: { activity: "explorer", sidebarVisible: true, sidebarWidth: 264, inspectorVisible: true, inspectorWidth: 248, bottomVisible: true, bottomHeight: 180, bottomTab: "tests" }, repaired: false };
      case "layout.set": return { layout: payload.layout };
      case "projects.list": return { projects: PROJECTS };
      case "app.validateDirectory": return { ok: true, realPath: "C:/tmp/octus-qa-proj" };
      case "sessions.list": return { sessions: [SESSION] };
      case "sessions.get": return { session: SESSION, runs: [] };
      case "sessions.messages": return { messages: [], total: 0, hasOlder: false };
      case "providers.list": return { providers: [] };
      case "budgets.status": return { configured: true, budgets: [], usage: [] };
      case "permissions.pending": return { requests: [] };
      case "questions.pending": return { requests: [] };
      case "plans.list": return { plans: [] };
      case "approvals.pending": return { requests: [] };
      case "agents.definitions": return { definitions: [] };
      case "agents.instances": return { instances: [] };
      case "agents.limits": return { limits: { maxPerSession: 4, maxPerProject: 6, maxDepth: 2 } };
      case "projects.isolatedDirs": return { directories: [] };
      case "projects.testAllowlist": return { entries: [{ id: "qa-echo", name: "QA echo", argv: ["node", "-e", "console.log(1)"] }] };
      case "projects.trustedInstructions": return { files: [] };
      case "skills.catalog": return { skills: [], errors: [] };
      case "worktrees.list": return { worktrees: [] };
      case "worktrees.get": return { ok: false, error: "nope" };
      case "repos.inspect": return { summary: { rootPath: "C:/tmp/octus-qa-proj", isGit: true, branch: "main", head: "abc", status: "dirty", staged: 0, unstaged: 1, untracked: 1, worktrees: [], branches: ["main"] } };
      case "tasks.list": return { tasks: [] };
      case "memory.list": return { entries: [] };
      case "recovery.status": return { pendingOps: 0, startedPromotions: 0, livePreviews: 0, staleMemories: 0, pendingContradictions: 0 };
      case "files.list": {
        if ((payload.relDir || ".") === "src") return { ok: true, page: SRC };
        if ((payload.page || 1) === 2) return { ok: true, page: PAGE2 };
        return { ok: true, page: PAGE1 };
      }
      case "files.read": return { ok: true, file: { rootPath: "C:/tmp/octus-qa-proj", relPath: payload.relPath, content: "export const APP_MARKER = 'app-v1';\\n", truncated: false, size: 38 } };
      case "repos.diff": return { ok: true, rootPath: "C:/tmp/octus-qa-proj", diff: "diff --git a/src/app.ts b/src/app.ts\\n+// T33-DIRTY\\n", truncated: false };
      case "repos.modified": return { ok: true, rootPath: "C:/tmp/octus-qa-proj", isGit: true, files: [{ path: "src/app.ts", x: " ", y: "M" }, { path: "notes.txt", x: "?", y: "?" }] };
      case "tests.run": return { ok: true, entryId: "qa-echo", exitCode: 0, output: "qa-ok\\n", truncated: false, durationMs: 94 };
      case "diagnostics.list": return { ok: true, problems: [{ id: "task-t1", severity: "error", source: "tasks", message: "Tarea fallida Demo: boom" }] };
      default: return {};
    }
  }
  window.octus = {
    invoke,
    onEvent: (handler) => () => {},
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

  // 0. Bienvenida → workbench con el proyecto QA.
  await page.locator('button[data-project-id="p1"]').waitFor({ timeout: 20000 });
  check("bienvenida: reciente QA visible", (await page.locator('button[data-project-id="p1"]').count()) === 1);
  await page.locator('button[data-project-id="p1"]').click();
  await page.locator("#welcome-continue").click();
  await page.locator("#workbench").waitFor({ timeout: 20000 });
  check("workbench visible tras continuar", (await page.locator("#workbench").count()) === 1);

  // 1. Explorar: árbol con entradas fijas.
  await page.locator("#file-explorer").waitFor({ timeout: 20000 });
  check("explorar: panel visible", (await page.locator("#file-explorer").count()) === 1);
  await page.locator('#file-tree [data-entry-path="src"]').waitFor({ timeout: 10000 });
  check("explorar: dir src en el árbol", (await page.locator('#file-tree [data-entry-path="src"]').count()) === 1);
  check("explorar: README.md en el árbol", (await page.locator('#file-tree [data-entry-path="README.md"]').count()) === 1);

  // 2. Ver archivo.
  await page.locator('#file-tree [data-entry-path="src"]').click();
  await page.locator('#file-tree [data-entry-path="src/app.ts"]').waitFor({ timeout: 10000 });
  check("explorar: subdir src lista app.ts", (await page.locator('#file-tree [data-entry-path="src/app.ts"]').count()) === 1);
  await page.locator('#file-tree [data-entry-path="src/app.ts"]').click();
  await page.locator("#file-viewer").waitFor({ timeout: 10000 });
  check("explorar: visor con marcador", ((await page.locator("#file-viewer").innerText()).includes("APP_MARKER")));

  // 3. Paginación (failure QA: proyecto grande no congela; stub con 2 páginas).
  await page.locator('#file-explorer button:has-text("Subir")').click();
  await page.locator('#file-tree [data-entry-path="README.md"]').waitFor({ timeout: 10000 });
  const nextEnabled = await page.locator("#explorer-next").isEnabled().catch(() => false);
  check("explorar: hay página siguiente (pagina, no congela)", nextEnabled === true);
  if (nextEnabled) {
    await page.locator("#explorer-next").click();
    await page.locator('#file-tree [data-entry-path="extra2.txt"]').waitFor({ timeout: 10000 });
    check("explorar: página 2 muestra extra2.txt", (await page.locator('#file-tree [data-entry-path="extra2.txt"]').count()) === 1);
  }

  // 4. Diff.
  await page.locator('#repo-diff button:has-text("Ver diff")').click();
  await waitForCond(async () => (await page.locator("#repo-diff").innerText()).includes("T33-DIRTY"), 10000);
  check("diff: muestra T33-DIRTY", ((await page.locator("#repo-diff").innerText()).includes("T33-DIRTY")));

  // 5. Modificados.
  check("modificados: app.ts M", (await page.locator('#modified-list [data-modified-path="src/app.ts"]').count()) === 1);
  check("modificados: notes.txt untracked", (await page.locator('#modified-list [data-modified-path="notes.txt"]').count()) === 1);

  // 6. Resultado de prueba.
  await page.locator('[data-bottom-tab="tests"]').click();
  await page.locator("#test-results").waitFor({ timeout: 10000 });
  check("pruebas: panel visible", (await page.locator("#test-results").count()) === 1);
  await page.locator('[data-test-entry="qa-echo"] button:has-text("Ejecutar")').click();
  await page.locator('[data-test-output="qa-echo"]').waitFor({ timeout: 10000 });
  check("pruebas: salida qa-ok del run", ((await page.locator('[data-test-output="qa-echo"]').innerText()).includes("qa-ok")));

  // 7. Problemas.
  await page.locator('[data-bottom-tab="problems"]').click();
  await page.locator("#problems-list").waitFor({ timeout: 10000 });
  check("problemas: diagnóstico task-t1", (await page.locator('#problems-list [data-problem-id="task-t1"]').count()) === 1);

  // 8. Failure: backend de archivos roto → error visible, sin pantalla en blanco.
  await page.evaluate(() => { window.__t33failFiles = true; });
  await page.locator("#explorer-prev").click().catch(() => {});
  const errVisible = await waitForCond(async () => (await page.locator("#file-explorer [role='alert']").count()) >= 1, 10000);
  check("failure: error de archivos visible sin romper la UI", errVisible);
  check("failure: workbench sigue en pie", (await page.locator("#workbench").count()) === 1);

  await page.screenshot({ path: path.join(EVIDENCE, "task-33-surface.png") });
  await browser.close();
  server.close();
  console.log(`\nSONDA PLAYWRIGHT TODO 33: ${failures === 0 ? "todo PASS" : failures + " FALLOS"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("FATAL " + String((error && error.stack) || error).slice(0, 1000));
  process.exit(1);
});
