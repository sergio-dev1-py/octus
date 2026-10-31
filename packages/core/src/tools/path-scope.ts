/**
 * @octus/core — contención de rutas con resolución real (ADR-015.4).
 * Los symlinks/junctions se resuelven ANTES de autorizar y ejecutar.
 */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { OctusError } from "../errors.js";

/**
 * Compara rutas reales con normalización previa: separadores unificados a `/`
 * y minúsculas en Windows. Sin esto, mezclar `\` y `/` rompe la contención.
 */
export function sameOrInside(rootReal: string, candidateReal: string): boolean {
  const norm = (p: string): string => {
    let out = p.replaceAll("\\", "/");
    if (process.platform === "win32") out = out.toLowerCase();
    return out.length > 1 && out.endsWith("/") ? out.slice(0, -1) : out;
  };
  const root = norm(rootReal);
  const candidate = norm(candidateReal);
  return candidate === root || candidate.startsWith(`${root}/`);
}

/** Nombres de archivo con secretos: denegados salvo el ejemplo documentado. */
export function isSecretBasename(basename: string): boolean {
  const lower = basename.toLowerCase();
  if (lower === ".env.example") return false;
  return lower === ".env" || lower.startsWith(".env.");
}

export interface ScopeOptions {
  /** Raíces internas de Octus (datos, secretos): ninguna herramienta las toca. */
  protectedRoots?: string[];
}

/**
 * Resuelve `userPath` (absoluta o relativa al scope) a ruta real y verifica
 * que queda dentro de `rootDir`. Funciona aunque el destino no exista.
 * Bloquea raíces protegidas y nombres con secretos.
 */
export function resolveInScope(rootDir: string, userPath: string, options: ScopeOptions = {}): string {
  // UNC denegadas por defecto (ADR-026): nunca entran al scope, existan o no.
  if (isUncPath(userPath)) {
    throw new OctusError("scope_violation", "UNC paths are not allowed");
  }
  const absolute = path.isAbsolute(userPath) ? path.normalize(userPath) : path.resolve(rootDir, userPath);
  let current = absolute;
  const rest: string[] = [];
  for (;;) {
    if (existsSync(current)) break;
    rest.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) throw new OctusError("scope_violation", `Path escapes scope: ${userPath}`);
    current = parent;
  }
  let realRoot: string;
  let realCurrent: string;
  try {
    realRoot = realpathSync(rootDir);
    realCurrent = realpathSync(current);
  } catch {
    throw new OctusError("scope_violation", `Cannot resolve scope for: ${userPath}`);
  }
  const full = rest.length > 0 ? path.join(realCurrent, ...rest) : realCurrent;
  if (!sameOrInside(realRoot, full)) {
    throw new OctusError("scope_violation", `Path escapes the session workspace: ${userPath}`);
  }
  for (const root of options.protectedRoots ?? []) {
    let realProtected: string;
    try {
      realProtected = realpathSync(root);
    } catch {
      continue;
    }
    if (sameOrInside(realProtected, full)) {
      throw new OctusError("scope_violation", "Path targets protected Octus data");
    }
  }
  if (isSecretBasename(path.basename(full))) {
    throw new OctusError("scope_violation", "Secret files are not readable by agents (use .env.example)");
  }
  return full;
}

/** Detecta rutas UNC (`\\server\share\…` o `//server/share/…`). */
export function isUncPath(userPath: string): boolean {
  return /^\\\\[^\\]+\\[^\\]+/.test(userPath) || /^\/\/[^/]+\/[^/]+/.test(userPath);
}

/** Ruta relativa legible para permisos y UI (siempre con `/`). */
export function scopeRelative(rootDir: string, absoluteReal: string): string {
  const rel = path.relative(rootDir, absoluteReal).replaceAll("\\", "/");
  return rel === "" ? "." : rel;
}
