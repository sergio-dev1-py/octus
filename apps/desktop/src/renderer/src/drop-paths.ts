/** Renderer — rutas propuestas por un drop (puro, sin DOM ni Solid).
 * Extraido de views/welcome.tsx sin cambiar comportamiento: las carpetas
 * vacias llegan con dataTransfer.files vacio en Chromium/Electron y se
 * aceptan via los items (getAsFile conserva el path absoluto,
 * webkitGetAsEntry confirma directorios). "soltado vacio" solo cuando de
 * verdad no hay ruta.
 */
export function pathsFromDrop(event: DragEvent): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  const pushPath = (candidate: unknown): void => {
    if (typeof candidate === "string" && candidate.length > 0 && !seen.has(candidate)) {
      seen.add(candidate);
      paths.push(candidate);
    }
  };
  for (const file of Array.from(event.dataTransfer?.files ?? [])) {
    pushPath((file as unknown as { path?: unknown }).path);
  }
  if (paths.length > 0) return paths;
  for (const item of Array.from(event.dataTransfer?.items ?? [])) {
    try {
      const fromFile = (typeof item.getAsFile === "function" ? item.getAsFile() : null) as unknown as {
        path?: unknown;
      } | null;
      if (fromFile && typeof fromFile.path === "string" && fromFile.path.length > 0) {
        pushPath(fromFile.path);
        continue;
      }
    } catch {
      // Un item ilegible no invalida el resto: se sigue con el siguiente.
    }
    try {
      const entry = (
        item as unknown as { webkitGetAsEntry?: () => unknown }
      ).webkitGetAsEntry?.call(item) as
        | { isDirectory?: unknown; isFile?: unknown; fullPath?: unknown; name?: unknown }
        | null
        | undefined;
      if (entry && (entry.isDirectory === true || entry.isFile === true)) {
        // webkitGetAsEntry da rutas relativas; solo sirve si ya es absoluta.
        if (typeof entry.fullPath === "string" && /^[A-Za-z]:[\\/]|^\\\\|^\//.test(entry.fullPath)) {
          pushPath(entry.fullPath);
        } else if (typeof entry.name === "string" && /^[A-Za-z]:[\\/]|^\\\\|^\//.test(entry.name)) {
          pushPath(entry.name);
        }
      }
    } catch {
      // Items sin entrada legible se ignoran.
    }
  }
  return paths;
}
