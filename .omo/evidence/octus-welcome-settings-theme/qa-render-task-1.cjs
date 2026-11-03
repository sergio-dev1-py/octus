/* QA preview for plan todo 1: renders the REAL renderer CSS (tokens.css +
   oc-components.css + styles.css, concatenated exactly as the @import chain
   resolves) against markup transcribed 1:1 from the new WelcomeView
   choose-mode (same ids, classes, structure, sample data). Screenshots:
   happy (no project selected) + failure (broken path + error banner). */
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

function pageShell(inner) {
  return `<!DOCTYPE html><html lang="es" data-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head>
<body><div class="app" id="welcome-shell"><main id="welcome" class="welcome-root" aria-label="Bienvenida">${inner}</main></div></body></html>`;
}

function brand() {
  return `<div class="welcome-brand">
<svg class="welcome-logo" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
<path d="M42 60 C42 40 50 26 60 26 C70 26 78 40 78 60" />
<circle cx="53" cy="48" r="3.5" fill="currentColor" stroke="none" />
<circle cx="67" cy="48" r="3.5" fill="currentColor" stroke="none" />
<path d="M42 52 C34 53 28 57 27 64 C26 70 32 72 35 67" />
<path d="M78 52 C86 53 92 57 93 64 C94 70 88 72 85 67" />
<path d="M44 60 C38 68 30 70 26 76 C22 82 28 87 32 82" />
<path d="M51 61 C48 70 42 74 40 82 C38 88 44 91 47 86" />
<path d="M57 61 C56 69 54 77 54 84 C54 90 60 90 60 85" />
<path d="M63 61 C64 69 66 77 66 84 C66 90 72 89 71 84" />
<path d="M69 61 C72 70 78 74 80 82 C82 88 76 91 73 86" />
<path d="M76 60 C82 68 90 70 94 76 C98 82 92 87 88 82" />
</svg><h1>Octus</h1></div>`;
}

function buttons() {
  return `<div class="welcome-actions-col">
<button id="welcome-pick" type="button" class="oc-btn oc-btn--primary"><svg class="oc-icon" data-icon="folder" viewBox="0 0 16 16" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 4.5c0-.8.7-1.5 1.5-1.5h3l1.5 2H13c.8 0 1.5.7 1.5 1.5v4c0 .8-.7 1.5-1.5 1.5H3c-.8 0-1.5-.7-1.5-1.5v-6z" /></svg> Abrir Carpeta</button>
<button id="welcome-settings" type="button" class="oc-btn oc-btn--secondary"><svg class="oc-icon" viewBox="0 0 16 16" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.5" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" /></svg> Ajustes</button>
</div>
<div id="welcome-dropzone">Arrastra una carpeta aquí para abrirla como workspace</div>`;
}

function recentRow(p) {
  return `<li><button type="button" class="recent"${p.broken ? ' data-broken="true"' : ""}>
<span class="recent-name">${p.name}</span>
<span class="recent-path">${p.path}</span>
<span class="recent-date">${p.date}</span>
${p.broken ? '<span class="recent-broken">ruta ausente</span>' : ""}
</button></li>`;
}

const projects = [
  { name: "openSpeakVoice-landing", path: "C:\\Users\\UserPy\\Documents", date: "2/11/2026, 10:00:00" },
  { name: "ProyPasantias", path: "C:\\Users\\UserPy\\Documents", date: "2/11/2026, 09:12:44" },
  { name: "ProyectoPasantias", path: "C:\\Users\\UserPy\\Documents", date: "1/11/2026, 18:02:10" },
  { name: "cuarto-workspace", path: "D:\\datos\\cuarto", date: "30/10/2026, 12:00:00" },
];

function recentsList(rows, showMore) {
  return `<section class="welcome-recents" aria-label="Workspaces"><h2>Workspaces</h2>
<ul id="welcome-recents">${rows.map(recentRow).join("")}</ul>
${showMore ? '<button type="button" id="welcome-more" class="welcome-more">Ver más workspaces…</button>' : ""}
</section>`;
}

const happy = pageShell(brand() + buttons() + recentsList(projects.slice(0, 3), true));
const failure = pageShell(
  brand() +
    `<div id="welcome-error" role="alert">«ProyectoPasantias»: ruta no disponible. Elige otro proyecto.<button type="button">×</button></div>` +
    buttons() +
    recentsList(
      [
        projects[0],
        { ...projects[2], broken: true },
        projects[1],
      ],
      true
    )
);

(async () => {
  const outDir = "C:/Users/UserPy/Documents/octus/.omo/evidence/octus-welcome-settings-theme";
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const pg = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await pg.setContent(happy, { waitUntil: "load" });
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: path.join(outDir, "task-1.png") });
  const ids = await pg.evaluate(() =>
    ["welcome-dropzone", "welcome-pick", "welcome-recents", "welcome-more"].map((id) => [id, !!document.getElementById(id)])
  );
  console.log("HAPPY ids:", JSON.stringify(ids));
  console.log("HAPPY title:", await pg.title(), "| h1:", await pg.textContent(".welcome-brand h1"));
  await pg.setContent(failure, { waitUntil: "load" });
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: path.join(outDir, "task-1-failure.png") });
  const err = await pg.textContent("#welcome-error");
  const broken = await pg.evaluate(() => document.querySelectorAll(".recent-broken").length);
  console.log("FAILURE error banner:", JSON.stringify((err || "").slice(0, 80)));
  console.log("FAILURE broken rows:", broken);
  await browser.close();
  console.log("saved to " + outDir);
})().catch((e) => {
  console.error("QA FAILED: " + (e && e.message));
  process.exit(1);
});
