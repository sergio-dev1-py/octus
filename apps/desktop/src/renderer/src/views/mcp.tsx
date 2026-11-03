/** Renderer/views — MCP Manager UI (Todo 30, W-M1 a W-M6 sobre el Todo 26).
 * Tres ejes siempre visibles y distintos por servidor: configurado (existe la
 * configuración) ≠ conectado (handshake y capacidades) ≠ autorizado
 * (confianza explícita global o por workspace). Configurar un remoto nunca se
 * llama instalar. Secretos: solo indicador guardado/sin guardar, jamás el valor.
 * Sin datos inventados: vacíos honestos y errores con reintento sin bloquear. */
import { For, Show, createSignal, onMount } from "solid-js";
import { OcButton, OcEmpty, OcErrorState } from "../components/oc.jsx";
import { setLayoutActivity, state } from "../store.js";
import {
  mcpAdd,
  mcpConnect,
  mcpDisconnect,
  mcpDismiss,
  mcpImport,
  mcpRefresh,
  mcpRemove,
  mcpRetry,
  mcpSaveSecret,
  mcpSelect,
  mcpSetTrust,
  mcpState,
  type McpServerSummary,
  type McpTransport,
} from "../store/mcp.js";

function connPill(server: McpServerSummary): { cls: string; label: string } {
  switch (server.connection) {
    case "connected":
      return { cls: "pill ok", label: "conectado" };
    case "connecting":
      return { cls: "pill warn", label: "conectando…" };
    case "reconnecting":
      return { cls: "pill warn", label: "reconectando…" };
    case "failed":
      return { cls: "pill err", label: "falló" };
    default:
      return { cls: "pill", label: "desconectado" };
  }
}

function ServerCard(props: { server: McpServerSummary; projectId: string; selected: boolean }) {
  const conn = () => connPill(props.server);
  const authorized = () => props.server.trustedGlobal || props.server.trustedWorkspace;
  const busy = () => mcpState.busyId === props.server.id;
  return (
    <div class="card" id={`mcp-server-${props.server.id}`} data-transport={props.server.transport} data-connection={props.server.connection} data-authorized={authorized() ? "yes" : "no"}>
      <div class="row">
        <strong>{props.server.name}</strong>
        <code class="muted">{props.server.id}</code>
        <span class="pill">{props.server.transport === "stdio" ? "stdio local" : "http remoto"}</span>
      </div>
      <div class="row" aria-label={`Estados de ${props.server.id}`}>
        <span class={props.server.configured ? "pill" : "pill warn"} id={`mcp-config-${props.server.id}`}>
          {props.server.configured ? "configurado" : "sin configurar"}
        </span>
        <span class={conn().cls} id={`mcp-conn-${props.server.id}`}>
          {conn().label}
        </span>
        <span class={authorized() ? "pill mode" : "pill warn"} id={`mcp-auth-${props.server.id}`}>
          {authorized() ? "autorizado" : "no autorizado"}
        </span>
        <Show when={!props.server.enabled}>
          <span class="pill warn">deshabilitado</span>
        </Show>
      </div>
      <p class="muted">
        {props.server.transport === "stdio"
          ? `comando: ${(props.server.command ?? "—").split(/[\\/]/).pop()} ${(props.server.args ?? []).join(" ")}`.trim()
          : `url: ${props.server.url ?? "—"}`}
        {" · "}capacidades: {props.server.capabilities.length > 0 ? props.server.capabilities.join(", ") : "—"}
        {props.server.serverName ? ` · ${props.server.serverName} ${props.server.serverVersion ?? ""}` : ""}
      </p>
      <Show when={props.server.lastError}>
        <p class="muted" id={`mcp-lasterr-${props.server.id}`}>
          último error: {props.server.lastError}
        </p>
      </Show>
      <div class="row">
        <OcButton id={`mcp-select-${props.server.id}`} variant={props.selected ? "primary" : "secondary"} onClick={() => void mcpSelect(props.server.id, props.projectId)}>
          {props.selected ? "Seleccionado" : "Ver detalle"}
        </OcButton>
        <Show
          when={props.server.connection === "connected"}
          fallback={
            <OcButton id={`mcp-connect-${props.server.id}`} variant="primary" disabled={busy()} onClick={() => void mcpConnect(props.server.id, props.projectId)}>
              Conectar
            </OcButton>
          }
        >
          <OcButton id={`mcp-disconnect-${props.server.id}`} variant="secondary" disabled={busy()} onClick={() => void mcpDisconnect(props.server.id, props.projectId)}>
            Desconectar
          </OcButton>
        </Show>
        <Show when={props.server.connection === "failed"}>
          <OcButton id={`mcp-retry-${props.server.id}`} variant="primary" disabled={busy()} onClick={() => void mcpRetry(props.server.id, props.projectId)}>
            Reintentar
          </OcButton>
        </Show>
      </div>
    </div>
  );
}

function AddForm(props: { projectId: string }) {
  let nameRef: HTMLInputElement | undefined;
  let transportRef: HTMLSelectElement | undefined;
  const [transport, setTransport] = createSignal<McpTransport>("stdio");
  let commandRef: HTMLInputElement | undefined;
  let argsRef: HTMLInputElement | undefined;
  let urlRef: HTMLInputElement | undefined;
  let tokenRef: HTMLInputElement | undefined;
  return (
    <div class="card" id="mcp-add-form">
      <h3>Agregar servidor</h3>
      <p class="muted">STDIO ejecuta un comando local con argumentos separados (sin shell). Un servidor remoto solo se configura, con URL y credencial en el almacén del sistema.</p>
      <div class="row">
        <label class="muted">
          nombre
          <input id="mcp-add-name" ref={nameRef} placeholder="mcp-qa-new" autocomplete="off" />
        </label>
        <label class="muted">
          transporte
          <select id="mcp-add-transport" ref={transportRef} value={transport()} onChange={(e) => setTransport(e.currentTarget.value as McpTransport)}>
            <option value="stdio">stdio (local)</option>
            <option value="http">http (remoto)</option>
          </select>
        </label>
      </div>
      <Show
        when={transport() === "stdio"}
        fallback={
          <div class="row">
            <label class="muted">
              url
              <input id="mcp-add-url" ref={urlRef} placeholder="https://mcp.ejemplo.com/mcp" autocomplete="off" inputmode="url" />
            </label>
            <label class="muted">
              token (opcional, al almacén del sistema)
              <input id="mcp-add-token" ref={tokenRef} type="password" placeholder="solo se guarda, nunca se muestra" autocomplete="off" />
            </label>
          </div>
        }
      >
        <div class="row">
          <label class="muted">
            comando (ruta del ejecutable)
            <input id="mcp-add-command" ref={commandRef} placeholder="node" autocomplete="off" />
          </label>
          <label class="muted">
            argumentos (separados por espacios)
            <input id="mcp-add-args" ref={argsRef} placeholder="server.js --stdio" autocomplete="off" />
          </label>
        </div>
      </Show>
      <div class="row">
        <OcButton
          id="mcp-add-submit"
          variant="primary"
          disabled={mcpState.busyId === "__add"}
          onClick={() =>
            void mcpAdd(
              {
                name: nameRef?.value.trim() || "",
                transport: (transportRef?.value as McpTransport) ?? "stdio",
                command: commandRef?.value.trim() || undefined,
                argsText: argsRef?.value ?? undefined,
                url: urlRef?.value.trim() || undefined,
                token: tokenRef?.value || undefined,
              },
              props.projectId,
            )
          }
        >
          Agregar
        </OcButton>
      </div>
      <Show when={mcpState.lastOp === "add" && mcpState.notice}>
        <p class="muted" id="mcp-add-result">
          {mcpState.notice}
        </p>
      </Show>
    </div>
  );
}

function ImportForm(props: { projectId: string }) {
  let jsonRef: HTMLTextAreaElement | undefined;
  return (
    <div class="card" id="mcp-import-form">
      <h3>Importar configuración</h3>
      <p class="muted">JSON con arreglo de servidores (nombre, transporte, comando/args o url). Nada se conecta ni se autoriza al importar.</p>
      <textarea id="mcp-import-json" ref={jsonRef} rows={4} placeholder='[{"name":"mcp-qa-new","transport":"stdio","command":"node","args":["server.js"]}]' aria-label="JSON de configuración MCP" />
      <div class="row">
        <OcButton
          id="mcp-import-submit"
          variant="secondary"
          disabled={mcpState.busyId === "__import"}
          onClick={() => void mcpImport(jsonRef?.value ?? "", props.projectId)}
        >
          Importar JSON
        </OcButton>
      </div>
      <Show when={mcpState.lastOp === "import" && mcpState.notice}>
        <p class="muted" id="mcp-import-result">
          {mcpState.notice}
        </p>
      </Show>
    </div>
  );
}

function DetailView(props: { server: McpServerSummary; projectId: string }) {
  let secretRef: HTMLInputElement | undefined;
  const authorized = () => props.server.trustedGlobal || props.server.trustedWorkspace;
  return (
    <section id={`mcp-detail-${props.server.id}`} aria-label={`Detalle de ${props.server.id}`}>
      <h3>
        Detalle · {props.server.name} <code class="muted">{props.server.id}</code>
      </h3>
      <div class="card">
        <h4>Confianza por workspace y permisos</h4>
        <p class="muted">La confianza precede a cualquier conexión. Revocar corta la conexión en caliente y queda auditado.</p>
        <div class="row">
          <span class="pill" id={`mcp-trust-global-state-${props.server.id}`}>
            global: {props.server.trustedGlobal ? "sí" : "no"}
          </span>
          <span class="pill" id={`mcp-trust-ws-state-${props.server.id}`}>
            workspace: {props.server.trustedWorkspace ? "sí" : "no"}
          </span>
        </div>
        <div class="row">
          <OcButton id={`mcp-trust-global-${props.server.id}`} variant="secondary" onClick={() => void mcpSetTrust(props.server.id, "global", !props.server.trustedGlobal, props.projectId)}>
            {props.server.trustedGlobal ? "Quitar confianza global" : "Confiar globalmente"}
          </OcButton>
          <OcButton id={`mcp-trust-ws-${props.server.id}`} variant="secondary" onClick={() => void mcpSetTrust(props.server.id, "workspace", !props.server.trustedWorkspace, props.projectId)}>
            {props.server.trustedWorkspace ? "Revocar confianza del workspace" : "Confiar en este workspace"}
          </OcButton>
        </div>
      </div>
      <div class="card">
        <h4>Herramientas aisladas por servidor</h4>
        <Show
          when={authorized()}
          fallback={
            <p class="muted" id="mcp-tools-gated">
              Servidor no autorizado en este workspace: sus herramientas están ocultas hasta otorgar confianza.
            </p>
          }
        >
          <Show
            when={(mcpState.detail.tools?.items.length ?? 0) > 0}
            fallback={<p class="muted">Sin herramientas anunciadas por este servidor.</p>}
          >
            <table class="oc-table" id="mcp-tools">
              <caption class="oc-table__caption">Herramientas de {props.server.id} (nombre aislado servidor:herramienta)</caption>
              <thead>
                <tr>
                  <th scope="col">Aislada</th>
                  <th scope="col">Descripción</th>
                </tr>
              </thead>
              <tbody>
                <For each={mcpState.detail.tools?.items ?? []}>
                  {(tool) => (
                    <tr data-oc-row data-tool={tool.isolated}>
                      <td>
                        <code>{tool.isolated}</code>
                      </td>
                      <td>{tool.description ?? "—"}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>
      </div>
      <div class="card">
        <h4>Recursos y prompts con aprobación</h4>
        <Show
          when={mcpState.detail.resources?.supported}
          fallback={<p class="muted">Este servidor no anuncia recursos.</p>}
        >
          <ul id="mcp-resources">
            <For each={mcpState.detail.resources?.items ?? []}>
              {(res) => (
                <li data-resource={res.uri}>
                  <code>{res.uri}</code> {res.sensitive ? <span class="pill warn">sensible: requiere aprobación</span> : <span class="pill">público</span>}
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show
          when={mcpState.detail.prompts?.supported}
          fallback={<p class="muted">Este servidor no anuncia prompts.</p>}
        >
          <ul id="mcp-prompts">
            <For each={mcpState.detail.prompts?.items ?? []}>
              {(prompt) => (
                <li data-prompt={prompt.name}>
                  <code>{prompt.name}</code> <span class="muted">args: {prompt.args.join(", ") || "—"}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
      <div class="card">
        <h4>Credenciales</h4>
        <div class="row">
          <span class={props.server.hasSecret ? "pill mode" : "pill warn"} id={`mcp-secret-state-${props.server.id}`}>
            {props.server.hasSecret ? "credencial guardada" : "sin credencial"}
          </span>
          <input id={`mcp-secret-input-${props.server.id}`} ref={secretRef} type="password" placeholder="nuevo token (solo se guarda)" autocomplete="off" aria-label={`Nuevo token para ${props.server.id}`} />
          <OcButton
            id={`mcp-secret-save-${props.server.id}`}
            variant="secondary"
            onClick={() => {
              const value = secretRef?.value ?? "";
              if (!value) return;
              if (secretRef) secretRef.value = "";
              void mcpSaveSecret(props.server.id, value, props.projectId);
            }}
          >
            Guardar en el almacén
          </OcButton>
        </div>
        <p class="muted">El valor nunca se muestra ni se registra; los logs lo redactan.</p>
      </div>
      <div class="card">
        <h4>Logs y errores</h4>
        <Show when={props.server.lastError}>
          <OcErrorState id={`mcp-error-${props.server.id}`} message={props.server.lastError ?? ""} retryLabel="Reintentar" onRetry={() => void mcpRetry(props.server.id, props.projectId)} />
        </Show>
        <Show when={(mcpState.detail.audit?.length ?? 0) > 0} fallback={<p class="muted">Sin eventos auditados para este servidor.</p>}>
          <ul id="mcp-audit">
            <For each={mcpState.detail.audit}>
              {(entry) => (
                <li data-audit={entry.id}>
                  <code>{entry.action}</code> <span class="muted">{entry.reason ?? "—"}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <div class="row">
          <OcButton id={`mcp-remove-${props.server.id}`} variant="danger" onClick={() => void mcpRemove(props.server.id, props.projectId)}>
            Eliminar servidor
          </OcButton>
        </div>
      </div>
    </section>
  );
}

export function McpManagerView(props?: { projectId?: string }) {
  const projectId = () => props?.projectId ?? state.activeProjectId ?? "";
  onMount(() => {
    if (projectId()) void mcpRefresh(projectId());
  });
  const selected = () => mcpState.servers.find((s) => s.id === mcpState.selectedId);
  return (
    <main class="settings-view" id="mcp-manager" aria-label="Gestor MCP">
      <button type="button" onClick={() => void setLayoutActivity("chat")}>
        ← Volver al chat
      </button>
      <h2>Conectores MCP</h2>
      <p class="muted">Lista de servidores con sus tres estados siempre distintos: configurado, conectado y autorizado. Nada se conecta sin confianza explícita.</p>
      <Show when={mcpState.error}>
        <div class="banner err" role="alert" id="mcp-banner-error">
          {mcpState.error}
          <button type="button" aria-label="Descartar error" onClick={() => mcpDismiss()}>
            ×
          </button>
        </div>
      </Show>
      <Show when={mcpState.notice}>
        <div class="banner" role="status" id="mcp-banner-notice">
          {mcpState.notice}
          <button type="button" aria-label="Descartar aviso" onClick={() => mcpDismiss()}>
            ×
          </button>
        </div>
      </Show>
      <div class="row">
        <OcButton id="mcp-refresh" variant="ghost" disabled={mcpState.loading} onClick={() => void mcpRefresh(projectId())}>
          Actualizar
        </OcButton>
        <span class="muted" id="mcp-count">
          {mcpState.servers.length} servidor(es) · workspace {projectId() || "—"}
        </span>
      </div>
      <section aria-label="Servidores">
        <Show when={mcpState.servers.length > 0} fallback={<OcEmpty id="mcp-empty" title="Sin servidores MCP" hint="Agrega uno por formulario o importa una configuración JSON. Nada se conectará sin tu confianza explícita." />}>
          <For each={mcpState.servers}>
            {(server) => <ServerCard server={server} projectId={projectId()} selected={server.id === mcpState.selectedId} />}
          </For>
        </Show>
      </section>
      <AddForm projectId={projectId()} />
      <ImportForm projectId={projectId()} />
      <Show when={selected()}>{(s) => <DetailView server={s()} projectId={projectId()} />}</Show>
    </main>
  );
}
