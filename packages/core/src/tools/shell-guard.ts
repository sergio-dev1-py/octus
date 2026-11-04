/**
 * @octus/core — guarda determinista de Git en shell (ADR-026).
 * En la Etapa 2 ningún perfil gestiona ramas/worktrees ni integra: esas operaciones
 * no existen como herramientas y también se bloquean aquí para que el shell no
 * sirva de vía de escape. Denegación, nunca autoaprobación.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { OctusError } from "../errors.js";
import { sameOrInside } from "./path-scope.js";

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

/**
 * Guarda de autopreservación: deniega en duro (sin pregunta) matar procesos
 * propios del harness, formatear discos y borrar raíces del sistema. Los
 * borrados fuera de estas raíces no se deniegan aquí: pasan por el permiso
 * `ask` de la definición para que el usuario decida.
 */
const KILL_BINARIES = new Set(["taskkill", "taskkill.exe", "tskill", "tskill.exe", "pkill", "killall", "kill", "kill.exe"]);
const BACKGROUND_LAUNCHERS = new Set(["start", "start.exe", "nohup", "nohup.exe"]);
const WIPER_BINARIES = new Set(["format", "format.com", "diskpart", "diskpart.exe"]);
const DELETE_BINARIES = new Set(["del", "erase", "rmdir", "rd", "rm", "remove-item"]);

function segmentsOf(tokens: Array<{ text: string; quoted: boolean }>): Array<Array<{ text: string; quoted: boolean }>> {
  const segments: Array<Array<{ text: string; quoted: boolean }>> = [[]];
  for (const token of tokens) {
    if (!token.quoted && (token.text === ";" || token.text === "|" || token.text === "&" || token.text === "(" || token.text === ")")) {
      segments.push([]);
    } else {
      segments[segments.length - 1]!.push(token);
    }
  }
  return segments;
}

function expandSystemVars(value: string): string {
  return value
    .replaceAll("%SystemRoot%", process.env.SystemRoot ?? "C:\\Windows")
    .replaceAll("%windir%", process.env.windir ?? process.env.SystemRoot ?? "C:\\Windows")
    .replaceAll("$env:SystemRoot", process.env.SystemRoot ?? "C:\\Windows");
}

function isSystemRoot(p: string): boolean {
  const expanded = expandSystemVars(p).replaceAll("\\", "/");
  if (expanded === "/" || /^[A-Za-z]:\/?$/i.test(expanded)) return true;
  const norm = expanded.toLowerCase().replace(/\/+$/, "");
  if (process.platform === "win32") {
    const sys = (process.env.SystemRoot ?? "C:\\Windows").replaceAll("\\", "/").toLowerCase();
    return norm === sys || norm.startsWith(`${sys}/`);
  }
  return norm === "" || ["/usr", "/bin", "/sbin", "/etc", "/System"].some((root) => norm === root || norm.startsWith(`${root}/`));
}

function segmentText(segment: Array<{ text: string; quoted: boolean }>): string {
  return segment.map((t) => t.text).join(" ").toLowerCase();
}

export function assertShellSelfPreservation(command: string): void {
  const tokens = tokenize(command);
  for (const segment of segmentsOf(tokens)) {
    const words = segment.filter((t) => !isEnvAssignment(t.text));
    if (words.length === 0) continue;
    const base = words[0]!.text.toLowerCase().replaceAll("\\", "/").split("/").pop() ?? "";
    const text = segmentText(segment);
    // Matar procesos propios del harness (el worker de persistencia corre en node).
    if (KILL_BINARIES.has(base)) {
      throw new OctusError(
        "scope_violation",
        `Killing processes ('${words[0]!.text}') is forbidden for agents: denied, never ask. Only the harness manages previews and child processes.`,
      );
    }
    if ((base === "powershell" || base === "powershell.exe" || base === "pwsh" || base === "pwsh.exe") && text.includes("stop-process")) {
      throw new OctusError("scope_violation", "Stop-Process is forbidden for agents: denied, never ask. Only the harness manages previews and child processes.");
    }
    if (BACKGROUND_LAUNCHERS.has(base)) {
      throw new OctusError(
        "scope_violation",
        `Detached/background processes ('${words[0]!.text}') are forbidden for agents: denied, never ask. Use a bounded command or the test runner.`,
      );
    }
    if ((base === "powershell" || base === "powershell.exe" || base === "pwsh" || base === "pwsh.exe") && (text.includes("start-process") || text.includes("start-job"))) {
      throw new OctusError("scope_violation", "Detached PowerShell processes are forbidden for agents: denied, never ask. Use a bounded command or the test runner.");
    }
    // Formatear o particionar discos.
    if (WIPER_BINARIES.has(base)) {
      throw new OctusError("scope_violation", `Disk wiping ('${words[0]!.text}') is forbidden for agents: denied, never ask`);
    }
    // Borrar raíces del sistema.
    if (DELETE_BINARIES.has(base)) {
      for (const token of segment.slice(1)) {
        if (!token.quoted && token.text.startsWith("-")) continue;
        const candidate = expandSystemVars(token.text).replace(/^["']|["']$/g, "");
        if (candidate && isSystemRoot(candidate)) {
          throw new OctusError("scope_violation", `Deleting a protected system location ('${token.text}') is forbidden: denied, never ask`);
        }
      }
    }
  }
}

/** Expande variables de shell/Windows para comparar rutas reales. */
function expandShellVars(value: string, cwd: string): string {
  const lookup = (name: string): string | undefined => {
    const key = name.toUpperCase();
    if (key === "CD" || key === "PWD") return cwd;
    if (key === "HOME") return process.env.HOME ?? process.env.USERPROFILE;
    return process.env[name] ?? process.env[key];
  };
  let out = value
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name: string) => lookup(name) ?? match)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (match, name: string) => lookup(name) ?? match)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => lookup(name) ?? match)
    .replace(/\$(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMPDIR|TEMP|TMP|PWD|CD)\b/gi, (match, name: string) => lookup(name) ?? match);
  if (out === "~" || /^~[\\/]/.test(out)) out = path.join(homedir(), out.slice(1));
  return out;
}

/** Extrae rutas absolutas, variables y relativas con `..` de un token. */
function pathCandidates(text: string): string[] {
  const out: string[] = [];
  const push = (value: string | undefined): void => {
    if (value && value.trim()) out.push(value.trim());
  };
  const trimmed = text.trim();
  const absoluteLike =
    /^(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|%[A-Za-z_][A-Za-z0-9_]*%|\$env:|\$\{|\$(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMPDIR|TEMP|TMP|PWD|CD)\b)/i;
  if (absoluteLike.test(trimmed) && !trimmed.includes("://")) {
    push(trimmed);
  } else {
    for (const match of text.matchAll(/(?:^|[\s"'`(=,;|&])([A-Za-z]:[\\/][^"'\s`),;|&]*)/g)) push(match[1]);
    for (const match of text.matchAll(/(\\\\[^\\/\s"']+[\\/][^"'\s`),;|&]*)/g)) push(match[1]);
    for (const match of text.matchAll(/(?:^|[\s"'`(=,;|&])(~[\\/][^"'\s`),;|&]*)/g)) push(match[1]);
    for (const match of text.matchAll(/(?:^|[\s"'`(=,;|&])(\/(?:Users|home|tmp|etc|var|mnt|opt|root|usr|private|Volumes)\/[^"'\s`),;|&]*)/g)) push(match[1]);
  }
  for (const match of text.matchAll(/(%[A-Za-z_][A-Za-z0-9_]*%|\$env:[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMPDIR|TEMP|TMP|PWD|CD)\b)/gi)) {
    push(match[1]);
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(trimmed) && !trimmed.includes("://")) push(trimmed);
  return out;
}

/**
 * Guarda de ámbito del shell: solo rutas dentro del workspace asignado.
 * Las rutas absolutas, variables (`%APPDATA%`, `$env:...`, `~`), UNC y `..`
 * se resuelven antes de comparar. El árbol del harness (`@octus`) y los
 * `protectedRoots` se deniegan en duro, sin abrir un diálogo de permiso.
 */
export function assertShellScope(command: string, cwd: string, protectedRoots: string[] = []): void {
  const real = (value: string): string => {
    try {
      return realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  const cwdReal = real(cwd);
  const protectedReal = protectedRoots.map(real);
  const nestedWorktrees = path.join(cwdReal, ".octus", "worktrees");
  for (const token of tokenize(command)) {
    for (const candidate of pathCandidates(token.text)) {
      const expanded = expandShellVars(candidate, cwdReal).trim().replace(/^["'`]|["'`]$/g, "");
      if (!expanded || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(expanded)) continue;
      let resolved: string;
      if (/^[A-Za-z]:$/.test(expanded)) resolved = path.resolve(`${expanded}${path.sep}`);
      else if (path.isAbsolute(expanded)) resolved = path.resolve(expanded);
      else if (expanded === "~" || expanded.startsWith("~")) resolved = path.resolve(expandShellVars(expanded, cwdReal));
      else if (expanded === ".." || /(^|[\\/])\.\.([\\/]|$)/.test(expanded)) resolved = path.resolve(cwdReal, expanded);
      else if (/[\\/]/.test(expanded)) resolved = path.resolve(cwdReal, expanded);
      else continue;
      const normalized = resolved.replaceAll("\\", "/");
      if (/\/@octus(\/|$)/i.test(normalized)) {
        throw new OctusError("scope_violation", `Path targets Octus harness data and is denied: ${candidate.slice(0, 200)}`);
      }
      if (protectedReal.some((root) => sameOrInside(root, resolved))) {
        throw new OctusError("scope_violation", `Path targets protected harness data and is denied: ${candidate.slice(0, 200)}`);
      }
      if (sameOrInside(nestedWorktrees, resolved)) {
        throw new OctusError("scope_violation", `Path targets another worker's worktree and is denied: ${candidate.slice(0, 200)}`);
      }
      if (!sameOrInside(cwdReal, resolved)) {
        throw new OctusError("scope_violation", `Shell path escapes the assigned workspace: ${candidate.slice(0, 200)}`);
      }
    }
  }
}

/** Lanza scope_violation si el comando invoca un subcomando Git prohibido. */
export function assertShellGitAllowed(command: string): void {
  assertShellSelfPreservation(command);
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
