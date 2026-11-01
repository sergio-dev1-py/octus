// Sonda Todo 3 — Node sin dependencias: afirma tokens, temas, densidades y
// ausencia de literales fuera de tokens. Uso: node scripts/probe-task-3.mjs
// Exit 0 = todo verde; exit 1 = fallo (lista el primero que falla y sigue).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokensPath = join(root, "apps/desktop/src/renderer/src/design/tokens.css");
const compPath = join(root, "apps/desktop/src/renderer/src/design/components.css");
const protoPath = join(root, "apps/desktop/src/renderer/src/design/prototypes.html");
const ptyPath = join(root, "apps/desktop/src/renderer/src/design/pty-weight-note.md");

let failures = 0;
function assert(name, cond, detail = "") {
  const mark = cond ? "PASS" : "FAIL";
  console.log(`${mark} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

const tokens = readFileSync(tokensPath, "utf8");
const comps = readFileSync(compPath, "utf8");
const proto = readFileSync(protoPath, "utf8");
const pty = readFileSync(ptyPath, "utf8");

// 1. Variables exigidas presentes en tokens.css
const requiredVars = [
  "--oc-bg", "--oc-bg-raised", "--oc-panel", "--oc-panel-sunken",
  "--oc-border", "--oc-border-strong", "--oc-text", "--oc-text-muted", "--oc-text-faint",
  "--oc-accent", "--oc-accent-ink", "--oc-accent-wash", "--oc-accent-border",
  "--oc-success", "--oc-success-wash", "--oc-warning", "--oc-warning-wash",
  "--oc-danger", "--oc-danger-wash", "--oc-info", "--oc-info-wash",
  "--oc-text-xs", "--oc-text-sm", "--oc-text-base", "--oc-text-lg", "--oc-text-xl",
  "--oc-font-base", "--oc-space-1", "--oc-space-2", "--oc-space-3", "--oc-space-4",
  "--oc-space-5", "--oc-space-6", "--oc-space-7",
  "--oc-radius-sm", "--oc-radius-md", "--oc-radius-lg", "--oc-radius-pill",
  "--oc-pad", "--oc-gap", "--oc-row-h", "--oc-message-pad",
];
for (const v of requiredVars) assert(`token ${v} definido`, tokens.includes(v));

// 2. Escala 12-18px completa
for (const px of ["12", "13", "14", "15", "16", "17", "18"]) {
  assert(`tamano base ${px}px`, new RegExp(`--oc-text-(xs|sm|base|lg|xl):\\s*1[268][px]|\\[data-font-size="${px}"\\]`).test(tokens) || tokens.includes(`"${px}"`));
}

// 3. Temas: claro en :root, oscuro explicito, sistema con media query
assert("tema claro en :root", /:root\s*{[^}]*--oc-bg:\s*#f6f5f2/.test(tokens));
assert("tema oscuro [data-theme=dark]", /\[data-theme="dark"\]\s*{[^}]*--oc-bg:\s*#1b1a17/.test(tokens));
assert("tema sistema con prefers-color-scheme", tokens.includes('[data-theme="system"]') && tokens.includes("@media (prefers-color-scheme: dark)"));
assert("color-scheme declarado", tokens.includes("color-scheme: light") && tokens.includes("color-scheme: dark"));

// 4. Tres densidades redefinen pad/gap/mensaje
for (const d of ["compact", "normal", "comfortable"]) {
  assert(`densidad ${d}`, new RegExp(`\\[data-density="${d}"\\]\\s*{[^}]*--oc-pad`).test(tokens));
}

// 5. Simulacion de cascada: resuelve var() por combinacion tema/densidad/tamano
function parseBlocks(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  const re = /(@media[^{]+\{)?\s*([^\{\}]+?)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const media = m[1] ? m[1].trim() : null;
    const sel = m[2].trim();
    const decls = {};
    for (const part of m[3].split(";")) {
      const i = part.indexOf(":");
      if (i > 0) decls[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    blocks.push({ media, sel, decls });
  }
  return blocks;
}
function resolve(blocks, theme, density, fontSize, darkMedia) {
  const vars = {};
  const apply = (decls) => Object.assign(vars, decls);
  for (const b of blocks) {
    if (b.sel === ":root") apply(b.decls);
    else if (b.sel === `[data-theme="${theme}"]` && !b.media) apply(b.decls);
    else if (b.sel === `[data-density="${density}"]`) apply(b.decls);
    else if (b.sel === `[data-font-size="${fontSize}"]`) apply(b.decls);
    else if (b.media && b.media.includes("prefers-color-scheme: dark") && theme === "system" && darkMedia && b.sel === '[data-theme="system"]') apply(b.decls);
  }
  const seen = new Set();
  const expand = (v) => {
    let out = v;
    for (let i = 0; i < 8 && out.includes("var("); i++) {
      out = out.replace(/var\((--[a-z0-9-]+)\)/g, (_, n) => (seen.has(n) ? "" : (seen.add(n), vars[n] ?? "")));
    }
    return out;
  };
  const out = {};
  for (const [k, v] of Object.entries(vars)) {
    seen.clear();
    out[k] = expand(v);
  }
  return out;
}
const blocks = parseBlocks(tokens);
const combos = [
  ["light", "normal", "14", false, "#f6f5f2", "14px", "12px"],
  ["dark", "compact", "12", false, "#1b1a17", "12px", "8px"],
  ["system", "comfortable", "18", true, "#1b1a17", "18px", "16px"],
  ["system", "normal", "14", false, "#f6f5f2", "14px", "12px"],
];
for (const [theme, density, fs, darkMedia, bg, font, pad] of combos) {
  const r = resolve(blocks, theme, density, fs, darkMedia);
  assert(`cascada ${theme}/${density}/${fs}px fondo`, r["--oc-bg"] === bg, `obtenido ${r["--oc-bg"]}`);
  assert(`cascada ${theme}/${density}/${fs}px fuente`, r["--oc-font-base"] === font, `obtenido ${r["--oc-font-base"]}`);
  assert(`cascada ${theme}/${density}/${fs}px pad`, r["--oc-pad"] === pad, `obtenido ${r["--oc-pad"]}`);
}

// 6. Los selectores fijos aplican tema y densidad (usan tokens, no literales)
const styleBlock = (proto.match(/<style>([\s\S]*)<\/style>/) || ["", ""])[1];
for (const sel of ["#workbench", ".message-timeline"]) {
  assert(`prototipo contiene ${sel}`, proto.includes(sel));
}
assert("#workbench aplica fondo del tema", /#workbench\s*{[^}]*background:\s*var\(--oc-bg\)/.test(styleBlock));
assert(".message-timeline aplica densidad", /\.message-timeline\s*{[^}]*gap:\s*var\(--oc-gap\)/.test(styleBlock) && /\.message-timeline\s*{[^}]*padding:\s*var\(--oc-pad\)/.test(styleBlock));
assert("prototipo tiene #welcome-dropzone", proto.includes('id="welcome-dropzone"'));
assert("prototipo tiene #composer", proto.includes('id="composer"'));
assert("prototipo tiene #agent-dag", proto.includes('id="agent-dag"'));
for (const s of ["screen-welcome", "screen-workbench", "screen-agents", "screen-skills", "screen-mcp"]) {
  assert(`pantalla ${s}`, proto.includes(`id="${s}"`));
}
assert("prototipo conmuta tema/densidad/tamano", proto.includes('data-theme') && proto.includes('data-density') && proto.includes('data-font-size'));

// 7. Sin valores literales fuera de tokens (components.css + <style> del prototipo)
const outside = comps + "\n" + styleBlock;
assert("sin colores hex fuera de tokens", !/#[0-9a-fA-F]{3,8}\b/.test(outside));
assert("sin rgb()/hsl() fuera de tokens", !/\brgba?\(|\bhsla?\(/.test(outside));
assert("sin font-size px fuera de tokens", !/font-size:\s*\d+px/.test(outside));

// 8. Restricciones: sin emojis, sin identidad ajena
const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
for (const [n, c] of [["tokens", tokens], ["componentes", comps], ["prototipos", proto]]) {
  assert(`sin emojis en ${n}`, !emoji.test(c));
}
assert("sin identidad VS Code", !/vs\s?code/i.test(tokens + comps + proto));

// 9. Nota PTY con cifras y decision
assert("nota PTY existe con cifras", pty.includes("64 363 742") || pty.includes("64363742") || pty.includes("61,4"));
assert("nota PTY cita version medida", pty.includes("1.1.0"));
assert("nota PTY confirma o refuta PTY-directo", /PTY-directo (CONFIRMADO|REFUTADO)/.test(pty));

console.log(failures === 0 ? "\nSONDA OK: todas las afirmaciones en verde" : `\nSONDA ROJA: ${failures} fallos`);
process.exit(failures === 0 ? 0 : 1);
