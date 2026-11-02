/**
 * Verificación Todo 16 — vista de agentes, tareas, runs y worktrees (sin display).
 * Uso: bun scripts/verify-task-16-agents.mjs (exit 0 = todo PASS).
 * 1) Semántica del DAG reutilizada: importa task-graph.ts REAL del core con el
 *    fixture del Todo 15 y afirma adyacencia, ciclo, ready-gate y orden.
 * 2) Cableado en fuentes: la vista usa canales IPC existentes, no inventa
 *    progreso (sin Math.random ni progreso congelado) y expone #agent-dag.
 * 3) Sistema de diseño: #agent-dag y la vista solo usan var(--oc-*) / alias.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const R = join(root, "apps/desktop/src/renderer/src");
let failures = 0;
let total = 0;
const check = (name, cond, detail = "") => {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const graph = await import(join(root, "packages/core/src/tasks/task-graph.ts"));

// Fixture del Todo 15: explorer -> implementer -> reviewer + researcher en paralelo.
const tasks = [
  { id: "tsk_explore", status: "reviewed", needsReview: true },
  { id: "tsk_impl", status: "running", needsReview: true },
  { id: "tsk_review", status: "draft", needsReview: true },
  { id: "tsk_research", status: "completed", needsReview: false },
];
const deps = [
  { taskId: "tsk_impl", dependsOn: "tsk_explore" },
  { taskId: "tsk_review", dependsOn: "tsk_impl" },
];
const input = { tasks, deps };
const adj = graph.adjacency(input);
check("dag: adyacencia reutilizada del core", adj.get("tsk_impl")?.join() === "tsk_explore" && adj.get("tsk_review")?.join() === "tsk_impl", JSON.stringify([...adj]));
check("dag: sin ciclo en el fixture lineal", graph.detectCycle(input) === null);
check("dag: ciclo con camino explícito", JSON.stringify(graph.detectCycle({ tasks, deps: [...deps, { taskId: "tsk_explore", dependsOn: "tsk_review" }] })) === JSON.stringify(["tsk_explore", "tsk_review", "tsk_impl", "tsk_explore"]));
check("dag: ready-gate exige reviewed con needsReview", graph.isDependencySatisfied("completed", true) === false && graph.isDependencySatisfied("reviewed", true) === true && graph.isDependencySatisfied("completed", false) === true);
check("dag: insatisfechas de tsk_review", [...graph.unsatisfiedDeps(input).get("tsk_review") ?? []].join() === "tsk_impl");
const ordered = graph.orderTasks([
  { id: "c", priority: 1, createdAt: 3, status: "draft" },
  { id: "a", priority: 3, createdAt: 1, status: "draft" },
  { id: "b", priority: 3, createdAt: 2, status: "draft" },
]);
check("dag: orden prioridad desc, createdAt asc", ordered.map((t) => t.id).join() === "a,b,c", ordered.map((t) => t.id).join());

// --- Cableado en fuentes ---
const mustExist = ["views/agents.tsx", "store/runs.ts", "views/chat.tsx", "views/workbench.tsx", "App.tsx", "store.ts", "store/state.ts", "store/events.ts", "store/projects.ts", "styles.css"];
for (const f of mustExist) check(`fuente existe: ${f}`, existsSync(join(R, f)));
const agents = readFileSync(join(R, "views/agents.tsx"), "utf8");
const runs = readFileSync(join(R, "store/runs.ts"), "utf8");
const app = readFileSync(join(R, "App.tsx"), "utf8");
const css = readFileSync(join(R, "styles.css"), "utf8");
check("vista: selector #agent-dag presente", agents.includes('id="agent-dag"'));
check("vista: runs con data-run-id seleccionable", agents.includes("data-run-id"));
check("vista: worktree muestra run y tarea vinculados", agents.includes("data-worktree-run"));
check("vista: run cancelado muestra estado final real", agents.includes('data-run-final="cancelled"') && agents.includes("estado final real"));
check("vista: sin progreso inventado", !agents.includes("Math.random") && !agents.includes("setInterval") && !agents.includes("progreso congelado"));
check("vista: sin agentes ficticios literales", !/(ins_|tsk_|run_|wt_)qa/i.test(agents) && !/mock-agent/i.test(agents.replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|\/\/.*/g, "")));
check("store: ficha vía runs.get existente", runs.includes('invoke("runs.get"'));
check("store: sin canal nuevo (runs.get ya existía en la sonda 15)", (() => {
  const ipc = readFileSync(join(root, "packages/shared/src/ipc.ts"), "utf8");
  return ipc.includes('"runs.get"') && ipc.includes('"tasks.list"') && ipc.includes('"worktrees.list"') && ipc.includes('"agents.definitions"');
})());
check("store: runs reexportado en la fachada", readFileSync(join(R, "store.ts"), "utf8").includes("./store/runs.js"));
check("app: centro muestra AgentsView en actividad agents", app.includes("AgentsView") && app.includes('state.layout.activity === "agents"'));
check("eventos: runs refrescan la ficha", readFileSync(join(R, "store/events.ts"), "utf8").includes("refreshRunDetail"));
check("css: reglas #agent-dag presentes", css.includes("#agent-dag"));
check("css: sin literales de diseño en el bloque agents", (() => {
  const block = css.slice(css.indexOf("/* Vista de agentes"));
  const px = [...block.matchAll(/(\d+)px/g)].map((m) => Number(m[1]));
  return !/#[0-9a-fA-F]{3,6}/.test(block) && px.every((n) => n <= 1);
})());
check("tsx: sin colores ni px literales en agents.tsx", !/#[0-9a-fA-F]{3,6}/.test(agents) && !/\d+px/.test(agents));
check("alcance: el diff sigue fuera (Todo 17)", !agents.toLowerCase().includes("worktrees.diff") && !agents.includes("promoteIntegration"));

console.log(`verify-task-16-agents: ${total - failures}/${total} OK`);
process.exit(failures === 0 ? 0 : 1);
