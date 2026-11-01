/** Renderer/views — bienvenida (Todo 10, F-1/W-01): pantalla inicial sin auto-selección. */
import { For, Show, createSignal } from "solid-js";
import type { Project, Session } from "@octus/shared";
import { invoke } from "../api.js";
import {
  createProject,
  createSession,
  isProjectBroken,
  markProjectBroken,
  selectProject,
  selectSession,
  setWelcomeError,
  state,
  validateDirectory,
} from "../store.js";
import { SettingsView } from "./settings.jsx";

// ---------------------------------------------------------------- bienvenida (Todo 10, F-1/W-01).
// Pantalla inicial sin auto-selección: arrastrar carpeta (rutas propuestas por
// el renderer, validadas en main), selector nativo, recientes con fecha, crear
// y abrir proyectos, continuar sesión y acceso a configuración. No ejecuta
// código del proyecto abierto: solo crea registros y selecciona.
function pathsFromDrop(event: DragEvent): string[] {
  const files = Array.from(event.dataTransfer?.files ?? []);
  const paths: string[] = [];
  for (const file of files) {
    const candidate = (file as unknown as { path?: unknown }).path;
    if (typeof candidate === "string" && candidate.length > 0) paths.push(candidate);
  }
  return paths;
}

function formatRecentDate(updatedAt: number): string {
  return new Date(updatedAt).toLocaleString();
}

export function WelcomeView() {
  const [mode, setMode] = createSignal<"choose" | "sessions" | "settings">("choose");
  const [dragging, setDragging] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [pending, setPending] = createSignal<{ id?: string; name: string; rootPath: string } | undefined>(undefined);
  const [pendingSessions, setPendingSessions] = createSignal<Session[]>([]);
  let nameInput: HTMLInputElement | undefined;

  async function enterSessions(proj: { id?: string; name: string; rootPath: string }): Promise<void> {
    setWelcomeError(undefined);
    setPending(proj);
    setPendingSessions([]);
    setMode("sessions");
    if (!proj.id) return;
    try {
      const { sessions } = await invoke("sessions.list", { projectId: proj.id });
      setPendingSessions(sessions);
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handlePath(path: string): Promise<void> {
    setBusy(true);
    try {
      const check = await validateDirectory(path);
      if (!check.ok) {
        setWelcomeError(check.error ?? "La carpeta no es válida.");
        return;
      }
      const real = check.realPath ?? path;
      const existing = state.projects.find((p) => p.rootPath === real || p.rootPath === path);
      if (existing) {
        await enterSessions({ id: existing.id, name: existing.name, rootPath: existing.rootPath });
      } else {
        setWelcomeError(undefined);
        setPending({ name: "", rootPath: real });
        nameInput?.focus();
      }
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function openRecent(project: Project): Promise<void> {
    setBusy(true);
    try {
      const check = await validateDirectory(project.rootPath);
      if (!check.ok) {
        // F-1: reciente con ruta ausente → se marca como roto y se deja elegir otro.
        markProjectBroken(project.id);
        setWelcomeError(`«${project.name}»: ${check.error ?? "ruta no disponible."} Elige otro proyecto.`);
        return;
      }
      await enterSessions({ id: project.id, name: project.name, rootPath: project.rootPath });
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function pickNative(): Promise<void> {
    setBusy(true);
    try {
      const picked = await invoke("app.pickDirectory", {});
      if (picked.path) await handlePath(picked.path);
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function createAndEnter(): Promise<void> {
    const target = pending();
    const name = nameInput?.value.trim() ?? "";
    if (!target || target.id || !name) {
      setWelcomeError("Pon un nombre al proyecto para crearlo.");
      return;
    }
    setBusy(true);
    try {
      // main vuelve a validar la carpeta: si falla, nada se crea.
      await createProject(name, target.rootPath);
      const created = state.projects.find((p) => p.rootPath === target.rootPath);
      if (created) await enterSessions({ id: created.id, name: created.name, rootPath: created.rootPath });
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function continueLatest(): Promise<void> {
    const target = pending();
    if (!target?.id) return;
    setBusy(true);
    try {
      await selectProject(target.id);
      const list = [...pendingSessions()].sort((a, b) => b.updatedAt - a.updatedAt);
      if (list.length > 0) await selectSession(list[0]!.id);
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function startNewSession(): Promise<void> {
    const target = pending();
    if (!target?.id) return;
    setBusy(true);
    try {
      await selectProject(target.id);
      await createSession();
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function openWithoutSession(): Promise<void> {
    const target = pending();
    if (!target?.id) return;
    setBusy(true);
    try {
      await selectProject(target.id);
    } catch (error) {
      setWelcomeError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function backToChoose(): void {
    setWelcomeError(undefined);
    setPending(undefined);
    setPendingSessions([]);
    setMode("choose");
  }

  return (
    <main id="welcome" aria-label="Bienvenida">
      <div class="welcome-card">
        <div class="welcome-head">
          <h1>Octus</h1>
          <p class="muted">Elige una carpeta para empezar. Nada se selecciona solo.</p>
        </div>
        <Show when={state.welcomeError}>
          <div id="welcome-error" role="alert">
            {state.welcomeError}
            <button type="button" onClick={() => setWelcomeError(undefined)}>×</button>
          </div>
        </Show>
        <Show
          when={mode() === "settings"}
          fallback={
            <Show
              when={mode() === "sessions" && pending()}
              fallback={
                <>
                  <div
                    id="welcome-dropzone"
                    classList={{ dragging: dragging() }}
                    onDragOver={(event: DragEvent) => {
                      event.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event: DragEvent) => {
                      event.preventDefault();
                      setDragging(false);
                      const paths = pathsFromDrop(event);
                      if (paths.length === 0) {
                        setWelcomeError("No se recibió ninguna carpeta (soltado vacío).");
                        return;
                      }
                      void handlePath(paths[0]!);
                    }}
                  >
                    Arrastra una carpeta de Windows aquí
                  </div>
                  <div class="row welcome-actions">
                    <button id="welcome-pick" type="button" disabled={busy()} onClick={() => void pickNative()}>
                      Abrir por explorador…
                    </button>
                    <button id="welcome-settings" type="button" onClick={() => setMode("settings")}>
                      Configuración
                    </button>
                  </div>
                  <Show when={pending() && !pending()!.id}>
                    <div class="welcome-create">
                      <p class="muted">Carpeta: {pending()!.rootPath}</p>
                      <div class="row">
                        <input id="welcome-name" ref={nameInput} placeholder="Nombre del proyecto nuevo" />
                        <button id="welcome-create" type="button" class="primary" disabled={busy()} onClick={() => void createAndEnter()}>
                          Crear proyecto
                        </button>
                      </div>
                    </div>
                  </Show>
                  <section aria-label="Recientes">
                    <h2>Recientes</h2>
                    <Show when={state.projects.length === 0} fallback={<></>}>
                      <p class="muted">Aún no hay proyectos.</p>
                    </Show>
                    <ul id="welcome-recents">
                      <For each={state.projects}>
                        {(project) => (
                          <li>
                            <button
                              type="button"
                              class="recent"
                              data-project-id={project.id}
                              data-broken={isProjectBroken(project.id)}
                              disabled={busy()}
                              onClick={() => void openRecent(project)}
                            >
                              <span class="recent-name">{project.name}</span>
                              <span class="recent-path">{project.rootPath}</span>
                              <span class="recent-date">{formatRecentDate(project.updatedAt)}</span>
                              <Show when={isProjectBroken(project.id)}>
                                <span class="recent-broken">ruta ausente</span>
                              </Show>
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                </>
              }
            >
              <section aria-label="Sesiones del proyecto">
                <h2>{pending()!.name || "Proyecto"}</h2>
                <p class="muted">{pending()!.rootPath}</p>
                <div class="row welcome-actions">
                  <button id="welcome-continue" type="button" class="primary" disabled={busy() || pendingSessions().length === 0} onClick={() => void continueLatest()}>
                    Continuar sesión
                  </button>
                  <button id="welcome-new-session" type="button" disabled={busy()} onClick={() => void startNewSession()}>
                    Nueva sesión
                  </button>
                  <button id="welcome-open" type="button" disabled={busy()} onClick={() => void openWithoutSession()}>
                    Abrir sin sesión
                  </button>
                  <button id="welcome-back" type="button" onClick={backToChoose}>
                    Volver
                  </button>
                </div>
                <Show
                  when={pendingSessions().length > 0}
                  fallback={<p class="muted">Sin sesiones todavía: crea la primera.</p>}
                >
                  <ul class="welcome-sessions">
                    <For each={[...pendingSessions()].sort((a, b) => b.updatedAt - a.updatedAt)}>
                      {(session) => (
                        <li>
                          <span>{session.title}</span> <span class="recent-date">{formatRecentDate(session.updatedAt)}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>
            </Show>
          }
        >
          <div class="row welcome-actions">
            <button id="welcome-back" type="button" onClick={backToChoose}>
              Volver a bienvenida
            </button>
          </div>
          <SettingsView />
        </Show>
      </div>
    </main>
  );
}
