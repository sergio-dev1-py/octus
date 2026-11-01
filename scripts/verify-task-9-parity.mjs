// Todo 9 — paridad de la modularización (App.tsx + store.ts): sin display, solo exit codes.
// Uso: node scripts/verify-task-9-parity.mjs (también vale bun). Exit 0 = todo PASS.
// PASS/FAIL por aserción: (1) API pública del store: superconjunto de la base,
// (2) componentes de la base presentes y sus selectores id fijos preservados (superconjunto),
// (3) cero imports circulares en renderer/src (store/ + views/).
// BASE_REF es el último commit pre-partición (todos 6-8 aterrizados); se fija por hash para que el
// chequeo sea estable en cualquier HEAD futuro (tras commitear la partición, HEAD ya es el shell
// adelgazado y compararse contra él sería vacuo). Los ids ADICIONALES respecto a la base son
// legítimos: paneles del workbench de los Todos 6-8 (sidebar, inspector, bottom, activities) y el
// gate ?catalog=1 del Todo 7, ya presentes en la base y conservados por el particionado.
// Merge ola 10 (Todo 13/14, rama feat/ux-skills-mcp-w10-chat): los ids NUEVOS del chat son
// legítimos y conservan el invariante de superconjunto (ningún id base se pierde):
// timeline (timeline-older, timeline-sentinel, timeline-bottom, cancel-notice, composer-files,
// composer-attach, composer-provider, composer-model, composer-cancel), tool calls expandibles
// (data-toolcall, data-toolcall-toggle/args/result/error/artifact), banda de errores y archivos
// (run-errors, data-error-item/retry/dismiss, modified-files, data-modified-file), aprobaciones
// con gate humano (data-approval-request/status/gate/pending) y actividad de agentes
// (agent-activity, data-agent-instance/status). Origen: commits a372092+ce0141c reubicados en
// views/chat.tsx, views/sections.tsx y toolcall-widgets.tsx sin re-monolitizar.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WT = "C:/Users/UserPy/Documents/octus-wt-octus-ux-skills-mcp-w10";
const R = WT + "/apps/desktop/src/renderer/src";
// Último commit pre-partición (base de comparación inmutable del Todo 9).
const BASE_REF = "2bc2dc9";
const atBase = (p) => execSync(`git -C ${WT} show ${BASE_REF}:${p}`, { encoding: "utf8" });
let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

// 1. API pública del store: exports de la base vs fachada nueva (superconjunto: la base no pierde nada)
const headStore = atBase("apps/desktop/src/renderer/src/store.ts");
const collectExports = (src) =>
  new Set(
    [...src.matchAll(/^export\s+(?:async\s+function|function|const|interface|type)\s+(\w+)|^export\s*(?:type\s*)?\{\s*([^}]+?)\s*\}/gm)].flatMap((m) =>
      m[1] ? [m[1]] : m[2].split(",").map((s) => s.trim()),
    ),
  );
const headExports = collectExports(headStore);
const newFiles = ["store.ts", ...fs.readdirSync(R + "/store").filter((f) => f.endsWith(".ts")).map((f) => "store/" + f)];
const newSrc = newFiles.map((f) => fs.readFileSync(R + "/" + f, "utf8")).join("\n");
const newExports = collectExports(newSrc);
const missing = [...headExports].filter((e) => !newExports.has(e));
check("store: ningun export de HEAD se pierde", missing.length === 0, missing.length ? "perdidos: " + missing.join(",") : `${headExports.size} exports de HEAD presentes`);
check("store: facade conserva la ruta ./store.js", fs.readFileSync(R + "/store.ts", "utf8").includes('export * from "./store/'));

// 2. Paridad de vistas: componentes y selectores (superconjunto sobre la base pre-partición)
const headApp = atBase("apps/desktop/src/renderer/src/App.tsx");
const headComps = new Set([...headApp.matchAll(/^function\s+(\w+)\s*\(/gm)].map((m) => m[1]));
const viewFiles = ["App.tsx", ...fs.readdirSync(R + "/views").filter((f) => f.endsWith(".tsx")).map((f) => "views/" + f)];
const viewSrc = viewFiles.map((f) => fs.readFileSync(R + "/" + f, "utf8")).join("\n");
const newComps = new Set(
  [...viewSrc.matchAll(/^export\s+function\s+(\w+)\s*\(|^export\s+default\s+function\s+(\w+)\s*\(/gm)].map((m) => m[1] ?? m[2]),
);
const missingComps = [...headComps].filter((c) => !newComps.has(c));
check("views: ningun componente de HEAD se pierde", missingComps.length === 0, missingComps.length ? "perdidos: " + missingComps.join(",") : `${headComps.size} componentes presentes`);
const idsOf = (src) => [...src.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const count = (xs) => { const m = new Map(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return m; };
const headIds = count(idsOf(headApp));
const newIds = count(idsOf(viewSrc));
const lostIds = [...headIds.entries()].filter(([id, n]) => (newIds.get(id) ?? 0) < n);
check(
  "views: ningun id fijo de la base se pierde (superconjunto)",
  lostIds.length === 0,
  lostIds.length ? "perdidos: " + lostIds.map(([id]) => id).join(",") : `${headIds.size} ids base presentes; ${newIds.size} totales tras partir`,
);
for (const needle of ['id="workbench"', 'id="composer"', 'message-timeline', 'id="layout-notice"', "CatalogView", "?catalog=1"]) {
  check(`views: marcador fijo presente (${needle})`, viewSrc.includes(needle));
}

// 3. Cero imports circulares en renderer/src
const files = [];
const walk = (d) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(f.name)) files.push(p);
  }
};
walk(R);
const rel = files.map((f) => path.relative(R, f).replace(/\\/g, "/"));
const graph = {};
for (const f of files) {
  const key = path.relative(R, f).replace(/\\/g, "/");
  graph[key] = [];
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(key), m[1].replace(/\.jsx?$/, "")));
    const hit = rel.find((k) => [base + ".ts", base + ".tsx"].includes(k));
    if (hit) graph[key].push(hit);
  }
}
const color = {};
const cycles = [];
for (const k of Object.keys(graph)) color[k] = 0;
const stack = [];
const dfs = (n) => {
  color[n] = 1;
  stack.push(n);
  for (const m of graph[n]) {
    if (color[m] === 1) cycles.push([...stack.slice(stack.indexOf(m)), m].join(" -> "));
    else if (color[m] === 0) dfs(m);
  }
  stack.pop();
  color[n] = 2;
};
for (const k of Object.keys(graph)) if (color[k] === 0) dfs(k);
check("imports: cero ciclos en renderer/src", cycles.length === 0, cycles.length ? cycles.join(" | ") : `${Object.keys(graph).length} archivos`);

console.log(failures === 0 ? "TASK-9 PARITY: ALL PASS" : `TASK-9 PARITY: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
