/**
 * Octus desktop — detección de shells instaladas (main).
 * Puertos mínimos de OpenOrch `availableShells`: en Windows se ofrecen
 * PowerShell, PowerShell 7, cmd, Git Bash y WSL; en POSIX se lee /etc/shells
 * más $SHELL. Sin dependencias: solo node:fs/path/child_process.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface ShellOption {
  id: string;
  name: string;
  path: string;
  args: string[];
}

function firstExisting(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function which(file: string): string | undefined {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    return line && existsSync(line) ? line : line;
  } catch {
    return undefined;
  }
}

let cache: ShellOption[] | undefined;

export function availableShells(): ShellOption[] {
  if (cache) return cache;
  const found: ShellOption[] = [];
  const push = (option: ShellOption | undefined): void => {
    if (!option || found.some((entry) => entry.id === option.id)) return;
    found.push(option);
  };
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    push({
      id: "powershell",
      name: "PowerShell",
      path: firstExisting([path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]) ?? which("powershell.exe") ?? "powershell.exe",
      args: ["-NoLogo"],
    });
    const pwsh = which("pwsh.exe") ?? firstExisting([path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe")]);
    if (pwsh) push({ id: "pwsh", name: "PowerShell 7", path: pwsh, args: ["-NoLogo"] });
    push({ id: "cmd", name: "Símbolo del sistema", path: process.env.ComSpec ?? path.join(systemRoot, "System32", "cmd.exe"), args: [] });
    const gitBash = firstExisting([
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
      path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    ]);
    if (gitBash) push({ id: "git-bash", name: "Git Bash", path: gitBash, args: [] });
    const wsl = firstExisting([path.join(systemRoot, "System32", "wsl.exe")]) ?? which("wsl.exe");
    if (wsl) push({ id: "wsl", name: "WSL", path: wsl, args: [] });
  } else {
    try {
      for (const line of readFileSync("/etc/shells", "utf8").split("\n")) {
        const file = line.trim();
        if (file.startsWith("/") && existsSync(file)) push({ id: path.basename(file), name: path.basename(file), path: file, args: [] });
      }
    } catch {
      // Sin /etc/shells: se sigue con $SHELL.
    }
    const envShell = process.env.SHELL;
    if (envShell && existsSync(envShell)) push({ id: path.basename(envShell), name: path.basename(envShell), path: envShell, args: [] });
  }
  if (found.length === 0) {
    found.push({
      id: "default",
      name: "Shell",
      path: process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : (process.env.SHELL ?? "/bin/sh"),
      args: [],
    });
  }
  cache = found;
  return found;
}

export function resolveShell(id?: string): ShellOption {
  const shells = availableShells();
  return shells.find((entry) => entry.id === id) ?? shells[0]!;
}
