/**
 * Octus desktop main — McpService (Todo 10 de workbench-chat-terminal, montaje aditivo).
 *
 * Expone los canales `mcp.*` que el renderer invoca por el puente dinámico
 * `window.octus.invoke` (store/mcp.ts). Delega TODO el protocolo en
 * `McpClientManager` (Todo 26) y `mcp-server-management.ts` (Todo 29) sin
 * cambiarlos: validación SSRF/HTTPS, puerta de confianza, secretos solo en el
 * almacén del SO y auditoría siguen intactos en el core.
 *
 * Decisiones (auditable aquí, no dispersas):
 * - Sin secretos al renderer JAMÁS: `list` devuelve solo `hasSecret`
 *   (boolean); `setSecret` escribe directo al SecretStore; `audit` devuelve
 *   motivos ya seguros del core (sin material secreto).
 * - `configured ≠ conectado ≠ autorizado` siempre distintos: configured =
 *   existe la fila; connection = estado del runtime; authorized = confianza
 *   explícita global o del workspace pedido.
 * - Nombres/URLs son datos no confiables (prompt_injection): solo se usan
 *   recortados en mensajes y nunca se interpolan en comandos ni logs crudos.
 * - `projectId` vacío = sin workspace (solo confianza global); conectar sin
 *   workspace se rechaza con error visible, nunca con datos inventados.
 */
import {
  addHttpServer,
  addStdioServer,
  contentBindingFor,
  isolatedName,
  mcpSecretRef,
  parseServerImportJson,
  setServerAuth,
  toolBindingFor,
  verifyServer,
  McpClientManager,
  type PersistenceService,
  type SecretStore,
} from "@octus/core";
import type {
  McpAddRequest,
  McpAuditItem,
  McpPromptItem,
  McpResourceItem,
  McpServerSummary,
  McpToolItem,
} from "@octus/shared";

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `argsText` del formulario (separado por espacios, sin shell) → argv. */
function splitArgs(argsText?: string): string[] | undefined {
  if (argsText === undefined) return undefined;
  const parts = argsText.trim().split(/\s+/).filter((p) => p.length > 0);
  return parts;
}

/** Sin workspace (cadena vacía) = solo confianza global. */
function workspaceOf(projectId: string): string | undefined {
  return projectId.trim().length > 0 ? projectId : undefined;
}

function unsupportedMethod(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (code === -32601 || code === "MethodNotFound") return true;
  }
  return /method not found|methodnotfound|-32601/i.test(errText(error));
}

export class MainMcpService {
  private readonly manager: McpClientManager;

  constructor(
    db: PersistenceService,
    private readonly secrets: SecretStore,
  ) {
    this.manager = new McpClientManager(db, secrets);
  }

  async close(): Promise<void> {
    await this.manager.close();
  }

  /** Lista con los tres ejes por servidor; error de backend = excepción (el store la vuelve aviso con reintento). */
  async list(projectId: string): Promise<McpServerSummary[]> {
    const workspace = workspaceOf(projectId);
    const configs = await this.manager.listServers();
    const out: McpServerSummary[] = [];
    for (const config of configs) {
      const info = this.manager.status(config.id);
      const trustedGlobal = await this.manager.isTrusted(config.id);
      const trustedWorkspace = workspace === undefined ? false : await this.manager.isTrusted(config.id, workspace);
      let hasSecret = false;
      try {
        hasSecret = (await this.secrets.get(mcpSecretRef(config.id))) != null;
      } catch {
        hasSecret = false;
      }
      const summary: McpServerSummary = {
        id: config.id,
        name: config.name,
        transport: config.transport,
        command: config.command,
        args: config.args,
        url: config.url,
        enabled: config.enabled,
        configured: true,
        connection: info.status,
        attempts: info.attempts,
        capabilities: Object.keys(info.capabilities ?? {}),
        tools: info.tools,
        hasResources: info.hasResources,
        hasPrompts: info.hasPrompts,
        trustedGlobal,
        trustedWorkspace,
        hasSecret,
      };
      if (info.serverName !== undefined) summary.serverName = info.serverName;
      if (info.serverVersion !== undefined) summary.serverVersion = info.serverVersion;
      if (info.lastError !== undefined) summary.lastError = info.lastError;
      out.push(summary);
    }
    return out;
  }

  async add(input: McpAddRequest): Promise<{ id: string }> {
    if (input.transport !== "stdio" && input.transport !== "http") {
      throw new Error(`invalid transport: ${String(input.transport).slice(0, 40)}`);
    }
    const config =
      input.transport === "stdio"
        ? await addStdioServer(this.manager, {
            name: input.name,
            command: input.command ?? "",
            args: splitArgs(input.argsText),
            cwd: input.cwd,
            connectTimeoutMs: input.connectTimeoutMs,
          })
        : await addHttpServer(this.manager, {
            name: input.name,
            url: input.url ?? "",
            connectTimeoutMs: input.connectTimeoutMs,
          });
    // Alta NUNCA conecta ni otorga confianza; el token va directo al SO.
    if (input.token !== undefined && input.token.length > 0) {
      await setServerAuth(this.manager, config.id, { token: input.token });
    }
    return { id: config.id };
  }

  /** Import JSON con errores por índice (el JSON jamás puede traer secretos: lo rechaza el core). */
  async importJson(jsonText: string): Promise<{ added: string[]; errors: Array<{ index: number; error: string }> }> {
    const inputs = parseServerImportJson(jsonText);
    const added: string[] = [];
    const errors: Array<{ index: number; error: string }> = [];
    for (let index = 0; index < inputs.length; index++) {
      try {
        const config = await this.manager.addServer(inputs[index]!);
        added.push(config.id);
      } catch (error) {
        errors.push({ index, error: errText(error) });
      }
    }
    return { added, errors };
  }

  async update(
    id: string,
    patch: { name?: string; command?: string; argsText?: string; url?: string; enabled?: boolean },
  ): Promise<void> {
    await this.manager.updateServer(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.command !== undefined ? { command: patch.command } : {}),
      ...(patch.argsText !== undefined ? { args: splitArgs(patch.argsText) ?? [] } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    });
  }

  async remove(id: string): Promise<void> {
    await this.manager.removeServer(id);
  }

  async verify(id: string, projectId: string): Promise<{ ok: boolean; error?: string }> {
    const workspace = workspaceOf(projectId);
    if (workspace === undefined) return { ok: false, error: "workspace requerido para verificar" };
    try {
      await verifyServer(this.manager, id, workspace);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errText(error) };
    }
  }

  async connect(id: string, projectId: string): Promise<{ ok: boolean; error?: string }> {
    const workspace = workspaceOf(projectId);
    if (workspace === undefined) return { ok: false, error: "workspace requerido para conectar" };
    try {
      await this.manager.connect(id, { projectId: workspace });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errText(error) };
    }
  }

  async disconnect(id: string, projectId: string): Promise<void> {
    await this.manager.disconnect(id, workspaceOf(projectId) ?? undefined);
  }

  async retry(id: string, projectId: string): Promise<{ ok: boolean; error?: string }> {
    const workspace = workspaceOf(projectId);
    if (workspace === undefined) return { ok: false, error: "workspace requerido para reintentar" };
    try {
      await this.manager.reconnect(id, { projectId: workspace });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errText(error) };
    }
  }

  async setTrust(id: string, scope: "global" | "workspace", trusted: boolean, projectId: string): Promise<void> {
    if (scope !== "global" && scope !== "workspace") {
      throw new Error(`invalid scope: ${String(scope).slice(0, 40)}`);
    }
    const workspace = workspaceOf(projectId);
    if (scope === "workspace" && workspace === undefined) throw new Error("workspace requerido para confianza de workspace");
    await this.manager.setTrust(id, scope === "global" ? { scope: "global" } : { scope: "workspace", projectId: workspace! }, trusted);
  }

  async setSecret(id: string, token: string): Promise<void> {
    if (token.trim().length === 0) throw new Error("invalid payload");
    await setServerAuth(this.manager, id, { token });
  }

  /** Herramientas aisladas; sin confianza explícita = vacías y `authorized:false` (la vista las oculta). */
  async tools(id: string, projectId: string): Promise<{ authorized: boolean; items: McpToolItem[] }> {
    const authorized = await this.manager.isTrusted(id, workspaceOf(projectId));
    if (!authorized) return { authorized: false, items: [] };
    const binding = toolBindingFor(this.manager, id);
    const listed = await binding.listTools();
    return {
      authorized: true,
      items: listed.map((t) => ({
        name: t.name,
        isolated: isolatedName(id, t.name),
        ...(t.description !== undefined ? { description: t.description } : {}),
      })),
    };
  }

  async resources(id: string): Promise<{ supported: boolean; items: McpResourceItem[] }> {
    try {
      const binding = contentBindingFor(this.manager, id);
      const listed = await binding.listResources();
      return {
        supported: true,
        items: listed.map((r) => ({
          uri: r.uri,
          ...(r.name !== undefined ? { name: r.name } : {}),
          sensitive: false,
        })),
      };
    } catch (error) {
      if (unsupportedMethod(error)) return { supported: false, items: [] };
      throw new Error(errText(error));
    }
  }

  async prompts(id: string): Promise<{ supported: boolean; items: McpPromptItem[] }> {
    try {
      const binding = contentBindingFor(this.manager, id);
      const listed = await binding.listPrompts();
      return {
        supported: true,
        items: listed.map((p) => ({
          name: p.name,
          ...(p.description !== undefined ? { description: p.description } : {}),
          args: (p.arguments ?? []).map((a) => a.name),
        })),
      };
    } catch (error) {
      if (unsupportedMethod(error)) return { supported: false, items: [] };
      throw new Error(errText(error));
    }
  }

  async audit(id?: string): Promise<McpAuditItem[]> {
    const entries = await this.manager.auditLog(id);
    return entries.map((e) => ({
      id: e.id,
      serverId: e.serverId,
      projectId: e.projectId,
      action: e.action,
      reason: e.reason,
      occurredAt: e.occurredAt,
    }));
  }
}
