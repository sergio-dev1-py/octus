/**
 * @octus/core — git-exec: único punto de invocación a Git para los managers (Etapa 4).
 * execFile con argumentos por array (nunca concatenación), cwd explícito,
 * timeout, windowsHide y errores tipados. Solo lectura salvo que el llamador
 * pida explícitamente una operación de escritura (add/worktree/checkout de archivos,
 * nunca reset/clean/stash).
 */
import { execFile } from "node:child_process";
import { OctusError } from "../errors.js";

export const GIT_TIMEOUT_MS = 60_000;
export const GIT_MAX_BUFFER = 8 * 1024 * 1024;

export interface GitResult {
  stdout: string;
  stderr: string;
}

export function runGit(cwd: string, args: string[], opts?: { timeoutMs?: number; tries?: number }): Promise<GitResult> {
  const attempts = Math.max(1, Math.min(opts?.tries ?? 1, 5));
  return new Promise((resolve, reject) => {
    const attempt = (left: number): void => {
      const child = execFile(
        "git",
        args,
        { cwd, timeout: opts?.timeoutMs ?? GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            // Reintento acotado para lecturas de verificación: en Windows el AV/indexador
            // puede bloquear fugazmente el fichero .git recién creado (fallo transitorio).
            if (left > 1) {
              setTimeout(() => attempt(left - 1), 250);
              return;
            }
            const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
            reject(
              new OctusError(killed ? "timeout" : "tool_failed", `git ${args[0] ?? ""} failed: ${(stderr || error.message).slice(0, 2000)}`, {
                details: { args: args.slice(0, 3) },
              }),
            );
            return;
          }
          resolve({ stdout, stderr });
        },
      );
      void child;
    };
    attempt(attempts);
  });
}

/** Valida un nombre de rama con git (nada de regex propias). Lanza invalid_tool_args. */
export async function assertValidBranchName(cwd: string, name: string): Promise<void> {
  if (!name || name.length > 200) throw new OctusError("invalid_tool_args", "Branch name is empty or too long");
  try {
    await runGit(cwd, ["check-ref-format", "--branch", name]);
  } catch {
    throw new OctusError("invalid_tool_args", `Invalid branch name: ${name.slice(0, 120)}`);
  }
}

/** Valida que `rev` resuelva a un commit y devuelve el SHA completo. */
export async function resolveCommitSha(cwd: string, rev: string): Promise<string> {
  if (!/^[0-9a-fA-F]{4,64}$/.test(rev) && !/^HEAD(~\d+)?$/.test(rev)) {
    throw new OctusError("invalid_tool_args", `Invalid revision: ${rev.slice(0, 120)}`);
  }
  try {
    const { stdout } = await runGit(cwd, ["rev-parse", "--verify", `${rev}^{commit}`]);
    const sha = stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("not a sha");
    return sha;
  } catch (error) {
    if (error instanceof OctusError) throw error;
    throw new OctusError("not_found", `Revision does not resolve to a commit: ${rev.slice(0, 120)}`);
  }
}
