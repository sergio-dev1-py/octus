/** Renderer/views — tareas programadas (plan octus-workbench-chat-terminal, todo 8).
 * Sección del sidebar (lista, toggle de activación, próxima ejecución) +
 * ventana de configuración (nombre, prompt, perfil, cron, zona, activada) +
 * historial de disparos por tarea. Consume solo el store/schedules.ts y los
 * canales `schedules.*` del todo 7; reutiliza los patrones de
 * TasksSection (card + pills) e IntegrationHistorySection (details + lista).
 * Sin literales de diseño: clases legacy del sidebar y oc-* del modal, ambas
 * sobre var(--oc-*). */
import { For, Show, createEffect, createSignal } from "solid-js";
import type { ScheduleProfile, ScheduleRunStatus } from "@octus/shared";
import {
  closeSchedulesModal,
  createSchedule,
  formatNextRun,
  openSchedulesModal,
  refreshScheduleRuns,
  refreshSchedules,
  removeSchedule,
  schedulesState,
  setScheduleEnabled,
  validateCron,
  type ScheduleFormInput,
} from "../store/schedules.js";

function runPill(status: ScheduleRunStatus): string {
  return status === "fired" ? "ok" : status === "failed" ? "err" : "warn";
}

function runLabel(status: ScheduleRunStatus): string {
  return status === "fired" ? "disparada" : status === "failed" ? "fallida" : "omitida (solape)";
}

function formatInstant(ms: number): string {
  if (!ms || ms <= 0) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

/** Historial de disparos de una tarea (details colapsable, como IntegrationHistorySection). */
export function ScheduleHistory(props: { taskId: string }) {
  const [open, setOpen] = createSignal(false);
  const runs = () => schedulesState.runsByTask[props.taskId];
  const toggle = () => {
    const next = !open();
    setOpen(next);
    if (next) void refreshScheduleRuns(props.taskId);
  };
  return (
    <details data-schedule-history={props.taskId} open={open()} onToggle={(e) => e.preventDefault()}>
      <summary
        role="button"
        tabIndex={0}
        aria-expanded={open()}
        onClick={(e) => {
          e.preventDefault();
          toggle();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
      >
        Historial ({runs()?.length ?? "…"})
      </summary>
      <Show when={open()}>
        <Show when={runs() !== undefined} fallback={<p class="muted">Cargando historial…</p>}>
          <Show when={(runs() ?? []).length > 0} fallback={<p class="muted">Sin disparos registrados todavía.</p>}>
            <ol>
              <For each={runs() ?? []}>
                {(run) => (
                  <li data-history-run={`${props.taskId}:${run.id}`}>
                    <span class={`pill ${runPill(run.status)}`}>{runLabel(run.status)}</span>{" "}
                    <span class="muted">
                      programada {formatInstant(run.scheduledAt)} · ejecutada {formatInstant(run.firedAt)}
                    </span>
                    <Show when={run.sessionId}>
                      <span class="muted">
                        {" "}· sesión <code>{run.sessionId!.slice(0, 8)}</code>
                      </span>
                    </Show>
                    <Show when={run.error}>
                      <p class="muted">error: {run.error}</p>
                    </Show>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </Show>
      </Show>
    </details>
  );
}

/** Ventana de configuración rápida (la gestión completa vive en Ajustes › Programadas). */
export function SchedulesModal() {
  const [name, setName] = createSignal("");
  const [prompt, setPrompt] = createSignal("");
  const [profile, setProfile] = createSignal<ScheduleProfile>("build");
  const [cron, setCron] = createSignal("");
  const [timezone, setTimezone] = createSignal("local");
  const [enabled, setEnabled] = createSignal(true);
  const cronError = () => (cron().trim().length === 0 ? null : validateCron(cron()));
  const save = () => {
    const input: ScheduleFormInput = {
      name: name(),
      prompt: prompt(),
      profile: profile(),
      cron: cron(),
      timezone: timezone(),
      enabled: enabled(),
      once: false,
      maxRuns: null,
    };
    void createSchedule(input).then((ok) => {
      if (ok) {
        setName("");
        setPrompt("");
        setCron("");
      }
    });
  };
  return (
    <Show when={schedulesState.modalOpen}>
      <div class="oc-dialog-backdrop" data-schedules-backdrop>
        <div class="oc-dialog" id="schedules-modal" role="dialog" aria-modal="true" aria-labelledby="schedules-modal-title">
          <div class="oc-dialog__head">
            <h2 class="oc-dialog__title" id="schedules-modal-title">Nueva tarea programada</h2>
            <button type="button" class="oc-btn oc-btn--ghost" id="schedules-cancel-top" aria-label="Cerrar" onClick={closeSchedulesModal}>
              ×
            </button>
          </div>
          <div class="oc-dialog__body">
            <Show when={schedulesState.formError}>
              <p class="oc-banner oc-banner--err" id="schedules-form-error" role="alert">
                {schedulesState.formError}
              </p>
            </Show>
            <label class="muted" for="schedules-name">
              Nombre
              <input
                id="schedules-name"
                class="oc-input"
                value={name()}
                placeholder="Resumen nocturno"
                onInput={(e) => setName(e.currentTarget.value)}
              />
            </label>
            <label class="muted" for="schedules-prompt">
              Prompt (corre como sesión nueva en scheduled_tasks)
              <textarea
                id="schedules-prompt"
                class="oc-textarea"
                value={prompt()}
                placeholder="Resume el estado del proyecto y propón el siguiente paso."
                onInput={(e) => setPrompt(e.currentTarget.value)}
              />
            </label>
            <div class="row">
              <label class="muted" for="schedules-profile">
                Perfil
                <select id="schedules-profile" class="oc-select" value={profile()} onChange={(e) => setProfile(e.currentTarget.value as ScheduleProfile)}>
                  <option value="build">build</option>
                  <option value="plan">plan</option>
                </select>
              </label>
              <label class="muted" for="schedules-timezone">
                Zona horaria
                <input
                  id="schedules-timezone"
                  class="oc-input"
                  value={timezone()}
                  placeholder="local"
                  onInput={(e) => setTimezone(e.currentTarget.value)}
                />
              </label>
            </div>
            <label class="muted" for="schedules-cron">
              Cron (5 campos: min hora dom mes dow)
              <input
                id="schedules-cron"
                class="oc-input"
                value={cron()}
                placeholder="0 9 * * 1-5"
                aria-invalid={cronError() ? "true" : "false"}
                aria-describedby="schedules-cron-error"
                onInput={(e) => setCron(e.currentTarget.value)}
              />
            </label>
            <Show when={cronError()}>
              <p class="oc-banner oc-banner--warn" id="schedules-cron-error" role="alert">
                {cronError()}
              </p>
            </Show>
            <label class="muted row" for="schedules-enabled">
              <input
                id="schedules-enabled"
                class="oc-check"
                type="checkbox"
                checked={enabled()}
                onChange={(e) => setEnabled(e.currentTarget.checked)}
              />{" "}
              Activada
            </label>
          </div>
          <div class="oc-dialog__actions">
            <button type="button" class="oc-btn oc-btn--ghost" id="schedules-cancel" onClick={closeSchedulesModal}>
              Cancelar
            </button>
            <button
              type="button"
              class="oc-btn oc-btn--primary"
              id="schedules-save"
              disabled={schedulesState.saving}
              onClick={save}
            >
              {schedulesState.saving ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

/** Sección del sidebar: contador vivo, toggle, próxima ejecución e historial. */
export function SchedulesSection() {
  const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null);
  createEffect(() => {
    void refreshSchedules();
  });
  const active = () => schedulesState.schedules.filter((s) => s.enabled).length;
  const openModal = () => {
    openSchedulesModal();
    void refreshSchedules();
  };
  return (
    <section id="scheduled-tasks" aria-label="Tareas programadas">
      <h2>Tareas programadas</h2>
      <p class="muted" id="schedules-count">
        {schedulesState.loading
          ? "Cargando programadas…"
          : schedulesState.schedules.length === 0
            ? "Sin programadas todavía."
            : `${schedulesState.schedules.length} programada(s) · ${active()} activa(s)`}
      </p>
      <Show when={schedulesState.error}>
        <p class="muted" id="schedules-error">
          No se pudieron cargar: {schedulesState.error}{" "}
          <button type="button" onClick={() => void refreshSchedules()}>
            Reintentar
          </button>
        </p>
      </Show>
      <button type="button" id="schedules-open" class="primary" onClick={openModal}>
        Abrir programadas
      </button>
      <Show when={schedulesState.schedules.length > 0}>
        <div role="list" aria-label="Lista de tareas programadas">
          <For each={schedulesState.schedules}>
            {(schedule) => (
              <div class="card" role="listitem" data-schedule={schedule.id}>
                <div class="row">
                  <strong>{schedule.name}</strong>
                  <span class={`pill ${schedule.enabled ? "ok" : ""}`}>{schedule.enabled ? "activada" : "pausada"}</span>
                  <span class="pill">{schedule.profile}</span>
                </div>
                <p class="muted">
                  <code>{schedule.cron}</code> · {schedule.timezone} · próxima: {formatNextRun(schedule.nextRunAt)}
                </p>
                <Show when={schedule.consecutiveFailures > 0}>
                  <p class="muted">
                    {schedule.consecutiveFailures} fallo(s) seguido(s)
                    <Show when={schedule.lastStatus}> · último: {schedule.lastStatus}</Show>
                  </p>
                </Show>
                <div class="row">
                  <button
                    type="button"
                    data-schedule-toggle={schedule.id}
                    aria-pressed={schedule.enabled ? "true" : "false"}
                    onClick={() => void setScheduleEnabled(schedule.id, !schedule.enabled)}
                  >
                    {schedule.enabled ? "Pausar" : "Activar"}
                  </button>
                  <Show
                    when={confirmRemove() === schedule.id}
                    fallback={
                      <button type="button" class="danger" data-schedule-remove={schedule.id} onClick={() => setConfirmRemove(schedule.id)}>
                        Eliminar
                      </button>
                    }
                  >
                    <button type="button" class="danger" data-schedule-confirm={schedule.id} onClick={() => { setConfirmRemove(null); void removeSchedule(schedule.id); }}>
                      Confirmar
                    </button>
                    <button type="button" data-schedule-cancel={schedule.id} onClick={() => setConfirmRemove(null)}>
                      Atrás
                    </button>
                  </Show>
                </div>
                <ScheduleHistory taskId={schedule.id} />
              </div>
            )}
          </For>
        </div>
      </Show>
      <SchedulesModal />
    </section>
  );
}
