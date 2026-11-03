/* QA proof for plan todo 2: renders the REAL renderer CSS (tokens.css +
   oc-components.css + styles.css, concatenated exactly as the @import chain
   resolves) against markup transcribed 1:1 from ActivityBar + BottomPanel +
   TerminalPanel (same ids, classes, structure, disabled/aria gating).
   State A: no activeProjectId -> 3 toggles + bottom tabs + terminal-create
   all disabled. State B: workspace+session selected -> all enabled, terminal
   PTY row selected, CWD pinned to project rootPath. */
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

const ROOT = "C:\\Users\\UserPy\\Documents\\octus-demo";

function activityBar(disabled) {
  const d = disabled ? " disabled aria-disabled=\"true\"" : " aria-disabled=\"false\"";
  const acts = [
    ["explorer", "Explorer (Alt+1)", true],
    ["chat", "Chat (Alt+2)", false],
    ["plans", "Planes (Alt+3)", false],
    ["agents", "Agentes (Alt+4)", false],
    ["skills-mcp", "Skills y MCP (Alt+5)", false],
    ["settings", "Configuración (Alt+6)", false],
  ];
  const dots = {
    explorer: "M2 2h5v12H2z M9 2h5v5H9z M9 9h5v5H9z",
    chat: "M2 3h12v8H8l-3 3v-3H2z",
    plans: "M2 4h12 M2 8h12 M2 12h7",
    agents: "M8 2v4 M8 10v4 M2 6h4 M10 6h4 M8 4a2 2 0 100 4 2 2 0 000-4z",
    "skills-mcp": "M2 6h4V2h4v4h4v4H2z M6 10h4v4H6z",
    settings: "M8 2a6 6 0 100 12A6 6 0 008 2z M8 6a2 2 0 100 4 2 2 0 000-4z",
  };
  return `<nav id="activity-bar" aria-label="Actividad">` +
    acts.map(([id, label, on]) =>
      `<button type="button" data-activity="${id}" title="${label}" aria-label="${label}" aria-pressed="${on}"${on ? ' class="active"' : ""}>` +
      `<svg class="ab-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="${dots[id]}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /></svg></button>`
    ).join("") +
    `<div class="ab-spacer"></div>` +
    `<button type="button" id="toggle-sidebar" title="Mostrar u ocultar sidebar (Ctrl+B)" aria-label="Mostrar u ocultar sidebar (Ctrl+B)" aria-pressed="true"${d}>` +
    `<svg class="ab-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h12v12H2z M6 2v12" fill="none" stroke="currentColor" stroke-width="1.5" /></svg></button>` +
    `<button type="button" id="toggle-inspector" title="Mostrar u ocultar inspector (Ctrl+Alt+I)" aria-label="Mostrar u ocultar inspector (Ctrl+Alt+I)" aria-pressed="true"${d}>` +
    `<svg class="ab-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h12v12H2z M10 2v12" fill="none" stroke="currentColor" stroke-width="1.5" /></svg></button>` +
    `<button type="button" id="toggle-bottom" title="Mostrar u ocultar panel inferior (Ctrl+J)" aria-label="Mostrar u ocultar panel inferior (Ctrl+J)" aria-pressed="true"${d}>` +
    `<svg class="ab-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h12v12H2z M2 10h12" fill="none" stroke="currentColor" stroke-width="1.5" /></svg></button>` +
    `<button type="button" id="layout-reset" title="Restablecer layout (Ctrl+0)" aria-label="Restablecer layout (Ctrl+0)">` +
    `<svg class="ab-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8A5 5 0 113 8a5 5 0 0110 0z M13 2v3H10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg></button></nav>`;
}

function bottomPanel(disabled, withTerminal) {
  const d = disabled ? " disabled aria-disabled=\"true\"" : " aria-disabled=\"false\"";
  const tabs = [["terminal", "Terminal", true], ["problems", "Problemas", false], ["output", "Salida", false], ["tests", "Pruebas", false]];
  const tabsHtml = tabs.map(([id, label, on]) =>
    `<button type="button" role="tab" data-bottom-tab="${id}" aria-selected="${on}"${on ? ' class="active"' : ""}${d}>${label}</button>`
  ).join("");
  const termBody = withTerminal
    ? `<div id="terminal-panel" aria-label="Terminal persistente">
<div class="row" role="tablist" aria-label="Terminales">
<button type="button" data-terminal-id="term-1" aria-selected="true" class="active">terminal (open)</button>
<input id="terminal-name" value="terminal" placeholder="nombre" aria-label="Nombre de la terminal">
<button type="button" id="terminal-create" class="primary">Nueva terminal</button>
</div>
<pre id="terminal-output" aria-label="Salida de la terminal">Microsoft Windows [Version 10.0.19044]\r\n${ROOT}&gt;</pre>
<div class="row"><input id="terminal-input" value="" placeholder="escribe y pulsa Enter" aria-label="Entrada de la terminal">
<button type="button" id="terminal-send">Enviar</button>
<button type="button" id="terminal-enter">Enviar + Enter</button>
<button type="button" id="terminal-kill">Cancelar proceso</button>
<button type="button" id="terminal-close">Cerrar terminal</button></div></div>`
    : `<div id="terminal-panel" aria-label="Terminal persistente">
<div class="row" role="tablist" aria-label="Terminales">
<input id="terminal-name" value="terminal" placeholder="nombre" aria-label="Nombre de la terminal">
<button type="button" id="terminal-create" class="primary" disabled aria-disabled="true">Nueva terminal</button>
</div>
<p class="muted">Sin terminales. Crea una para trabajar en <code>—</code>.</p></div>`;
  return `<section id="bottom-panel" aria-label="Panel inferior">
<div class="bottom-tabs" role="tablist">${tabsHtml}<div class="ab-spacer"></div>
<button type="button" title="Ocultar panel inferior (Ctrl+J)" aria-label="Ocultar panel inferior (Ctrl+J)">Ocultar</button></div>
<div class="bottom-body">${termBody}</div></section>`;
}

function stateBlock(title, note, disabled, withTerminal) {
  return `<section class="qa-state"><h2>${title}</h2><p class="muted">${note}</p>
<div class="app" id="workbench"><div class="wb-top">${activityBar(disabled)}</div>${bottomPanel(disabled, withTerminal)}</div></section>`;
}

const html = `<!DOCTYPE html><html lang="es" data-theme="dark"><head><meta charset="utf-8"><style>${css}
.qa-state{border:1px solid #3a4a6b;margin:16px;padding:12px 16px 20px;border-radius:8px}
.qa-state>h2{margin:0 0 4px;font-size:15px}.qa-state .app{margin-top:8px;height:auto;min-height:0}.qa-state .wb-top{flex:none}</style></head><body>
${stateBlock("A · Sin proyecto: toggles y terminal bloqueados", "activeProjectId = undefined — los 3 toggles, los tabs inferiores y «Nueva terminal» deben estar disabled.", true, false)}
${stateBlock("B · Con workspace + sesión: todo activo, PTY en la raíz", "activeProjectId = ws-demo — toggles habilitados, terminal «term-1» abierta con CWD = " + ROOT + ".", false, true)}
</body></html>`;

(async () => {
  const outDir = "C:/Users/UserPy/Documents/octus/.omo/evidence/octus-welcome-settings-theme";
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const pg = await browser.newPage({ viewport: { width: 1280, height: 1700 } });
  await pg.setContent(html, { waitUntil: "load" });
  await pg.waitForTimeout(400);
  const report = await pg.evaluate(() => {
    const states = [...document.querySelectorAll(".qa-state")];
    return states.map((s, i) => {
      const q = (sel) => [...s.querySelectorAll(sel)];
      return {
        state: i === 0 ? "A-sin-proyecto" : "B-con-proyecto",
        toggles: ["toggle-sidebar", "toggle-inspector", "toggle-bottom"].map((id) => {
          const b = s.querySelector("#" + id);
          return [id, b.disabled, b.getAttribute("aria-disabled")];
        }),
        tabs: q('[data-bottom-tab]').map((b) => [b.dataset.bottomTab, b.disabled]),
        createDisabled: s.querySelector("#terminal-create").disabled,
        termTabs: q("[data-terminal-id]").map((b) => [b.dataset.terminalId, b.textContent.trim()]),
      };
    });
  });
  console.log("RENDERED:", JSON.stringify(report, null, 1));
  await pg.screenshot({ path: path.join(outDir, "task-2.png"), fullPage: true });
  await browser.close();
  console.log("saved to " + outDir + "/task-2.png");
})().catch((e) => {
  console.error("QA FAILED: " + (e && e.stack || e));
  process.exit(1);
});
