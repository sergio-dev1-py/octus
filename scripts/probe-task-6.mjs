// Sonda Todo 6 — Node sin dependencias: afirma que el sistema del Todo 3 está
// aplicado en el renderer real (selectores fijos #workbench/.message-timeline),
// que styles.css no duplica valores fuera de tokens y que prefs.get/prefs.set
// persisten en kv ui.prefs.v1. Uso: node scripts/probe-task-6.mjs
// Exit 0 = todo verde; exit 1 = fallo.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokensPath = join(root, "apps/desktop/src/renderer/src/design/tokens.css");
const stylesPath = join(root, "apps/desktop/src/renderer/src/styles.css");
const appPath = join(root, "apps/desktop/src/renderer/src/App.tsx");
const storePath = join(root, "apps/desktop/src/renderer/src/store.ts");
const prefsRendererPath = join(root, "apps/desktop/src/renderer/src/prefs.ts");
const prefsSharedPath = join(root, "packages/shared/src/prefs.ts");
const ipcPath = join(root, "packages/shared/src/ipc.ts");
const mainPath = join(root, "apps/desktop/src/main/index.ts");

let failures = 0;
function assert(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

const tokens = readFileSync(tokensPath, "utf8");
const styles = readFileSync(stylesPath, "utf8");
const app = readFileSync(appPath, "utf8");
const store = readFileSync(storePath, "utf8");
const prefsRenderer = readFileSync(prefsRendererPath, "utf8");
const prefsShared = readFileSync(prefsSharedPath, "utf8");
const ipc = readFileSync(ipcPath, "utf8");
const main = readFileSync(mainPath, "utf8");

// 1. styles.css importa tokens y no redefine valores
assert("styles.css importa design/tokens.css", styles.includes('@import "./design/tokens.css"'));
const stylesNoComments = styles.replace(/\/\*[\s\S]*?\*\//g, "");
assert("styles.css sin colores hex literales", !/#[0-9a-fA-F]{3,8}\b/.test(stylesNoComments));
assert("styles.css sin font-size en px", !/font-size\s*:\s*\d+px/.test(stylesNoComments));
const spacingProps = [...stylesNoComments.matchAll(/(padding|margin|gap|border-radius)\s*:\s*([^;]+);/g)];
const spacingBad = spacingProps.filter((m) => /(^|\s)\d+px/.test(m[2]) && !/var\(--oc-/.test(m[2]));
assert("espaciado/radio solo con var(--oc-*)", spacingBad.length === 0, spacingBad.slice(0, 3).map((m) => m[0]).join(" | "));

// 2. Selectores fijos del Todo 3 sobre el layout real
assert('#workbench en el layout real', app.includes('id="workbench"'));
assert('.message-timeline sobre el timeline real', app.includes('message-timeline'));
assert('selectores fijos de preferencias', app.includes('id="prefs-theme"') && app.includes('id="prefs-density"') && app.includes('id="prefs-font-size"'));
assert('store aplica data-theme/density/font-size', store.includes("applyUiPrefs") && prefsRenderer.includes("root.dataset.theme") && prefsRenderer.includes("root.dataset.density") && prefsRenderer.includes("root.dataset.fontSize"));
assert('store carga prefs en initStore', /initStore[\s\S]*?loadUiPrefs/.test(store));
assert('tamano 12..18 ofrecido', ["12", "13", "14", "15", "16", "17", "18"].every((n) => app.includes(`value="${n}"`)));

// 3. Contrato C-01: canales IPC + kv ui.prefs.v1
assert('canal prefs.get en ipc.ts', ipc.includes('"prefs.get"'));
assert('canal prefs.set en ipc.ts', ipc.includes('"prefs.set"'));
assert('clave ui.prefs.v1 en shared', prefsShared.includes('ui.prefs.v1'));
assert('main registra prefs.get/prefs.set', main.includes('"prefs.get"') && main.includes('"prefs.set"'));
assert('main lee kv con degradación', main.includes("parseStoredUiPrefs"));
assert('main valida escritura estricta', main.includes("isUiPrefs(payload.prefs)"));
assert('shared exporta prefs', readFileSync(join(root, "packages/shared/src/index.ts"), "utf8").includes("./prefs.js"));

// 4. Cascada simulada: resuelve var() para combinaciones tema/densidad/tamano
function parseBlocks(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  const re = /([^\{\}]+?)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const sel = m[1].trim().replace(/^@media[^{]*\{/, "").trim();
    const decls = {};
    for (const part of m[2].split(";")) {
      const i = part.indexOf(":");
      if (i > 0) decls[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    blocks.push({ sel, decls });
  }
  return blocks;
}
function resolveVar(vars, value, depth = 0) {
  if (depth > 10 || typeof value !== "string") return value;
  return value.replace(/var\((--[\w-]+)\)/g, (_, name) => resolveVar(vars, vars[name] ?? "", depth + 1));
}
function computeVars(theme, density, fontSize, systemDark) {
  const vars = {};
  const blocks = parseBlocks(tokens);
  const apply = (sel) => {
    for (const b of blocks) if (b.sel === sel) Object.assign(vars, b.decls);
  };
  apply(":root");
  if (theme === "dark") apply('[data-theme="dark"]');
  if (theme === "system" && systemDark) {
    // reglas dentro de @media que redefinen [data-theme="system"]: el parser
    // plano las captura como selector con el mismo nombre tras el strip.
    for (const b of blocks) {
      if (b.sel === '[data-theme="system"]' && b.decls["--oc-bg"]) Object.assign(vars, b.decls);
    }
  }
  apply(`[data-density="${density}"]`);
  apply(`[data-font-size="${fontSize}"]`);
  return vars;
}
const combos = [
  ["light", "normal", "14", false, "#f6f5f2", "14px", "12px"],
  ["dark", "compact", "12", false, "#1b1a17", "12px", "8px"],
  ["system", "comfortable", "18", true, "#1b1a17", "18px", "16px"],
  ["system", "normal", "14", false, "#f6f5f2", "14px", "12px"],
];
for (const [theme, density, size, sysDark, bg, fs, pad] of combos) {
  const vars = computeVars(theme, density, size, sysDark);
  const gotBg = resolveVar(vars, "var(--oc-bg)");
  const gotFs = resolveVar(vars, "var(--oc-font-base)");
  const gotPad = resolveVar(vars, "var(--oc-pad)");
  assert(`cascada ${theme}/${density}/${size}: bg`, gotBg === bg, `got ${gotBg}`);
  assert(`cascada ${theme}/${density}/${size}: font`, gotFs === fs, `got ${gotFs}`);
  assert(`cascada ${theme}/${density}/${size}: pad`, gotPad === pad, `got ${gotPad}`);
}

// 5. Las reglas reales usan variables en los selectores fijos
assert('#workbench usa var(--oc-bg)', /\.app\s*\{[^}]*background:\s*var\(--bg\)/.test(stylesNoComments) && /--bg:\s*var\(--oc-bg\)/.test(stylesNoComments));
assert('.timeline usa gap de densidad', /\.timeline\s*\{[^}]*gap:\s*var\(--oc-gap\)/.test(stylesNoComments));
assert('.message usa padding de densidad', /\.message\s*\{[^}]*padding:\s*var\(--oc-message-pad\)/.test(stylesNoComments));

console.log(failures === 0 ? "SONDA OK" : `SONDA FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
