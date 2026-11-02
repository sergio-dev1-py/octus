/** Renderer/views — Todo 33: explorador paginado, diff, modificados, pruebas y diagnósticos.
 * El árbol pagina (50/página, máx. 200 en core) para no bloquear la UI en proyectos grandes. */
import { For, Show, createSignal } from "solid-js";
import { OcButton, OcEmpty, OcErrorState } from "../components/oc.jsx";
import { state } from "../store.js";
import {
  openExplorerFile,
  refreshDiagnostics,
  refreshExplorer,
  refreshModified,
  refreshRepoDiff,
  runProjectTest,
} from "../store/files.js";

function parentDir(relDir: string): string | undefined {
  const clean = relDir === "" || relDir === "." ? "." : relDir.replace(/\/+$/, "");
  if (clean === ".") return undefined;
  const idx = clean.lastIndexOf("/");
  return idx < 0 ? "." : clean.slice(0, idx);
}

export function FilesExplorerPanel() {
  const [staged, setStaged] = createSignal(false);
  const [stat, setStat] = createSignal(false);
  const page = () => state.explorerPage;
  const goUp = () => {
    const parent = parentDir(state.explorerRelDir);
    if (parent !== undefined) void refreshExplorer(parent, 1);
  };
  return (
    <section id="file-explorer" aria-label="Explorador de archivos">
      <h2>Archivos</h2>
      <Show when={state.explorerError} fallback={undefined}>
        <OcErrorState message={state.explorerError!} onRetry={() => void refreshExplorer(state.explorerRelDir, page()?.page ?? 1)} />
      </Show>
      <Show when={page()} fallback={<p class="muted">Sin proyecto seleccionado.</p>}>
        <div class="row">
          <code>{page()!.relDir}</code>
          <span class="muted">
            pág. {page()!.page}/{page()!.pageCount} · {page()!.total} entradas
          </span>
        </div>
        <div class="row">
          <OcButton disabled={state.explorerRelDir === "."} onClick={goUp}>
            Subir
          </OcButton>
          <OcButton id="explorer-prev" disabled={page()!.page <= 1} onClick={() => void refreshExplorer(state.explorerRelDir, page()!.page - 1)}>
            Anterior
          </OcButton>
          <OcButton id="explorer-next" disabled={page()!.page >= page()!.pageCount} onClick={() => void refreshExplorer(state.explorerRelDir, page()!.page + 1)}>
            Siguiente
          </OcButton>
        </div>
        <ul id="file-tree">
          <For each={page()!.entries}>
            {(entry) => (
              <li data-entry-kind={entry.kind} data-entry-path={entry.relPath}>
                {entry.kind === "dir" ? (
                  <button type="button" onClick={() => void refreshExplorer(entry.relPath, 1)}>
                    {entry.name}/
                  </button>
                ) : (
                  <button type="button" onClick={() => void openExplorerFile(entry.relPath)}>
                    {entry.name}
                  </button>
                )}
              </li>
            )}
          </For>
        </ul>
        <Show when={state.explorerFile}>
          <article id="file-viewer" data-viewer-path={state.explorerFile!.relPath}>
            <h3>{state.explorerFile!.relPath}</h3>
            <Show when={state.explorerFile!.truncated}>
              <p class="muted">Vista truncada ({state.explorerFile!.size} bytes).</p>
            </Show>
            <pre>{state.explorerFile!.content}</pre>
          </article>
        </Show>
      </Show>
      <article id="repo-diff" aria-label="Diferencias del repositorio">
        <h2>Diferencias</h2>
        <div class="row">
          <label>
            <input type="checkbox" checked={staged()} onChange={(e) => setStaged(e.currentTarget.checked)} /> staged
          </label>
          <label>
            <input type="checkbox" checked={stat()} onChange={(e) => setStat(e.currentTarget.checked)} /> stat
          </label>
          <OcButton onClick={() => void refreshRepoDiff({ staged: staged(), stat: stat() })}>Ver diff</OcButton>
        </div>
        <Show when={state.repoDiffError}>
          <OcErrorState message={state.repoDiffError!} onRetry={() => void refreshRepoDiff({ staged: staged(), stat: stat() })} />
        </Show>
        <Show when={state.repoDiff !== undefined}>
          <Show when={state.repoDiffTruncated}>
            <p class="muted">Diff truncado en el límite del backend.</p>
          </Show>
          <pre>{state.repoDiff || "(sin diferencias)"}</pre>
        </Show>
      </article>
      <article id="modified-list" aria-label="Archivos modificados">
        <h2>Modificados</h2>
        <OcButton onClick={() => void refreshModified()}>Actualizar</OcButton>
        <Show when={!state.modifiedIsGit} fallback={
          <Show when={state.modifiedFiles.length > 0} fallback={<p class="muted">Árbol limpio.</p>}>
            <ul>
              <For each={state.modifiedFiles}>
                {(file) => (
                  <li data-modified-path={file.path}>
                    <code>{file.x}{file.y}</code> {file.path}
                  </li>
                )}
              </For>
            </ul>
          </Show>
        }>
          <p class="muted">No es un repositorio git.</p>
        </Show>
      </article>
    </section>
  );
}

export function TestResultsPanel() {
  return (
    <section id="test-results" aria-label="Resultados de pruebas">
      <h2>Pruebas</h2>
      <Show when={state.testAllowlist.length > 0} fallback={<OcEmpty title="Sin allowlist de pruebas" hint="Sin allowlist de pruebas en este proyecto." />}>
        <ul>
          <For each={state.testAllowlist}>
            {(entry) => (
              <li data-test-entry={entry.id}>
                <code>{entry.id}</code> {entry.name} — <code>{entry.argv.join(" ")}</code>{" "}
                <OcButton disabled={state.testRunning} onClick={() => void runProjectTest(entry.id)}>
                  Ejecutar
                </OcButton>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={state.testRunning}>
        <p class="muted">Ejecutando prueba…</p>
      </Show>
      <Show when={state.testRunError}>
        <OcErrorState message={state.testRunError!} onRetry={() => undefined} />
      </Show>
      <Show when={state.testRunResult}>
        <article data-test-output={state.testRunResult!.entryId}>
          <p class="muted">
            exit {state.testRunResult!.exitCode} · {state.testRunResult!.durationMs} ms
            {state.testRunResult!.truncated ? " · salida truncada" : ""}
          </p>
          <pre>{state.testRunResult!.output || "(sin salida)"}</pre>
        </article>
      </Show>
    </section>
  );
}

export function ProblemsListPanel() {
  return (
    <section id="problems-list" aria-label="Problemas y diagnósticos">
      <h2>Problemas</h2>
      <OcButton onClick={() => void refreshDiagnostics()}>Actualizar</OcButton>
      <Show when={state.diagnostics.length > 0} fallback={<p class="muted">Sin problemas.</p>}>
        <ul>
          <For each={state.diagnostics}>
            {(problem) => (
              <li data-problem-id={problem.id} data-severity={problem.severity}>
                <strong>[{problem.source}]</strong> {problem.message}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
