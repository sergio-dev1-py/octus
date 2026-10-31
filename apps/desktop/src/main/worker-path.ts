/**
 * Octus desktop — localización del worker SQLite empaquetado o en fuente (dev).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveWorkerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.join(here, "store-worker.mjs");
  if (existsSync(bundled)) return bundled;
  // Dev: el main compilado corre desde apps/desktop/out/main; el worker vive en packages/core.
  const fromSource = path.resolve(here, "..", "..", "..", "..", "packages", "core", "src", "persistence", "store-worker.mjs");
  if (existsSync(fromSource)) return fromSource;
  throw new Error(`SQLite worker not found (looked in ${bundled} and ${fromSource})`);
}

export function resolveDefinitionsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.join(here, "definitions");
  if (existsSync(bundled)) return bundled;
  const fromSource = path.resolve(here, "..", "..", "..", "..", "packages", "core", "src", "agents", "definitions");
  if (existsSync(fromSource)) return fromSource;
  throw new Error(`Agent definitions not found (looked in ${bundled} and ${fromSource})`);
}
