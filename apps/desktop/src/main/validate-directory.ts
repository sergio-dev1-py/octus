/**
 * Octus desktop — validación de carpetas en el proceso principal (Todo 10).
 * Módulo puro (sin electron): el renderer nunca toca el filesystem; propone
 * una ruta (drop o selector nativo) y main la valida aquí antes de crear nada.
 */
import fs from "node:fs";

export type DirectoryCheck =
  | { ok: true; realPath: string }
  | { ok: false; error: "empty" | "not-found" | "not-directory" | "unreadable" };

export function checkDirectoryReadable(input: string): DirectoryCheck {
  const path = input.trim();
  if (path.length === 0) return { ok: false, error: "empty" };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, error: "not-found" };
    if (code === "EACCES" || code === "EPERM") return { ok: false, error: "unreadable" };
    return { ok: false, error: "unreadable" };
  }
  if (!stat.isDirectory()) return { ok: false, error: "not-directory" };
  try {
    fs.accessSync(path, fs.constants.R_OK);
  } catch {
    return { ok: false, error: "unreadable" };
  }
  try {
    return { ok: true, realPath: fs.realpathSync(path) };
  } catch {
    return { ok: true, realPath: path };
  }
}

const MESSAGES: Record<Exclude<DirectoryCheck, { ok: true }>["error"], string> = {
  empty: "No se recibió ninguna carpeta (soltado vacío).",
  "not-found": "La carpeta no existe.",
  "not-directory": "La ruta no es una carpeta.",
  unreadable: "La carpeta no tiene permiso de lectura.",
};

export function directoryErrorMessage(check: Extract<DirectoryCheck, { ok: false }>): string {
  return MESSAGES[check.error];
}
