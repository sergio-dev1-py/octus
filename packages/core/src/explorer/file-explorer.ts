/**
 * @octus/core — FileExplorer: listado paginado y lectura acotada sobre el
 * repositorio o worktree del proyecto (Todo 33). Solo lectura, sin ejecución.
 * La paginación evita bloquear la UI en proyectos grandes: el renderer pide
 * páginas fijas (máx. 200 entradas) y el árbol nunca carga el proyecto entero.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { OctusError } from "../errors.js";
import { isUncPath, sameOrInside } from "../tools/path-scope.js";

export interface FileEntry {
  name: string;
  relPath: string;
  kind: "dir" | "file";
  size?: number;
}

export interface FileListPage {
  rootPath: string;
  relDir: string;
  entries: FileEntry[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface FileContent {
  rootPath: string;
  relPath: string;
  content: string;
  truncated: boolean;
  size: number;
}

export const EXPLORER_MAX_PAGE_SIZE = 200;
export const EXPLORER_MAX_READ_CHARS = 20_000;

function toRelPosix(abs: string, root: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

/** Resuelve `rel` dentro de `root` o lanza scope_violation (sin escapes, sin UNC). */
export function resolveInside(rootReal: string, rel: string): string {
  if (isUncPath(rel)) throw new OctusError("scope_violation", "UNC paths are not allowed in the explorer");
  if (rel.includes("\0")) throw new OctusError("invalid_tool_args", "Invalid path");
  const abs = rel === "" || rel === "." ? rootReal : path.resolve(rootReal, rel);
  if (!sameOrInside(rootReal, abs)) {
    throw new OctusError("scope_violation", `Path escapes the project root: ${rel.slice(0, 200)}`);
  }
  return abs;
}

export function listDirPage(rootReal: string, relDir: string, page: number, pageSize: number): FileListPage {
  const size = Math.min(Math.max(1, Math.floor(pageSize) || 50), EXPLORER_MAX_PAGE_SIZE);
  const dir = resolveInside(rootReal, relDir === "" ? "" : relDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new OctusError("not_found", `Directory not found: ${(relDir || ".").slice(0, 200)}`);
  }
  names.sort((a, b) => a.localeCompare(b, "en"));
  const total = names.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const slice = names.slice((safePage - 1) * size, safePage * size);
  const entries: FileEntry[] = slice.map((name) => {
    const abs = path.join(dir, name);
    let kind: "dir" | "file" = "file";
    let entrySize: number | undefined;
    try {
      const st = statSync(abs);
      kind = st.isDirectory() ? "dir" : "file";
      if (st.isFile()) entrySize = st.size;
    } catch {
      kind = "file";
    }
    return { name, relPath: toRelPosix(abs, rootReal), kind, size: entrySize };
  });
  // Directorios primero dentro de la página (orden estable para la UI).
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "en") : a.kind === "dir" ? -1 : 1));
  return { rootPath: rootReal, relDir: relDir === "" ? "." : relDir, entries, total, page: safePage, pageSize: size, pageCount };
}

export function readFileCapped(rootReal: string, relPath: string, maxChars = EXPLORER_MAX_READ_CHARS): FileContent {
  const cap = Math.min(Math.max(1, Math.floor(maxChars) || EXPLORER_MAX_READ_CHARS), EXPLORER_MAX_READ_CHARS);
  const abs = resolveInside(rootReal, relPath);
  let buf: Buffer;
  try {
    const st = statSync(abs);
    if (!st.isFile()) throw new OctusError("invalid_tool_args", "Not a file");
    buf = readFileSync(abs);
  } catch (error) {
    if (error instanceof OctusError) throw error;
    throw new OctusError("not_found", `File not found: ${relPath.slice(0, 200)}`);
  }
  // Heurística binaria: NUL en los primeros 8 KiB → no mostrar como texto.
  if (buf.subarray(0, 8192).includes(0)) {
    throw new OctusError("invalid_tool_args", "Binary file cannot be previewed as text");
  }
  const text = buf.toString("utf8");
  const truncated = text.length > cap;
  return { rootPath: rootReal, relPath, content: truncated ? text.slice(0, cap) : text, truncated, size: buf.length };
}

export function projectRootReal(rawRoot: string): string {
  if (isUncPath(rawRoot)) throw new OctusError("scope_violation", "UNC paths are not allowed");
  try {
    // realpathSync resuelve symlinks: el root canónico fija la contención.
    return realpathSync(rawRoot);
  } catch {
    if (!existsSync(rawRoot)) throw new OctusError("not_found", "Project directory does not exist");
    throw new OctusError("tool_failed", "Project directory is not readable");
  }
}

export { existsSync };
