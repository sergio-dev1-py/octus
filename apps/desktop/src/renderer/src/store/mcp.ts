/** Renderer/store — MCP Manager UI (Todo 30, W-M1 a W-M6).
 * Puente fino entre la vista views/mcp.tsx y el backend:
 * - `McpClient` es la interfaz inyectable (producción: IPC `mcp.*` vía
 *   `window.octus.invoke` dinámico —los canales los provee el main en el
 *   Todo 29—; QA: cliente fetch contra el puente del harness).
 * - Este módulo NO toca packages/shared (contrato IPC del Todo 29) ni guarda
 *   secretos: solo el indicador `hasSecret`, nunca el valor.
 * - Invariantes visibles que la vista debe mantener (spec W-M):
 *   configurado ≠ conectado ≠ autorizado, siempre distintos;
 *   configurar un remoto nunca se llama instalar. */
import { createStore } from "solid-js/store";

export type McpTransport = "stdio" | "http";
export type McpConnStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "failed";
export type McpTrustScope = "global" | "workspace";

/** Resumen por servidor: configuración + conexión + confianza (tres ejes separados). */
export interface McpServerSummary {
  id: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  url: string | null;
  enabled: boolean;
  /** Existe la configuración (listar implica configurado). */
  configured: boolean;
  connection: McpConnStatus;
  lastError?: string;
  attempts: number;
  serverName?: string;
  serverVersion?: string;
  capabilities: string[];
  /** Nombres de herramienta tal cual los anunció el handshake (pueden ocultarse si no autorizado). */
  tools: string[];
  hasResources: boolean;
  hasPrompts: boolean;
  trustedGlobal: boolean;
  trustedWorkspace: boolean;
  /** Solo indicador: el secreto vive en el almacén del SO, jamás en el renderer. */
  hasSecret: boolean;
}

export interface McpToolItem {
  name: string;
  isolated: string;
  description?: string;
}

export interface McpResourceItem {
  uri: string;
  name?: string;
  sensitive: boolean;
}

export interface McpPromptItem {
  name: string;
  description?: string;
  args: string[];
}

export interface McpAuditItem {
  id: string;
  serverId: string;
  projectId: string | null;
  action: string;
  reason: string | null;
  occurredAt: number;
}

export interface McpAddInput {
  name: string;
  transport: McpTransport;
  /** STDIO: ejecutable y argumentos separados, sin shell. */
  command?: string;
  argsText?: string;
  cwd?: string;
  /** HTTP: URL con autenticación (el token va al almacén del SO). */
  url?: string;
  token?: string;
  connectTimeoutMs?: number;
}

export interface McpImportResult {
  added: string[];
  errors: Array<{ index: number; error: string }>;
}

export interface McpOpResult {
  ok: boolean;
  error?: string;
}

/** Operaciones que la vista necesita. Todo serializable JSON. */
export interface McpClient {
  list(projectId: string): Promise<McpServerSummary[]>;
  add(input: McpAddInput): Promise<{ id: string }>;
  importJson(jsonText: string): Promise<McpImportResult>;
  update(id: string, patch: { name?: string; command?: string; argsText?: string; url?: string; enabled?: boolean }): Promise<void>;
  remove(id: string): Promise<void>;
  verify(id: string, projectId: string): Promise<McpOpResult>;
  connect(id: string, projectId: string): Promise<McpOpResult>;
  disconnect(id: string, projectId: string): Promise<void>;
  retry(id: string, projectId: string): Promise<McpOpResult>;
  setTrust(id: string, scope: McpTrustScope, trusted: boolean, projectId: string): Promise<void>;
  setSecret(id: string, token: string): Promise<void>;
  tools(id: string, projectId: string): Promise<{ authorized: boolean; items: McpToolItem[] }>;
  resources(id: string): Promise<{ supported: boolean; items: McpResourceItem[] }>;
  prompts(id: string): Promise<{ supported: boolean; items: McpPromptItem[] }>;
  audit(id?: string): Promise<McpAuditItem[]>;
}

/**
 * Cliente de producción: invoca los canales `mcp.*` del main por el puente
 * `window.octus.invoke` sin pasar por el contrato tipado de @octus/shared
 * (ese contrato lo amplía el Todo 29 con los mismos nombres de operación
 * usados aquí: list/add/import/update/remove/verify/connect/disconnect/
 * retry/setTrust/setSecret/tools/resources/prompts/audit).
 * Si el backend aún no los expone, cada llamada rechaza y el store lo
 * convierte en aviso visible en vez de inventar datos.
 */
export function createIpcMcpClient(): McpClient {
  async function call<T>(op: string, payload: Record<string, unknown>): Promise<T> {
    const bridge = (window as unknown as { octus?: { invoke?: (channel: string, payload: unknown) => Promise<T> } }).octus;
    if (!bridge?.invoke) throw new Error("Puente IPC no disponible");
    return bridge.invoke(`mcp.${op}`, payload);
  }
  const wrap = async <T>(op: string, payload: Record<string, unknown>): Promise<T> => call<T>(op, payload);
  return {
    list: (projectId) => wrap("list", { projectId }),
    add: (input) => wrap("add", { ...input }),
    importJson: (jsonText) => wrap("import", { jsonText }),
    update: (id, patch) => wrap("update", { id, ...patch }),
    remove: (id) => wrap("remove", { id }),
    verify: (id, projectId) => wrap("verify", { id, projectId }),
    connect: (id, projectId) => wrap("connect", { id, projectId }),
    disconnect: (id, projectId) => wrap("disconnect", { id, projectId }),
    retry: (id, projectId) => wrap("retry", { id, projectId }),
    setTrust: (id, scope, trusted, projectId) => wrap("setTrust", { id, scope, trusted, projectId }),
    setSecret: (id, token) => wrap("setSecret", { id, token }),
    tools: (id, projectId) => wrap("tools", { id, projectId }),
    resources: (id) => wrap("resources", { id }),
    prompts: (id) => wrap("prompts", { id }),
    audit: (id) => wrap("audit", { id }),
  };
}

export interface McpDetail {
  tools: { authorized: boolean; items: McpToolItem[] } | null;
  resources: { supported: boolean; items: McpResourceItem[] } | null;
  prompts: { supported: boolean; items: McpPromptItem[] } | null;
  audit: McpAuditItem[];
}

interface McpUIState {
  servers: McpServerSummary[];
  selectedId?: string;
  detail: McpDetail;
  loading: boolean;
  busyId?: string;
  notice?: string;
  error?: string;
  /** Última operación de escritura (para mostrar su resultado junto a su formulario). */
  lastOp?: "add" | "import";
}

const [mcpState, setMcpState] = createStore<McpUIState>({
  servers: [],
  selectedId: undefined,
  detail: { tools: null, resources: null, prompts: null, audit: [] },
  loading: false,
  busyId: undefined,
  notice: undefined,
  error: undefined,
  lastOp: undefined,
});

let activeClient: McpClient | null = null;

export { mcpState };

/** Inyección del transporte (producción: IPC; QA: fetch contra el harness). */
export function setMcpClient(client: McpClient): void {
  activeClient = client;
}

function client(): McpClient {
  if (!activeClient) activeClient = createIpcMcpClient();
  return activeClient;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function mcpRefresh(projectId: string): Promise<void> {
  setMcpState("loading", true);
  setMcpState("error", undefined);
  try {
    const servers = await client().list(projectId);
    setMcpState("servers", servers);
    if (mcpState.selectedId && !servers.some((s) => s.id === mcpState.selectedId)) {
      setMcpState("selectedId", undefined);
    }
  } catch (error) {
    setMcpState("error", `No se pudo cargar el gestor MCP: ${errText(error)}`);
  } finally {
    setMcpState("loading", false);
  }
}

export async function mcpAdd(input: McpAddInput, projectId: string): Promise<string | null> {
  setMcpState("busyId", "__add");
  setMcpState("error", undefined);
  setMcpState("notice", undefined);
  setMcpState("lastOp", "add");
  try {
    const { id } = await client().add(input);
    setMcpState("notice", `Servidor configurado, pendiente de confianza: ${id}`);
    await mcpRefresh(projectId);
    setMcpState("selectedId", id);
    return id;
  } catch (error) {
    setMcpState("error", `No se pudo agregar: ${errText(error)}`);
    return null;
  } finally {
    setMcpState("busyId", undefined);
  }
}

export async function mcpImport(jsonText: string, projectId: string): Promise<McpImportResult | null> {
  setMcpState("busyId", "__import");
  setMcpState("error", undefined);
  setMcpState("notice", undefined);
  setMcpState("lastOp", "import");
  try {
    const result = await client().importJson(jsonText);
    setMcpState(
      "notice",
      result.errors.length === 0
        ? `Configuración importada: ${result.added.join(", ") || "sin cambios"}. Pendiente de confianza.`
        : `Importados ${result.added.length}, con errores en ${result.errors.length} entrada(s).`,
    );
    await mcpRefresh(projectId);
    return result;
  } catch (error) {
    setMcpState("error", `Importación inválida: ${errText(error)}`);
    return null;
  } finally {
    setMcpState("busyId", undefined);
  }
}

/* Orden: refrescar ANTES de fijar el error. mcpRefresh limpia el error previo;
   fijarlo antes del refresh lo borraría y el fallo quedaría invisible. */
export async function mcpConnect(id: string, projectId: string): Promise<boolean> {
  setMcpState("busyId", id);
  setMcpState("error", undefined);
  try {
    const result = await client().connect(id, projectId);
    if (!result.ok) {
      await mcpRefresh(projectId);
      setMcpState("error", result.error ?? `No se pudo conectar ${id}`);
      return false;
    }
    await mcpRefresh(projectId);
    await mcpSelect(id, projectId);
    return true;
  } catch (error) {
    const text = `No se pudo conectar ${id}: ${errText(error)}`;
    await mcpRefresh(projectId);
    setMcpState("error", text);
    return false;
  } finally {
    setMcpState("busyId", undefined);
  }
}

export async function mcpDisconnect(id: string, projectId: string): Promise<void> {
  setMcpState("busyId", id);
  let text: string | undefined;
  try {
    await client().disconnect(id, projectId);
  } catch (error) {
    text = `No se pudo desconectar ${id}: ${errText(error)}`;
  } finally {
    setMcpState("busyId", undefined);
    await mcpRefresh(projectId);
    if (text) setMcpState("error", text);
    if (mcpState.selectedId === id) await mcpSelect(id, projectId);
  }
}

export async function mcpRetry(id: string, projectId: string): Promise<boolean> {
  setMcpState("busyId", id);
  setMcpState("error", undefined);
  try {
    const result = await client().retry(id, projectId);
    await mcpRefresh(projectId);
    if (!result.ok) setMcpState("error", result.error ?? `Reintento fallido para ${id}`);
    return result.ok;
  } catch (error) {
    const text = `Reintento fallido para ${id}: ${errText(error)}`;
    await mcpRefresh(projectId);
    setMcpState("error", text);
    return false;
  } finally {
    setMcpState("busyId", undefined);
  }
}

export async function mcpSetTrust(id: string, scope: McpTrustScope, trusted: boolean, projectId: string): Promise<void> {
  setMcpState("busyId", id);
  let text: string | undefined;
  try {
    await client().setTrust(id, scope, trusted, projectId);
    setMcpState(
      "notice",
      trusted ? `Confianza otorgada a ${id} (${scope}).` : `Confianza revocada a ${id} (${scope}); conexión cortada.`,
    );
  } catch (error) {
    text = `No se pudo cambiar la confianza de ${id}: ${errText(error)}`;
  } finally {
    setMcpState("busyId", undefined);
    await mcpRefresh(projectId);
    if (text) setMcpState("error", text);
    if (mcpState.selectedId === id) await mcpSelect(id, projectId);
  }
}

export async function mcpSaveSecret(id: string, token: string, projectId: string): Promise<void> {
  setMcpState("busyId", id);
  let text: string | undefined;
  try {
    await client().setSecret(id, token);
    setMcpState("notice", `Credencial guardada en el almacén del sistema para ${id}.`);
  } catch (error) {
    text = `No se pudo guardar la credencial de ${id}: ${errText(error)}`;
  } finally {
    setMcpState("busyId", undefined);
    await mcpRefresh(projectId);
    if (text) setMcpState("error", text);
  }
}

export async function mcpRemove(id: string, projectId: string): Promise<void> {
  setMcpState("busyId", id);
  let text: string | undefined;
  try {
    await client().remove(id);
    setMcpState("notice", `Servidor ${id} eliminado con su credencial.`);
  } catch (error) {
    text = `No se pudo eliminar ${id}: ${errText(error)}`;
  } finally {
    setMcpState("busyId", undefined);
    await mcpRefresh(projectId);
    if (text) setMcpState("error", text);
  }
}

export async function mcpSelect(id: string, projectId: string): Promise<void> {
  setMcpState("selectedId", id);
  setMcpState("detail", { tools: null, resources: null, prompts: null, audit: [] });
  try {
    const [tools, resources, prompts, audit] = await Promise.all([
      client().tools(id, projectId),
      client().resources(id),
      client().prompts(id),
      client().audit(id),
    ]);
    setMcpState("detail", { tools, resources, prompts, audit });
  } catch (error) {
    setMcpState("error", `No se pudo cargar el detalle de ${id}: ${errText(error)}`);
  }
}

export function mcpDismiss(): void {
  setMcpState("error", undefined);
  setMcpState("notice", undefined);
  setMcpState("lastOp", undefined);
}
