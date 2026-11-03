/* task-F3: LIVE workbench-with-project QA in real Electron (octus-welcome-settings-theme).
 * Closes task-10 live gaps: (a) workbench WITH project live (toggles enabled,
 * terminal rooted at project root), (b) toggles-with-project real clicks,
 * (c) OS-level file-drop attempt OR documented impossibility + closest proof.
 * Runs against the production build (apps/desktop/out) with an ISOLATED
 * OCTUS_DATA_DIR; fixture project lives in os.tmpdir (never in the repo).
 * Drives ONLY real paths: real IPC (window.octus.invoke -> main -> core/PTY),
 * real welcome clicks (.recent -> Nueva sesion), real toggle clicks.
 * Evidence: task-F3.* in .omo/evidence/octus-welcome-settings-theme/.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("C:/Users/UserPy/Documents/octus/node_modules/playwright-core");

const ROOT = "C:/Users/UserPy/Documents/octus";
const EV = path.join(ROOT, ".omo/evidence/octus-welcome-settings-theme");
const ELECTRON = path.join(ROOT, "apps/desktop/node_modules/electron/dist/electron.exe");
const MAIN = path.join(ROOT, "apps/desktop/out/main/index.js");
const PORT = 19223;

const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");
const DATADIR = fs.mkdtempSync(path.join(os.tmpdir(), "octus-f3-data-"));
const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), "octus-f3-proj-"));
fs.writeFileSync(path.join(FIXTURE, "nota.txt"), "hola f3\n");

const transcript = [];
function log(m) {
  const line = `[${new Date().toISOString()}] ${m}`;
  transcript.push(line);
  console.log(line);
}
const rows = [];
function row(gap, check, pass, detail) {
  rows.push({ gap, check, pass, detail });
  log(`${pass ? "PASS" : "FAIL"} [${gap}] ${check} :: ${detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitCdp(secs) {
  for (let i = 0; i < secs; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) { log(`CDP up after ~${i}s`); return; }
    } catch { /* retry */ }
    await sleep(1000);
  }
  throw new Error(`CDP endpoint 127.0.0.1:${PORT} never came up`);
}

(async () => {
  log(`task-F3 start root=${ROOT}`);
  log(`DATADIR(isolated)=${DATADIR}`);
  log(`FIXTURE(project root)=${FIXTURE}`);
  let child;
  let browser;
  try {
    const USERDATA = path.join(DATADIR, "user-data");
    fs.mkdirSync(USERDATA, { recursive: true });
    log(`USERDATA(isolated)=${USERDATA}`);
    child = spawn(ELECTRON, [MAIN, `--remote-debugging-port=${PORT}`, `--user-data-dir=${USERDATA}`], {
      cwd: ROOT,
      env: { ...process.env, OCTUS_DATA_DIR: DATADIR },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => { const s = String(d).trim(); if (s) log(`[electron-out] ${s.slice(0, 400)}`); });
    child.stderr.on("data", (d) => { const s = String(d).trim(); if (s) log(`[electron-err] ${s.slice(0, 400)}`); });
    child.on("exit", (c) => log(`electron exit code=${c}`));

    await waitCdp(60);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const context = browser.contexts()[0];
    let page = null;
    for (let i = 0; i < 60 && !page; i++) {
      for (const p of context.pages()) {
        try { const u = p.url(); if (u.startsWith("file://")) { page = p; break; } } catch { /* keep looking */ }
      }
      if (!page) await sleep(1000);
    }
    if (!page) throw new Error("no file:// renderer page found via CDP");
    await page.bringToFront().catch(() => {});
    log(`renderer url=${page.url()}`);

    // ---- baseline: welcome visible (fresh isolated data => no projects) ----
    await page.waitForSelector("#welcome-shell", { timeout: 45000 });
    await page.waitForSelector("#welcome-dropzone", { timeout: 15000 });
    await page.screenshot({ path: path.join(EV, "task-F3.welcome.png") });
    row("base", "welcome renders live with isolated data", true, "task-F3.welcome.png, #welcome-shell + #welcome-dropzone present");

    // ==================== GAP (c): OS-level file-drop ====================
    // Attempt 1: true OS-level drop. CDP Input.dispatchDragEvent does NOT
    // support file paths in Electron, and Playwright exposes no OS file-drop
    // API (only file-chooser / setInputFiles). There is no automation channel
    // from this Win32 host into the Electron window that carries a real
    // filesystem path, so a genuine OS drop cannot be synthesized here.
    // Attempt 2 (live, closest real): synthetic drop inside the LIVE renderer.
    const dropRes = await page.evaluate(() => {
      const dz = document.querySelector("#welcome-dropzone");
      if (!dz) return { error: "no-dropzone" };
      const dt = new DataTransfer();
      try {
        dt.items.add(new File(["hola"], "nota.txt", { type: "text/plain" }));
      } catch (e) { return { error: "dt-add: " + String(e) }; }
      dz.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      return { dispatched: true, err: document.querySelector("#welcome-error")?.textContent ?? null };
    });
    log(`synthetic live drop result: ${JSON.stringify(dropRes)}`);
    await page.screenshot({ path: path.join(EV, "task-F3.drop-synthetic.png") });
    const honestEmpty = typeof dropRes.err === "string" && dropRes.err.includes("soltado vac");
    row("c", "synthetic drop in LIVE Electron yields honest empty-drop error", honestEmpty,
      `err=${JSON.stringify(dropRes.err)} (synthetic File carries no OS path, as predicted) :: task-F3.drop-synthetic.png`);
    // Closest real proof: the SAME validator handlePath uses, live in Electron.
    const vOk = await page.evaluate((fx) => window.octus.invoke("app.validateDirectory", { path: fx }), FIXTURE);
    row("c", "live app.validateDirectory accepts fixture dir (real IPC/main)", vOk && vOk.ok === true, JSON.stringify(vOk));
    const vMissing = await page.evaluate(() => window.octus.invoke("app.validateDirectory", { path: "C:\\definitivamente-no-existe-f3\\x" }));
    row("c", "live app.validateDirectory rejects missing path (broken-path failure path)", vMissing && vMissing.ok === false, JSON.stringify(vMissing));
    const vFile = await page.evaluate((fx) => window.octus.invoke("app.validateDirectory", { path: fx }), path.join(FIXTURE, "nota.txt"));
    row("c", "live app.validateDirectory rejects a file (not-directory)", vFile && vFile.ok === false, JSON.stringify(vFile));

    // ==================== setup: real project via real IPC ====================
    // projects.create -> main -> core (same handler welcome's Crear proyecto uses).
    const created = await page.evaluate((args) => window.octus.invoke("projects.create", args), { name: "f3-proof", rootPath: FIXTURE });
    const projectId = created && created.project && created.project.id;
    log(`projects.create -> ${JSON.stringify({ id: projectId, rootPath: created?.project?.rootPath })}`);
    if (!projectId) throw new Error("projects.create returned no project");
    await page.reload();
    await page.waitForSelector("#welcome-recents .recent", { timeout: 30000 });

    // Real welcome clicks: recent -> sessions mode -> Nueva sesion -> workbench.
    await page.click("#welcome-recents .recent");
    await page.waitForSelector("#welcome-new-session", { timeout: 30000 });
    await page.click("#welcome-new-session");
    await page.waitForSelector("#workbench", { timeout: 30000 });
    log("workbench reached via real clicks (.recent -> #welcome-new-session)");
    await page.screenshot({ path: path.join(EV, "task-F3.workbench.png") });

    // ==================== GAP (a): workbench WITH project ====================
    const aState = await page.evaluate((fx) => {
      const q = (s) => document.querySelector(s);
      const enabled = (s) => { const el = q(s); return el ? el.disabled === false : null; };
      const tabs = [...document.querySelectorAll("[data-bottom-tab]")].map((b) => ({ id: b.dataset.bottomTab, disabled: b.disabled }));
      return {
        workbench: !!q("#workbench"),
        tSidebar: enabled("#toggle-sidebar"),
        tInspector: enabled("#toggle-inspector"),
        tBottom: enabled("#toggle-bottom"),
        sessionNew: enabled("#session-new"),
        tabs,
        terminalPanel: !!q("#terminal-panel"),
        terminalCreate: enabled("#terminal-create"),
        rootShown: q("#terminal-panel code")?.textContent ?? null,
        sessionRow: (document.querySelector("#session-list")?.textContent ?? "").trim().slice(0, 120),
      };
    }, FIXTURE);
    log(`gap-a state: ${JSON.stringify(aState)}`);
    row("a", "live workbench present with project", aState.workbench === true, "task-F3.workbench.png shows #workbench");
    const togglesOn = aState.tSidebar === true && aState.tInspector === true && aState.tBottom === true;
    row("a", "3 toggles ENABLED with project (live)", togglesOn, `sidebar=${aState.tSidebar} inspector=${aState.tInspector} bottom=${aState.tBottom}`);
    row("a", "session-new enabled + session exists (live)", aState.sessionNew === true && aState.sessionRow.length > 0, `sessionNew=${aState.sessionNew} row=${JSON.stringify(aState.sessionRow)}`);
    const tabsOn = Array.isArray(aState.tabs) && aState.tabs.length === 4 && aState.tabs.every((t) => t.disabled === false);
    row("a", "4 bottom tabs enabled with project (live)", tabsOn, JSON.stringify(aState.tabs));
    row("a", "TerminalPanel mounted, create enabled, projectRoot==fixture (live)", aState.terminalPanel && aState.terminalCreate === true && aState.rootShown === FIXTURE,
      `rootShown=${JSON.stringify(aState.rootShown)}`);

    // Terminal rooted proof, FULLY via live UI: create -> type cd -> Enter -> read output.
    const termTabSel = await page.evaluate(() => document.querySelector('[data-bottom-tab="terminal"]')?.getAttribute("aria-selected"));
    if (termTabSel !== "true") await page.click('[data-bottom-tab="terminal"]');
    await page.click("#terminal-create");
    await page.waitForSelector("#terminal-output", { timeout: 15000 });
    await page.fill("#terminal-input", "cd");
    await page.click("#terminal-enter");
    let termOut = "";
    for (let i = 0; i < 40; i++) {
      termOut = await page.evaluate(() => document.querySelector("#terminal-output")?.textContent ?? "");
      if (termOut.toLowerCase().includes(FIXTURE.toLowerCase())) break;
      await sleep(500);
    }
    log(`terminal output tail: ${JSON.stringify(termOut.slice(-300))}`);
    row("a", "live PTY rooted at project root via REAL UI (create+cd+Enter, output shows fixture)", termOut.toLowerCase().includes(FIXTURE.toLowerCase()),
      `output contains fixture path; tail=${JSON.stringify(termOut.slice(-200))}`);
    await page.screenshot({ path: path.join(EV, "task-F3.terminal.png") });

    // ==================== GAP (b): toggles real clicks ====================
    async function toggleFlip(toggleId, panelId) {
      const before = await page.evaluate((p) => document.querySelector(p)?.style.display ?? "?", panelId);
      await page.click(toggleId);
      await sleep(700);
      const after = await page.evaluate((p) => document.querySelector(p)?.style.display ?? "?", panelId);
      await page.click(toggleId);
      await sleep(700);
      const restored = await page.evaluate((p) => document.querySelector(p)?.style.display ?? "?", panelId);
      return { before, after, restored, flipped: before !== after, backTo: restored === before };
    }
    const sb = await toggleFlip("#toggle-sidebar", "#sidebar");
    row("b", "toggle-sidebar flips #sidebar visibility via REAL click", sb.flipped && sb.backTo, JSON.stringify(sb));
    const bt = await toggleFlip("#toggle-bottom", "#bottom-panel");
    row("b", "toggle-bottom flips #bottom-panel visibility via REAL click", bt.flipped && sb.backTo && bt.backTo, JSON.stringify(bt));
    await page.screenshot({ path: path.join(EV, "task-F3.toggles.png") });
    const ins = await toggleFlip("#toggle-inspector", "#inspector");
    row("b", "toggle-inspector flips #inspector visibility via REAL click", ins.flipped && ins.backTo, JSON.stringify(ins));
    // Keyboard shortcut path (Ctrl+B) also live.
    const kbBefore = await page.evaluate(() => document.querySelector("#sidebar")?.style.display ?? "?");
    await page.keyboard.press("Control+b");
    await sleep(700);
    const kbAfter = await page.evaluate(() => document.querySelector("#sidebar")?.style.display ?? "?");
    await page.keyboard.press("Control+b");
    await sleep(700);
    row("b", "Ctrl+B shortcut toggles sidebar live", kbBefore !== kbAfter, `before=${kbBefore} after=${kbAfter}`);
  } catch (err) {
    log(`FATAL: ${err && err.stack ? err.stack : String(err)}`);
    rows.push({ gap: "*", check: "script completed without fatal", pass: false, detail: String((err && err.message) || err) });
  } finally {
    try {
      const fails = rows.filter((r) => !r.pass);
      log(`SUMMARY rows=${rows.length} pass=${rows.length - fails.length} fail=${fails.length}`);
      for (const r of rows) log(`ROW ${r.pass ? "PASS" : "FAIL"} [${r.gap}] ${r.check}`);
      fs.writeFileSync(path.join(EV, "task-F3.raw.log"), transcript.join("\n") + "\n", "utf8");
      fs.writeFileSync(path.join(EV, "task-F3.rows.json"), JSON.stringify({ runTs: RUN_TS, fixture: FIXTURE, dataDir: DATADIR, rows }, null, 2), "utf8");
      try { await browser?.close(); } catch { /* electron killed below */ }
    } finally {
      try { child?.kill(); } catch { /* best effort */ }
    }
  }
})();
