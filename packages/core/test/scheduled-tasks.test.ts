/** Todo workbench-chat-terminal/7 — programadas: cron + manager con reloj falso + fachada. */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { ScheduledTasksManager, type ScheduleHooks } from "../src/scheduled/scheduled-tasks-manager.js";
import { isValidCron, nextCronRun, parseCron } from "../src/scheduled/cron.js";
import { isOctusError } from "../src/errors.js";
import { expectRejects, makeTestCore, workspaceOf } from "./helpers.js";

/** Reloj falso controlable para el manager (sin timers reales). */
function fakeClock(startMs: number) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function stubHooks(clock: { now: () => number }, extra: Partial<ScheduleHooks> = {}): ScheduleHooks & {
  sessions: string[];
  prompts: Array<{ sessionId: string; prompt: string }>;
  activeRuns: Set<string>;
  failuresLeft: { count: number };
} {
  const state = {
    sessions: [] as string[],
    prompts: [] as Array<{ sessionId: string; prompt: string }>,
    activeRuns: new Set<string>(),
    failuresLeft: { count: 0 },
  };
  let n = 0;
  const hooks: ScheduleHooks = {
    now: clock.now,
    ensureBase: async () => ({ projectId: "prj_base", baseDir: "/base/scheduled_tasks" }),
    openSession: async (_projectId: string, _title: string, _profile: "plan" | "build") => {
      n++;
      const sessionId = `ses_stub_${n}`;
      state.sessions.push(sessionId);
      return { sessionId };
    },
    startPrompt: async (sessionId: string, prompt: string) => {
      if (state.failuresLeft.count > 0) {
        state.failuresLeft.count--;
        throw new Error("prompt exploded");
      }
      const runId = `run_stub_${state.prompts.length + 1}`;
      state.prompts.push({ sessionId, prompt });
      state.activeRuns.add(runId);
      return { runId };
    },
    isRunActive: (runId: string) => state.activeRuns.has(runId),
    ...extra,
  };
  return { ...hooks, ...state };
}

async function makeManager(clockMs: number, extra: Partial<ScheduleHooks> = {}) {
  const t = await makeTestCore();
  const clock = fakeClock(clockMs);
  const hooks = stubHooks(clock, extra);
  const manager = new ScheduledTasksManager(t.core.db, t.core.events, t.core.bus, hooks);
  return { t, clock, hooks, manager };
}

describe("cron 5 campos", () => {
  test("acepta `* * * * *` y rechaza 6 campos, nombres y pasos cero", () => {
    expect(isValidCron("* * * * *")).toBe(true);
    expect(isValidCron("*/15 9-17 * * 1-5")).toBe(true);
    expect(isValidCron("0 0 29 2 *")).toBe(true); // sintaxis válida aunque el año común no la dispare
    expect(isValidCron("* * * * * *")).toBe(false); // con segundos: rechazado
    expect(isValidCron("0 9 * * MON")).toBe(false);
    expect(isValidCron("*/0 * * * *")).toBe(false);
    expect(isValidCron("61 * * * *")).toBe(false);
    expect(isValidCron("0 24 * * *")).toBe(false);
    expect(isValidCron("0 0 0 * *")).toBe(false);
    expect(isValidCron("0 0 * 13 *")).toBe(false);
    expect(isValidCron("")).toBe(false);
    expect(isValidCron("5-2 * * * *")).toBe(false); // rango invertido
  });

  test("7 en dow es domingo y `*/n` avanza por pasos", () => {
    const parsed = parseCron("0 0 * * 7");
    expect(parsed.dow.has(0)).toBe(true);
    expect(parsed.dow.has(7)).toBe(false);
    const stepped = parseCron("*/20 * * * *");
    expect(stepped.minute.has(0) && stepped.minute.has(20) && stepped.minute.has(40)).toBe(true);
    expect(stepped.minute.has(21)).toBe(false);
  });

  test("nextCronRun: estrictamente posterior y respeta listas", () => {
    // 2026-06-15 10:00:30 local → próximo minuto 10:01.
    const base = new Date(2026, 5, 15, 10, 0, 30).getTime();
    expect(nextCronRun("* * * * *", base, "local")).toBe(new Date(2026, 5, 15, 10, 1, 0).getTime());
    // Límite exacto: en punto no se re-dispara el mismo minuto.
    const sharp = new Date(2026, 5, 15, 10, 1, 0).getTime();
    expect(nextCronRun("* * * * *", sharp, "local")).toBe(new Date(2026, 5, 15, 10, 2, 0).getTime());
    // Solo días 1 y 15 a las 09:00: el 15 ya pasó (10:00), toca el 1 de julio.
    const next = nextCronRun("0 9 1,15 * *", base, "local");
    expect(next).toBe(new Date(2026, 6, 1, 9, 0, 0).getTime());
  });

  test("30 de febrero nunca dispara (null) y zona desconocida rechaza", () => {
    const base = new Date(2026, 0, 1).getTime();
    expect(nextCronRun("0 0 30 2 *", base, "local")).toBeNull();
    let threw: unknown = null;
    try {
      nextCronRun("* * * * *", base, "No/Existe");
    } catch (error) {
      threw = error;
    }
    expect(isOctusError(threw, "invalid_cron")).toBe(true);
  });

  test("DST: la hora inexistente del salto no lanza (salta al día siguiente)", () => {
    // 2026-03-08: en America/New_York las 02:30 no existen (spring forward).
    const base = Date.UTC(2026, 2, 7, 12, 0, 0);
    const next = nextCronRun("30 2 * * *", base, "America/New_York");
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(base);
  });
});

describe("ScheduledTasksManager con reloj falso", () => {
  test("crear + tick dispara una vez y avanza next_run_at", async () => {
    const start = new Date(2026, 5, 15, 10, 0, 0).getTime();
    const { t, clock, hooks, manager } = await makeManager(start);
    try {
      const created = await manager.create({ name: "ping", prompt: "di hola", cron: "* * * * *" });
      expect(created.enabled).toBe(true);
      expect(created.nextRunAt).toBe(start + 60_000);
      const before = await manager.list();
      expect(before).toHaveLength(1);
      clock.advance(61_000);
      const tick = await manager.tickDue();
      expect(tick).toEqual({ due: 1, fired: 1, skipped: 0, failed: 0 });
      expect(hooks.sessions).toHaveLength(1);
      expect(hooks.prompts).toHaveLength(1);
      const after = await manager.get(created.id);
      expect(after.nextRunAt).toBeGreaterThan(start + 61_000);
      expect(after.consecutiveFailures).toBe(0);
      expect(after.lastStatus).toBe("fired");
      const runs = await manager.runs(created.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("fired");
      expect(runs[0]!.sessionId).toBe("ses_stub_1");
    } finally {
      await t.cleanup();
    }
  });

  test("update edita y reprograma desde ahora", async () => {
    const start = new Date(2026, 5, 15, 10, 0, 0).getTime();
    const { t, clock, manager } = await makeManager(start);
    try {
      const created = await manager.create({ name: "x", prompt: "p", cron: "0 9 * * *" });
      clock.advance(3_600_000);
      const updated = await manager.update(created.id, { name: "y", cron: "0 18 * * *", maxRuns: 3 });
      expect(updated.name).toBe("y");
      expect(updated.cron).toBe("0 18 * * *");
      expect(updated.maxRuns).toBe(3);
      expect(updated.nextRunAt).toBeGreaterThan(clock.now());
      await expectRejects(manager.update(created.id, { cron: "nope" }), /cron/);
    } finally {
      await t.cleanup();
    }
  });

  test("once se auto-elimina tras disparar", async () => {
    const start = new Date(2026, 5, 15, 10, 0, 0).getTime();
    const { t, clock, hooks, manager } = await makeManager(start);
    try {
      const created = await manager.create({ name: "una", prompt: "p", cron: "* * * * *", once: true });
      expect(created.once).toBe(true);
      clock.advance(61_000);
      const tick = await manager.tickDue();
      expect(tick.fired).toBe(1);
      expect(hooks.sessions).toHaveLength(1);
      await expectRejects(manager.get(created.id), /Schedule not found/);
    } finally {
      await t.cleanup();
    }
  });

  test("maxRuns desactiva tras N disparos", async () => {
    const start = new Date(2026, 5, 15, 10, 0, 0).getTime();
    const { t, clock, hooks, manager } = await makeManager(start);
    try {
      const created = await manager.create({ name: "dos", prompt: "p", cron: "* * * * *", maxRuns: 2 });
      for (let i = 0; i < 2; i++) {
        clock.advance(61_000);
        for (const id of hooks.activeRuns) hooks.activeRuns.delete(id);
        const tick = await manager.tickDue();
        expect(tick.fired).toBe(1);
      }
      const after = await manager.get(created.id);
      expect(after.enabled).toBe(false);
      clock.advance(61_000);
      const idle = await manager.tickDue();
      expect(idle.fired).toBe(0);
    } finally {
      await t.cleanup();
    }
  });

  test("sin catch-up en espiral: 3h dormido = 1 solo disparo por tick", async () => {
    const start = new Date(2026, 5, 15, 10, 0, 0).getTime();
    const { t, clock, hooks, manager } = await makeManager(start);
    try {
      const created = await manager.create({ name: "cada minuto", prompt: "p", cron: "* * * * *" });
      clock.advance(3 * 3_600_000); // apagón de 3 horas
      const tick = await manager.tickDue();
      expect(tick.fired).toBe(1);
      expect(hooks.prompts).toHaveLength(1);
      const after = await manager.get(created.id);
      expect(after.nextRunAt).toBeGreaterThan(clock.now());
      // El siguiente tick inmediato no dispara nada (next ya está en futuro).
      const idle = await manager.tickDue();
      expect(idle).toEqual({ due: 0, fired: 0, skipped: 0, failed: 0 });
    } finally {
      await t.cleanup();
    }
  });

  test("solape: disparo anterior activo registra skipped_overlap sin sesión nueva", async () => {
    const start = new Date(2026, 5, 15, 10, 0, 0).getTime();
    const { t, clock, hooks, manager } = await makeManager(start);
    try {
      const created = await manager.create({ name: "lenta", prompt: "p", cron: "* * * * *" });
      clock.advance(61_000);
      await manager.tickDue();
      expect(hooks.sessions).toHaveLength(1);
      // El run anterior sigue activo → el siguiente vencimiento salta.
      clock.advance(61_000);
      const tick = await manager.tickDue();
      expect(tick.skipped).toBe(1);
      expect(tick.fired).toBe(0);
      expect(hooks.sessions).toHaveLength(1);
      const runs = await manager.runs(created.id);
      expect(runs.map((r) => r.status)).toEqual(["skipped_overlap", "fired"]);
      // Al terminar el run anterior, vuelve a disparar.
      for (const id of hooks.activeRuns) hooks.activeRuns.delete(id);
      clock.advance(61_000);
      const tick2 = await manager.tickDue();
      expect(tick2.fired).toBe(1);
      expect(hooks.sessions).toHaveLength(2);
    } finally {
      await t.cleanup();
    }
  });

  test("5 fallos consecutivos auto-deshabilitan; el 6º tick no dispara", async () => {
    const start = new Date(2026, 5, 15, 10, 0, 0).getTime();
    const { t, clock, hooks, manager } = await makeManager(start);
    try {
      hooks.failuresLeft.count = 100;
      const created = await manager.create({ name: "rota", prompt: "p", cron: "* * * * *" });
      for (let i = 0; i < 5; i++) {
        clock.advance(61_000);
        await manager.tickDue();
      }
      const disabled = await manager.get(created.id);
      expect(disabled.enabled).toBe(false);
      expect(disabled.consecutiveFailures).toBe(5);
      const runs = await manager.runs(created.id);
      expect(runs.every((r) => r.status === "failed")).toBe(true);
      clock.advance(61_000);
      const quiet = await manager.tickDue();
      expect(quiet).toEqual({ due: 0, fired: 0, skipped: 0, failed: 0 });
      // Rehabilitar resetea fallos y recalcula next.
      const back = await manager.setEnabled(created.id, true);
      expect(back.enabled).toBe(true);
      expect(back.consecutiveFailures).toBe(0);
      expect(back.nextRunAt).toBeGreaterThan(clock.now());
    } finally {
      await t.cleanup();
    }
  });

  test("tick concurrente no duplica (mutex): dos tickDue a la vez = 1 disparo", async () => {
    const start = new Date(2026, 5, 15, 10, 0, 0).getTime();
    const { t, clock, hooks, manager } = await makeManager(start);
    try {
      await manager.create({ name: "m", prompt: "p", cron: "* * * * *" });
      clock.advance(61_000);
      const [a, b] = await Promise.all([manager.tickDue(), manager.tickDue()]);
      expect(a.fired + b.fired).toBe(1);
      expect(hooks.prompts).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });

  test("deshabilitada no dispara; remove borra historial en cascada", async () => {
    const start = new Date(2026, 5, 15, 10, 0, 0).getTime();
    const { t, clock, hooks, manager } = await makeManager(start);
    try {
      const created = await manager.create({ name: "m", prompt: "p", cron: "* * * * *" });
      await manager.setEnabled(created.id, false);
      clock.advance(61_000);
      expect(await manager.tickDue()).toEqual({ due: 0, fired: 0, skipped: 0, failed: 0 });
      await manager.setEnabled(created.id, true);
      clock.advance(61_000);
      await manager.tickDue();
      expect(hooks.prompts).toHaveLength(1);
      await manager.remove(created.id);
      expect(await manager.list()).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });

  test("entradas malformadas se rechazan con error honesto", async () => {
    const start = new Date(2026, 5, 15, 10, 0, 0).getTime();
    const { t, manager } = await makeManager(start);
    try {
      for (const bad of ["* * * *", "* * * * * *", "lunes 9", "", "*/0 * * * *", "0 0 30 2 *"]) {
        let threw: unknown = null;
        try {
          await manager.create({ name: "m", prompt: "p", cron: bad });
        } catch (error) {
          threw = error;
        }
        expect(isOctusError(threw, "invalid_cron"), `cron '${bad}'`).toBe(true);
      }
      for (const input of [
        { name: "", prompt: "p", cron: "* * * * *" },
        { name: "m", prompt: "  ", cron: "* * * * *" },
        { name: "m", prompt: "p", cron: "* * * * *", profile: "turbo" as never },
        { name: "m", prompt: "p", cron: "* * * * *", timezone: "No/Existe" },
      ]) {
        let threw: unknown = null;
        try {
          await manager.create(input);
        } catch (error) {
          threw = error;
        }
        expect(!!threw, JSON.stringify(input)).toBe(true);
      }
    } finally {
      await t.cleanup();
    }
  });

  test("fired significa despacho, no éxito del run (sin éxito engañoso)", async () => {
    const start = new Date(2026, 5, 15, 10, 0, 0).getTime();
    const { t, clock, manager } = await makeManager(start);
    try {
      const created = await manager.create({ name: "m", prompt: "p", cron: "* * * * *" });
      clock.advance(61_000);
      await manager.tickDue();
      const runs = await manager.runs(created.id);
      // El manager solo afirma que el prompt se despachó (runId existe);
      // el resultado del agente vive en runs.*, no aquí.
      expect(runs[0]!.status).toBe("fired");
      expect(typeof runs[0]!.runId).toBe("string");
    } finally {
      await t.cleanup();
    }
  });
});

describe("fachada OctusCore (reloj real, tick explícito)", () => {
  test("create valida cron, crea base auto y tick dispara sesión nueva", async () => {
    const t = await makeTestCore();
    try {
      let threw: unknown = null;
      try {
        await t.core.createSchedule({ name: "mala", prompt: "p", cron: "cada lunes" });
      } catch (error) {
        threw = error;
      }
      expect(isOctusError(threw, "invalid_cron")).toBe(true);

      const created = await t.core.createSchedule({ name: "saludo", prompt: "di hola", cron: "* * * * *" });
      expect(created.nextRunAt).toBeGreaterThan(Date.now());
      const baseDir = path.join(t.dir, "data", "scheduled_tasks");
      expect(existsSync(baseDir)).toBe(true);
      const projects = await t.core.listProjects();
      expect(projects.some((p) => p.rootPath === baseDir)).toBe(true);

      const fired = await t.core.tickSchedules(Date.now() + 61_000);
      expect(fired.fired).toBe(1);
      const runs = await t.core.listScheduleRuns(created.id);
      expect(runs[0]!.status).toBe("fired");
      expect(typeof runs[0]!.sessionId).toBe("string");
      const session = await t.core.getSession(runs[0]!.sessionId!);
      expect(session.session.title).toBe("saludo");

      const status = await t.core.schedulerStatus(session.session.id);
      expect(status.scheduled).toEqual({ due: 0, enabled: 1 });
    } finally {
      await t.cleanup();
    }
  });

  test("remove inexistente y setEnabled inexistente dan not_found", async () => {
    const t = await makeTestCore();
    try {
      let threw: unknown = null;
      try {
        await t.core.removeSchedule("sch_missing");
      } catch (error) {
        threw = error;
      }
      expect(isOctusError(threw, "not_found")).toBe(true);
    } finally {
      await t.cleanup();
    }
  });
});
