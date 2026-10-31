/**
 * @octus/core — PreviewManager: ejecuta la integración exacta antes de promocionar (Etapa 5, §E).
 * Workspace independiente en detached sobre el SHA exacto (nunca el workspace
 * principal ni worktrees de implementers). Env por allowlist sin secretos, DB
 * de prueba separada, localhost por convención, puertos dinámicos, kill del
 * árbol completo, limpieza segura. Declaración honesta: allowlist + sin
 * secretos + dir separado + localhost NO es un sandbox (línea ADR-018).
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { z } from "zod";
import { createId, type Preview } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { now } from "../util.js";
import { runGit } from "../repositories/git-exec.js";
import type { RepositoryManager } from "../repositories/repository-manager.js";
import type { WorktreeManager } from "../worktrees/worktree-manager.js";
import { isAlive, killTree, scrubbedEnv } from "../tools/process-tree.js";

export const previewEntrySchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  phase: z.enum(["install", "start"]),
  argv: z.array(z.string().min(1)).min(1).max(20),
  timeoutMs: z.number().int().min(5_000).max(600_000).optional(),
});

export type PreviewEntry = z.infer<typeof previewEntrySchema>;

export interface PreviewStatusView {
  preview: Preview;
  /** La URL corresponde al SHA registrado. */
  shaMatchesHead: boolean;
  reachable: boolean;
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_TAIL_CHARS = 200_000;
const START_PROBE_TIMEOUT_MS = 10_000;

function allowlistKey(projectId: string): string {
  return `preview_allowlist.${projectId}`;
}

interface Tracked {
  child: ChildProcess;
  stopping: boolean;
}

export class PreviewManager {
  private readonly tracked = new Map<string, Tracked>();

  constructor(
    private readonly db: PersistenceService,
    private readonly events: EventStore,
    private readonly bus: EventBus,
    private readonly repos: RepositoryManager,
    private readonly worktrees: WorktreeManager,
    private readonly dataDir: string,
  ) {}

  // ------------------------------------------------------------------ lectura
  async listPreviews(integrationId: string): Promise<Preview[]> {
    const rows = await this.db.query<Record<string, string | number | null>>("SELECT * FROM previews WHERE integration_id = ? ORDER BY created_at ASC", [integrationId]);
    return rows.map(deserializePreview);
  }

  async getPreview(id: string): Promise<Preview> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM previews WHERE id = ?", [id]);
    if (!row) throw new OctusError("not_found", `Preview not found: ${id}`);
    return deserializePreview(row);
  }

  async listAllowlist(projectId: string): Promise<PreviewEntry[]> {
    const row = await this.db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", [allowlistKey(projectId)]);
    if (!row) return [];
    try {
      const parsed = z.array(previewEntrySchema).safeParse(JSON.parse(row.value));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  /** Solo la aplicación en nombre del usuario (nunca un modelo). */
  async saveAllowlist(projectId: string, entries: PreviewEntry[]): Promise<PreviewEntry[]> {
    const parsed = z.array(previewEntrySchema).safeParse(entries);
    if (!parsed.success) {
      throw new OctusError("invalid_tool_args", `Invalid preview allowlist: ${parsed.error.issues.map((i) => i.message).slice(0, 3).join("; ")}`);
    }
    await this.db.exec("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [
      allowlistKey(projectId),
      JSON.stringify(parsed.data),
      now(),
    ]);
    return parsed.data;
  }

  // ------------------------------------------------------------------ ciclo
  /**
   * Prepara el workspace detached en el SHA exacto. Idempotente por fila viva:
   * si ya existe un preview sobre el mismo head sin terminar, lo devuelve.
   */
  async createPreview(integrationId: string): Promise<Preview> {
    const integration = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM integrations WHERE id = ?", [integrationId]);
    if (!integration) throw new OctusError("not_found", `Integration not found: ${integrationId}`);
    const head = integration.head ? String(integration.head) : undefined;
    if (!head) throw new OctusError("invalid_state", `Integration ${integrationId} has no head to preview`);
    const live = await this.db.queryOne<Record<string, string | number | null>>(
      "SELECT * FROM previews WHERE integration_id = ? AND sha = ? AND status IN ('starting','running','reachable') ORDER BY created_at DESC LIMIT 1",
      [integrationId, head],
    );
    if (live) return deserializePreview(live);
    const root = await this.repoRootOf(String(integration.repository_id));
    await this.repos.validateRepository(root);
    const workRoot = await this.worktrees.effectiveWorktreesRoot(String(integration.project_id));
    const id = createId("prv");
    const candidate = path.join(workRoot, "previews", id);
    const dataDir = path.join(realpathSync(this.dataDir), "previews", id);
    mkdirSync(path.dirname(candidate), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const port = await this.allocatePort();
    const url = `http://127.0.0.1:${port}`;
    const timestamp = now();
    await this.db.exec(
      "INSERT INTO previews (id, integration_id, sha, canonical_path, argv, port, url, status, log_path, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', ?, ?, 'starting', ?, ?, ?)",
      [id, integrationId, head, candidate, port, url, path.join(dataDir, "output.log"), timestamp, timestamp],
    );
    try {
      await runGit(root, ["worktree", "add", "--detach", candidate, head]);
      const real = realpathSync(candidate);
      const tip = (await runGit(real, ["rev-parse", "HEAD"], { tries: 4 })).stdout.trim();
      if (tip !== head) throw new OctusError("tool_failed", `Preview HEAD ${tip.slice(0, 12)} does not match ${head.slice(0, 12)}`);
      await this.db.exec("UPDATE previews SET canonical_path = ?, updated_at = ? WHERE id = ?", [real, now(), id]);
      const event = await this.events.append({ type: "preview.created", aggregate: { kind: "integration", id: integrationId }, correlationId: createId("cor"), payload: { previewId: id, sha: head, url } });
      this.bus.publish(event);
      return this.getPreview(id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.db.exec("UPDATE previews SET status = 'failed', updated_at = ? WHERE id = ?", [now(), id]).catch(() => undefined);
      try {
        await runGit(root, ["worktree", "remove", "--force", candidate]);
      } catch {
        // queda para reconcile
      }
      throw new OctusError("tool_failed", `Preview workspace creation failed: ${msg.slice(0, 300)}`);
    }
  }

  /**
   * Ejecuta install (secuencial, debe salir 0) y arranca el proceso start.
   * Idempotente con proceso vivo. Los fallos de comando quedan en estado failed.
   */
  async startPreview(previewId: string, opts?: { startEntryId?: string }): Promise<{ status: string; url: string; pid?: number; reachable: boolean }> {
    let preview = await this.getPreview(previewId);
    if (preview.pid !== undefined && isAlive(preview.pid)) {
      const reachable = await this.probePort(preview.port, 1000);
      return { status: preview.status, url: preview.url, pid: preview.pid, reachable };
    }
    if (preview.pid !== undefined) {
      await this.db.exec("UPDATE previews SET status = 'failed', pid = NULL, updated_at = ? WHERE id = ?", [now(), previewId]);
      preview = await this.getPreview(previewId);
    }
    const integration = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM integrations WHERE id = ?", [preview.integrationId]);
    if (!integration) throw new OctusError("not_found", `Integration not found: ${preview.integrationId}`);
    const head = integration.head ? String(integration.head) : undefined;
    if (!head || head !== preview.sha) {
      await this.db.exec("UPDATE previews SET status = 'failed', updated_at = ? WHERE id = ?", [now(), previewId]);
      throw new OctusError("invalid_state", "Preview SHA no longer matches the integration head; create a fresh preview");
    }
    // Re-provisionar si el worktree se retiró (stop quita el proceso, no el espacio;
    // cleanup sí lo retira: aquí se reconstruye).
    let dir = preview.canonicalPath;
    if (!this.physicalPreview(dir)) {
      const root = await this.repoRootOf(String(integration.repository_id));
      await runGit(root, ["worktree", "add", "--detach", dir, head]);
      dir = realpathSync(dir);
      await this.db.exec("UPDATE previews SET canonical_path = ?, updated_at = ? WHERE id = ?", [dir, now(), previewId]);
    }
    const entries = await this.listAllowlist(String(integration.project_id));
    const env = this.previewEnv(preview, head);
    const logPath = preview.logPath || path.join(realpathSync(this.dataDir), "previews", previewId, "output.log");
    // Install secuencial (debe salir 0; si falla, estado failed, sin proceso).
    for (const entry of entries.filter((e) => e.phase === "install")) {
      await this.appendLog(logPath, `$ ${entry.argv.join(" ")}\n`);
      try {
        const out = await this.execute(entry, dir, env);
        await this.appendLog(logPath, `${out.slice(0, 20000)}\n`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await this.appendLog(logPath, `install failed: ${msg.slice(0, 2000)}\n`);
        await this.db.exec("UPDATE previews SET status = 'failed', updated_at = ? WHERE id = ?", [now(), previewId]);
        return { status: "failed", url: preview.url, reachable: false };
      }
    }
    const starts = entries.filter((e) => e.phase === "start");
    const chosen = opts?.startEntryId ? starts.find((e) => e.id === opts.startEntryId) : starts[0];
    if (!chosen) {
      await this.db.exec("UPDATE previews SET status = 'failed', updated_at = ? WHERE id = ?", [now(), previewId]);
      throw new OctusError("invalid_state", "No start entry in the preview allowlist (configure one before starting)");
    }
    await this.db.exec("UPDATE previews SET argv = ?, status = 'starting', updated_at = ? WHERE id = ?", [JSON.stringify(chosen.argv), now(), previewId]);
    await this.appendLog(logPath, `$ ${chosen.argv.join(" ")}\n`);
    const child = spawn(chosen.argv[0]!, chosen.argv.slice(1), {
      cwd: dir,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.pid) throw new OctusError("tool_failed", "Preview process failed to spawn");
    const tracked: Tracked = { child, stopping: false };
    this.tracked.set(previewId, tracked);
    child.stdout?.on("data", (chunk: Buffer) => void this.appendLog(logPath, chunk.toString("utf8")).catch(() => undefined));
    child.stderr?.on("data", (chunk: Buffer) => void this.appendLog(logPath, chunk.toString("utf8")).catch(() => undefined));
    child.on("close", (code) => {
      if (this.tracked.get(previewId) !== tracked) return;
      this.tracked.delete(previewId);
      const finalStatus = tracked.stopping ? "stopped" : code === 0 ? "completed" : "failed";
      void this.db.exec("UPDATE previews SET status = ?, pid = NULL, updated_at = ? WHERE id = ?", [finalStatus, now(), previewId]).catch(() => undefined);
    });
    child.on("error", () => {
      if (this.tracked.get(previewId) !== tracked) return;
      this.tracked.delete(previewId);
      if (!tracked.stopping) {
        void this.db.exec("UPDATE previews SET status = 'failed', pid = NULL, updated_at = ? WHERE id = ?", [now(), previewId]).catch(() => undefined);
      }
    });
    const timestamp = now();
    await this.db.exec("UPDATE previews SET pid = ?, status = 'running', log_path = ?, updated_at = ? WHERE id = ?", [child.pid, logPath, timestamp, previewId]);
    child.unref();
    const event = await this.events.append({ type: "preview.started", aggregate: { kind: "integration", id: preview.integrationId }, correlationId: createId("cor"), payload: { previewId, pid: child.pid, url: preview.url } });
    this.bus.publish(event);
    // Espera compuesta: el proceso puede morir antes de escuchar (fallo rápido),
    // o tardar en abrir el puerto. Nunca se declara reachable sin sonda positiva.
    const deadline = Date.now() + START_PROBE_TIMEOUT_MS;
    let reachable = false;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      reachable = await this.probePort(preview.port, 500);
      if (reachable) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      // Da margen al handler de close para persistir el estado terminal.
      for (let i = 0; i < 20; i++) {
        const s = (await this.getPreview(previewId).catch(() => undefined))?.status;
        if (s && !["running", "starting"].includes(s)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const final = await this.getPreview(previewId);
    if (reachable && (final.status === "running" || final.status === "reachable")) {
      await this.db.exec("UPDATE previews SET status = 'reachable', updated_at = ? WHERE id = ?", [now(), previewId]);
      const ready = await this.events.append({ type: "preview.ready", aggregate: { kind: "integration", id: preview.integrationId }, correlationId: createId("cor"), payload: { previewId, url: preview.url, sha: preview.sha } });
      this.bus.publish(ready);
      return { status: "reachable", url: preview.url, pid: final.pid, reachable: true };
    }
    // El proceso pudo terminar durante la sonda (exit≠0 → failed registrado).
    return { status: final.status, url: preview.url, pid: final.pid, reachable: false };
  }

  /** Detiene el árbol del proceso (idempotente). */
  async stopPreview(previewId: string): Promise<{ stopped: boolean }> {
    const preview = await this.getPreview(previewId).catch(() => undefined);
    if (!preview) return { stopped: false };
    const tracked = this.tracked.get(previewId);
    if (tracked) {
      tracked.stopping = true;
      if (tracked.child.pid !== undefined) killTree(tracked.child.pid);
      this.tracked.delete(previewId);
    } else if (preview.pid !== undefined && isAlive(preview.pid)) {
      killTree(preview.pid);
    } else {
      if (["running", "reachable", "starting"].includes(preview.status)) {
        await this.db.exec("UPDATE previews SET status = 'stopped', pid = NULL, updated_at = ? WHERE id = ?", [now(), previewId]);
      }
      return { stopped: true };
    }
    // Espera breve a la muerte real (evita EBUSY al limpiar justo después).
    const deadline = Date.now() + 5000;
    const pid = tracked?.child.pid ?? preview.pid;
    while (pid !== undefined && isAlive(pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    // Cierra los pipes del lado padre (en Windows bloquean el rm del tmp).
    try {
      tracked?.child.stdout?.destroy();
    } catch {
      // best effort
    }
    try {
      tracked?.child.stderr?.destroy();
    } catch {
      // best effort
    }
    try {
      tracked?.child.unref();
    } catch {
      // best effort
    }
    await this.db.exec("UPDATE previews SET status = 'stopped', pid = NULL, updated_at = ? WHERE id = ?", [now(), previewId]);
    const event = await this.events.append({ type: "preview.stopped", aggregate: { kind: "integration", id: preview.integrationId }, correlationId: createId("cor"), payload: { previewId } });
    this.bus.publish(event);
    return { stopped: true };
  }

  /** restart = stop + start. */
  async restartPreview(previewId: string, opts?: { startEntryId?: string }): Promise<{ status: string; url: string; pid?: number; reachable: boolean }> {
    await this.stopPreview(previewId);
    return this.startPreview(previewId, opts);
  }

  /** Inspección con sonda viva y verificación de SHA. */
  async inspectPreview(previewId: string): Promise<PreviewStatusView> {
    const preview = await this.getPreview(previewId);
    const integration = await this.db.queryOne<{ head: string | null }>("SELECT head FROM integrations WHERE id = ?", [preview.integrationId]);
    const head = integration?.head ? String(integration.head) : undefined;
    let reachable = false;
    if (["running", "reachable"].includes(preview.status)) {
      reachable = await this.probePort(preview.port, 2000);
      if (reachable && preview.status === "running") {
        await this.db.exec("UPDATE previews SET status = 'reachable', updated_at = ? WHERE id = ?", [now(), previewId]);
        preview.status = "reachable";
      }
    }
    return { preview, shaMatchesHead: !!head && head === preview.sha, reachable };
  }

  async getPreviewStatus(previewId: string): Promise<string> {
    return (await this.getPreview(previewId)).status;
  }

  async getPreviewLogs(previewId: string, tailChars = 50_000): Promise<string> {
    const preview = await this.getPreview(previewId);
    try {
      const text = readFileSync(preview.logPath, "utf8");
      return text.slice(-Math.min(Math.max(tailChars, 1), MAX_LOG_TAIL_CHARS)) || "(empty log)";
    } catch {
      return "(no logs)";
    }
  }

  /**
   * Limpieza explícita: detiene, retira el worktree y borra la fila
   * (el preview es efímero; la auditoría vive en eventos + validaciones).
   */
  async cleanupPreview(previewId: string): Promise<{ removed: boolean }> {
    const preview = await this.getPreview(previewId).catch(() => undefined);
    if (!preview) return { removed: false };
    await this.stopPreview(previewId).catch(() => undefined);
    try {
      const integration = await this.db.queryOne<{ repository_id: string }>("SELECT repository_id FROM integrations WHERE id = ?", [preview.integrationId]);
      if (integration) {
        const repo = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM repositories WHERE id = ?", [String(integration.repository_id)]);
        if (repo) {
          await runGit(String(repo.root_path), ["worktree", "remove", "--force", preview.canonicalPath]);
        }
      }
    } catch {
      // best effort: la fila se borra igual si el repo ya no existe
    }
    await this.db.exec("DELETE FROM previews WHERE id = ?", [previewId]);
    return { removed: true };
  }

  /**
   * Reconciliación post-reinicio: procesos vivos desconocidos → orphaned
   * (sin matar por pid: podría estar reutilizado). 'starting' se conserva
   * (lanzamiento pendiente, reintentable). Sin auto-run (ADR-040).
   */
  async reconcile(): Promise<{ orphaned: number }> {
    let orphaned = 0;
    const live = await this.db.query<{ id: string }>("SELECT id FROM previews WHERE status IN ('running','reachable')");
    for (const row of live) {
      const tracked = this.tracked.get(row.id);
      if (tracked) continue; // proceso propio de esta ejecución
      await this.db.exec("UPDATE previews SET status = 'orphaned', pid = NULL, updated_at = ? WHERE id = ?", [now(), row.id]);
      orphaned++;
    }
    return { orphaned };
  }

  // ---------------------------------------------------------------- internas
  private async repoRootOf(repositoryId: string): Promise<string> {
    const row = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM repositories WHERE id = ?", [repositoryId]);
    if (!row) throw new OctusError("not_found", `Repository not found: ${repositoryId}`);
    return String(row.root_path);
  }

  private async allocatePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => (port > 0 ? resolve(port) : reject(new Error("no port"))));
      });
    });
  }

  private async probePort(port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const done = (ok: boolean): void => {
        socket.destroy();
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      socket.on("connect", () => {
        clearTimeout(timer);
        done(true);
      });
      socket.on("error", () => {
        clearTimeout(timer);
        done(false);
      });
    });
  }

  private previewEnv(preview: Preview, sha: string): Record<string, string> {
    const dataDir = path.join(realpathSync(this.dataDir), "previews", preview.id);
    mkdirSync(dataDir, { recursive: true });
    const env: Record<string, string> = {
      ...scrubbedEnv(),
      OCTUS_PREVIEW_PORT: String(preview.port),
      OCTUS_PREVIEW_HOST: "127.0.0.1",
      OCTUS_PREVIEW_URL: preview.url,
      OCTUS_PREVIEW_DATA_DIR: dataDir,
      OCTUS_PREVIEW_SHA: sha,
    };
    // Fail-closed: ninguna clave con pinta de secreto, aunque scrubbedEnv ya filtra.
    for (const key of Object.keys(env)) {
      if (/api[_-]?key|token|secret|password|credentials/i.test(key)) {
        throw new OctusError("internal", `Preview env would leak a secret-like variable: ${key}`);
      }
    }
    return env;
  }

  private async execute(entry: PreviewEntry, cwd: string, env: Record<string, string>): Promise<string> {
    const [exe, ...args] = entry.argv;
    return new Promise((resolve, reject) => {
      const child = execFile(exe!, args, { cwd, env, windowsHide: true, timeout: entry.timeoutMs ?? 300_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new OctusError("tool_failed", `Preview command '${entry.id}' failed: ${(String(stderr || error.message)).slice(0, 2000)}`));
          return;
        }
        resolve(`${stdout}${stderr}`);
      });
      void child;
    });
  }

  private async appendLog(logPath: string, text: string): Promise<void> {
    try {
      let size = 0;
      try {
        size = statSync(logPath).size;
      } catch {
        size = 0;
      }
      if (size >= MAX_LOG_BYTES) return;
      mkdirSync(path.dirname(logPath), { recursive: true });
      appendFileSync(logPath, text.slice(0, MAX_LOG_BYTES - size));
    } catch {
      // logs best-effort: nunca tumban el preview
    }
  }

  private physicalPreview(canonicalPath: string): boolean {
    try {
      realpathSync(canonicalPath);
      return true;
    } catch {
      return false;
    }
  }
}

function deserializePreview(row: Record<string, string | number | null>): Preview {
  let argv: string[] = [];
  try {
    const parsed = JSON.parse(String(row.argv ?? "[]")) as unknown;
    if (Array.isArray(parsed)) argv = parsed.map(String);
  } catch {
    argv = [];
  }
  return {
    id: String(row.id),
    integrationId: String(row.integration_id),
    sha: String(row.sha),
    canonicalPath: String(row.canonical_path),
    argv,
    port: Number(row.port),
    url: String(row.url),
    pid: row.pid !== null && row.pid !== undefined ? Number(row.pid) : undefined,
    status: row.status as Preview["status"],
    logPath: String(row.log_path ?? ""),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
