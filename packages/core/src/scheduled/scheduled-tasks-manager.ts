/**
 * @octus/core — ScheduledTasksManager (Todo workbench-chat-terminal/7).
 * Tareas programadas por cron, concepto aparte del TaskScheduler/DAG interno:
 * este archivo NO importa nada de `tasks/` (solo copia el idiom del mutex
 * de tick; la BD es la fuente de verdad).
 *
 * - Validación cron de 5 campos; el inválido se rechaza al crear.
 * - tickDue con mutex: como máximo 1 disparo por tarea y tick; el next_run_at
 *   siempre avanza desde `ahora` (sin catch-up en espiral tras dormir/apagón).
 * - Solape: si el disparo anterior sigue activo (memoria + hook isRunActive),
 *   se registra skipped_overlap y no se abre sesión nueva.
 * - Tras 5 fallos consecutivos de disparo la tarea se auto-deshabilita.
 * - next_run_at es solo-escritura de este manager.
 */
import { createId, type ScheduleRunStatus, type ScheduledRun, type ScheduledTask } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { now } from "../util.js";
import { nextCronRun, parseCron } from "./cron.js";

/** Fallos consecutivos de disparo antes de auto-deshabilitar. */
export const SCHEDULE_MAX_FAILURES = 5;
/** Carpeta auto (inglés) bajo el dir de usuario, creada al primer uso. */
export const SCHEDULE_BASE_DIRNAME = "scheduled_tasks";
const RUN_HISTORY_LIMIT = 200;
const ERROR_PREVIEW_CHARS = 500;

export interface ScheduleBase {
  projectId: string;
  baseDir: string;
}

export interface ScheduleHooks {
  now?: () => number;
  /** Asegura la base auto (mkdir + proyecto); creada al primer uso. */
  ensureBase: () => Promise<ScheduleBase>;
  /** Abre la sesión nueva de la tarea sobre la base. */
  openSession: (projectId: string, title: string, profile: "plan" | "build") => Promise<{ sessionId: string }>;
  /** Dispara el prompt por el camino existente (sessions.prompt). */
  startPrompt: (sessionId: string, prompt: string) => Promise<{ runId: string }>;
  /** true si el run anterior sigue activo (solape entre ticks). */
  isRunActive?: (runId: string) => boolean | Promise<boolean>;
}

export interface ScheduleTickResult {
  due: number;
  fired: number;
  skipped: number;
  failed: number;
}

interface ScheduleRow {
  id: string;
  name: string;
  prompt: string;
  profile: string;
  cron: string;
  timezone: string;
  once: number;
  max_runs: number | null;
  enabled: number;
  consecutive_failures: number;
  next_run_at: number;
  last_run_at: number | null;
  last_status: string | null;
  created_at: number;
  updated_at: number;
}

function deserializeSchedule(row: ScheduleRow): ScheduledTask {
  return {
    id: String(row.id),
    name: String(row.name),
    prompt: String(row.prompt),
    profile: row.profile === "plan" ? "plan" : "build",
    cron: String(row.cron),
    timezone: String(row.timezone),
    once: Number(row.once ?? 0) === 1,
    ...(row.max_runs === null || row.max_runs === undefined ? {} : { maxRuns: Number(row.max_runs) }),
    enabled: Number(row.enabled) === 1,
    consecutiveFailures: Number(row.consecutive_failures),
    nextRunAt: Number(row.next_run_at),
    ...(row.last_run_at === null ? {} : { lastRunAt: Number(row.last_run_at) }),
    ...(row.last_status === null
      ? {}
      : { lastStatus: String(row.last_status) as ScheduleRunStatus }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function deserializeRun(row: Record<string, string | number | null>): ScheduledRun {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
    ...(row.run_id ? { runId: String(row.run_id) } : {}),
    status: String(row.status) as ScheduleRunStatus,
    scheduledAt: Number(row.scheduled_at),
    firedAt: Number(row.fired_at),
    ...(row.error ? { error: String(row.error) } : {}),
    createdAt: Number(row.created_at),
  };
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > ERROR_PREVIEW_CHARS ? text.slice(0, ERROR_PREVIEW_CHARS) : text;
}

export class ScheduledTasksManager {
  /** Serializa ticks en el proceso (idiom copiado de TaskScheduler, sin reutilizarlo). */
  private ticking: Promise<unknown> = Promise.resolve();
  /** Disparos en curso en este proceso (solape intra-tick e inter-tick). */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly db: PersistenceService,
    private readonly events: EventStore,
    private readonly bus: EventBus,
    private readonly hooks: ScheduleHooks,
  ) {}

  private clock(): number {
    return this.hooks.now ? this.hooks.now() : now();
  }

  // ------------------------------------------------------------- lectura/CRUD

  async list(): Promise<ScheduledTask[]> {
    const rows = await this.db.query<ScheduleRow>("SELECT * FROM scheduled_tasks ORDER BY created_at ASC");
    return rows.map(deserializeSchedule);
  }

  async get(id: string): Promise<ScheduledTask> {
    const row = await this.db.queryOne<ScheduleRow>("SELECT * FROM scheduled_tasks WHERE id = ?", [id]);
    if (!row) throw new OctusError("not_found", `Schedule not found: ${id}`);
    return deserializeSchedule(row);
  }

  async create(input: { name: string; prompt: string; profile?: "plan" | "build"; cron: string; timezone?: string; once?: boolean; maxRuns?: number | null }): Promise<ScheduledTask> {
    const name = input.name?.trim() ?? "";
    const prompt = input.prompt?.trim() ?? "";
    if (!name) throw new OctusError("invalid_schedule", "schedule name is required");
    if (!prompt) throw new OctusError("invalid_schedule", "schedule prompt is required");
    const profile = input.profile ?? "build";
    if (profile !== "plan" && profile !== "build") throw new OctusError("invalid_schedule", "schedule profile must be 'plan' or 'build'");
    // El cron inválido se rechaza aquí (sintaxis y zona); también el que nunca dispara.
    parseCron(input.cron);
    const timezone = (input.timezone ?? "local").trim() || "local";
    const once = input.once === true;
    const maxRuns = input.maxRuns ?? null;
    if (maxRuns !== null && (!Number.isInteger(maxRuns) || maxRuns < 1)) {
      throw new OctusError("invalid_schedule", "maxRuns must be a positive integer");
    }
    const ts = this.clock();
    const next = nextCronRun(input.cron, ts, timezone);
    if (next === null) throw new OctusError("invalid_cron", "cron never fires within a year");
    // Primer uso: la base auto existe desde la primera programada.
    await this.hooks.ensureBase();
    const id = createId("sch");
    await this.db.exec(
      "INSERT INTO scheduled_tasks (id, name, prompt, profile, cron, timezone, once, max_runs, enabled, consecutive_failures, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)",
      [id, name, prompt, profile, input.cron, timezone, once ? 1 : 0, maxRuns, next, ts, ts],
    );
    await this.publish("schedule.created", id, { name, cron: input.cron, timezone, nextRunAt: next });
    return this.get(id);
  }

  /** Edita una tarea (nombre, prompt, perfil, cron, zona, once, maxRuns).
   *  Revalida el cron y recalcula la próxima ejecución desde ahora. */
  async update(id: string, patch: { name?: string; prompt?: string; profile?: "plan" | "build"; cron?: string; timezone?: string; once?: boolean; maxRuns?: number | null }): Promise<ScheduledTask> {
    const current = await this.get(id);
    const name = patch.name !== undefined ? patch.name.trim() : current.name;
    const prompt = patch.prompt !== undefined ? patch.prompt.trim() : current.prompt;
    if (!name) throw new OctusError("invalid_schedule", "schedule name is required");
    if (!prompt) throw new OctusError("invalid_schedule", "schedule prompt is required");
    const profile = patch.profile ?? current.profile;
    if (profile !== "plan" && profile !== "build") throw new OctusError("invalid_schedule", "schedule profile must be 'plan' or 'build'");
    const cron = patch.cron ?? current.cron;
    const timezone = (patch.timezone ?? current.timezone).trim() || "local";
    parseCron(cron);
    const once = patch.once ?? current.once;
    const maxRuns = patch.maxRuns !== undefined ? patch.maxRuns : (current.maxRuns ?? null);
    if (maxRuns !== null && (!Number.isInteger(maxRuns) || maxRuns < 1)) {
      throw new OctusError("invalid_schedule", "maxRuns must be a positive integer");
    }
    const ts = this.clock();
    const next = nextCronRun(cron, ts, timezone);
    if (next === null) throw new OctusError("invalid_cron", "cron never fires within a year");
    await this.db.exec(
      "UPDATE scheduled_tasks SET name = ?, prompt = ?, profile = ?, cron = ?, timezone = ?, once = ?, max_runs = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
      [name, prompt, profile, cron, timezone, once ? 1 : 0, maxRuns, next, ts, id],
    );
    await this.publish("schedule.updated", id, { name, cron });
    return this.get(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<ScheduledTask> {
    const current = await this.get(id);
    const ts = this.clock();
    // Al rehabilitar, el next heredado del periodo apagado está rancio: se recalcula.
    const next = enabled ? nextCronRun(current.cron, ts, current.timezone) : current.nextRunAt;
    if (enabled && next === null) throw new OctusError("invalid_cron", "cron never fires within a year");
    await this.db.exec(
      "UPDATE scheduled_tasks SET enabled = ?, consecutive_failures = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
      [enabled ? 1 : 0, enabled ? 0 : current.consecutiveFailures, enabled ? next! : current.nextRunAt, ts, id],
    );
    await this.publish("schedule.updated", id, { enabled });
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    await this.db.exec("DELETE FROM scheduled_tasks WHERE id = ?", [id]);
    await this.publish("schedule.removed", id, {});
  }

  async runs(taskId: string, limit = 50): Promise<ScheduledRun[]> {
    await this.get(taskId);
    const capped = Math.min(Math.max(Math.floor(limit) || 50, 1), RUN_HISTORY_LIMIT);
    const rows = await this.db.query<Record<string, string | number | null>>(
      "SELECT * FROM scheduled_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?",
      [taskId, capped],
    );
    return rows.map(deserializeRun);
  }

  /** Vencidas ahora mismo (para el `due` aditivo de tasks.scheduler). */
  async dueCount(at?: number): Promise<{ due: number; enabled: number }> {
    const ts = at ?? this.clock();
    const row = await this.db.queryOne<{ due: number; enabled: number }>(
      "SELECT (SELECT COUNT(*) FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ?) AS due, (SELECT COUNT(*) FROM scheduled_tasks WHERE enabled = 1) AS enabled",
      [ts],
    );
    return { due: row?.due ?? 0, enabled: row?.enabled ?? 0 };
  }

  // ------------------------------------------------------------------- tick

  /** Tick serializado (mutex local; la BD manda): como mucho 1 disparo por tarea. */
  async tickDue(at?: number): Promise<ScheduleTickResult> {
    const ts = at ?? this.clock();
    const run = this.ticking.then(() => this.tickInner(ts));
    this.ticking = run.catch(() => undefined);
    return run;
  }

  private async tickInner(ts: number): Promise<ScheduleTickResult> {
    const due = await this.db.query<ScheduleRow>(
      "SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC",
      [ts],
    );
    const result: ScheduleTickResult = { due: due.length, fired: 0, skipped: 0, failed: 0 };
    for (const row of due) {
      const task = deserializeSchedule(row);
      if (this.inFlight.has(task.id) || (await this.hasOpenFire(task.id))) {
        await this.recordSkip(task, ts);
        result.skipped++;
        continue;
      }
      this.inFlight.add(task.id);
      try {
        await this.fire(task, ts);
        result.fired++;
      } catch (error) {
        await this.recordFailure(task, ts, error);
        result.failed++;
      } finally {
        this.inFlight.delete(task.id);
      }
    }
    return result;
  }

  /** Disparo anterior aún activo: memoria del proceso o hook del core. */
  private async hasOpenFire(taskId: string): Promise<boolean> {
    if (!this.hooks.isRunActive) return false;
    const open = await this.db.query<{ run_id: string | null }>(
      "SELECT run_id FROM scheduled_runs WHERE task_id = ? AND status = 'fired' ORDER BY fired_at DESC LIMIT 5",
      [taskId],
    );
    for (const row of open) {
      if (!row.run_id) continue;
      try {
        if (await this.hooks.isRunActive(String(row.run_id))) return true;
      } catch {
        // Hook caído: no bloquear el disparo por un observador roto.
        return false;
      }
    }
    return false;
  }

  /** Cada tarea corre como sesión nueva de la base vía el camino existente. */
  private async fire(task: ScheduledTask, ts: number): Promise<void> {
    const base = await this.hooks.ensureBase();
    const opened = await this.hooks.openSession(base.projectId, task.name, task.profile);
    const started = await this.hooks.startPrompt(opened.sessionId, task.prompt);
    const id = createId("schrun");
    await this.db.exec(
      "INSERT INTO scheduled_runs (id, task_id, session_id, run_id, status, scheduled_at, fired_at, created_at) VALUES (?, ?, ?, ?, 'fired', ?, ?, ?)",
      [id, task.id, opened.sessionId, started.runId, task.nextRunAt, ts, ts],
    );
    await this.advance(task, ts, { lastStatus: "fired", failures: 0 });
    await this.enforceRunLimits(task.id);
    await this.publish("schedule.fired", task.id, { runId: started.runId, sessionId: opened.sessionId });
  }

  /** once → se elimina tras disparar; maxRuns → se desactiva al agotarse. */
  private async enforceRunLimits(taskId: string): Promise<void> {
    const task = await this.get(taskId).catch(() => undefined);
    if (!task) return;
    if (task.once) {
      await this.db.exec("DELETE FROM scheduled_tasks WHERE id = ?", [taskId]);
      await this.publish("schedule.removed", taskId, { reason: "once-fired" });
      return;
    }
    if (task.maxRuns !== null && task.maxRuns !== undefined) {
      const row = await this.db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM scheduled_runs WHERE task_id = ? AND status = 'fired'", [taskId]);
      if ((row?.n ?? 0) >= task.maxRuns) {
        await this.db.exec("UPDATE scheduled_tasks SET enabled = 0, updated_at = ? WHERE id = ?", [this.clock(), taskId]);
        await this.publish("schedule.updated", taskId, { enabled: false, reason: "max-runs" });
      }
    }
  }

  private async recordSkip(task: ScheduledTask, ts: number): Promise<void> {
    const id = createId("schrun");
    await this.db.exec(
      "INSERT INTO scheduled_runs (id, task_id, status, scheduled_at, fired_at, created_at) VALUES (?, ?, 'skipped_overlap', ?, ?, ?)",
      [id, task.id, task.nextRunAt, ts, ts],
    );
    await this.advance(task, ts, { lastStatus: "skipped_overlap", failures: task.consecutiveFailures });
    await this.publish("schedule.skipped", task.id, { reason: "overlap" });
  }

  private async recordFailure(task: ScheduledTask, ts: number, error: unknown): Promise<void> {
    const failures = task.consecutiveFailures + 1;
    const id = createId("schrun");
    await this.db.exec(
      "INSERT INTO scheduled_runs (id, task_id, status, scheduled_at, fired_at, error, created_at) VALUES (?, ?, 'failed', ?, ?, ?, ?)",
      [id, task.id, task.nextRunAt, ts, errorMessage(error), ts],
    );
    const disabled = failures >= SCHEDULE_MAX_FAILURES;
    await this.db.exec(
      "UPDATE scheduled_tasks SET enabled = ?, consecutive_failures = ?, next_run_at = ?, last_run_at = ?, last_status = 'failed', updated_at = ? WHERE id = ?",
      [disabled ? 0 : 1, failures, this.nextOrDisable(task, ts), ts, ts, task.id],
    );
    if (disabled) {
      await this.publish("schedule.disabled", task.id, { consecutiveFailures: failures });
    }
  }

  /** next_run_at siempre avanza desde `ahora`: sin catch-up en espiral. */
  private nextOrDisable(task: ScheduledTask, ts: number): number {
    const next = nextCronRun(task.cron, ts, task.timezone);
    return next ?? ts + 60_000;
  }

  private async advance(
    task: ScheduledTask,
    ts: number,
    update: { lastStatus: ScheduleRunStatus; failures: number },
  ): Promise<void> {
    await this.db.exec(
      "UPDATE scheduled_tasks SET consecutive_failures = ?, next_run_at = ?, last_run_at = ?, last_status = ?, updated_at = ? WHERE id = ?",
      [update.failures, this.nextOrDisable(task, ts), ts, update.lastStatus, ts, task.id],
    );
  }

  private async publish(type: string, id: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const event = await this.events.append({
        type: type as "schedule.created",
        aggregate: { kind: "schedule", id },
        correlationId: createId("cor"),
        payload,
      });
      this.bus.publish(event);
    } catch {
      // La auditoría de eventos nunca tumba el tick.
    }
  }
}
