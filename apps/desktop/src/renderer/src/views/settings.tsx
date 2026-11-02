/** Renderer/views — vista de ajustes: modal por secciones (Todo 4). */
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "../api.js";
import {
  setError,
  setUiPrefs,
  state,
} from "../store.js";
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

export function SettingsView(props: { onClose?: () => void } = {}) {
  // Modal Ajustes (plan octus-welcome-settings-theme, todo 4): cabecera con X
  // + nav lateral de 2 secciones. Los paneles reutilizan los componentes de
  // las todos 5/6 sin redisenar su interior; Skills/Appearance/Project quedan
  // fuera de este modal.
  const [section, setSection] = createSignal<"providers" | "agents">("providers");
  onMount(() => {
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
          </nav>
          <div id="settings-panel" class="oc-settings-panel">
            <Show when={state.error}>
              <div class="banner err">
                {state.error}
                <button onClick={() => setError(undefined)}>×</button>
              </div>
            </Show>
            <Show when={section() === "providers"} fallback={<AgentSettings />}>
              <ProviderSettings />
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
