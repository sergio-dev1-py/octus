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
import { OcIcon } from "../components/oc.jsx";
import { pathsFromDrop } from "../drop-paths.js";
import { SettingsView } from "./settings.jsx";

// ---------------------------------------------------------------- bienvenida (Todo 10, F-1/W-01).
// Pantalla inicial sin auto-selección: arrastrar carpeta (rutas propuestas por
// el renderer vía drop-paths, validadas en main), selector nativo, recientes
// con fecha, crear y abrir proyectos, continuar sesión y acceso a
// configuración. No ejecuta código del proyecto abierto: solo crea registros
// y selecciona.

function formatRecentDate(updatedAt: number): string {
  return new Date(updatedAt).toLocaleString();
}

// Bienvenida objetivo (plan octus-welcome-settings-theme, todo 1): la lista de
// workspaces muestra los 3 primeros y "Ver más" despliega el resto.
const WELCOME_VISIBLE_COUNT = 3;

export function WelcomeView() {
  const [mode, setMode] = createSignal<"choose" | "sessions" | "settings">("choose");
  const [dragging, setDragging] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [pending, setPending] = createSignal<{ id?: string; name: string; rootPath: string } | undefined>(undefined);
  const [pendingSessions, setPendingSessions] = createSignal<Session[]>([]);
  const [showAll, setShowAll] = createSignal(false);
  const visibleProjects = () =>
    showAll() ? state.projects : state.projects.slice(0, WELCOME_VISIBLE_COUNT);
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
    <main id="welcome" class="welcome-root" aria-label="Bienvenida">
      <div class="welcome-brand">
        <svg
          class="welcome-logo"
          viewBox="0 0 120 120"
          fill="none"
          stroke="currentColor"
          stroke-width="5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M42 60 C42 40 50 26 60 26 C70 26 78 40 78 60" />
          <circle cx="53" cy="48" r="3.5" fill="currentColor" stroke="none" />
          <circle cx="67" cy="48" r="3.5" fill="currentColor" stroke="none" />
          <path d="M42 52 C34 53 28 57 27 64 C26 70 32 72 35 67" />
          <path d="M78 52 C86 53 92 57 93 64 C94 70 88 72 85 67" />
          <path d="M44 60 C38 68 30 70 26 76 C22 82 28 87 32 82" />
          <path d="M51 61 C48 70 42 74 40 82 C38 88 44 91 47 86" />
          <path d="M57 61 C56 69 54 77 54 84 C54 90 60 90 60 85" />
          <path d="M63 61 C64 69 66 77 66 84 C66 90 72 89 71 84" />
          <path d="M69 61 C72 70 78 74 80 82 C82 88 76 91 73 86" />
          <path d="M76 60 C82 68 90 70 94 76 C98 82 92 87 88 82" />
        </svg>
        <h1>Octus</h1>
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
                  <div class="welcome-actions-col">
                    <button id="welcome-pick" type="button" class="oc-btn oc-btn--primary" disabled={busy()} onClick={() => void pickNative()}>
                      <OcIcon name="folder" /> Abrir Carpeta
                    </button>
                    <button id="welcome-settings" type="button" class="oc-btn oc-btn--secondary" onClick={() => setMode("settings")}>
                      <svg
                        class="oc-icon"
                        viewBox="0 0 16 16"
                        stroke="currentColor"
                        fill="none"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <circle cx="8" cy="8" r="2.5" />
                        <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
                      </svg>
                      Ajustes
                    </button>
                  </div>
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
                    Arrastra una carpeta aquí para abrirla como workspace
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
                  <section class="welcome-recents" aria-label="Workspaces">
                    <h2>Workspaces</h2>
                    <Show when={state.projects.length === 0} fallback={<></>}>
                      <p class="muted">Aún no hay proyectos.</p>
                    </Show>
                    <ul id="welcome-recents">
                      <For each={visibleProjects()}>
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
                    <Show when={state.projects.length > WELCOME_VISIBLE_COUNT}>
                      <button type="button" id="welcome-more" class="welcome-more" onClick={() => setShowAll((v) => !v)}>
                        {showAll() ? "Ver menos" : "Ver más workspaces…"}
                      </button>
                    </Show>
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
          <SettingsView onClose={backToChoose} />
        </Show>
    </main>
  );
}
