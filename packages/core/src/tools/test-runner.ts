/**
 * @octus/core — ejecución de pruebas de Reviewer en copia desechable (ADR-029).
 * Nunca sobre el worktree del Implementer: copia sin `.git`, con topes, y limpieza.
 * Los comandos salen de una allowlist explícita del usuario (kv por proyecto).
 */
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { OctusError } from "../errors.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { now } from "../util.js";

export const testEntrySchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  argv: z.array(z.string().min(1)).min(1).max(20),
  timeoutMs: z.number().int().min(5_000).max(600_000).optional(),
});

export type TestEntry = z.infer<typeof testEntrySchema>;

/** Artefactos/cachés que no deben copiarse al sandbox de pruebas. */
const COPY_EXCLUDES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".output",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".npm",
  "npm-cache",
  ".turbo",
  ".parcel-cache",
  ".vercel",
  ".pnpm-store",
  ".yarn",
]);

export interface TestRunResult {
  entryId: string;
  exitCode: number;
  output: string;
  truncated: boolean;
  durationMs: number;
}

const MAX_COPY_BYTES = 512 * 1024 * 1024;
const MAX_COPY_FILES = 100_000;
const MAX_OUTPUT_CHARS = 60_000;
const DEFAULT_TIMEOUT_MS = 300_000;

function allowlistKey(projectId: string): string {
  return `test_allowlist.${projectId}`;
}

/** Defaults seguros y deterministas para proyectos Node: scripts estándar. */
export function defaultTestEntries(rootPath: string): TestEntry[] {
  try {
    const pkgPath = path.join(rootPath, "package.json");
    if (!existsSync(pkgPath)) return [];
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, unknown> };
    const scripts = pkg.scripts ?? {};
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const wanted: Array<[string, string]> = [
      ["typecheck", "typecheck"],
      ["build", "build"],
      // E2E suele levantar un servidor en un puerto fijo; se deja fuera del
      // default para no chocar con la app en marcha. `test:unit` es seguro.
      ["test:unit", "test:unit"],
    ];
    return wanted
      .filter(([, script]) => typeof scripts[script] === "string")
      .map(([id, script]) => ({ id, name: `npm run ${script}`, argv: [npm, "run", script], timeoutMs: 600_000 }));
  } catch {
    return [];
  }
}

export class TestRunner {
  constructor(
    private readonly db: PersistenceService,
    private readonly tmpRoot: string = tmpdir(),
  ) {}

  async listAllowlist(projectId: string): Promise<TestEntry[]> {
    const row = await this.db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", [allowlistKey(projectId)]);
    if (!row) return [];
    try {
      const parsed = z.array(testEntrySchema).safeParse(JSON.parse(row.value));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  /** Si el proyecto nunca configuró allowlist, propone los scripts estándar de package.json. */
  async ensureDefaults(projectId: string, rootPath: string): Promise<TestEntry[]> {
    const row = await this.db.queryOne<{ key: string }>("SELECT key FROM kv WHERE key = ?", [allowlistKey(projectId)]);
    if (row) return this.listAllowlist(projectId);
    const defaults = defaultTestEntries(rootPath);
    if (defaults.length === 0) return [];
    return this.saveAllowlist(projectId, defaults);
  }

  /** Solo la aplicación en nombre del usuario (nunca un modelo). */
  async saveAllowlist(projectId: string, entries: TestEntry[]): Promise<TestEntry[]> {
    const parsed = z.array(testEntrySchema).safeParse(entries);
    if (!parsed.success) {
      throw new OctusError("invalid_tool_args", `Invalid test allowlist: ${parsed.error.issues.map((i) => i.message).slice(0, 3).join("; ")}`);
    }
    await this.db.exec("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [
      allowlistKey(projectId),
      JSON.stringify(parsed.data),
      now(),
    ]);
    return parsed.data;
  }

  async run(projectId: string, entryId: string, sourceDir: string, signal: AbortSignal): Promise<TestRunResult> {
    const configured = await this.listAllowlist(projectId);
    const entries = configured.length > 0 ? configured : defaultTestEntries(sourceDir);
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) {
      const available = entries.map((candidate) => candidate.id).join(", ") || "(none)";
      throw new OctusError("tool_failed", `Test entry '${entryId}' is not configured for this project. Available: ${available}`);
    }
    const started = now();
    const sandbox = mkdtempSync(path.join(this.tmpRoot, "octus-test-"));
    try {
      const project = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM projects WHERE id = ?", [projectId]).catch(() => undefined);
      this.copyDisposable(sourceDir, sandbox);
      this.linkNodeModules(sourceDir, project ? String(project.root_path) : undefined, sandbox);
      const [executable, ...args] = entry.argv;
      const timeoutMs = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const output = await this.execute(executable!, args, sandbox, timeoutMs, signal);
      const truncated = output.length > MAX_OUTPUT_CHARS;
      return { entryId, exitCode: 0, output: output.slice(0, MAX_OUTPUT_CHARS), truncated, durationMs: now() - started };
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  /** node_modules no se copia (pesado): se enlaza desde el workspace principal. */
  private linkNodeModules(sourceDir: string, projectRoot: string | undefined, sandbox: string): void {
    const candidates = [path.join(sourceDir, "node_modules"), ...(projectRoot ? [path.join(projectRoot, "node_modules")] : [])];
    const target = candidates.find((candidate) => existsSync(candidate));
    if (!target) return;
    const link = path.join(sandbox, "node_modules");
    if (existsSync(link)) return;
    try {
      symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // Sin enlace, el comando fallará con un error claro en su salida.
    }
  }

  /** Copia sin `.git`, con topes; los symlinks se materializan (nada apunta fuera). */
  private copyDisposable(sourceDir: string, sandbox: string): void {
    let bytes = 0;
    let files = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (COPY_EXCLUDES.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          try {
            const stat = statSync(full);
            if (!stat.isFile()) continue;
            bytes += stat.size;
          } catch {
            continue;
          }
        } else if (entry.isFile()) {
          bytes += statSync(full).size;
        } else if (entry.isDirectory()) {
          walk(full);
          continue;
        } else {
          continue;
        }
        files++;
        if (bytes > MAX_COPY_BYTES || files > MAX_COPY_FILES) {
          throw new OctusError("tool_failed", `Test target exceeds disposable-copy caps (${MAX_COPY_BYTES} bytes / ${MAX_COPY_FILES} files)`);
        }
      }
    };
    if (!existsSync(sourceDir)) throw new OctusError("tool_failed", "Test target directory does not exist");
    walk(sourceDir);
    cpSync(sourceDir, sandbox, {
      recursive: true,
      dereference: true,
      filter: (src) => !COPY_EXCLUDES.has(path.basename(src)),
    });
  }

  private execute(executable: string, args: string[], cwd: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      // En Windows los `.cmd` no son ejecutables directos: `shell` permite que
      // cmd resuelva npm/npx. Los argumentos vienen de la allowlist del usuario.
      const child = execFile(executable, args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: process.platform === "win32" }, (error, stdout, stderr) => {
        if (error) {
          const out = `${stdout}${stderr}`.slice(0, MAX_OUTPUT_CHARS);
          reject(new OctusError("tool_failed", `Test command failed (exit ${String((error as { code?: unknown }).code ?? "?")}): ${out.slice(0, 2000) || "(no output)"}`));
          return;
        }
        resolve(`${stdout}${stderr}`);
      });
      if (signal.aborted) {
        child.kill();
        reject(new OctusError("aborted", "Test run aborted"));
        return;
      }
      signal.addEventListener("abort", () => child.kill(), { once: true });
    });
  }
}
