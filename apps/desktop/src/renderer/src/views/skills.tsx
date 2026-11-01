/** Renderer/views — Skills Manager (Todo 24, W-S1..S7): catálogo, detalle,
    importar, habilitar e historial sobre los componentes del Todo 7 y tokens.
    installed ≠ enabled siempre: ambas pastillas visibles y distintas.
    Una skill con error de validación muestra el error y bloquea habilitar
    (botón deshabilitado + el backend `skills.enable` también la rechaza). */
import { For, Show, createSignal } from "solid-js";
import type { SkillCatalogItem } from "@octus/shared";
import { OcButton, OcEmpty, OcErrorState } from "../components/oc.jsx";
import { invoke } from "../api.js";
import { setView, state } from "../store.js";
import {
  disableSkill,
  enableSkill,
  importSkillFromFolder,
  importSkillFromZip,
  installSkillFromGit,
  loadSkillsHistory,
  pickSkillDirectory,
  refreshSkillsCatalog,
  selectSkill,
  setSkillScope,
  setSkillsFilter,
  setSkillsHistoryRun,
  setSkillsSearch,
  skillsNotice,
  uninstallSkill,
} from "../store/skills.js";

function installedLabel(skill: SkillCatalogItem): string {
  return skill.installed ? "instalada" : "no instalada";
}

function enabledLabel(skill: SkillCatalogItem): string {
  return skill.enabled ? "habilitada" : "deshabilitada";
}

function provenanceText(skill: SkillCatalogItem): string {
  const provenance = skill.provenance as { kind?: string; sourcePath?: string; repoUrl?: string; ref?: string } | null;
  if (!provenance || typeof provenance.kind !== "string") return "descubierta (sin instalador)";
  if (provenance.kind === "git") return `git ${provenance.repoUrl ?? "?"} @ ${provenance.ref ?? "?"}`;
  return `${provenance.kind} ${provenance.sourcePath ?? "?"}`;
}

function visibleSkills(): SkillCatalogItem[] {
  const query = state.skillsSearch.trim().toLowerCase();
  return state.skillsCatalog.filter((skill) => {
    if (state.skillsFilter === "installed" && !skill.installed) return false;
    if (state.skillsFilter === "enabled" && !skill.enabled) return false;
    if (query && !`${skill.name} ${skill.description}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

function SkillRow(props: { skill: SkillCatalogItem }) {
  const selected = () => state.skillsSelected === props.skill.name;
  return (
    <li data-skill-name={props.skill.name} data-installed={String(props.skill.installed)} data-enabled={String(props.skill.enabled)}>
      <button type="button" class={selected() ? "active" : ""} onClick={() => selectSkill(selected() ? undefined : props.skill.name)} aria-pressed={selected()}>
        <code>{props.skill.name}</code>
        <Show when={props.skill.version}>
          <span class="muted">@{props.skill.version}</span>
        </Show>
      </button>{" "}
      <span class={`pill ${props.skill.installed ? "ok" : ""}`} data-skill-installed={String(props.skill.installed)}>{installedLabel(props.skill)}</span>{" "}
      <span class={`pill ${props.skill.enabled ? "ok" : "warn"}`} data-skill-enabled={String(props.skill.enabled)}>{enabledLabel(props.skill)}</span>{" "}
      <span class="pill" data-skill-origin={props.skill.origin} title={`Origen: ${props.skill.origin}`}>{props.skill.origin}</span>{" "}
      <span class="pill" data-skill-scope={props.skill.scope} title={`Alcance: ${props.skill.scope}`}>{props.skill.scope}</span>
      <Show when={props.skill.errors.length > 0}>
        {" "}<span class="pill err" title={props.skill.errors.join(" | ")}>error de validación</span>
      </Show>
      <p class="muted">{props.skill.description}</p>
    </li>
  );
}

function SkillDetail() {
  const detail = () => state.skillsDetail;
  const [resourcePath, setResourcePath] = createSignal("");
  const [resourceOut, setResourceOut] = createSignal<string | undefined>(undefined);
  const blocked = () => (detail()?.errors.length ?? 0) > 0;
  return (
    <Show when={detail()} fallback={<OcEmpty id="skills-detail-empty" title="Sin selección" hint="Elige una skill del catálogo para ver su detalle." />}>
      <article class="card" id="skills-detail" data-skill-detail={detail()!.name}>
        <h3 id="skills-detail-title">
          <code>{detail()!.name}</code>
          <Show when={detail()!.version}>
            <span class="muted">@{detail()!.version}</span>
          </Show>
        </h3>
        <p>{detail()!.description}</p>
        <p class="muted">
          Origen <code id="skills-detail-origin" data-skill-detail-origin={detail()!.origin}>{detail()!.origin}</code> · alcance{" "}
          <code id="skills-detail-scope" data-skill-detail-scope={detail()!.scope}>{detail()!.scope}</code> ·{" "}
          <span data-skill-detail-installed={String(detail()!.installed)}>{installedLabel(detail()!)}</span> ·{" "}
          <span data-skill-detail-enabled={String(detail()!.enabled)}>{enabledLabel(detail()!)}</span>
        </p>
        <p class="muted" id="skills-detail-provenance" data-provenance={provenanceText(detail()!)}>
          Procedencia: {provenanceText(detail()!)}
        </p>
        <Show when={detail()!.compatibility}>
          <p class="muted">Compatibilidad: {detail()!.compatibility}</p>
        </Show>
        <Show when={detail()!.allowedTools}>
          <p class="muted">Herramientas declaradas (descriptivo, nunca autoriza): <code>{detail()!.allowedTools}</code></p>
        </Show>
        <Show when={detail()!.errors.length > 0}>
          <div id="skills-detail-errors" role="alert">
            <For each={detail()!.errors}>{(error) => <p class="muted" data-skill-detail-error>{error}</p>}</For>
          </div>
        </Show>
        <div class="row">
          <OcButton
            id="skills-enable"
            variant="primary"
            disabled={blocked()}
            title={blocked() ? `Bloqueado: ${detail()!.errors[0]}` : "Habilitar en este proyecto"}
            onClick={() => void enableSkill(detail()!.name)}
          >
            Habilitar
          </OcButton>
          <OcButton id="skills-disable" variant="secondary" disabled={!detail()!.enabled} onClick={() => void disableSkill(detail()!.name)}>
            Deshabilitar
          </OcButton>
          <label class="muted" for="skills-scope">Alcance</label>
          <select id="skills-scope" value={detail()!.scope} onChange={(e) => void setSkillScope(detail()!.name, e.currentTarget.value as "global" | "project" | "managed")}>
            <option value="global">global</option>
            <option value="project">project</option>
            <option value="managed">managed</option>
          </select>
          <Show when={detail()!.installed}>
            <OcButton id="skills-uninstall" variant="danger" onClick={() => void uninstallSkill(detail()!.name)}>
              Desinstalar
            </OcButton>
          </Show>
        </div>
        <details>
          <summary>Recursos ({detail()!.files.length})</summary>
          <ul id="skills-detail-files">
            <For each={detail()!.files}>{(file) => <li><code>{file}</code></li>}</For>
          </ul>
          <div class="row">
            <input id="skills-resource-path" placeholder="docs/uso.md" value={resourcePath()} onInput={(e) => setResourcePath(e.currentTarget.value)} aria-label="Recurso relativo" />
            <OcButton
              id="skills-resource-load"
              variant="secondary"
              onClick={() => {
                void (async () => {
                  const result = await invoke("skills.resource", { name: detail()!.name, relativePath: resourcePath() });
                  setResourceOut(result.ok ? (result.content ?? "") : `error: ${result.error ?? "?"}`);
                })();
              }}
            >
              Leer recurso
            </OcButton>
          </div>
          <Show when={resourceOut() !== undefined}>
            <pre id="skills-resource-out">{resourceOut()!.slice(0, 4000)}</pre>
          </Show>
        </details>
        <details>
          <summary>SKILL.md (frontal + cuerpo topado)</summary>
          <pre>{detail()!.frontmatterText.slice(0, 2000)}</pre>
          <pre>{detail()!.body.slice(0, 4000)}</pre>
        </details>
      </article>
    </Show>
  );
}

function SkillsImport() {
  let folderPath: HTMLInputElement | undefined;
  let zipPath: HTMLInputElement | undefined;
  let gitRepo: HTMLInputElement | undefined;
  let gitRef: HTMLInputElement | undefined;
  let gitSource: HTMLInputElement | undefined;
  return (
    <section class="card" id="skills-import">
      <h3>Importar e instalar</h3>
      <div class="row">
        <input id="skills-import-folder-path" ref={folderPath} placeholder="C:\\ruta\\a\\mi-skill" aria-label="Carpeta de la skill" />
        <OcButton
          id="skills-import-folder-pick"
          variant="secondary"
          onClick={() => {
            void (async () => {
              const picked = await pickSkillDirectory();
              if (picked && folderPath) folderPath.value = picked;
            })();
          }}
        >
          Elegir carpeta…
        </OcButton>
        <OcButton id="skills-import-folder-go" variant="primary" onClick={() => void importSkillFromFolder(folderPath?.value ?? "")}>
          Importar carpeta
        </OcButton>
      </div>
      <div class="row">
        <input id="skills-import-zip-path" ref={zipPath} placeholder="C:\\ruta\\a\\skill.zip" aria-label="Zip de la skill" />
        <OcButton id="skills-import-zip-go" variant="primary" onClick={() => void importSkillFromZip(zipPath?.value ?? "")}>
          Importar zip
        </OcButton>
      </div>
      <div class="row">
        <input id="skills-install-git-repo" ref={gitRepo} placeholder="https://…/repo.git" aria-label="Repo git (URL explícita)" />
        <input id="skills-install-git-ref" ref={gitRef} placeholder="v1.0.0 o SHA" aria-label="Ref git (rama, etiqueta o SHA)" />
        <input id="skills-install-git-source" ref={gitSource} placeholder="copia local ya obtenida (opcional)" aria-label="Copia local del operador" />
        <OcButton
          id="skills-install-git-go"
          variant="primary"
          onClick={() => void installSkillFromGit(gitRepo?.value ?? "", gitRef?.value ?? "", gitSource?.value || undefined)}
        >
          Instalar desde git
        </OcButton>
      </div>
      <p class="muted">La fuente queda siempre visible en el detalle (carpeta, zip o git con repo y ref). Duplicados y zips con rutas fuera de la skill se rechazan sin escribir nada.</p>
    </section>
  );
}

function SkillsHistory() {
  return (
    <section class="card" id="skills-history">
      <h3>Historial de uso por run</h3>
      <div class="row">
        <input
          id="skills-history-run"
          placeholder="run_qa01"
          value={state.skillsHistoryRun}
          onInput={(e) => setSkillsHistoryRun(e.currentTarget.value)}
          aria-label="ID de run"
        />
        <OcButton id="skills-history-load" variant="secondary" onClick={() => void loadSkillsHistory(state.skillsHistoryRun)}>
          Ver uso
        </OcButton>
      </div>
      <Show when={state.skillsHistory.length > 0} fallback={<p class="muted">Sin uso registrado para ese run.</p>}>
        <ul id="skills-history-list">
          <For each={state.skillsHistory}>{(name) => <li data-history-skill={name}><code>{name}</code></li>}</For>
        </ul>
      </Show>
      <Show when={state.skillsHistoryBypass.length > 0}>
        <p class="muted">Intentos de usar skill como autorización (denegados y auditados):</p>
        <ul>
          <For each={state.skillsHistoryBypass}>{(attempt) => <li><code>{attempt.skill}</code> pidió <code>{attempt.action}</code></li>}</For>
        </ul>
      </Show>
    </section>
  );
}

export function SkillsManagerView() {
  const installed = () => state.skillsCatalog.filter((s) => s.installed).length;
  const enabled = () => state.skillsCatalog.filter((s) => s.enabled).length;
  return (
    <section id="skills-manager" aria-label="Skills Manager">
      <h2>Skills</h2>
      <p class="muted" id="skills-counts" data-installed={installed()} data-enabled={enabled()}>
        {installed()} instaladas, {enabled()} habilitadas en este proyecto. Instalada ≠ habilitada: una instalada pero deshabilitada nunca llega al contexto de los runs.
      </p>
      <Show when={state.skillsNotice}>
        <div class="banner" id="skills-notice" role="status">
          {state.skillsNotice}
          <button type="button" onClick={() => skillsNotice(undefined)}>×</button>
        </div>
      </Show>
      <Show when={!state.activeProjectId}>
        <OcEmpty id="skills-no-project" title="Sin proyecto" hint="Elige un proyecto para habilitar skills por proyecto. El catálogo se sigue mostrando." />
      </Show>
      <div class="row" role="tablist" aria-label="Filtros del catálogo">
        <OcButton id="skills-filter-all" variant={state.skillsFilter === "all" ? "primary" : "secondary"} onClick={() => setSkillsFilter("all")}>
          Catálogo ({state.skillsCatalog.length})
        </OcButton>
        <OcButton id="skills-filter-installed" variant={state.skillsFilter === "installed" ? "primary" : "secondary"} onClick={() => setSkillsFilter("installed")}>
          Instaladas ({installed()})
        </OcButton>
        <OcButton id="skills-filter-enabled" variant={state.skillsFilter === "enabled" ? "primary" : "secondary"} onClick={() => setSkillsFilter("enabled")}>
          Habilitadas ({enabled()})
        </OcButton>
        <input id="skills-search" placeholder="Buscar…" value={state.skillsSearch} onInput={(e) => setSkillsSearch(e.currentTarget.value)} aria-label="Buscar skills" />
      </div>
      <Show
        when={visibleSkills().length > 0}
        fallback={<OcEmpty id="skills-list-empty" title="Sin skills" hint="Importa una carpeta, un zip o instala desde git con fuente explícita." />}
      >
        <ul id="skills-list">
          <For each={visibleSkills()}>{(skill) => <SkillRow skill={skill} />}</For>
        </ul>
      </Show>
      <Show when={state.skillsErrors.length > 0}>
        <OcErrorState
          id="skills-errors"
          message={`${state.skillsErrors.length} ${state.skillsErrors.length === 1 ? "directorio con error" : "directorios con errores"} de validación: ${state.skillsErrors[0]!.message}`}
          retryLabel="Recargar catálogo"
          onRetry={() => {
            void refreshSkillsCatalog();
          }}
        />
        <ul id="skills-errors-list">
          <For each={state.skillsErrors}>
            {(error) => (
              <li data-skill-error={error.path}>
                <code>{error.path}</code> [{error.scope}] {error.message}{" "}
                <button
                  type="button"
                  class="oc-btn oc-btn--danger"
                  data-skill-error-blocked={error.path}
                  disabled
                  title={`Habilitar bloqueado: ${error.message}`}
                >
                  Habilitar bloqueado
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <SkillDetail />
      <SkillsImport />
      <SkillsHistory />
    </section>
  );
}

/** Vista contextual del workbench (sidebar skills-mcp): lo mismo, sin pantallas gemelas. */
export function SkillsContextPanel() {
  const enabledSkills = () => state.skillsCatalog.filter((s) => s.enabled);
  return (
    <section id="skills-context" aria-label="Skills en este proyecto">
      <h2>Skills</h2>
      <p class="muted" data-context-counts={`${enabledSkills().length}/${state.skillsCatalog.length}`}>
        {enabledSkills().length} habilitadas de {state.skillsCatalog.length} en el catálogo.
      </p>
      <Show when={enabledSkills().length > 0} fallback={<p class="muted">Ninguna habilitada en este proyecto. Las instaladas pero deshabilitadas no llegan a los runs.</p>}>
        <ul>
          <For each={enabledSkills()}>
            {(skill) => (
              <li data-context-skill={skill.name}>
                <code>{skill.name}</code> <span class="muted">[{skill.scope}]</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={state.skillsErrors.length > 0}>
        <p class="muted" id="skills-context-errors">{state.skillsErrors.length} con error de validación (habilitar bloqueado).</p>
      </Show>
      <OcButton id="skills-open-settings" variant="primary" onClick={() => setView("settings")}>
        Abrir Skills Manager
      </OcButton>
    </section>
  );
}
