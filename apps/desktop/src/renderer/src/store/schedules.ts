/** Renderer/store — tareas programadas (plan octus-workbench-chat-terminal, todo 8).
 * Puente fino entre la vista views/schedules.tsx y el backend del todo 7:
 * canales `schedules.list/create/setEnabled/remove/runs` (verificados en main).
 * Estado propio (como store/mcp.ts) para no tocar el UIState global: la lista,
 * el historial por tarea y la ventana de configuración viven aquí.
 * Sin secretos: solo nombre, prompt, perfil, cron, zona y flags. */
import { createStore } from "solid-js/store";
import type { ScheduledRun, ScheduledTask, ScheduleProfile } from "@octus/shared";
import { invoke } from "../api.js";
import { setError } from "./state.js";

/* -------------------------------- validación visible de cron (espejo estricto
 * de packages/core/src/scheduled/cron.ts: 5 campos, mismos rangos, sin
 * segundos ni alias. El backend revalida; esto evita el viaje de ida del
 * error y muestra el motivo junto al campo antes de guardar. Solo se afirma
 * null/no-null en tests: el texto es ayuda visual, no contrato. */

const FIELD_SPECS = [
  { name: "minuto", min: 0, max: 59 },
  { name: "hora", min: 0, max: 23 },
  { name: "día del mes", min: 1, max: 31 },
  { name: "mes", min: 1, max: 12 },
  { name: "día de la semana", min: 0, max: 7 },
] as const;

const ITEM_PATTERN = /^(\*|\d+|\d+-\d+)(\/\d+)?$/;

function parseField(field: string, min: number, max: number, name: string): void {
  if (field.length === 0) throw new Error(`cron: campo '${name}' vacío`);
  for (const raw of field.split(",")) {
    const item = raw.trim();
    const match = ITEM_PATTERN.exec(item);
    if (!match) throw new Error(`cron: '${item}' no es válido en '${name}'`);
    const base = match[1]!;
    const stepText = match[2];
    let step = 1;
    if (stepText !== undefined) {
      step = Number(stepText.slice(1));
      if (!Number.isInteger(step) || step < 1) throw new Error(`cron: paso inválido en '${item}' (${name})`);
    }
    if (base === "*") continue;
    if (base.includes("-")) {
      const [aText, bText] = base.split("-") as [string, string];
      const lo = Number(aText);
      const hi = Number(bText);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
        throw new Error(`cron: rango '${item}' fuera de ${min}-${max} (${name})`);
      }
      continue;
    }
    const value = Number(base);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`cron: valor '${item}' fuera de ${min}-${max} (${name})`);
    }
  }
}

/** null si el cron de 5 campos es válido; motivo visible si no. */
export function validateCron(expr: string): string | null {
  if (typeof expr !== "string" || expr.trim().length === 0) return "cron: la expresión es obligatoria (5 campos: min hora dom mes dow)";
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return `cron: se esperan 5 campos, hay ${fields.length} (min hora dom mes dow)`;
  try {
    fields.forEach((field, i) => parseField(field, FIELD_SPECS[i]!.min, FIELD_SPECS[i]!.max, FIELD_SPECS[i]!.name));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "cron: expresión inválida";
  }
}

/** null si la zona es 'local', vacía o una zona IANA válida; motivo si no. */
export function validateTimezone(timezone: string): string | null {
  const tz = (timezone ?? "").trim();
  if (tz === "" || tz === "local") return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return null;
  } catch {
    return `cron: zona desconocida '${tz}' (usa 'local' o una zona IANA como Europe/Madrid)`;
  }
}

export interface ScheduleFormInput {
  name: string;
  prompt: string;
  profile: ScheduleProfile;
  cron: string;
  timezone: string;
  enabled: boolean;
}

/** null si el formulario puede enviarse; motivo visible (primer fallo) si no. */
export function validateScheduleInput(input: ScheduleFormInput): string | null {
  if (input.name.trim().length === 0) return "El nombre es obligatorio.";
  if (input.prompt.trim().length === 0) return "El prompt es obligatorio: describe la tarea a ejecutar.";
  const cronError = validateCron(input.cron);
  if (cronError) return cronError;
  const tzError = validateTimezone(input.timezone);
  if (tzError) return tzError;
  return null;
}

/* ------------------------------------------------------------- estado propio */

interface SchedulesState {
  schedules: ScheduledTask[];
  loading: boolean;
  error?: string;
  runsByTask: Record<string, ScheduledRun[]>;
  modalOpen: boolean;
  formError?: string;
  saving: boolean;
}

const [schedulesState, setSchedulesState] = createStore<SchedulesState>({
  schedules: [],
  loading: false,
  error: undefined,
  runsByTask: {},
  modalOpen: false,
  formError: undefined,
  saving: false,
});

export { schedulesState };

export function openSchedulesModal(): void {
  setSchedulesState("formError", undefined);
  setSchedulesState("modalOpen", true);
}

export function closeSchedulesModal(): void {
  setSchedulesState("modalOpen", false);
  setSchedulesState("formError", undefined);
  setSchedulesState("saving", false);
}

export async function refreshSchedules(): Promise<boolean> {
  setSchedulesState("loading", true);
  try {
    const { schedules } = await invoke("schedules.list", {});
    setSchedulesState("schedules", schedules);
    setSchedulesState("error", undefined);
    setError(undefined);
    return true;
  } catch (error) {
    setSchedulesState("error", error instanceof Error ? error.message : String(error));
    setSchedulesState("schedules", []);
    return false;
  } finally {
    setSchedulesState("loading", false);
  }
}

export async function createSchedule(input: ScheduleFormInput): Promise<boolean> {
  const invalid = validateScheduleInput(input);
  if (invalid) {
    setSchedulesState("formError", invalid);
    return false;
  }
  setSchedulesState("saving", true);
  try {
    const timezone = input.timezone.trim() === "" ? undefined : input.timezone.trim();
    const result = await invoke("schedules.create", {
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      profile: input.profile,
      cron: input.cron.trim(),
      timezone,
    });
    if (!result.ok) {
      setSchedulesState("formError", result.error ?? "No se pudo crear la tarea programada.");
      return false;
    }
    // La tarea nueva nace habilitada o no según el formulario: el canal
    // create no acepta enabled, así que se ajusta tras crear.
    if (result.schedule && result.schedule.enabled !== input.enabled) {
      await invoke("schedules.setEnabled", { id: result.schedule.id, enabled: input.enabled });
    }
    setSchedulesState("formError", undefined);
    closeSchedulesModal();
    await refreshSchedules();
    return true;
  } catch (error) {
    setSchedulesState("formError", error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    setSchedulesState("saving", false);
  }
}

export async function setScheduleEnabled(id: string, enabled: boolean): Promise<boolean> {
  try {
    const result = await invoke("schedules.setEnabled", { id, enabled });
    if (!result.ok) {
      setError(result.error ?? "No se pudo cambiar el estado.");
      return false;
    }
    setError(undefined);
    await refreshSchedules();
    return true;
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
    return false;
  }
}

export async function removeSchedule(id: string): Promise<boolean> {
  try {
    const result = await invoke("schedules.remove", { id });
    if (!result.ok) {
      setError(result.error ?? "No se pudo eliminar.");
      return false;
    }
    setError(undefined);
    await refreshSchedules();
    return true;
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
    return false;
  }
}

export async function refreshScheduleRuns(taskId: string): Promise<void> {
  try {
    const { runs } = await invoke("schedules.runs", { taskId, limit: 20 });
    setSchedulesState("runsByTask", taskId, runs);
  } catch {
    setSchedulesState("runsByTask", taskId, []);
  }
}

/** Próxima ejecución legible; "—" si el manager aún no la calculó. */
export function formatNextRun(nextRunAt: number): string {
  if (!nextRunAt || nextRunAt <= 0) return "—";
  try {
    return new Date(nextRunAt).toLocaleString();
  } catch {
    return "—";
  }
}
