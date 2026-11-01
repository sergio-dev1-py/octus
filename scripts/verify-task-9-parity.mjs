// Todo 9 — paridad de la modularización (App.tsx + store.ts): sin display, solo exit codes.
// PASS/FAIL por aserción: (1) API pública del store idéntica a HEAD,
// (2) mismos componentes y selectores fijos en las vistas,
// (3) cero imports circulares en renderer/src (store/ + views/).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WT = "C:/Users/UserPy/Documents/octus-wt-octus-ux-skills-mcp-w8";
const R = WT + "/apps/desktop/src/renderer/src";
let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

// 1. API pública del store: exports en HEAD vs fachada nueva
const headStore = execSync(`git -C ${WT} show HEAD:apps/desktop/src/renderer/src/store.ts`, { encoding: "utf8" });
const collectExports = (src) =>
  new Set(
    [...src.matchAll(/^export\s+(?:async\s+function|function|const|interface)\s+(\w+)|^export\s*\{\s*([^}]+?)\s*\}/gm)].flatMap((m) =>
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

// 2. Paridad de vistas: componentes y selectores
const headApp = execSync(`git -C ${WT} show HEAD:apps/desktop/src/renderer/src/App.tsx`, { encoding: "utf8" });
const headComps = new Set([...headApp.matchAll(/^function\s+(\w+)\s*\(/gm)].map((m) => m[1]));
const viewFiles = ["App.tsx", ...fs.readdirSync(R + "/views").filter((f) => f.endsWith(".tsx")).map((f) => "views/" + f)];
const viewSrc = viewFiles.map((f) => fs.readFileSync(R + "/" + f, "utf8")).join("\n");
const newComps = new Set(
  [...viewSrc.matchAll(/^export\s+function\s+(\w+)\s*\(|^export\s+default\s+function\s+(\w+)\s*\(/gm)].map((m) => m[1] ?? m[2]),
);
const missingComps = [...headComps].filter((c) => !newComps.has(c));
check("views: ningun componente de HEAD se pierde", missingComps.length === 0, missingComps.length ? "perdidos: " + missingComps.join(",") : `${headComps.size} componentes presentes`);
const idsOf = (src) => [...src.matchAll(/id="([^"]+)"/g)].map((m) => m[1]).sort();
const headIds = idsOf(headApp);
const newIds = idsOf(viewSrc);
check("views: mismos selectores id fijos", JSON.stringify(headIds) === JSON.stringify(newIds), `${headIds.length} ids en HEAD, ${newIds.length} tras partir`);
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
