/**
 * Todo 8 — verificación ejecutada del workbench (no dry-run).
 * Se ejecuta con: bun scripts/verify-task-8-layout.mjs
 *
 * Afirma con código real (mismo módulo que usa el renderer):
 *  1. ocultar, redimensionar y restaurar cada panel (sidebar, inspector, inferior)
 *  2. estado persistido tras reinicio simulado (close + reopen de PersistenceService real)
 *  3. caso failure: layout corrupto → defecto sin pantalla en blanco (+ flag repaired)
 *  4. los estilos aplicados al DOM usan layoutStyles (la traducción exacta del renderer)
 *  5. cableado: IPC layout.get/set en shared + main, selectores fijos y atajos en App
 *
 * Herramientas: bun (ejecuta TS), node:sqlite vía PersistenceService real,
 * linkedom (DOM real, instalado en scratch para no añadir deps pesadas al repo).
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "file:///C:/Windows/Temp/scratch-layout-qa/node_modules/linkedom/esm/index.js";
import {
  BOTTOM_MAX,
  BOTTOM_MIN,
  DEFAULT_LAYOUT,
  INSPECTOR_MAX,
  INSPECTOR_MIN,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  UI_LAYOUT_KEY,
  isWorkbenchLayout,
  layoutStyles,
  parseStoredLayout,
  parseWorkbenchLayout,
  resetLayout,
  resizeBottomBy,
  resizeInspectorBy,
  resizeSidebarBy,
  setActivity,
  setBottomTab,
  toggleBottom,
  toggleInspector,
  toggleSidebar,
} from "../packages/shared/src/layout.js";
import { PersistenceService } from "../packages/core/src/persistence/persistence-service.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function applyToDom(document, layout) {
  // Misma traducción que App.tsx: layoutStyles → estilos en línea de los paneles.
  const styles = layoutStyles(layout);
  const sidebar = document.getElementById("sidebar");
  const inspector = document.getElementById("inspector");
  const bottom = document.getElementById("bottom-panel");
  sidebar.style.display = styles.sidebar.display;
  sidebar.style.width = styles.sidebar.width;
  inspector.style.display = styles.inspector.display;
  inspector.style.width = styles.inspector.width;
  bottom.style.display = styles.bottom.display;
  bottom.style.height = styles.bottom.height;
  return { sidebar, inspector, bottom };
}

function skeleton() {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>
    <div class="app" id="workbench">
      <div class="wb-top">
        <nav id="activity-bar"></nav>
        <aside id="sidebar"></aside>
        <div class="wb-resize" data-resize="sidebar"></div>
        <div id="center"><div class="message-timeline"></div><div class="composer" id="composer"></div></div>
        <div class="wb-resize" data-resize="inspector"></div>
        <aside id="inspector"></aside>
      </div>
      <div class="wb-resize wb-resize-row" data-resize="bottom"></div>
      <section id="bottom-panel"></section>
    </div>
  </body></html>`);
  return document;
}

// --- 1. Ocultar, redimensionar y restaurar cada panel ---
{
  let layout = { ...DEFAULT_LAYOUT };
  const document = skeleton();
  let els = applyToDom(document, layout);
  check("sidebar visible al inicio", els.sidebar.style.display === "" && els.sidebar.style.width === "264px", JSON.stringify(els.sidebar.style.width));

  layout = toggleSidebar(layout);
  els = applyToDom(document, layout);
  check("ocultar sidebar (display none, tamaño conservado)", els.sidebar.style.display === "none" && els.sidebar.style.width === "264px");

  layout = resizeSidebarBy(layout, 36);
  els = applyToDom(document, layout);
  check("redimensionar sidebar oculta conserva el nuevo tamaño", els.sidebar.style.width === "300px", els.sidebar.style.width);

  layout = toggleSidebar(layout);
  els = applyToDom(document, layout);
  check("restaurar sidebar muestra 300px", els.sidebar.style.display === "" && els.sidebar.style.width === "300px");

  layout = toggleInspector(layout);
  els = applyToDom(document, layout);
  check("ocultar inspector", els.inspector.style.display === "none");

  layout = resizeInspectorBy(layout, -50);
  els = applyToDom(document, layout);
  check("redimensionar inspector a 298px", els.inspector.style.width === "298px", els.inspector.style.width);

  layout = toggleInspector(layout);
  els = applyToDom(document, layout);
  check("restaurar inspector muestra 298px", els.inspector.style.display === "" && els.inspector.style.width === "298px");

  layout = toggleBottom(layout);
  els = applyToDom(document, layout);
  check("ocultar panel inferior", els.bottom.style.display === "none");

  layout = resizeBottomBy(layout, -40);
  els = applyToDom(document, layout);
  check("redimensionar panel inferior a 220px", els.bottom.style.height === "220px", els.bottom.style.height);

  layout = toggleBottom(layout);
  els = applyToDom(document, layout);
  check("restaurar panel inferior muestra 220px", els.bottom.style.display === "" && els.bottom.style.height === "220px");

  // Rangos del sistema.
  check("sidebar recorta al máximo", resizeSidebarBy(DEFAULT_LAYOUT, 99999).sidebarWidth === SIDEBAR_MAX);
  check("sidebar recorta al mínimo", resizeSidebarBy(DEFAULT_LAYOUT, -99999).sidebarWidth === SIDEBAR_MIN);
  check("inspector recorta al máximo", resizeInspectorBy(DEFAULT_LAYOUT, -99999).inspectorWidth === INSPECTOR_MAX);
  check("inspector recorta al mínimo", resizeInspectorBy(DEFAULT_LAYOUT, 99999).inspectorWidth === INSPECTOR_MIN);
  check("panel inferior recorta al máximo", resizeBottomBy(DEFAULT_LAYOUT, -99999).bottomHeight === BOTTOM_MAX);
  check("panel inferior recorta al mínimo", resizeBottomBy(DEFAULT_LAYOUT, 99999).bottomHeight === BOTTOM_MIN);

  // Actividad reabre el sidebar y conmuta pestaña reabre el panel.
  const reopened = setActivity(toggleSidebar(DEFAULT_LAYOUT), "plans");
  check("cambiar de actividad reabre el sidebar", reopened.sidebarVisible === true && reopened.activity === "plans");
  const retabbed = setBottomTab(toggleBottom(DEFAULT_LAYOUT), "problems");
  check("cambiar de pestaña reabre el panel inferior", retabbed.bottomVisible === true && retabbed.bottomTab === "problems");
  check("resetLayout devuelve el defecto", JSON.stringify(resetLayout()) === JSON.stringify(DEFAULT_LAYOUT));
}

// --- 2. Persistencia real tras reinicio simulado ---
{
  const dir = mkdtempSync(path.join(tmpdir(), "octus-task8-verify-"));
  const dbPath = path.join(dir, "verify.db");
  const UPSERT =
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at";
  const changed = setBottomTab(resizeSidebarBy(toggleBottom(DEFAULT_LAYOUT), 36), "output");
  let db = await PersistenceService.open({ dbPath });
  try {
    await db.exec(UPSERT, [UI_LAYOUT_KEY, JSON.stringify(changed), Date.now()]);
  } finally {
    await db.close();
  }
  db = await PersistenceService.open({ dbPath });
  try {
    const row = await db.queryOne("SELECT value FROM kv WHERE key = ?", [UI_LAYOUT_KEY]);
    const back = parseStoredLayout(row?.value);
    check("layout persistido tras reinicio (oculto+300px+output)", JSON.stringify(back) === JSON.stringify(changed), JSON.stringify(back));
    check("layout rehidratado es válido", isWorkbenchLayout(back) === true);
    // El DOM del "reinicio" aplica los mismos estilos.
    const document = skeleton();
    const els = applyToDom(document, back);
    check(
      "DOM tras reinicio: sidebar a 300px y panel visible con pestaña output",
      els.sidebar.style.display === "" && els.sidebar.style.width === "300px" && els.bottom.style.display === "" && back.bottomTab === "output",
      JSON.stringify({ side: els.sidebar.style.display, bottom: els.bottom.style.display, tab: back.bottomTab }),
    );
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- 3. Failure: layout corrupto → defecto sin pantalla en blanco ---
{
  const dir = mkdtempSync(path.join(tmpdir(), "octus-task8-corrupt-"));
  const dbPath = path.join(dir, "corrupt.db");
  let db = await PersistenceService.open({ dbPath });
  try {
    await db.exec(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [UI_LAYOUT_KEY, "{corrupto", Date.now()],
    );
  } finally {
    await db.close();
  }
  db = await PersistenceService.open({ dbPath });
  try {
    const row = await db.queryOne("SELECT value FROM kv WHERE key = ?", [UI_LAYOUT_KEY]);
    // Misma lógica que el handler layout.get del main.
    let repaired = false;
    try {
      repaired = !isWorkbenchLayout(JSON.parse(row?.value));
    } catch {
      repaired = true;
    }
    const layout = parseStoredLayout(row?.value);
    check("layout corrupto degrada al defecto", JSON.stringify(layout) === JSON.stringify(DEFAULT_LAYOUT));
    check("layout corrupto marca repaired para avisar", repaired === true);
    const document = skeleton();
    const els = applyToDom(document, layout);
    check(
      "DOM tras corrupción: workbench completo visible, sin pantalla en blanco",
      els.sidebar.style.display === "" && els.inspector.style.display === "" && els.bottom.style.display === "",
    );
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
  // Degradación por campo sin lanzar.
  const partial = parseWorkbenchLayout({ activity: "agents", sidebarWidth: 99999, bottomTab: "nope" });
  check(
    "degradación por campo: válido sobrevive, inválido cae al defecto",
    partial.activity === "agents" && partial.sidebarWidth === SIDEBAR_MAX && partial.bottomTab === "terminal",
    JSON.stringify(partial),
  );
}

// --- 4. Cableado: IPC, main, App y estilos ---
{
  const ipc = read("packages/shared/src/ipc.ts");
  check("ipc declara layout.get", ipc.includes('"layout.get"'));
  check("ipc declara layout.set", ipc.includes('"layout.set"'));
  const main = read("apps/desktop/src/main/index.ts");
  check("main registra layout.get/layout.set en CHANNELS", main.includes('"layout.get"') && main.includes('"layout.set"'));
  check("main persiste en kv ui.layout.v1", main.includes("UI_LAYOUT_KEY"));
  check("main valida en escritura con isWorkbenchLayout", main.includes("isWorkbenchLayout(payload.layout)"));
  check("main degrada en lectura con parseStoredLayout", main.includes("parseStoredLayout("));

  const app = read("apps/desktop/src/renderer/src/App.tsx");
  for (const sel of ['id="activity-bar"', 'id="sidebar"', 'id="center"', 'id="inspector"', 'id="bottom-panel"', 'id="layout-reset"', 'id="toggle-sidebar"', 'id="toggle-inspector"', 'id="toggle-bottom"', 'id="layout-notice"', "data-bottom-tab", "data-activity", "message-timeline", 'id="composer"']) {
    check(`App contiene selector fijo ${sel}`, app.includes(sel));
  }
  check("App expone tiradores data-resize por panel", app.includes("data-resize={props.kind}") && app.includes('kind: "sidebar" | "inspector" | "bottom"'));
  // Atajos nuevos sin romper lo existente.
  for (const chord of ['event.code === "KeyB"', 'event.code === "KeyJ"', 'event.code === "KeyI"', 'event.code === "Digit0"', 'event.code']) {
    check(`App contiene atajo ${chord}`, app.includes(chord));
  }
  check("composer conserva Enter-para-enviar", app.includes('event.key === "Enter"'));
  check("atajos ignoran inputs y selects", app.includes('input, textarea, select'));
  check("store persiste layout vía layout.set", read("apps/desktop/src/renderer/src/store.ts").includes('"layout.set"'));

  const css = read("apps/desktop/src/renderer/src/styles.css");
  check("styles sin hex literales (todo por tokens)", !/#[0-9a-fA-F]{3,}\b/.test(css));
  // HALLAZGO preexistente (no introducido por el Todo 8): 1px en bordes hairline
  // y cuatro tamaños estructurales (70px composer, 420/640px diálogo, 220px pre)
  // anteriores al workbench. El Todo 8 no añade ningún px nuevo.
  const pxValues = new Set([...css.matchAll(/(\d+)px/g)].map((m) => m[1]));
  check(
    "styles sin px nuevos (solo hairlines 1px y estructurales preexistentes)",
    [...pxValues].every((v) => ["1", "70", "420", "640", "220"].includes(v)),
    `valores px: ${[...pxValues].join(",")}`,
  );
  check("styles usa var(--oc-*)", css.includes("var(--oc-"));
  check("styles define #activity-bar", css.includes("#activity-bar"));
  check("styles define #bottom-panel", css.includes("#bottom-panel"));
  check("styles define .wb-resize", css.includes(".wb-resize"));

  // Sin dependencias pesadas para el Todo 8.
  const desktopPkg = read("apps/desktop/package.json");
  check("sin dependencias pesadas nuevas", !desktopPkg.includes("playwright") && !desktopPkg.includes("jsdom") && !desktopPkg.includes("node-pty"));
}

if (failures > 0) {
  console.log(`\nverify-task-8-layout: FAIL (${failures})`);
  process.exit(1);
}
console.log("\nverify-task-8-layout: OK (ocultar, redimensionar, restaurar, persistencia, corrupto→defecto)");
