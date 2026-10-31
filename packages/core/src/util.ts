/** @octus/core — utilidades puras (sin dependencias de plataforma). */

export function now(): number {
  return Date.now();
}

export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Coincidencia de comodines `*` para acciones/recursos de permisos. */
export function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

/** Normaliza rutas para comparar (Windows: separadores y mayúsculas). */
export function normalizePath(p: string): string {
  const norm = p.replaceAll("\\", "/");
  return process.platform === "win32" ? norm.toLowerCase() : norm;
}

/** Backoff exponencial con jitter (ms). Intento 1-based. */
export function backoffMs(attempt: number, baseMs = 500, capMs = 30_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}
