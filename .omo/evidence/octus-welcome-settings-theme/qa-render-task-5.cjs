/* QA preview for plan todo 5: renders the REAL renderer CSS (tokens.css +
   oc-components.css + styles.css, concatenated exactly as the @import chain
   resolves) against markup transcribed 1:1 from the new ProviderSettings
   (h2 Proveedores, .card > h3 + .row.oc-provider-actions con input + 3
   botones + details Models(n)). Hartwell-style adversarial checks: sin
   parentesis API en el panel, botones en una sola fila a 1280px, radios 2px
   via tokens, Models(n) presente. Limite honesto: el markup es transcrito
   (no el componente Solid compilado); el componente real queda cubierto por
   el fixture run settings-modal (todo 4) + typecheck. */
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

// Transcripcion 1:1 de ProviderSettings (sections.tsx, todo 5).
function providerCard(i, configured) {
  const pill = configured
    ? '<span class="pill ok">key saved</span>'
    : '<span class="pill warn">no key</span>';
  return `<div class="card"><h3>Proveedor ${i} ${pill}</h3>
<div class="row oc-provider-actions"><input type="password" placeholder="Paste API key" autocomplete="off" />
<button class="primary">Save key</button><button>Remove</button><button>Test</button></div>
<details><summary>Models (2)</summary><ul><li><code>model-${i}a</code> — ctx 128,000, efforts: low, high</li></ul></details></div>`;
}

const inner = `<div id="settings-overlay" class="oc-settings-overlay">
<div id="settings-modal" class="oc-settings-dialog" role="dialog" aria-modal="true" aria-label="Ajustes">
<div class="oc-settings-head"><h2 class="oc-settings-title">Ajustes</h2>
<button id="settings-close" type="button" class="oc-btn oc-btn--ghost" aria-label="Cerrar ajustes">×</button></div>
<div class="oc-settings-body">
<nav class="oc-settings-nav" aria-label="Secciones de ajustes">
<button id="settings-nav-providers" type="button" aria-selected="true">Proveedores</button>
<button id="settings-nav-agents" type="button" aria-selected="false">Agentes</button>
</nav>
<div id="settings-panel" class="oc-settings-panel">
<section><h2>Proveedores</h2>${providerCard(1, false)}${providerCard(2, true)}</section>
</div></div></div></div>`;

const html = `<!DOCTYPE html><html lang="es" data-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head>
<body><div class="app"><main></main>${inner}</div></body></html>`;

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "OK   " : "FAIL ") + name + (detail !== undefined ? " :: " + detail : ""));
  if (!cond) failures++;
}

(async () => {
  const outDir = "C:/Users/UserPy/Documents/octus/.omo/evidence/octus-welcome-settings-theme";
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const pg = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  pg.on("pageerror", (e) => console.log("PAGEERROR:", e && e.message));
  await pg.setContent(html, { waitUntil: "load" });
  await pg.waitForTimeout(300);

  const h2 = await pg.textContent("#settings-panel section h2");
  check("heading es Proveedores", h2 && h2.trim() === "Proveedores", JSON.stringify(h2));

  const panelText = await pg.textContent("#settings-panel");
  check("sin parentesis API en el panel", panelText && !/\(API\)/i.test(panelText), JSON.stringify((panelText || "").slice(0, 80)));

  const btns = await pg.evaluate(() => {
    const rows = [...document.querySelectorAll(".oc-provider-actions")];
    return rows.map((row) => {
      const b = [...row.querySelectorAll("button")];
      const tops = b.map((x) => Math.round(x.getBoundingClientRect().top));
      const labels = b.map((x) => x.textContent.trim());
      const rowRect = row.getBoundingClientRect();
      return { labels, tops, rowWidth: Math.round(rowRect.width), scrollW: row.scrollWidth, clientW: row.clientWidth };
    });
  });
  check("2 filas de proveedor", btns.length === 2, JSON.stringify(btns.length));
  for (const [i, r] of btns.entries()) {
    check(`fila ${i + 1} botones Save/Remove/Test`, JSON.stringify(r.labels) === JSON.stringify(["Save key", "Remove", "Test"]), JSON.stringify(r.labels));
    check(`fila ${i + 1} una sola fila (mismo top)`, new Set(r.tops).size === 1, JSON.stringify(r.tops));
    check(`fila ${i + 1} sin overflow horizontal`, r.scrollW <= r.clientW + 1, `scrollW=${r.scrollW} clientW=${r.clientW}`);
  }

  const summaries = await pg.evaluate(() =>
    [...document.querySelectorAll("#settings-panel details summary")].map((s) => s.textContent.trim()));
  check("details Models(n)", summaries.length === 2 && summaries.every((s) => /^Models \(\d+\)$/.test(s)), JSON.stringify(summaries));

  const radii = await pg.evaluate(() => {
    const b = document.querySelector(".oc-provider-actions button");
    const cs = getComputedStyle(b);
    const root = getComputedStyle(document.documentElement);
    return { btn: cs.borderRadius, sm: root.getPropertyValue("--oc-radius-sm").trim(), md: root.getPropertyValue("--oc-radius-md").trim() };
  });
  check("radios 2px via tokens", radii.btn === "2px" && radii.sm === "2px" && radii.md === "2px", JSON.stringify(radii));

  const cssVars = await pg.evaluate(() => {
    const sheets = [...document.styleSheets];
    let literal = null;
    for (const sh of sheets) {
      let rules;
      try { rules = sh.cssRules; } catch { continue; }
      for (const rl of rules) {
        if (rl.selectorText && rl.selectorText.includes("oc-provider-actions")) {
          const t = rl.cssText;
          // 0px es el cero sin unidad serializado por el navegador (igual que
          // el `margin: 0` existente); solo cuentan medidas reales y colores.
          const m = t.match(/#[0-9a-fA-F]{3,8}|\b(?!0px\b)\d+px\b/);
          if (m) { literal = m[0] + " in " + rl.selectorText; break; }
        }
      }
    }
    return literal;
  });
  check("oc-provider-actions sin literales", cssVars === null, JSON.stringify(cssVars));

  await pg.screenshot({ path: path.join(outDir, "task-5.png") });
  console.log("saved task-5.png");
  await browser.close();
  if (failures > 0) {
    console.error(`QA FAILED: ${failures} check(s)`);
    process.exit(1);
  }
  console.log("QA PASS: all checks");
})().catch((e) => {
  console.error("QA FAILED: " + (e && e.message));
  process.exit(1);
});
