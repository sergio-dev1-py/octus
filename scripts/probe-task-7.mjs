// Sonda Todo 7 — Node sin dependencias: afirma que los componentes compartidos
// del workbench viven sobre los tokens del Todo 6, cubren el alcance exigido
// (botones, dialogos, menus, iconografia monocromatica, tablas, estados vacios
// y de error) y que el gate de tokens rechaza componentes fuera del sistema.
// Uso: node scripts/probe-task-7.mjs — Exit 0 = verde; exit 1 = fallo.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ocTsx = join(root, "apps/desktop/src/renderer/src/components/oc.tsx");
const ocCss = join(root, "apps/desktop/src/renderer/src/components/oc-components.css");
const catalogTsx = join(root, "apps/desktop/src/renderer/src/components/catalog.tsx");
const stylesPath = join(root, "apps/desktop/src/renderer/src/styles.css");
const appPath = join(root, "apps/desktop/src/renderer/src/App.tsx");

let failures = 0;
let passes = 0;
function assert(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (cond) passes++;
  else failures++;
}

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const tsx = readFileSync(ocTsx, "utf8");
const css = readFileSync(ocCss, "utf8");
const catalog = readFileSync(catalogTsx, "utf8");
const styles = readFileSync(stylesPath, "utf8");
const app = readFileSync(appPath, "utf8");
const cssNc = strip(css);

/* --- escaneres reutilizables (los mismos que usa el caso failure) --- */
function scanCssViolations(text) {
  const found = [];
  const clean = strip(text);
  if (/#[0-9a-fA-F]{3,8}\b/.test(clean)) found.push("color-hex-literal");
  if (/\brgba?\(/.test(clean) || /\bhsla?\(/.test(clean)) found.push("color-func-literal");
  if (/font-size\s*:\s*\d+px/.test(clean)) found.push("font-px-literal");
  for (const m of clean.matchAll(/(padding|margin|gap|border-radius)\s*:\s*([^;]+);/g)) {
    if (/(^|\s)\d+px/.test(m[2]) && !/var\(--oc-/.test(m[2])) found.push(`spacing-px-literal:${m[0].slice(0, 40)}`);
  }
  for (const m of clean.matchAll(/var\((--[\w-]+)/g)) {
    if (!m[1].startsWith("--oc-")) found.push(`non-token-var:${m[1]}`);
  }
  return found;
}
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
function scanTsxViolations(text) {
  const found = [];
  if (EMOJI_RE.test(text)) found.push("emoji");
  if (/#[0-9a-fA-F]{3,8}\b/.test(text)) found.push("color-hex-literal");
  if (/\bdocument\.|\bwindow\.|\blocation\./.test(text)) found.push("dom-global");
  return found;
}

/* A. Cableado: archivos, import CSS y ruta aditiva del catalogo */
assert("existen oc.tsx, oc-components.css y catalog.tsx", tsx.length > 0 && css.length > 0 && catalog.length > 0);
assert("styles.css importa oc-components.css tras tokens", styles.indexOf('@import "./components/oc-components.css"') > styles.indexOf('@import "./design/tokens.css"'));
assert("App importa CatalogView", app.includes('from "./components/catalog.jsx"'));
assert("App abre catalogo solo con ?catalog=1", app.includes('get("catalog")') && app.includes('"1"'));
assert("App conserva el arbol por defecto (fallback)", app.includes('id="workbench"') && app.includes("ActivityBar") && app.includes("BottomPanel"));

/* B. CSS sobre tokens, sin literales */
assert("css sin colores hex ni funciones de color", !scanCssViolations(cssNc).some((v) => v.startsWith("color")));
assert("css sin font-size en px", !scanCssViolations(cssNc).includes("font-px-literal"));
assert(
  "css sin espaciado/radio en px",
  !scanCssViolations(cssNc).some((v) => v.startsWith("spacing")),
  scanCssViolations(cssNc).join(","),
);
assert("css solo referencia var(--oc-*)", !scanCssViolations(cssNc).some((v) => v.startsWith("non-token-var")));
assert("css sin emojis", !EMOJI_RE.test(css));

/* C. Alcance del Todo 7 en el CSS */
for (const cls of [".oc-btn--primary", ".oc-btn--secondary", ".oc-btn--danger", ".oc-btn--ghost", ".oc-dialog", ".oc-dialog-backdrop", ".oc-menu__list", ".oc-menu__item", ".oc-icon", ".oc-table", ".oc-empty", ".oc-error"]) {
  assert(`css define ${cls}`, cssNc.includes(cls));
}

/* D. TSX: SolidJS, reactividad, a11y, monocromo, sin globales */
assert("componentes importan SolidJS", tsx.includes('from "solid-js"'));
for (const hook of ["createSignal", "Show", "For"]) assert(`usa ${hook} (reactividad)`, tsx.includes(hook));
assert("sin tarjetas decorativas", !tsx.includes("oc-card") && !catalog.includes("oc-card"));
assert("TSX sin emojis ni hex ni globales DOM", scanTsxViolations(tsx).length === 0, scanTsxViolations(tsx).join(","));
assert("catalogo sin emojis ni hex ni globales DOM", scanTsxViolations(catalog).length === 0, scanTsxViolations(catalog).join(","));
assert("dialogo con role/aria-modal", tsx.includes('role="dialog"') && tsx.includes('aria-modal="true"'));
assert("menu con roles menu/menuitem", tsx.includes('role="menu"') && tsx.includes('role="menuitem"'));
assert("error con role=alert", tsx.includes('role="alert"'));
assert("iconos stroke=currentColor y fill=none", tsx.includes('stroke="currentColor"') && tsx.includes('fill="none"'));
for (const name of ["check", "x", "warn", "info", "chevron-down", "plus", "search", "folder"]) assert(`icono ${name} definido`, tsx.includes(`${name}: "M`) || tsx.includes(`"${name}": "M`));
assert("tabla con caption y th scope=col", tsx.includes("<caption") && tsx.includes('scope="col"'));

/* E. Catalogo: cada variante con selector fijo */
const requiredIds = [
  "oc-catalog", "oc-btn-primary", "oc-btn-secondary", "oc-btn-danger", "oc-btn-ghost", "oc-btn-disabled",
  "oc-dialog", "oc-dialog-ok", "oc-dialog-cancel", "oc-dialog-reopen",
  "oc-menu", "oc-menu-open", "oc-menu-item-a", "oc-menu-item-b", "oc-menu-open-item-a", "oc-menu-open-item-b",
  "oc-icons", "oc-table", "oc-table-empty", "oc-empty", "oc-error",
];
for (const id of requiredIds) assert(`catalogo fija #${id}`, catalog.includes(`"${id}"`));
// IDs derivados en oc.tsx (`${id}-sufijo`): el catalogo fija la base y el
// componente construye el sufijo; se afirma cada lado por separado.
for (const [base, suffix] of [["oc-dialog", "close"], ["oc-empty", "action"], ["oc-error", "retry"], ["oc-menu", "trigger"]]) {
  assert(`catalogo fija base #${base}`, catalog.includes(`"${base}"`));
  assert(`oc.tsx deriva ${base}-${suffix}`, tsx.includes(`\`${"$"}{props.id}-${suffix}\``));
}
assert("catalogo renderiza los 8 iconos", catalog.includes("ocIconNames()"));
assert("catalogo prueba dialogo cerrable y reabrible", catalog.includes("setDialogOpen(false)") && catalog.includes("setDialogOpen(true)"));
assert("catalogo prueba menu abierto por defecto", catalog.includes("defaultOpen"));
assert("catalogo prueba tabla con y sin filas", catalog.includes("ROWS") && catalog.includes("rows={[]}"));

/* F. Caso failure EJECUTADO: el gate rechaza componentes fuera de tokens */
const failDir = mkdtempSync(join(tmpdir(), "task7-fail-"));
try {
  writeFileSync(join(failDir, "bad.css"), ".oc-evil { color: #fff; background: rgb(255,0,0); font-size: 13px; padding: 7px; }\n");
  writeFileSync(join(failDir, "bad.tsx"), 'export const evil = "🎨";\nconst color = "#b3261e";\ndocument.title = "x";\n');
  const cssBad = scanCssViolations(readFileSync(join(failDir, "bad.css"), "utf8"));
  const tsxBad = scanTsxViolations(readFileSync(join(failDir, "bad.tsx"), "utf8"));
  assert("failure: css fuera de tokens se rechaza (4 clases)", cssBad.length >= 4, cssBad.join(","));
  assert("failure: tsx con emoji/hex/DOM se rechaza (3 clases)", tsxBad.length >= 3, tsxBad.join(","));
  assert("failure: el producto no tiene esas violaciones", scanCssViolations(cssNc).length === 0 && scanTsxViolations(tsx).length === 0);
} finally {
  rmSync(failDir, { recursive: true, force: true });
}

console.log(`\nSONDA Todo 7: ${passes} PASS / ${failures} FAIL → ${failures === 0 ? "OK" : "FAIL"}`);
process.exit(failures === 0 ? 0 : 1);
