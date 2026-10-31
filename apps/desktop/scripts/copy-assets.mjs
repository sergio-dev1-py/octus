/**
 * Copia activos sin transpilar junto al main empaquetado:
 * - worker SQLite (store-worker.mjs)
 * - definiciones de agentes YAML (definitions/)
 * En dev se usan los archivos en fuente; en prod, estas copias.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoCore = path.resolve(here, "..", "..", "..", "packages", "core", "src");
const targetDir = path.resolve(here, "..", "out", "main");

const workerSource = path.join(repoCore, "persistence", "store-worker.mjs");
if (!existsSync(workerSource)) {
  console.error(`[copy-assets] missing source: ${workerSource}`);
  process.exit(1);
}
mkdirSync(targetDir, { recursive: true });
copyFileSync(workerSource, path.join(targetDir, "store-worker.mjs"));
console.log(`[copy-assets] worker -> ${path.join(targetDir, "store-worker.mjs")}`);

const defsSource = path.join(repoCore, "agents", "definitions");
const defsTarget = path.join(targetDir, "definitions");
if (!existsSync(defsSource)) {
  console.error(`[copy-assets] missing source: ${defsSource}`);
  process.exit(1);
}
mkdirSync(defsTarget, { recursive: true });
for (const file of readdirSync(defsSource).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))) {
  copyFileSync(path.join(defsSource, file), path.join(defsTarget, file));
}
console.log(`[copy-assets] definitions -> ${defsTarget}`);
