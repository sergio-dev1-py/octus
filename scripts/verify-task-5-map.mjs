#!/usr/bin/env node
/**
 * verify-task-5-map.mjs
 * Todo 5 del plan octus-ux-skills-mcp: verifica la integridad del mapa.
 *
 * Afirma:
 *  1. Cada contrato C-01..C-14 trae productor, consumidor, canal y
 *     persistencia no vacios (contrato incompleto = rechazo, exit != 0).
 *  2. La matriz cubre las 29 herramientas del gateway con efecto base y
 *     al menos un scope; los 5 scopes (P,S,R,T,I) aparecen en la matriz.
 *  3. El presupuesto trae cifras (valores numericos > 0).
 *  4. El documento de diseno no cita rutas fantasma en cuarentena.
 *
 * Uso: node scripts/verify-task-5-map.mjs   (exit 0 = mapa integro)
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

const mapPath = join(ROOT, "scripts", "task-5-map.json");
if (!existsSync(mapPath)) {
  console.error("verify-task-5-map: FAIL (falta scripts/task-5-map.json)");
  process.exit(1);
}
const map = JSON.parse(readFileSync(mapPath, "utf8"));

// 1. Contratos completos.
const fields = ["producer", "consumer", "channel", "persistence"];
let complete = 0;
for (const c of map.contracts ?? []) {
  const missing = fields.filter((f) => typeof c[f] !== "string" || c[f].trim().length === 0);
  if (!c.id || !c.name) {
    failures.push("CONTRACT-NO-ID: entrada sin id o nombre.");
    continue;
  }
  if (missing.length > 0) {
    failures.push("CONTRACT-INCOMPLETE: " + c.id + " (" + (c.name || "?") + ") sin " + missing.join(", "));
  } else {
    complete++;
  }
}
notes.push("contratos completos: " + complete + "/" + (map.contracts ?? []).length);

// 2. Matriz: herramientas y scopes.
const EXPECTED_TOOLS = [
  "read", "glob", "grep", "write", "edit", "shell", "question",
  "git_status", "git_diff", "git_stage", "git_commit",
  "websearch", "webfetch", "test_run", "delegate",
  "agent_status", "agent_message", "agent_wait", "agent_result", "agent_cancel",
  "plan.create", "plan.update", "plan.get", "plan.list", "plan.request_approval",
  "plan_tasks", "record_review", "memory_propose", "memory_validate",
];
const byName = new Map((map.tools ?? []).map((t) => [t.name, t]));
for (const name of EXPECTED_TOOLS) {
  const row = byName.get(name);
  if (!row) {
    failures.push("MATRIX-MISSING-TOOL: " + name + " sin fila en la matriz.");
    continue;
  }
  if (!["allow", "ask", "deny"].includes(row.effect)) {
    failures.push("MATRIX-NO-EFFECT: " + name + " sin efecto base valido.");
  }
  if (!Array.isArray(row.scopes) || row.scopes.length === 0) {
    failures.push("MATRIX-NO-SCOPE: " + name + " sin scopes.");
  }
}
notes.push("herramientas en matriz: " + byName.size + "/" + EXPECTED_TOOLS.length);
const covered = new Set();
for (const t of map.tools ?? []) for (const s of t.scopes ?? []) covered.add(s);
for (const s of map.scopes ?? []) {
  if (!covered.has(s)) failures.push("MATRIX-UNCOVERED-SCOPE: scope " + s + " sin herramienta.");
}
notes.push("scopes cubiertos: " + [...covered].sort().join(","));

// 3. Presupuesto con cifras.
let budgets = 0;
for (const b of map.budgets ?? []) {
  if (typeof b.value !== "number" || !(b.value > 0)) {
    failures.push("BUDGET-NO-FIGURE: " + (b.dimension || "?") + " sin cifra.");
  } else {
    budgets++;
  }
}
notes.push("presupuestos con cifra: " + budgets + "/" + (map.budgets ?? []).length);

// 4. Sin rutas fantasma en el documento de diseno.
const GHOSTS = [
  "packages/core/src/engine.ts",
  "packages/core/src/mcp.ts",
  "packages/core/src/skills.ts",
  "packages/core/src/codemode.ts",
  "packages/core/src/tools/browser.ts",
  "packages/core/src/mcp-auth",
];
const docPath = join(ROOT, ".omo", "design", "octus-ux-skills-mcp", "task-5-contracts.md");
if (!existsSync(docPath)) {
  failures.push("DOC-MISSING: falta .omo/design/octus-ux-skills-mcp/task-5-contracts.md.");
} else {
  const doc = readFileSync(docPath, "utf8");
  for (const g of GHOSTS) {
    if (doc.includes(g)) failures.push("DOC-GHOST-REF: el diseno cita " + g + " como ruta viva.");
  }
  if (!doc.includes("C-01") || !doc.includes("C-14")) {
    failures.push("DOC-INCOMPLETE: el diseno no cubre el rango C-01..C-14.");
  }
}

if (failures.length > 0) {
  console.error("verify-task-5-map: FAIL (" + failures.length + ")");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("verify-task-5-map: OK (" + notes.join("; ") + ")");
