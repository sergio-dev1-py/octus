/** Renderer/views — vista de ajustes: modal por secciones (Todo 4). */
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { ScheduleProfile } from "@octus/shared";
import { invoke } from "../api.js";
import {
  setError,
  setLayoutActivity,
  setUiPrefs,
  setView,
  state,
} from "../store.js";
import {
  disableSkill,
  enableSkill,
  importSkillFromFolder,
  importSkillFromZip,
  installSkillFromGit,
  refreshSkillsCatalog,
  uninstallSkill,
} from "../store/skills.js";
import { mcpRefresh, mcpState } from "../store/mcp.js";
import {
  createSchedule,
  formatNextRun,
  refreshSchedules,
  removeSchedule,
  schedulesState,
  setScheduleEnabled,
  updateSchedule,
  type ScheduleFormInput,
} from "../store/schedules.js";
import { ProviderSettings } from "./sections.jsx";

export function AgentSettings() {
  let maxSession: HTMLInputElement | undefined;
  let maxProject: HTMLInputElement | undefined;
  let maxDepth: HTMLInputElement | undefined;
  const modelInputs: Record<string, { provider?: HTMLInputElement; model?: HTMLInputElement; effort?: HTMLInputElement }> = {};
  return (
    <section>
      <h2>Agents</h2>
      <div class="card">
        <h3>Concurrency limits</h3>
        <div class="row">
          <label class="muted">
            per session
            <input ref={maxSession} type="number" min="1" max="100" value={state.agentLimits.maxPerSession} />
          </label>
          <label class="muted">
            per project
            <input ref={maxProject} type="number" min="1" max="100" value={state.agentLimits.maxPerProject} />
          </label>
          <label class="muted">
            max depth
            <input ref={maxDepth} type="number" min="1" max="10" value={state.agentLimits.maxDepth} />
          </label>
          <button
            type="button"
            class="primary"
            onClick={() => {
              void (async () => {
                const limits = {
                  maxPerSession: Number.parseInt(maxSession?.value ?? "", 10),
                  maxPerProject: Number.parseInt(maxProject?.value ?? "", 10),
                  maxDepth: Number.parseInt(maxDepth?.value ?? "", 10),
                };
                const result = await invoke("agents.setLimits", { limits });
                if (!result.ok) setError(result.error ?? "Could not save limits");
                else setError(undefined);
              })();
            }}
          >
            Save limits
          </button>
        </div>
      </div>
      <For each={state.definitions}>
        {(definition) => (
          <div class="card">
            <h3>
              <code>{definition.id}</code> <span class="muted">{definition.kind}</span>
            </h3>
            <p class="muted">{definition.description}</p>
            <p class="muted">
              default: <code>{definition.defaultModel.providerId}/{definition.defaultModel.modelId}</code>
              {definition.defaultModel.effort ? ` effort=${definition.defaultModel.effort}` : ""} · tools={definition.tools.length} · prompt v{definition.promptVersion}
            </p>
            <div class="row">
              <input ref={(el) => ((modelInputs[definition.id] ??= {}).provider = el)} placeholder="providerId" value={definition.defaultModel.providerId} />
              <input ref={(el) => ((modelInputs[definition.id] ??= {}).model = el)} placeholder="modelId" value={definition.defaultModel.modelId} />
              <input ref={(el) => ((modelInputs[definition.id] ??= {}).effort = el)} placeholder="effort (optional)" value={definition.defaultModel.effort ?? ""} />
              <button
                type="button"
                class="primary"
                onClick={() => {
                  void (async () => {
                    const entry = modelInputs[definition.id] ?? {};
                    const providerId = entry.provider?.value.trim() ?? "";
                    const modelId = entry.model?.value.trim() ?? "";
                    const effort = entry.effort?.value.trim() || undefined;
                    if (!providerId || !modelId) {
                      setError("providerId and modelId are required");
                      return;
                    }
                    const result = await invoke("agents.setDefinitionModel", { definitionId: definition.id, model: { providerId, modelId, effort } });
                    if (!result.ok) setError(result.error ?? "Could not save model");
                    else setError(undefined);
                  })();
                }}
              >
                Save model
              </button>
            </div>
          </div>
        )}
      </For>
    </section>
  );
}

export function ProjectSettings() {
  let dirKind: HTMLSelectElement | undefined;
  let testJson: HTMLTextAreaElement | undefined;
  let trustedInput: HTMLInputElement | undefined;
  const projectId = () => state.activeProjectId;
  return (
    <section>
      <h2>Project: {state.projects.find((p) => p.id === state.activeProjectId)?.name ?? "—"}</h2>
      <Show when={!projectId()}>
        <p class="muted">Select a project to manage isolated directories, tests and trusted instructions.</p>
      </Show>
      <Show when={projectId()}>
        <div class="card">
          <h3>Isolated directories (implementer scope)</h3>
          <For each={state.isolatedDirs}>
            {(dir) => (
              <div class="row">
                <code>{dir.path}</code>
                <span class="pill">{dir.kind}</span>
                <Show when={dir.branch}>
                  <span class="muted">{dir.branch}</span>
                </Show>
                <button
                  class="danger"
                  onClick={() => {
                    void (async () => {
                      const result = await invoke("projects.removeIsolatedDir", { id: dir.id });
                      if (!result.ok) setError(result.error ?? "Could not remove directory");
                    })();
                  }}
                >
                  Remove
                </button>
              </div>
            )}
          </For>
          <div class="row">
            <select ref={dirKind}>
              <option value="directory">directory</option>
              <option value="worktree">worktree</option>
            </select>
            <button
              class="primary"
              onClick={() => {
                void (async () => {
                  const picked = await invoke("app.pickDirectory", {});
                  if (!picked.path || !projectId()) return;
                  const result = await invoke("projects.addIsolatedDir", { projectId: projectId()!, path: picked.path, kind: (dirKind?.value ?? "directory") as "directory" | "worktree" });
                  if (!result.ok) setError(result.error ?? "Could not add directory");
                  else setError(undefined);
                })();
              }}
            >
              Add directory
            </button>
          </div>
        </div>
        <div class="card">
          <h3>Reviewer test allowlist (JSON array)</h3>
          <p class="muted">Each entry: {"{ \"id\", \"name\", \"argv\": [\"exe\", \"arg\", …] }"}. Commands run in a disposable copy, never on worker files.</p>
          <textarea ref={testJson} placeholder='[{"id":"unit","name":"unit","argv":["bun","test"]}]' value={JSON.stringify(state.testAllowlist)} />
          <div class="row">
            <button
              class="primary"
              onClick={() => {
                void (async () => {
                  if (!projectId()) return;
                  let entries: Array<{ id: string; name: string; argv: string[] }>;
                  try {
                    entries = JSON.parse(testJson?.value || "[]");
                  } catch {
                    setError("Test allowlist is not valid JSON");
                    return;
                  }
                  const result = await invoke("projects.saveTestAllowlist", { projectId: projectId()!, entries });
                  if (!result.ok) setError(result.error ?? "Could not save allowlist");
                  else setError(undefined);
                })();
              }}
            >
              Save allowlist
            </button>
          </div>
          <ul>
            <For each={state.testAllowlist}>
              {(entry) => (
                <li>
                  <code>{entry.id}</code> {entry.name} — <code>{entry.argv.join(" ")}</code>
                </li>
              )}
            </For>
          </ul>
        </div>
        <div class="card">
          <h3>Trusted instruction files</h3>
          <p class="muted">Only these workspace-relative files become system instructions. Everything else is untrusted.</p>
          <div class="row">
            <input ref={trustedInput} placeholder="OCTUS.md, notes.md" value={state.trustedFiles.join(", ")} />
            <button
              class="primary"
              onClick={() => {
                void (async () => {
                  if (!projectId()) return;
                  const files = (trustedInput?.value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
                  const result = await invoke("projects.saveTrustedInstructions", { projectId: projectId()!, files });
                  if (!result.ok) setError(result.error ?? "Could not save trusted files");
                  else setError(undefined);
                })();
              }}
            >
              Save
            </button>
          </div>
          <p class="muted">Current: {state.trustedFiles.join(", ") || "—"}</p>
        </div>
      </Show>
    </section>
  );
}

export function AppearanceSettings() {
  return (
    <section>
      <h2>Appearance</h2>
      <div class="row">
        <label for="prefs-theme">Theme</label>
        <select id="prefs-theme" value={state.prefs.theme} onChange={(e) => void setUiPrefs({ theme: e.currentTarget.value as "light" | "dark" | "system" })}>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="system">System</option>
        </select>
        <label for="prefs-density">Density</label>
        <select id="prefs-density" value={state.prefs.density} onChange={(e) => void setUiPrefs({ density: e.currentTarget.value as "compact" | "normal" | "comfortable" })}>
          <option value="compact">Compact</option>
          <option value="normal">Normal</option>
          <option value="comfortable">Comfortable</option>
        </select>
        <label for="prefs-font-size">Size</label>
        <select id="prefs-font-size" value={state.prefs.fontSize} onChange={(e) => void setUiPrefs({ fontSize: Number(e.currentTarget.value) })}>
          <option value="12">12</option>
          <option value="13">13</option>
          <option value="14">14</option>
          <option value="15">15</option>
          <option value="16">16</option>
          <option value="17">17</option>
          <option value="18">18</option>
        </select>
      </div>
    </section>
  );
}

export function ShortcutsSettings() {
  const rows: Array<[string, string]> = [
    ["Ctrl+B", "Mostrar u ocultar el panel lateral"],
    ["Ctrl+J", "Mostrar u ocultar la terminal"],
    ["Ctrl+Alt+I", "Mostrar u ocultar el inspector"],
    ["Ctrl+0", "Restablecer el diseño del workbench"],
    ["Shift+Tab (en el input)", "Alternar perfil plan/build"],
    ["Enter", "Enviar mensaje"],
    ["Shift+Enter", "Salto de línea"],
  ];
  return (
    <section aria-label="Atajos de teclado">
      <h2>Atajos de teclado</h2>
      <ul class="shortcuts-list">
        <For each={rows}>
          {([keys, action]) => (
            <li>
              <code>{keys}</code> <span class="muted">{action}</span>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

export function SkillsSettingsSection() {
  onMount(() => {
    void refreshSkillsCatalog();
  });
  let folderInput: HTMLInputElement | undefined;
  let zipInput: HTMLInputElement | undefined;
  let gitRepoInput: HTMLInputElement | undefined;
  let gitRefInput: HTMLInputElement | undefined;
  const enabled = () => state.skillsCatalog.filter((s) => s.enabled);
  const available = () => state.skillsCatalog.filter((s) => !s.enabled);
  const dot = (on: boolean): string =>
    on
      ? "display:inline-block;flex-shrink:0;width:10px;height:10px;border-radius:9999px;background:var(--oc-success);"
      : "display:inline-block;flex-shrink:0;width:10px;height:10px;border-radius:9999px;background:var(--oc-border-strong);";
  return (
    <section aria-label="Skills">
      <h2>Skills</h2>
      <p class="muted">Las activas las puede usar el agente con @ en el input; las disponibles hay que habilitarlas primero.</p>
      <Show when={state.skillsNotice}>
        <p class="muted" role="status">{state.skillsNotice}</p>
      </Show>
      <h3>Activas ({enabled().length})</h3>
      <Show when={enabled().length > 0} fallback={<p class="muted">Ninguna activa. Habilita una de abajo.</p>}>
        <ul>
          <For each={enabled()}>
            {(skill) => (
              <li>
                <span aria-hidden="true" style={dot(true)} title="Activa" /> <code>{skill.name}</code>{" "}
                <span class="muted">{skill.description}</span>{" "}
                <button type="button" onClick={() => void disableSkill(skill.name)}>
                  Desactivar
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <h3>Disponibles ({available().length})</h3>
      <Show when={available().length > 0} fallback={<p class="muted">No hay más skills en el catálogo.</p>}>
        <ul>
          <For each={available()}>
            {(skill) => (
              <li>
                <span aria-hidden="true" style={dot(false)} title="Inactiva" /> <code>{skill.name}</code>{" "}
                <span class="muted">{skill.description}</span>{" "}
                <button type="button" class="primary" disabled={!skill.installed} onClick={() => void enableSkill(skill.name)}>
                  Activar
                </button>
                <Show when={skill.installed}>
                  <button type="button" class="danger" onClick={() => void uninstallSkill(skill.name)}>
                    Desinstalar
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <h3>Agregar manual</h3>
      <div class="row">
        <input ref={folderInput} placeholder="Carpeta de la skill" aria-label="Carpeta de la skill" />
        <button type="button" onClick={() => void importSkillFromFolder(folderInput?.value ?? "")}>
          Importar carpeta
        </button>
      </div>
      <div class="row">
        <input ref={zipInput} placeholder="Ruta del zip" aria-label="Ruta del zip" />
        <button type="button" onClick={() => void importSkillFromZip(zipInput?.value ?? "")}>
          Importar zip
        </button>
      </div>
      <div class="row">
        <input ref={gitRepoInput} placeholder="Repo git URL" aria-label="Repo git URL" />
        <input ref={gitRefInput} placeholder="ref (tag/commit)" aria-label="ref" />
        <button type="button" onClick={() => void installSkillFromGit(gitRepoInput?.value ?? "", gitRefInput?.value ?? "")}>
          Instalar git
        </button>
      </div>
    </section>
  );
}

export function McpSettingsSection() {
  onMount(() => {
    if (state.activeProjectId) void mcpRefresh(state.activeProjectId);
  });
  const dot = (on: boolean): string =>
    on
      ? "display:inline-block;flex-shrink:0;width:10px;height:10px;border-radius:9999px;background:var(--oc-success);"
      : "display:inline-block;flex-shrink:0;width:10px;height:10px;border-radius:9999px;background:var(--oc-border-strong);";
  const isUp = (s: (typeof mcpState.servers)[number]) => s.enabled && s.connection === "connected";
  return (
    <section aria-label="MCP">
      <h2>MCP</h2>
      <p class="muted">Servidores instalados. El agente los usa a través del gestor.</p>
      <Show when={mcpState.servers.length > 0} fallback={<p class="muted">Sin servidores MCP instalados.</p>}>
        <ul>
          <For each={mcpState.servers}>
            {(server) => (
              <li>
                <span aria-hidden="true" style={dot(isUp(server))} title={isUp(server) ? "Activo" : "Inactivo"} />{" "}
                <code>{server.name}</code>{" "}
                <span class="muted">
                  {server.enabled ? (isUp(server) ? `activo · ${server.tools.length} tools` : "habilitado · sin conexión") : "deshabilitado"}
                  {server.lastError ? ` · ${server.lastError}` : ""}
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="row">
        <button
          type="button"
          class="primary"
          onClick={() => {
            setView("chat");
            void setLayoutActivity("skills-mcp");
          }}
        >
          Abrir gestor MCP
        </button>
      </div>
    </section>
  );
}

export function SchedulesSettingsSection() {
  onMount(() => {
    void refreshSchedules();
  });
  const [editingId, setEditingId] = createSignal<string | undefined>(undefined);
  const [when, setWhen] = createSignal<"once" | "minutes" | "hourly" | "daily" | "weekdays" | "weekly" | "custom">("daily");
  const [confirmRemove, setConfirmRemove] = createSignal<string | undefined>(undefined);
  let nameInput: HTMLInputElement | undefined;
  let promptInput: HTMLTextAreaElement | undefined;
  let profileInput: HTMLSelectElement | undefined;
  let customCronInput: HTMLInputElement | undefined;
  let minutesInput: HTMLInputElement | undefined;
  let timeInput: HTMLInputElement | undefined;
  let maxRunsInput: HTMLInputElement | undefined;

  const cronFor = (): string => {
    const [hh, mm] = (timeInput?.value || "09:00").split(":").map((n) => Number.parseInt(n, 10));
    const h = Number.isFinite(hh) ? hh : 9;
    const m = Number.isFinite(mm) ? mm : 0;
    switch (when()) {
      case "once":
      case "daily":
        return `${m} ${h} * * *`;
      case "weekdays":
        return `${m} ${h} * * 1-5`;
      case "weekly":
        return `${m} ${h} * * 1`;
      case "hourly":
        return `0 * * * *`;
      case "minutes": {
        const n = Math.max(1, Math.min(59, Number.parseInt(minutesInput?.value || "30", 10) || 30));
        return `*/${n} * * * *`;
      }
      case "custom":
        return (customCronInput?.value || "").trim();
    }
  };

  const startEdit = (id: string) => {
    const task = schedulesState.schedules.find((s) => s.id === id);
    if (!task) return;
    setEditingId(id);
    if (nameInput) nameInput.value = task.name;
    if (promptInput) promptInput.value = task.prompt;
    if (profileInput) profileInput.value = task.profile;
    if (maxRunsInput) maxRunsInput.value = task.maxRuns?.toString() ?? "";
    setWhen("custom");
    if (customCronInput) customCronInput.value = task.cron;
  };

  const cancelEdit = () => {
    setEditingId(undefined);
    if (nameInput) nameInput.value = "";
    if (promptInput) promptInput.value = "";
  };

  const save = () => {
    const input = {
      name: nameInput?.value ?? "",
      prompt: promptInput?.value ?? "",
      profile: (profileInput?.value ?? "build") as ScheduleProfile,
      cron: cronFor(),
      timezone: "local",
      enabled: true,
      once: when() === "once",
      maxRuns: maxRunsInput?.value.trim() ? Number.parseInt(maxRunsInput.value, 10) : null,
    };
    if (editingId()) {
      void updateSchedule(editingId()!, input).then((ok) => {
        if (ok) cancelEdit();
      });
    } else {
      void createSchedule(input as ScheduleFormInput);
    }
  };

  const templates: Array<{ title: string; hint: string; prompt: string; preset: "daily" | "minutes" }> = [
    { title: "Resumen matinal", hint: "Diario a las 9:00", prompt: "Resume el estado del proyecto: qué cambió ayer, qué está roto y cuál es el siguiente paso.", preset: "daily" },
    { title: "Revisar CI cada 30 min", hint: "Cada 30 minutos", prompt: "Revisa si hay fallos de CI o tests rotos y repórtalos con evidencia.", preset: "minutes" },
    { title: "Recordatorio diario", hint: "Diario a las 9:00", prompt: "Recuérdame los pendientes abiertos del proyecto.", preset: "daily" },
  ];
  const applyTemplate = (preset: "daily" | "minutes", prompt: string) => {
    setWhen(preset);
    if (promptInput) promptInput.value = prompt;
    promptInput?.focus();
  };

  return (
    <section aria-label="Tareas programadas">
      <h2>Programadas</h2>
      <p class="muted">
        Se ejecutan en segundo plano con el horario de este equipo mientras la app está abierta: cada disparo abre una sesión nueva con el agente build, sin restricciones, y hace el trabajo del mensaje.
      </p>
      <Show when={schedulesState.schedules.length > 0} fallback={<p class="muted">Nada programado todavía.</p>}>
        <ul>
          <For each={schedulesState.schedules}>
            {(task) => (
              <li data-schedule={task.id}>
                <span aria-hidden="true" style={task.enabled ? "display:inline-block;width:10px;height:10px;border-radius:9999px;background:var(--oc-success);" : "display:inline-block;width:10px;height:10px;border-radius:9999px;background:var(--oc-border-strong);"} title={task.enabled ? "Activa" : "Pausada"} />{" "}
                <strong>{task.name}</strong> <span class="pill">{task.profile}</span>{" "}
                {task.enabled ? <span class="pill ok">activa</span> : <span class="pill">pausada</span>}{" "}
                {task.once ? <span class="pill">una vez</span> : null}
                {task.maxRuns ? <span class="pill">máx {task.maxRuns}</span> : null}
                <p class="muted">
                  <code>{task.cron}</code> · próxima: {formatNextRun(task.nextRunAt)}
                </p>
                <div class="row">
                  <button type="button" onClick={() => void setScheduleEnabled(task.id, !task.enabled)}>
                    {task.enabled ? "Pausar" : "Reanudar"}
                  </button>
                  <button type="button" onClick={() => startEdit(task.id)}>
                    Editar
                  </button>
                  <Show when={confirmRemove() === task.id} fallback={
                    <button type="button" class="danger" onClick={() => setConfirmRemove(task.id)}>
                      Eliminar
                    </button>
                  }>
                    <button type="button" class="danger" onClick={() => { setConfirmRemove(undefined); void removeSchedule(task.id); }}>
                      Confirmar
                    </button>
                    <button type="button" onClick={() => setConfirmRemove(undefined)}>
                      Atrás
                    </button>
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <h3>{editingId() ? "Editar tarea" : "Nueva tarea"}</h3>
      <div class="row" style={{ "align-items": "stretch" }}>
        <For each={templates}>
          {(template) => (
            <button type="button" class="card" style={{ "text-align": "left", "flex": "1" }} title={template.hint} onClick={() => applyTemplate(template.preset, template.prompt)}>
              <strong>{template.title}</strong>
              <p class="muted">{template.hint}</p>
            </button>
          )}
        </For>
      </div>
      <div class="card">
        <label class="muted">
          Hilo
          <select disabled aria-label="Hilo">
            <option>Nueva conversación</option>
          </select>
        </label>
        <label class="muted">
          Título
          <input ref={nameInput} placeholder="Opcional: primeras palabras del mensaje" aria-label="Título" />
        </label>
        <label class="muted">
          Mensaje
          <textarea ref={promptInput} rows={3} placeholder="¿Qué debe hacer el hilo?" aria-label="Mensaje" />
        </label>
        <div class="row">
          <label class="muted">
            Perfil
            <select ref={profileInput} aria-label="Perfil">
              <option value="build">build</option>
              <option value="plan">plan</option>
            </select>
          </label>
          <label class="muted">
            Cuándo
            <select value={when()} onChange={(e) => setWhen(e.currentTarget.value as ReturnType<typeof when>)} aria-label="Cuándo">
              <option value="once">Una vez</option>
              <option value="minutes">Cada N minutos</option>
              <option value="hourly">Cada hora</option>
              <option value="daily">Diario</option>
              <option value="weekdays">Días laborables</option>
              <option value="weekly">Semanal</option>
              <option value="custom">Personalizado (cron)</option>
            </select>
          </label>
          <Show when={when() === "minutes"}>
            <label class="muted">
              Cada (min)
              <input ref={minutesInput} type="number" min={1} max={59} value="30" aria-label="Cada cuántos minutos" />
            </label>
          </Show>
          <Show when={when() !== "minutes" && when() !== "hourly" && when() !== "custom"}>
            <label class="muted">
              Hora
              <input ref={timeInput} type="time" value="09:00" aria-label="Hora" />
            </label>
          </Show>
          <label class="muted">
            Parar tras (runs, vacío = sin límite)
            <input ref={maxRunsInput} type="number" min={1} placeholder="Sin límite" aria-label="Parar tras N runs" />
          </label>
        </div>
        <Show when={when() === "custom"}>
          <label class="muted">
            Cron (5 campos)
            <input ref={customCronInput} placeholder="0 9 * * 1-5" aria-label="Cron personalizado" />
          </label>
        </Show>
        <Show when={schedulesState.formError}>
          <p class="banner err" role="alert">{schedulesState.formError}</p>
        </Show>
        <div class="row">
          <Show when={editingId()} fallback={
            <button type="button" class="primary" disabled={schedulesState.saving} onClick={save}>
              {schedulesState.saving ? "Guardando…" : "Guardar tarea"}
            </button>
          }>
            <button type="button" class="primary" disabled={schedulesState.saving} onClick={save}>
              {schedulesState.saving ? "Guardando…" : "Guardar cambios"}
            </button>
            <button type="button" onClick={cancelEdit}>
              Cancelar
            </button>
          </Show>
        </div>
      </div>
    </section>
  );
}

export function SettingsView(props: { onClose?: () => void } = {}) {
  // Modal Ajustes: cabecera con X + nav lateral. La sección sigue a
  // state.settingsSection (los botones del sidebar navegan directo a ella).
  type Section = "providers" | "agents" | "shortcuts" | "skills" | "mcp" | "schedules";
  const [section, setSection] = createSignal<Section>("providers");
  createEffect(() => {
    setSection(state.settingsSection as Section);
  });
  onMount(() => {
    setSection(state.settingsSection as "providers" | "agents" | "shortcuts" | "skills" | "mcp" | "schedules");
    if (typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });
  return (
    <div
      id="settings-overlay"
      class="oc-settings-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose?.();
      }}
    >
      <div id="settings-modal" class="oc-settings-dialog" role="dialog" aria-modal="true" aria-label="Ajustes">
        <div class="oc-settings-head">
          <h2 class="oc-settings-title">Ajustes</h2>
          <Show when={props.onClose}>
            <button
              id="settings-close"
              type="button"
              class="oc-btn oc-btn--ghost"
              aria-label="Cerrar ajustes"
              onClick={() => props.onClose?.()}
            >
              ×
            </button>
          </Show>
        </div>
        <div class="oc-settings-body">
          <nav class="oc-settings-nav" aria-label="Secciones de ajustes">
            <button
              id="settings-nav-providers"
              type="button"
              aria-selected={section() === "providers" ? "true" : "false"}
              onClick={() => setSection("providers")}
            >
              Proveedores
            </button>
            <button
              id="settings-nav-agents"
              type="button"
              aria-selected={section() === "agents" ? "true" : "false"}
              onClick={() => setSection("agents")}
            >
              Agentes
            </button>
            <button
              id="settings-nav-shortcuts"
              type="button"
              aria-selected={section() === "shortcuts" ? "true" : "false"}
              onClick={() => setSection("shortcuts")}
            >
              Atajos
            </button>
            <button
              id="settings-nav-skills"
              type="button"
              aria-selected={section() === "skills" ? "true" : "false"}
              onClick={() => setSection("skills")}
            >
              Skills
            </button>
            <button
              id="settings-nav-mcp"
              type="button"
              aria-selected={section() === "mcp" ? "true" : "false"}
              onClick={() => setSection("mcp")}
            >
              MCP
            </button>
            <button
              id="settings-nav-schedules"
              type="button"
              aria-selected={section() === "schedules" ? "true" : "false"}
              onClick={() => setSection("schedules")}
            >
              Programadas
            </button>
          </nav>
          <div id="settings-panel" class="oc-settings-panel">
            <Show when={state.error}>
              <div class="banner err">
                {state.error}
                <button onClick={() => setError(undefined)}>×</button>
              </div>
            </Show>
            <Show when={section() === "providers"} fallback={
              <Show when={section() === "agents"} fallback={
                <Show when={section() === "shortcuts"} fallback={
                  <Show when={section() === "skills"} fallback={
                    <Show when={section() === "mcp"} fallback={<SchedulesSettingsSection />}>
                      <McpSettingsSection />
                    </Show>
                  }>
                    <SkillsSettingsSection />
                  </Show>
                }>
                  <ShortcutsSettings />
                </Show>
              }>
                <AgentSettings />
              </Show>
            }>
              <ProviderSettings />
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
