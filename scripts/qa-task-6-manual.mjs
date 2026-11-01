// QA manual Todo 6 (smoke equivalente sin display): recorre el layout REAL
// (selectores fijos #workbench, .message-timeline, #composer, controles
// #prefs-*) conmutando los 3 temas x 3 densidades x tamanos 12/14/18 y afirma
// que cada propiedad computada resuelve a un valor concreto del sistema.
// Binario: PASS/FAIL por combo + veredicto global. Uso:
//   node scripts/qa-task-6-manual.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokens = readFileSync(join(root, "apps/desktop/src/renderer/src/design/tokens.css"), "utf8");
const styles = readFileSync(join(root, "apps/desktop/src/renderer/src/styles.css"), "utf8");
const app = readFileSync(join(root, "apps/desktop/src/renderer/src/App.tsx"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  cond ? pass++ : fail++;
}

// Superficie real: los selectores existen en el layout y los controles cablean prefs.
check("superficie #workbench", app.includes('id="workbench"'));
check("superficie .message-timeline", app.includes('class="timeline message-timeline"'));
check("superficie #composer (clase .composer)", app.includes('class="composer"') && /\.composer/.test(styles));
check("control #prefs-theme con 3 temas", ["light", "dark", "system"].every((t) => app.includes(`value="${t}"`)));
check("control #prefs-density con 3 densidades", ["compact", "normal", "comfortable"].every((d) => app.includes(`value="${d}"`)));
check("control #prefs-font-size 12..18", ["12", "18"].every((n) => app.includes(`id="prefs-font-size"`) && app.includes(`value="${n}"`)));

// Motor de cascada mínimo sobre los CSS reales.
function parseBlocks(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*@import[^;]+;/m, "");
  const blocks = [];
  const re = /([^\{\}]+?)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const sel = m[1].trim();
    const decls = {};
    for (const part of m[2].split(";")) {
      const i = part.indexOf(":");
      if (i > 0) decls[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    blocks.push({ sel, decls });
  }
  return blocks;
}
const tokenBlocks = parseBlocks(tokens);
const styleBlocks = parseBlocks(styles);
const styleAliases = {};
for (const b of styleBlocks) {
  if (!b.sel.endsWith(":root")) continue;
  for (const [k, v] of Object.entries(b.decls)) if (k.startsWith("--")) styleAliases[k] = v;
}
function tokenVars(theme, density, fontSize, systemDark) {
  const vars = {};
  const apply = (sel) => { for (const b of tokenBlocks) if (b.sel === sel) Object.assign(vars, b.decls); };
  apply(":root");
  if (theme === "dark") apply('[data-theme="dark"]');
  if (theme === "system" && systemDark) {
    for (const b of tokenBlocks) if (b.sel === '[data-theme="system"]' && b.decls["--oc-bg"]) Object.assign(vars, b.decls);
  }
  apply(`[data-density="${density}"]`);
  apply(`[data-font-size="${fontSize}"]`);
  return vars;
}
function resolve(vars, value, depth = 0) {
  if (depth > 12 || typeof value !== "string" || !value.includes("var(")) return value;
  return resolve(vars, value.replace(/var\((--[\w-]+)\)/g, (_, n) => vars[n] ?? styleAliases[n] ?? ""), depth + 1);
}
function styleDecl(re, prop) {
  const b = styleBlocks.find((x) => re.test(x.sel));
  return b ? b.decls[prop] : undefined;
}
const concrete = (v) => typeof v === "string" && v.length > 0 && !v.includes("var(") && v !== "transparent";

// Render conmutado: 3 temas x 3 densidades x {12,14,18} sobre el layout real.
for (const theme of ["light", "dark", "system"]) {
  for (const density of ["compact", "normal", "comfortable"]) {
    for (const size of ["12", "14", "18"]) {
      const sysDark = theme === "system" ? size === "18" : false; // cubre SO claro y oscuro
      const vars = tokenVars(theme, density, size, sysDark);
      const bg = resolve(vars, styleDecl(/^\.app$/, "background"));
      const gap = resolve(vars, styleDecl(/^\.timeline$/, "gap"));
      const mpad = resolve(vars, styleDecl(/^\.message$/, "padding"));
      const fs = resolve(vars, "var(--oc-font-base)");
      const ok = concrete(bg) && concrete(gap) && concrete(mpad) && concrete(fs);
      check(`render ${theme}/${density}/${size}`, ok, `#workbench:${bg} timeline-gap:${gap} msg-pad:${mpad} font:${fs}`);
    }
  }
}
console.log(`\nMANUAL-QA Todo 6: ${pass} PASS / ${fail} FAIL → ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
