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
import logoUrl from "../assets/octus-logo.png";
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

  function basenameOf(directory: string): string {
    const parts = directory.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? directory;
  }

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
      // El nombre del proyecto es siempre el de la carpeta (sin pedirlo).
      const existing = state.projects.find((p) => p.rootPath === real || p.rootPath === path);
      if (existing) {
        await enterSessions({ id: existing.id, name: existing.name, rootPath: existing.rootPath });
      } else {
        setWelcomeError(undefined);
        await createProject(basenameOf(real), real);
        const created = state.projects.find((p) => p.rootPath === real);
        if (created) await enterSessions({ id: created.id, name: created.name, rootPath: created.rootPath });
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

  function backToChoose(): void {
    setWelcomeError(undefined);
    setPending(undefined);
    setPendingSessions([]);
    setMode("choose");
  }

  return (
    <main id="welcome" class="welcome-root" aria-label="Bienvenida">
      <div class="welcome-brand">
        <img class="welcome-logo" src={logoUrl} alt="Octus" width={120} height={120} />
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
                      const paths = pathsFromDrop(event, (file) => window.octus.pathForFile(file));
                      if (paths.length === 0) {
                        setWelcomeError("No se recibió ninguna carpeta (soltado vacío).");
                        return;
                      }
                      void handlePath(paths[0]!);
                    }}
                  >
                    Arrastra una carpeta aquí para abrirla como workspace
                  </div>
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
