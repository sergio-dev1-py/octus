/* QA preview for plan todo 4: renders the REAL renderer CSS (tokens.css +
   oc-components.css + styles.css, concatenated exactly as the @import chain
   resolves) against markup transcribed 1:1 from the new SettingsView modal
   shell (overlay/dialog/head/nav/panel ids + classes) with representative
   provider/agent panel content. A Hartwell-style check: open/close via X,
   section switching, overflow assertion, tall-content internal scroll. */
const fs = require("fs");
const path = require("path");
const { chromium } = require("C:/Users/UserPy/Documents/octus/node_modules/playwright-core");

const R = "C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src";
const tokens = fs.readFileSync(path.join(R, "design/tokens.css"), "utf8");
const occ = fs.readFileSync(path.join(R, "components/oc-components.css"), "utf8");
let styles = fs.readFileSync(path.join(R, "styles.css"), "utf8");
styles = styles
  .replace('@import "./design/tokens.css";', "")
  .replace('@import "./components/oc-components.css";', "");
const css = tokens + "\n" + occ + "\n" + styles;

function providerCard(i) {
  return `<div class="card"><h3>Proveedor ${i} <span class="pill warn">no key</span></h3>
<div class="row"><input type="password" placeholder="Paste API key" autocomplete="off" />
<button class="primary">Save key</button><button>Remove</button><button>Test</button></div>
<details><summary>Models (3)</summary><ul><li><code>model-${i}a</code></li></ul></details></div>`;
}

function agentCard(i) {
  return `<div class="card"><h3><code>agent-${i}</code> <span class="muted">chat</span></h3>
<div class="row"><input placeholder="providerId" value="p${i}" /><input placeholder="modelId" value="m${i}" />
<input placeholder="effort (optional)" /><button>Save model</button></div></div>`;
}

function modalShell(panelProviders, panelAgents) {
  return `<div id="settings-overlay" class="oc-settings-overlay">
<div id="settings-modal" class="oc-settings-dialog" role="dialog" aria-modal="true" aria-label="Ajustes">
<div class="oc-settings-head"><h2 class="oc-settings-title">Ajustes</h2>
<button id="settings-close" type="button" class="oc-btn oc-btn--ghost" aria-label="Cerrar ajustes">×</button></div>
<div class="oc-settings-body">
<nav class="oc-settings-nav" aria-label="Secciones de ajustes">
<button id="settings-nav-providers" type="button" aria-selected="true">Proveedores</button>
<button id="settings-nav-agents" type="button" aria-selected="false">Agentes</button>
</nav>
<div id="settings-panel" class="oc-settings-panel">
<section id="panel-providers"><h2>Providers</h2>${panelProviders}</section>
<section id="panel-agents" hidden><h2>Agents</h2>${panelAgents}</section>
</div></div></div></div>`;
}

const behaviour = `<script>
const overlay = () => document.getElementById('settings-overlay');
document.getElementById('settings-close').addEventListener('click', () => overlay()?.remove());
overlay().addEventListener('click', (e) => { if (e.target === overlay()) overlay()?.remove(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay()?.remove(); });
for (const [nav, panel] of [['settings-nav-providers','panel-providers'],['settings-nav-agents','panel-agents']]) {
  document.getElementById(nav).addEventListener('click', () => {
    for (const n of ['settings-nav-providers','settings-nav-agents'])
      document.getElementById(n).setAttribute('aria-selected', n === nav ? 'true' : 'false');
    for (const p of ['panel-providers','panel-agents'])
      document.getElementById(p).hidden = (p !== panel);
  });
}
</script>`;

function pageShell(inner) {
  return `<!DOCTYPE html><html lang="es" data-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head>
<body><div class="app" id="welcome-shell"><main id="welcome" class="welcome-root" aria-label="Bienvenida"></main>${inner}</div>${behaviour}</body></html>`;
}

const normal = pageShell(modalShell(providerCard(1) + providerCard(2), agentCard(1) + agentCard(2)));
const tallCards = Array.from({ length: 12 }, (_, i) => providerCard(i + 1)).join("") +
  Array.from({ length: 12 }, (_, i) => agentCard(i + 1)).join("");
const tall = pageShell(modalShell(tallCards, tallCards));

(async () => {
  const outDir = "C:/Users/UserPy/Documents/octus/.omo/evidence/octus-welcome-settings-theme";
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const pg = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  pg.on("pageerror", (e) => console.log("PAGEERROR:", e && e.message));

  // --- happy: modal abre, X visible, nav con 2 secciones ---
  await pg.setContent(normal, { waitUntil: "load" });
  await pg.waitForTimeout(300);
  const head = await pg.textContent(".oc-settings-title");
  const navCount = await pg.evaluate(() => document.querySelectorAll(".oc-settings-nav button").length);
  const navLabels = await pg.evaluate(() =>
    [...document.querySelectorAll(".oc-settings-nav button")].map((b) => b.textContent.trim()));
  const dialogRect = await pg.evaluate(() => {
    const r = document.getElementById("settings-modal").getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: innerWidth, h: innerHeight };
  });
  const overflowNormal = await pg.evaluate(() => {
    const d = document.getElementById("settings-modal");
    return { scrollHeight: d.scrollHeight, clientHeight: d.clientHeight };
  });
  console.log("HEAD title:", JSON.stringify(head));
  console.log("NAV count/labels:", navCount, JSON.stringify(navLabels));
  console.log("DIALOG rect vs viewport:", JSON.stringify(dialogRect));
  console.log("OVERFLOW normal:", JSON.stringify(overflowNormal),
    "=>", overflowNormal.scrollHeight <= overflowNormal.clientHeight + 1 ? "OK" : "FAIL");
  await pg.screenshot({ path: path.join(outDir, "task-4.png") });

  // --- section switching: click Agentes ---
  await pg.click("#settings-nav-agents");
  await pg.waitForTimeout(200);
  const switched = await pg.evaluate(() => ({
    agentsVisible: !document.getElementById("panel-agents").hidden,
    providersHidden: document.getElementById("panel-providers").hidden,
    sel: document.getElementById("settings-nav-agents").getAttribute("aria-selected"),
  }));
  console.log("SWITCH to Agentes:", JSON.stringify(switched));
  await pg.screenshot({ path: path.join(outDir, "task-4-agents.png") });

  // --- close via X ---
  await pg.click("#settings-close");
  await pg.waitForTimeout(200);
  const closed = await pg.evaluate(() => !document.getElementById("settings-overlay"));
  console.log("CLOSE via X: overlay removed =", closed);

  // --- adversarial: tall content must stay inside viewport, panel scrolls ---
  // NB: setContent reuses the Window (document.open), so top-level consts
  // would collide with the previous page's script. Fresh page per document.
  const pg2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  pg2.on("pageerror", (e) => console.log("PAGEERROR(tall):", e && e.message));
  await pg2.setContent(tall, { waitUntil: "load" });
  await pg2.waitForTimeout(300);
  const tallCheck = await pg2.evaluate(() => {
    const d = document.getElementById("settings-modal");
    const p = document.getElementById("settings-panel");
    const r = d.getBoundingClientRect();
    return {
      rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      viewport: { w: innerWidth, h: innerHeight },
      dialog: { scrollHeight: d.scrollHeight, clientHeight: d.clientHeight },
      panel: { scrollHeight: p.scrollHeight, clientHeight: p.clientHeight },
    };
  });
  const fitsViewport = tallCheck.rect.top >= 0 && tallCheck.rect.left >= 0 &&
    tallCheck.rect.bottom <= tallCheck.viewport.h && tallCheck.rect.right <= tallCheck.viewport.w;
  const marginTop = tallCheck.rect.top, marginBottom = tallCheck.viewport.h - tallCheck.rect.bottom;
  console.log("TALL rect:", JSON.stringify(tallCheck.rect), "viewport:", JSON.stringify(tallCheck.viewport));
  console.log("TALL margins top/bottom:", marginTop.toFixed(1), marginBottom.toFixed(1), "=> fits:", fitsViewport ? "OK" : "FAIL");
  console.log("TALL dialog overflow:", JSON.stringify(tallCheck.dialog),
    "=>", tallCheck.dialog.scrollHeight <= tallCheck.dialog.clientHeight + 1 ? "OK" : "FAIL");
  console.log("TALL panel internal scroll:", JSON.stringify(tallCheck.panel),
    "=>", tallCheck.panel.scrollHeight > tallCheck.panel.clientHeight ? "scrolls OK" : "no-scroll (content fits)");
  await pg2.screenshot({ path: path.join(outDir, "task-4-tall.png") });

  // --- Escape closes ---
  await pg2.click(".oc-settings-title");
  const dbgPre = await pg2.evaluate(() => ({
    active: document.activeElement ? document.activeElement.tagName : "none",
    hasOverlay: !!document.getElementById("settings-overlay"),
  }));
  console.log("ESCAPE pre:", JSON.stringify(dbgPre));
  await pg2.keyboard.press("Escape");
  await pg2.waitForTimeout(200);
  console.log("CLOSE via Escape: overlay removed =", await pg2.evaluate(() => !document.getElementById("settings-overlay")));
  await pg2.close();

  await browser.close();
  console.log("saved to " + outDir);
})().catch((e) => {
  console.error("QA FAILED: " + (e && e.message));
  process.exit(1);
});
