/**
 * @octus/core — guarda determinista de Git en shell (ADR-026).
 * En la Etapa 2 ningún perfil gestiona ramas/worktrees ni integra: esas operaciones
 * no existen como herramientas y también se bloquean aquí para que el shell no
 * sirva de vía de escape. Denegación, nunca autoaprobación.
 */
import { OctusError } from "../errors.js";

const DENIED_SUBCOMMANDS = new Set([
  "branch",
  "checkout",
  "switch",
  "merge",
  "pull",
  "push",
  "worktree",
  "rebase",
  "reset",
  "stash",
  "clean",
  "clone",
  "submodule",
]);

const DENIED_GIT_FLAGS = new Set(["-c", "-C", "--git-dir", "--work-tree"]);

/** Tokeniza respetando comillas; marca el texto citado para no analizarlo como código. */
function tokenize(command: string): Array<{ text: string; quoted: boolean }> {
  const tokens: Array<{ text: string; quoted: boolean }> = [];
  let current = "";
  let quoted = false;
  let quote: string | undefined;
  const flush = () => {
    if (current) {
      tokens.push({ text: current, quoted });
      current = "";
      quoted = false;
    }
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
      flush();
      tokens.push({ text: ch, quoted: false });
      continue;
    }
    current += ch;
  }
  flush();
  return tokens;
}

function isGitBinary(token: string): boolean {
  const base = token.toLowerCase().replaceAll("\\", "/").split("/").pop() ?? "";
  return base === "git" || base === "git.exe";
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/** Lanza scope_violation si el comando invoca un subcomando Git prohibido. */
export function assertShellGitAllowed(command: string): void {
  const tokens = tokenize(command);
  let atCommandStart = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!.text;
    if (token === ";" || token === "|" || token === "&" || token === "(" || token === ")") {
      atCommandStart = true;
      continue;
    }
    if (atCommandStart && isEnvAssignment(token)) continue;
    if (!atCommandStart || !isGitBinary(token)) {
      atCommandStart = false;
      continue;
    }
    for (let j = i + 1; j < tokens.length; j++) {
      const next = tokens[j]!.text;
      if (next === ";" || next === "|" || next === "&" || next === "(" || next === ")") break;
      // Anulaciones de config/directorio: escapan del ámbito aunque el subcomando sea benigno.
      if (DENIED_GIT_FLAGS.has(next) || next.startsWith("--git-dir=") || next.startsWith("--work-tree=")) {
        throw new OctusError(
          "scope_violation",
          `Git flag '${next}' is not available to agents (config/directory overrides are forbidden)`,
        );
      }
      if (next.startsWith("-") || isEnvAssignment(next)) continue;
      if (DENIED_SUBCOMMANDS.has(next.toLowerCase())) {
        throw new OctusError(
          "scope_violation",
          `Git '${next.toLowerCase()}' is not available to agents in this stage (no branch/worktree management, merge, push, rebase or reset)`,
        );
      }
      break;
    }
  }
}
