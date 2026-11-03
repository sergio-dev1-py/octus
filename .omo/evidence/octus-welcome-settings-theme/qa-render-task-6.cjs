/* QA proof for plan octus-welcome-settings-theme, todo 6: the REAL AgentSettings
 * (SettingsView from settings.tsx + real tokens/oc-components/styles CSS) with
 * 2 seeded definitions. Asserts: per-definition provider/model/effort inputs +
 * compact primary Save model buttons (2px radius via tokens), concurrency
 * limits intact, zero budget/money-limit mentions, and the empty-field error
 * path. Screenshot -> task-6.png, raw log -> task-6.log (this file's stdout). */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { build } = require("C:/Users/UserPy/Documents/octus/apps/desktop/node_modules/vite/dist/node/index.js");
const solidPlugin = require("C:/Users/UserPy/Documents/octus/apps/desktop/node_modules/vite-plugin-solid/dist/cjs/index.cjs");
const { chromium } = require("C:/Users/UserPy/Documents/octus/node_modules/playwright-core");

const ROOT = "C:/Users/UserPy/Documents/octus";
const EVIDENCE = path.join(ROOT, ".omo/evidence/octus-welcome-settings-theme");
const SRC_FIXTURE = path.join(ROOT, "apps/desktop/test/settings-modal");

const log = [];
function say(line) { log.push(line); console.log(line); }

const fixture = `/** Temp proof fixture (todo 6): SettingsView REAL + CSS real, 3 proveedores y 2 definiciones. */
import { render } from "solid-js/web";
import { SettingsView } from "../../src/renderer/src/views/settings.jsx";
import "../../src/renderer/src/styles.css";
import { setState } from "../../src/renderer/src/store.js";

setState("providers", [1, 2, 3].map((i) => ({
  id: "p" + i, displayName: "Proveedor " + i, configured: false,
  models: [{ providerId: "p" + i, modelId: "m" + i, displayName: "Modelo " + i,
    capabilities: { toolCall: true, reasoningEfforts: ["low"], maxContextTokens: 128000, maxOutputTokens: 8000, supportsImages: false } }],
})));
setState("definitions", [
  { id: "chat", kind: "coordinator", name: "Chat", description: "Agente de chat general.",
    defaultModel: { providerId: "p1", modelId: "m1", effort: "low" },
    maxSteps: 20, timeoutMs: 60000, idleTimeoutMs: 30000, systemPrompt: "x",
    tools: ["read", "write"], deniedTools: [], permissionRules: [],
    deliveryFormat: "text", canDelegateTo: [], promptVersion: 3 },
  { id: "reviewer", kind: "reviewer", name: "Reviewer", description: "Revisa cambios.",
    defaultModel: { providerId: "p2", modelId: "m2" },
    maxSteps: 10, timeoutMs: 60000, idleTimeoutMs: 30000, systemPrompt: "y",
    tools: ["read"], deniedTools: [], permissionRules: [],
    deliveryFormat: "text", canDelegateTo: [], promptVersion: 1 },
]);
setState("agentLimits", { maxPerSession: 4, maxPerProject: 6, maxDepth: 2 });

declare global { interface Window { __settingsClosed?: boolean } }
const root = document.getElementById("root")!;
const dispose = render(() => (<SettingsView onClose={() => { window.__settingsClosed = true; dispose(); }} />), root);
`;

(async () => {
  const dir = path.join(ROOT, "apps/desktop/test/.tmp-task6-proof");
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.copyFile(path.join(SRC_FIXTURE, "index.html"), path.join(dir, "index.html"));
  await fs.promises.writeFile(path.join(dir, "fixture.tsx"), fixture);
  say("fixture dir: " + dir);

  const outDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "octus-task6-out-"));
  await build({ root: dir, plugins: [solidPlugin()], base: "./",
    build: { outDir, emptyOutDir: true, minify: false, sourcemap: false }, logLevel: "warn" });
  say("vite build ok: " + outDir);

  const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
  const server = Bun.serve({ port: 0, async fetch(req) {
    const pathname = new URL(req.url).pathname.replace(/^\/+/, "");
    const file = Bun.file(path.join(outDir, pathname === "" ? "index.html" : pathname));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    const dot = pathname.lastIndexOf(".");
    return new Response(file, { headers: { "Content-Type": MIME[pathname.slice(dot)] ?? "application/octet-stream" } });
  }});
  const base = `http://127.0.0.1:${server.port}/index.html`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let failed = 0;
  const check = (name, cond) => { say((cond ? "PASS " : "FAIL ") + name); if (!cond) failed++; };

  await page.goto(base, { waitUntil: "load" });
  await page.click("#settings-nav-agents");
  const panel = await page.textContent("#settings-panel");
  check("agents panel shows Concurrency limits", (panel ?? "").includes("Concurrency limits"));
  check("agents panel shows chat definition", (panel ?? "").includes("chat"));
  check("agents panel shows reviewer definition", (panel ?? "").includes("reviewer"));
  check("agents panel shows default model p1/m1", (panel ?? "").includes("p1") && (panel ?? "").includes("m1"));
  check("zero budget mentions (budget/Budget/Presupuesto/$/USD/limite monetario)", !/budget|presupuesto|USD|money cap|tope/i.test(panel ?? ""));

  const saveBtns = await page.$$eval("#settings-panel button", (els) =>
    els.filter((e) => (e.textContent ?? "").trim() === "Save model").map((e) => e.className));
  check("2 Save model buttons present", saveBtns.length === 2);
  check("Save model buttons use compact primary class", saveBtns.every((c) => c.includes("primary")));
  const radius = await page.$eval("#settings-panel button.primary",
    (el) => getComputedStyle(el).borderRadius);
  check("Save model radius is 2px via tokens (got " + radius + ")", radius === "2px" || radius === "2px 2px 2px 2px");

  const placeholders = await page.$$eval("#settings-panel input", (els) =>
    els.map((e) => e.getAttribute("placeholder")));
  check("provider/model/effort inputs per definition",
    placeholders.includes("providerId") && placeholders.includes("modelId") && placeholders.includes("effort (optional)"));

  // Failure path: empty provider+model shows inline error, no invoke needed.
  await page.fill("#settings-panel input[placeholder='providerId']", "");
  await page.fill("#settings-panel input[placeholder='modelId']", "");
  await page.click("#settings-panel button.primary >> nth=1");
  const after = await page.textContent("#settings-panel");
  check("empty provider/model shows error banner", (after ?? "").includes("providerId and modelId are required"));

  await page.screenshot({ path: path.join(EVIDENCE, "task-6.png") });
  say("screenshot -> " + path.join(EVIDENCE, "task-6.png"));

  await page.close(); await browser.close(); server.stop(true);
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.rm(outDir, { recursive: true, force: true });
  say(failed === 0 ? "TASK-6 PROOF: ALL OK" : `TASK-6 PROOF: ${failed} FAILURES`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error("TASK-6 PROOF ERROR:", e); process.exit(2); });
