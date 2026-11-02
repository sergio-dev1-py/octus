/** Plan octus-workbench-chat-terminal, todo 8: store de programadas.
 * Puro + CRUD contra canales stubbed (sin main real):
 * - validateCron/validateTimezone/validateScheduleInput: la entrada malformada
 *   se rechaza en cliente sin tocar IPC (malformed_input).
 * - create/setEnabled/remove invocan los canales exactos del todo 7 y
 *   refrescan la lista (stale_state); el error de backend deja el modal
 *   abierto con formError en vez de un éxito engañoso (misleading_success).
 * Solo se afirman valores máquina (null/no-null, llamadas, estado); ningún
 * texto visible se fija aquí.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  createSchedule,
  refreshScheduleRuns,
  refreshSchedules,
  removeSchedule,
  schedulesState,
  setScheduleEnabled,
  validateCron,
  validateScheduleInput,
  validateTimezone,
} from "../src/renderer/src/store/schedules.js";

type Handler = (channel: string, payload: unknown) => Promise<unknown>;
let handler: Handler = async () => ({});
const calls: Array<{ channel: string; payload: unknown }> = [];

(globalThis as unknown as { window: unknown }).window = {
  octus: {
    invoke: (channel: string, payload: unknown) => {
      calls.push({ channel, payload });
      return handler(channel, payload);
    },
    onEvent: () => () => {},
  },
};

beforeEach(() => {
  calls.length = 0;
  handler = async () => ({});
});

function okList(schedules: unknown[] = []) {
  handler = async (channel: string) => {
    if (channel === "schedules.list") return { schedules };
    if (channel === "schedules.runs") return { runs: [] };
    return { ok: true };
  };
}

describe("validateCron (espejo del core)", () => {
  test("crons válidos pasan", () => {
    for (const expr of ["* * * * *", "0 9 * * 1-5", "*/15 8-18 * * 1,2,3", "0 0 29 2 *", "30 23 * * 0", "0 0 * * 7"]) {
      expect(validateCron(expr)).toBeNull();
    }
  });
  test("malformados se rechazan sin IPC", () => {
    for (const expr of ["", "   ", "0 9 * *", "0 9 * * * *", "61 * * * *", "0 24 * * *", "0 9 0 * *", "0 9 * 13 *", "0 9 * * 8", "*/0 * * * *", "a b c d e", "5-2 * * * *", "0 9 * * MON"]) {
      expect(validateCron(expr)).not.toBeNull();
    }
    expect(calls.length).toBe(0);
  });
});

describe("validateTimezone", () => {
  test("local, vacía e IANA válida pasan", () => {
    expect(validateTimezone("local")).toBeNull();
    expect(validateTimezone("")).toBeNull();
    expect(validateTimezone("Europe/Madrid")).toBeNull();
  });
  test("zona desconocida se rechaza", () => {
    expect(validateTimezone("Nope/Zone")).not.toBeNull();
  });
});

describe("validateScheduleInput", () => {
  test("formulario completo válido", () => {
    expect(validateScheduleInput({ name: "n", prompt: "p", profile: "build", cron: "0 9 * * *", timezone: "local", enabled: true })).toBeNull();
  });
  test("nombre/prompt vacíos y cron malo se rechazan", () => {
    const base = { name: "n", prompt: "p", profile: "build" as const, cron: "0 9 * * *", timezone: "local", enabled: true };
    expect(validateScheduleInput({ ...base, name: "  " })).not.toBeNull();
    expect(validateScheduleInput({ ...base, prompt: "" })).not.toBeNull();
    expect(validateScheduleInput({ ...base, cron: "nope" })).not.toBeNull();
    expect(validateScheduleInput({ ...base, timezone: "Nope/Zone" })).not.toBeNull();
  });
});

describe("CRUD contra canales", () => {
  test("refreshSchedules llena la lista (stale_state: relectura)", async () => {
    const rows = [{ id: "a", name: "Noche", cron: "0 2 * * *", timezone: "local", enabled: true, nextRunAt: 1, consecutiveFailures: 0, profile: "build", prompt: "p", createdAt: 0, updatedAt: 0 }];
    okList(rows);
    expect(await refreshSchedules()).toBe(true);
    expect(schedulesState.schedules.length).toBe(1);
    expect(schedulesState.schedules[0]!.id).toBe("a");
    // Segunda lectura con lista vacía (evento schedule.removed): no queda viejo.
    okList([]);
    await refreshSchedules();
    expect(schedulesState.schedules.length).toBe(0);
  });

  test("crear con cron malo no toca IPC", async () => {
    okList([]);
    const ok = await createSchedule({ name: "n", prompt: "p", profile: "build", cron: "mal", timezone: "local", enabled: true });
    expect(ok).toBe(false);
    expect(calls.length).toBe(0);
    expect(schedulesState.formError).toBeString();
  });

  test("crear válido invoca create (+setEnabled si nace pausada) y refresca", async () => {
    const created = { id: "nueva", name: "N", cron: "0 9 * * *", timezone: "local", enabled: true, nextRunAt: 5, consecutiveFailures: 0, profile: "build", prompt: "p", createdAt: 0, updatedAt: 0 };
    handler = async (channel: string) => {
      if (channel === "schedules.create") return { ok: true, schedule: created };
      if (channel === "schedules.list") return { schedules: [created] };
      return { ok: true };
    };
    const { openSchedulesModal } = await import("../src/renderer/src/store/schedules.js");
    openSchedulesModal();
    const ok = await createSchedule({ name: "N", prompt: "p", profile: "build", cron: "0 9 * * *", timezone: "local", enabled: false });
    expect(ok).toBe(true);
    expect(calls.some((c) => c.channel === "schedules.create")).toBe(true);
    expect(calls.some((c) => c.channel === "schedules.setEnabled")).toBe(true);
    expect(schedulesState.modalOpen).toBe(false);
    expect(schedulesState.schedules.length).toBe(1);
  });

  test("error de backend no finge éxito: modal abierto + formError", async () => {
    handler = async (channel: string) => {
      if (channel === "schedules.create") return { ok: false, error: "boom" };
      return { schedules: [] };
    };
    const { openSchedulesModal } = await import("../src/renderer/src/store/schedules.js");
    openSchedulesModal();
    const ok = await createSchedule({ name: "N", prompt: "p", profile: "plan", cron: "0 9 * * *", timezone: "", enabled: true });
    expect(ok).toBe(false);
    expect(schedulesState.modalOpen).toBe(true);
    expect(schedulesState.formError).toBeString();
  });

  test("toggle y borrado invocan su canal y refrescan", async () => {
    okList([]);
    expect(await setScheduleEnabled("x", false)).toBe(true);
    expect(calls[calls.length - 2]!.channel).toBe("schedules.setEnabled");
    expect(calls[calls.length - 1]!.channel).toBe("schedules.list");
    expect(await removeSchedule("x")).toBe(true);
    expect(calls[calls.length - 2]!.channel).toBe("schedules.remove");
  });

  test("historial: runs por tarea; fallo deja lista vacía", async () => {
    const runs = [{ id: "r1", taskId: "t", status: "fired", scheduledAt: 1, firedAt: 2, createdAt: 2 }];
    handler = async (channel: string) => {
      if (channel === "schedules.runs") return { runs };
      return { schedules: [] };
    };
    await refreshScheduleRuns("t");
    expect(schedulesState.runsByTask["t"]!.length).toBe(1);
    handler = async () => {
      throw new Error("caído");
    };
    await refreshScheduleRuns("t");
    expect(schedulesState.runsByTask["t"]!.length).toBe(0);
  });
});
