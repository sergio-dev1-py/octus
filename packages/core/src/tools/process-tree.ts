/**
 * @octus/core — árbol de procesos y entorno depurado (extraído de tool-definitions, sin cambios).
 * Lo usan la herramienta shell (ADR-018) y el PreviewManager (Etapa 5): el mismo
 * árbol-muere-con-timeout y el mismo entorno por allowlist, sin secretos.
 */
import { spawn } from "node:child_process";

export const CHILD_ENV_ALLOW = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "TEMP",
  "TMP",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "OS",
  "COMSPEC",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]);

/** Entorno hijo: solo la allowlist mínima. Jamás hereda el entorno completo ni secretos. */
export function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && CHILD_ENV_ALLOW.has(key)) out[key] = value;
  }
  return out;
}

/** Termina el árbol de procesos (Windows taskkill /T /F; POSIX grupo de procesos). */
export function killTree(childPid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/T", "/F", "/PID", String(childPid)], { stdio: "ignore", windowsHide: true });
    } catch {
      // ignore
    }
    return;
  }
  try {
    process.kill(-childPid, "SIGKILL");
  } catch {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      // ignore
    }
  }
}

/** true si el pid sigue vivo (señal 0). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
