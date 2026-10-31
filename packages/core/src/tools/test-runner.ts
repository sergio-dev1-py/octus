/**
 * @octus/core — ejecución de pruebas de Reviewer en copia desechable (ADR-029).
 * Nunca sobre el worktree del Implementer: copia sin `.git`, con topes, y limpieza.
 * Los comandos salen de una allowlist explícita del usuario (kv por proyecto).
 */
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
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
    const entries = await this.listAllowlist(projectId);
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) {
      throw new OctusError("tool_denied", `Test entry '${entryId}' is not in the project allowlist`);
    }
    const started = now();
    const sandbox = mkdtempSync(path.join(this.tmpRoot, "octus-test-"));
    try {
      this.copyDisposable(sourceDir, sandbox);
      const [executable, ...args] = entry.argv;
      const timeoutMs = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const output = await this.execute(executable!, args, sandbox, timeoutMs, signal);
      const truncated = output.length > MAX_OUTPUT_CHARS;
      return { entryId, exitCode: 0, output: output.slice(0, MAX_OUTPUT_CHARS), truncated, durationMs: now() - started };
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  /** Copia sin `.git`, con topes; los symlinks se materializan (nada apunta fuera). */
  private copyDisposable(sourceDir: string, sandbox: string): void {
    let bytes = 0;
    let files = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
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
      filter: (src) => path.basename(src) !== ".git",
    });
  }

  private execute(executable: string, args: string[], cwd: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(executable, args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
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
