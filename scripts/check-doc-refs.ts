#!/usr/bin/env bun
/**
 * check-doc-refs.ts
 * Todo 1 del plan octus-ux-skills-mcp: vigila la cuarentena documental.
 *
 * Afirma cero referencias de integracion a modulos inexistentes:
 *  1. Cada modulo fantasma listado en GHOSTS sigue ausente del arbol.
 *  2. Ningun .ts de packages o apps importa una ruta fantasma.
 *  3. Ningun .md fuera de .harness/ (historia permitida) cita una ruta
 *     fantasma como si existiera. QUARANTINE.md y TREE_AUTHORITY.md viven
 *     dentro de .harness y son la excepcion declarada.
 *  4. Cada ancla de TREE_AUTHORITY.md sigue en su sitio y
 *     packages/core/package.json sigue sin SDK MCP ni node-pty.
 *
 * Uso: bun scripts/check-doc-refs.ts   (exit 0 = todo en orden)
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const failures: string[] = [];

// Rutas fantasma: existen en los documentos de linaje (OpenOrch), no en Octus.
const GHOSTS = [
  "packages/core/src/engine.ts",
  "packages/core/src/mcp.ts",
  "packages/core/src/skills.ts",
  "packages/core/src/codemode.ts",
  "packages/core/src/tools/browser.ts",
  "packages/core/src/mcp-auth",
];

// Anclas que TREE_AUTHORITY.md declara como existentes.
const ANCHORS = [
  "packages/core/src/runtime/agent-runtime.ts",
  "packages/core/src/tools/tool-gateway.ts",
  "packages/core/src/permissions/permission-manager.ts",
  "packages/core/src/runtime/context-builder.ts",
  "packages/core/src/orchestration/agent-manager.ts",
  "packages/core/src/tasks/task-scheduler.ts",
  "packages/core/src/persistence/persistence-service.ts",
  "packages/core/src/secrets/secret-store.ts",
  "packages/shared/src/events.ts",
  "packages/shared/src/ipc.ts",
  "apps/desktop/src/main/secret-store.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === ".data" || entry === "out" || entry === "dist") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function toPosix(p: string): string {
  return relative(ROOT, p).split(sep).join("/");
}

// 1. Fantasmas ausentes.
for (const g of GHOSTS) {
  if (existsSync(join(ROOT, g))) {
    failures.push(`GHOST-PRESENT: ${g} ahora existe; actualiza QUARANTINE.md antes de seguir.`);
  }
}

// 2 y 3. Barrido de referencias.
const files = walk(ROOT);
for (const f of files) {
  const rel = toPosix(f);
  if (!rel.endsWith(".ts") && !rel.endsWith(".md")) continue;
  if (rel.endsWith("check-doc-refs.ts")) continue;
  const inHarness = rel.startsWith(".harness/");
  const inEvidence = rel.startsWith(".omo/evidence/");
  let text: string;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  for (const g of GHOSTS) {
    if (!text.includes(g)) continue;
    if (rel.endsWith(".ts") && (rel.startsWith("packages/") || rel.startsWith("apps/"))) {
      failures.push(`CODE-REF: ${rel} cita ${g}, que no existe.`);
    } else if (rel.endsWith(".md") && !inHarness && !inEvidence) {
      failures.push(`DOC-REF: ${rel} cita ${g} fuera de .harness como referencia viva.`);
    }
  }
}

// 4. Anclas presentes.
for (const a of ANCHORS) {
  if (!existsSync(join(ROOT, a))) failures.push(`ANCHOR-MISSING: ${a} ya no esta en el arbol; revisa TREE_AUTHORITY.md.`);
}

// 4b. Sin SDK MCP ni node-pty en packages/core.
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, "packages/core/package.json"), "utf8"));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const banned = Object.keys(deps).filter((d) => /mcp/i.test(d) || d === "node-pty" || d === "@lydell/node-pty");
  if (banned.length > 0) failures.push(`DEPS: packages/core declara dependencia nueva ligada a cuarentena: ${banned.join(", ")}.`);
} catch (e) {
  failures.push(`DEPS: no se pudo leer packages/core/package.json (${e}).`);
}

if (failures.length > 0) {
  console.error(`check-doc-refs: FAIL (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`check-doc-refs: OK (fantasmas ausentes: ${GHOSTS.length}, anclas presentes: ${ANCHORS.length}, archivos barridos: ${files.length})`);
