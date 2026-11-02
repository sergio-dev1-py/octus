/**
 * @octus/core — MCP Client Manager con confianza por workspace (Todo 26, ola 13).
 *
 * Servicio central de configuraciones, servidores, conexiones, handshake,
 * capacidades, reconexión controlada, timeouts y cancelación.
 *
 * Reglas de seguridad (contrato C-10 del Todo 5):
 * - La puerta de confianza precede a CUALQUIER conexión: ningún servidor
 *   desconocido conecta con confianza automática; un proyecto recién abierto
 *   nunca ejecuta servidores no autorizados.
 * - Confianza explícita global o por workspace; revocar vuelve a negar.
 * - Configuración en `mcp_servers` SIN secretos; secretos solo en el almacén
 *   del SO bajo `octus.mcp.<serverId>` (patrón SO-primero de secret-store).
 * - Octus nunca se expone como servidor: solo transportes de CLIENTE.
 *
 * Decisiones registradas:
 * - Auditoría en tabla propia `mcp_audit` (no en `events`): `PersistedEventType`
 *   es un union cerrado de las etapas 1–6 y no se reabre.
 * - Validación de URL http/https + sin credenciales aquí; el endurecimiento
 *   SSRF/HTTPS de la Todo 29 lo reutiliza sin cambiar esta API.
 */
import { createId } from "@octus/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OctusError } from "../errors.js";
import { backoffMs, now, sleep } from "../util.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import type { SecretStore } from "../secrets/secret-store.js";

export type McpTransportKind = "stdio" | "http";

export interface McpServerInput {
  id?: string;
  name: string;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  enabled?: boolean;
  connectTimeoutMs?: number;
}

export interface McpServerPatch {
  name?: string;
  command?: string;
  args?: string[];
  cwd?: string | null;
  url?: string;
  enabled?: boolean;
  connectTimeoutMs?: number | null;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransportKind;
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  enabled: boolean;
  connectTimeoutMs: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Secreto por servidor (SOLO en SecretStore, jamás en SQLite ni logs). */
export interface McpServerSecret {
  token?: string;
  env?: Record<string, string>;
}

export function mcpSecretRef(serverId: string): string {
  return `octus.mcp.${serverId}`;
}

export type McpTrustScope = { scope: "global" } | { scope: "workspace"; projectId: string };

export type McpConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "failed";

export interface McpConnectionInfo {
  serverId: string;
  status: McpConnectionStatus;
  serverName?: string;
  serverVersion?: string;
  capabilities: Record<string, unknown>;
  tools: string[];
  hasResources: boolean;
  hasPrompts: boolean;
  attempts: number;
  lastError?: string;
  connectedAt?: number;
}

export interface McpAuditEntry {
  id: string;
  serverId: string;
  projectId: string | null;
  action: string;
  reason: string | null;
  occurredAt: number;
}

export interface McpWorkspaceReport {
  projectId: string;
  connected: string[];
  denied: Array<{ serverId: string; reason: string }>;
  failed: Array<{ serverId: string; error: string }>;
}

export interface McpConnectOptions {
  projectId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface McpReconnectOptions extends McpConnectOptions {
  maxAttempts?: number;
  baseMs?: number;
}

export interface McpManagerOptions {
  connectTimeoutMs?: number;
  maxReconnectAttempts?: number;
  reconnectBaseMs?: number;
  reconnectCapMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_CAP_MS = 30_000;
const CLIENT_NAME = "octus";
const CLIENT_VERSION = "0.1.0";

/** Caracteres de shell: el comando va sin shell (spawn directo), se rechazan.
 *  Las rutas Windows con `\`, espacios o `(x86)` son legítimas y se permiten. */
const SHELL_META = /[;&|$`\n\r\0]/;
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function abortedError(ctx: string): OctusError {
  return new OctusError("aborted", `${ctx} aborted`);
}

function normalizeError(error: unknown, ctx: string): OctusError {
  if (error instanceof OctusError) return error;
  if (error instanceof DOMException && error.name === "AbortError") return abortedError(ctx);
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message)) return abortedError(ctx);
  if (/timed out|timeout/i.test(message)) {
    return new OctusError("timeout", `${ctx} timed out`, { details: { message: message.slice(0, 300) } });
  }
  return new OctusError("tool_failed", `${ctx} failed: ${message.slice(0, 300)}`);
}

function assertProjectId(projectId: string): void {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new OctusError("invalid_tool_args", `Invalid projectId for MCP trust scope: ${projectId.slice(0, 80)}`);
  }
}

function assertValidInput(input: McpServerInput): void {
  if (!input.name || !input.name.trim()) throw new OctusError("invalid_tool_args", "MCP server name is required");
  if (input.transport !== "stdio" && input.transport !== "http") {
    throw new OctusError("invalid_tool_args", `MCP transport must be 'stdio' or 'http', got: ${String(input.transport).slice(0, 40)}`);
  }
  if (input.transport === "stdio") {
    if (!input.command || !input.command.trim()) throw new OctusError("invalid_tool_args", "MCP stdio server requires a command");
    if (SHELL_META.test(input.command)) {
      throw new OctusError("invalid_tool_args", "MCP stdio command must not contain shell metacharacters (no shell is used)");
    }
    if (input.args !== undefined) {
      if (!Array.isArray(input.args) || input.args.some((a) => typeof a !== "string" || a.includes("\0"))) {
        throw new OctusError("invalid_tool_args", "MCP stdio args must be an array of strings");
      }
    }
  } else {
    if (!input.url) throw new OctusError("invalid_tool_args", "MCP http server requires a url");
    assertValidHttpUrl(input.url);
  }
  if (input.connectTimeoutMs !== undefined && (!Number.isInteger(input.connectTimeoutMs) || input.connectTimeoutMs <= 0)) {
    throw new OctusError("invalid_tool_args", "connectTimeoutMs must be a positive integer");
  }
}

export function assertValidHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OctusError("invalid_tool_args", `Invalid MCP server URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OctusError("invalid_tool_args", `MCP server URL must be http(s): ${url.protocol}//…`);
  }
  if (url.username || url.password) {
    throw new OctusError("invalid_tool_args", "MCP server URL must not embed credentials; use the OS secret store");
  }
  return url;
}

interface RuntimeState {
  status: McpConnectionStatus;
  client?: Client;
  transport?: StdioClientTransport | StreamableHTTPClientTransport;
  info: McpConnectionInfo;
}

function blankInfo(serverId: string): McpConnectionInfo {
  return {
    serverId,
    status: "disconnected",
    capabilities: {},
    tools: [],
    hasResources: false,
    hasPrompts: false,
    attempts: 0,
  };
}

export class McpClientManager {
  private readonly runtimes = new Map<string, RuntimeState>();
  private readonly connectTimeoutMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectCapMs: number;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly db: PersistenceService,
    private readonly secrets: SecretStore,
    options: McpManagerOptions = {},
  ) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectCapMs = options.reconnectCapMs ?? DEFAULT_RECONNECT_CAP_MS;
    this.sleepFn = options.sleep ?? sleep;
  }

  // -- configuración -------------------------------------------------------

  async addServer(input: McpServerInput): Promise<McpServerConfig> {
    assertValidInput(input);
    const id = input.id?.trim() || createId("mcp");
    if (!PROJECT_ID_RE.test(id)) throw new OctusError("invalid_tool_args", `Invalid MCP server id: ${id.slice(0, 80)}`);
    const existing = await this.db.queryOne("SELECT id FROM mcp_servers WHERE id = ?", [id]);
    if (existing) throw new OctusError("already_exists", `MCP server '${id}' already exists`);
    const at = now();
    await this.db.exec(
      `INSERT INTO mcp_servers (id, name, transport, command, args, cwd, url, enabled, connect_timeout_ms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name.trim(),
        input.transport,
        input.transport === "stdio" ? input.command!.trim() : null,
        JSON.stringify(input.args ?? []),
        input.cwd ?? null,
        input.transport === "http" ? input.url! : null,
        input.enabled === false ? 0 : 1,
        input.connectTimeoutMs ?? null,
        at,
        at,
      ],
    );
    // Añadir NUNCA conecta ni otorga confianza: la puerta precede a todo.
    await this.audit("server.added", id, null, `transport=${input.transport}`);
    return (await this.getServer(id))!;
  }

  async updateServer(id: string, patch: McpServerPatch): Promise<McpServerConfig> {
    const current = await this.getServer(id);
    if (!current) throw new OctusError("not_found", `Unknown MCP server '${id}'`);
    const next = {
      name: patch.name !== undefined ? patch.name : current.name,
      command: patch.command !== undefined ? patch.command : (current.command ?? undefined),
      args: patch.args !== undefined ? patch.args : current.args,
      cwd: patch.cwd !== undefined ? (patch.cwd ?? undefined) : (current.cwd ?? undefined),
      url: patch.url !== undefined ? patch.url : (current.url ?? undefined),
      enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
      connectTimeoutMs: patch.connectTimeoutMs !== undefined ? (patch.connectTimeoutMs ?? undefined) : (current.connectTimeoutMs ?? undefined),
    };
    assertValidInput({
      transport: current.transport,
      name: next.name,
      command: next.command,
      args: next.args,
      cwd: next.cwd ?? undefined,
      url: next.url ?? undefined,
      enabled: next.enabled,
      connectTimeoutMs: next.connectTimeoutMs,
    });
    await this.db.exec(
      `UPDATE mcp_servers SET name = ?, command = ?, args = ?, cwd = ?, url = ?, enabled = ?, connect_timeout_ms = ?, updated_at = ? WHERE id = ?`,
      [
        next.name.trim(),
        current.transport === "stdio" ? next.command!.trim() : null,
        JSON.stringify(next.args ?? []),
        next.cwd ?? null,
        current.transport === "http" ? next.url! : null,
        next.enabled === false ? 0 : 1,
        next.connectTimeoutMs ?? null,
        now(),
        id,
      ],
    );
    // Cambiar la configuración corta la conexión viva: no hay estado rancio.
    await this.disconnectQuiet(id);
    return (await this.getServer(id))!;
  }

  async removeServer(id: string): Promise<void> {
    const current = await this.getServer(id);
    if (!current) throw new OctusError("not_found", `Unknown MCP server '${id}'`);
    await this.disconnectQuiet(id);
    await this.db.exec("DELETE FROM mcp_servers WHERE id = ?", [id]);
    try {
      await this.secrets.delete(mcpSecretRef(id));
    } catch {
      // El almacén puede no tener secreto: no es un error de borrado.
    }
    await this.removeTrustEntries(id);
    await this.audit("server.removed", id, null, null);
  }

  async getServer(id: string): Promise<McpServerConfig | null> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM mcp_servers WHERE id = ?", [id]);
    return row ? deserializeConfig(row) : null;
  }

  async listServers(): Promise<McpServerConfig[]> {
    const rows = await this.db.query<Record<string, string | number | null>>("SELECT * FROM mcp_servers ORDER BY name ASC");
    return rows.map(deserializeConfig);
  }

  async setServerSecret(id: string, secret: McpServerSecret): Promise<void> {
    const current = await this.getServer(id);
    if (!current) throw new OctusError("not_found", `Unknown MCP server '${id}'`);
    if (!secret || (secret.token === undefined && secret.env === undefined)) {
      throw new OctusError("invalid_tool_args", "MCP secret must include a token and/or env");
    }
    await this.secrets.set(mcpSecretRef(id), JSON.stringify(secret));
    await this.audit("server.secret_set", id, null, "stored in OS secret store");
  }

  // -- confianza (la puerta precede a cualquier conexión) --------------------

  private trustKey(scope: McpTrustScope): string {
    return scope.scope === "global" ? "mcp.trust.global" : `mcp.trust.${scope.projectId}`;
  }

  private async readTrustMap(key: string): Promise<Record<string, boolean>> {
    const row = await this.db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", [key]);
    if (!row) return {};
    try {
      const parsed: unknown = JSON.parse(row.value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, boolean>;
      }
      return {};
    } catch {
      // Dato corrupto en kv: degradar a vacío, nunca a confiable.
      return {};
    }
  }

  private async writeTrustMap(key: string, map: Record<string, boolean>): Promise<void> {
    const compact: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(map)) if (v) compact[k] = true;
    await this.db.exec("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [
      key,
      JSON.stringify(compact),
      now(),
    ]);
  }

  async setTrust(serverId: string, scope: McpTrustScope, trusted: boolean): Promise<void> {
    const current = await this.getServer(serverId);
    if (!current) throw new OctusError("not_found", `Unknown MCP server '${serverId}'`);
    if (scope.scope === "workspace") assertProjectId(scope.projectId);
    const key = this.trustKey(scope);
    const map = await this.readTrustMap(key);
    if (trusted) map[serverId] = true;
    else delete map[serverId];
    await this.writeTrustMap(key, map);
    await this.audit(trusted ? "trust.granted" : "trust.revoked", serverId, scope.scope === "workspace" ? scope.projectId : null, scope.scope);
    if (!trusted) await this.disconnectQuiet(serverId);
  }

  async isTrusted(serverId: string, projectId?: string): Promise<boolean> {
    const global = await this.readTrustMap("mcp.trust.global");
    if (global[serverId] === true) return true;
    if (projectId === undefined) return false;
    assertProjectId(projectId);
    const local = await this.readTrustMap(`mcp.trust.${projectId}`);
    return local[serverId] === true;
  }

  private async removeTrustEntries(serverId: string): Promise<void> {
    const keys = await this.db.query<{ key: string }>("SELECT key FROM kv WHERE key = 'mcp.trust.global' OR key LIKE 'mcp.trust.%'");
    for (const { key } of keys) {
      const map = await this.readTrustMap(key);
      if (map[serverId]) {
        delete map[serverId];
        await this.writeTrustMap(key, map);
      }
    }
  }

  // -- conexiones ------------------------------------------------------------

  status(serverId: string): McpConnectionInfo {
    const info = this.runtimes.get(serverId)?.info ?? blankInfo(serverId);
    return { ...info, serverId };
  }

  statuses(): McpConnectionInfo[] {
    return [...this.runtimes.values()].map((r) => ({ ...r.info }));
  }

  private runtimeFor(serverId: string): RuntimeState {
    let runtime = this.runtimes.get(serverId);
    if (!runtime) {
      runtime = { status: "disconnected", info: blankInfo(serverId) };
      this.runtimes.set(serverId, runtime);
    }
    return runtime;
  }

  /** Puerta de confianza + un intento de conexión. */
  async connect(serverId: string, opts: McpConnectOptions): Promise<McpConnectionInfo> {
    assertProjectId(opts.projectId);
    if (opts.signal?.aborted) throw abortedError(`MCP connect '${serverId}'`);
    const config = await this.getServer(serverId);
    if (!config) throw new OctusError("not_found", `Unknown MCP server '${serverId}'`);
    if (!config.enabled) throw new OctusError("invalid_state", `MCP server '${serverId}' is disabled`);
    if (!(await this.isTrusted(serverId, opts.projectId))) {
      const reason = `server '${serverId}' is not trusted (scope: workspace '${opts.projectId}' / global)`;
      await this.audit("connect.denied", serverId, opts.projectId, reason);
      throw new OctusError("permission_denied", `MCP server '${serverId}' is not trusted for this workspace; grant explicit trust first`);
    }
    const runtime = this.runtimeFor(serverId);
    if (runtime.status === "connected") return { ...runtime.info };
    const timeoutMs = opts.timeoutMs ?? config.connectTimeoutMs ?? this.connectTimeoutMs;
    runtime.status = "connecting";
    runtime.info = { ...blankInfo(serverId), status: "connecting", attempts: 1 };
    try {
      await this.attemptConnect(serverId, config, opts.projectId, { signal: opts.signal, timeoutMs });
    } catch (error) {
      const normalized = normalizeError(error, `MCP connect '${serverId}'`);
      runtime.status = "failed";
      runtime.info.status = "failed";
      runtime.info.lastError = normalized.message;
      await this.audit("connect.failed", serverId, opts.projectId, normalized.message.slice(0, 300));
      throw normalized;
    }
    runtime.status = "connected";
    runtime.info.status = "connected";
    await this.audit("connect.ok", serverId, opts.projectId, runtime.info.serverName ?? null);
    return { ...runtime.info };
  }

  /** Reconexión controlada con backoff exponencial y tope de intentos. */
  async reconnect(serverId: string, opts: McpReconnectOptions): Promise<McpConnectionInfo> {
    assertProjectId(opts.projectId);
    if (opts.signal?.aborted) throw abortedError(`MCP reconnect '${serverId}'`);
    const config = await this.getServer(serverId);
    if (!config) throw new OctusError("not_found", `Unknown MCP server '${serverId}'`);
    if (!config.enabled) throw new OctusError("invalid_state", `MCP server '${serverId}' is disabled`);
    if (!(await this.isTrusted(serverId, opts.projectId))) {
      const reason = `server '${serverId}' is not trusted (scope: workspace '${opts.projectId}' / global)`;
      await this.audit("reconnect.denied", serverId, opts.projectId, reason);
      throw new OctusError("permission_denied", `MCP server '${serverId}' is not trusted for this workspace; grant explicit trust first`);
    }
    const maxAttempts = opts.maxAttempts ?? this.maxReconnectAttempts;
    const baseMs = opts.baseMs ?? this.reconnectBaseMs;
    const timeoutMs = opts.timeoutMs ?? config.connectTimeoutMs ?? this.connectTimeoutMs;
    const runtime = this.runtimeFor(serverId);
    runtime.status = "reconnecting";
    runtime.info.status = "reconnecting";
    let last: OctusError = new OctusError("tool_failed", `MCP reconnect '${serverId}' made no attempts`);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (opts.signal?.aborted) {
        last = abortedError(`MCP reconnect '${serverId}'`);
        break;
      }
      runtime.info.attempts = attempt;
      try {
        await this.attemptConnect(serverId, config, opts.projectId, { signal: opts.signal, timeoutMs });
        runtime.status = "connected";
        runtime.info.status = "connected";
        runtime.info.lastError = undefined;
        await this.audit("reconnect.ok", serverId, opts.projectId, `attempt=${attempt}`);
        return { ...runtime.info };
      } catch (error) {
        last = normalizeError(error, `MCP reconnect '${serverId}'`);
        runtime.info.lastError = last.message;
        if (last.code === "aborted" || attempt >= maxAttempts) break;
        const delay = backoffMs(attempt, baseMs, this.reconnectCapMs);
        try {
          await this.sleepFn(delay, opts.signal);
        } catch {
          last = abortedError(`MCP reconnect '${serverId}'`);
          break;
        }
      }
    }
    runtime.status = "failed";
    runtime.info.status = "failed";
    await this.audit("reconnect.failed", serverId, opts.projectId, last.message.slice(0, 300));
    throw last;
  }

  /**
   * Apertura de workspace: conecta SOLO lo confiable. Lo no confiable se niega
   * y se audita sin crear ningún transporte ni proceso.
   */
  async openWorkspace(projectId: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<McpWorkspaceReport> {
    assertProjectId(projectId);
    const report: McpWorkspaceReport = { projectId, connected: [], denied: [], failed: [] };
    const servers = (await this.listServers()).filter((s) => s.enabled);
    for (const server of servers) {
      if (opts.signal?.aborted) throw abortedError(`MCP openWorkspace '${projectId}'`);
      if (!(await this.isTrusted(server.id, projectId))) {
        const reason = `server '${server.id}' is not trusted (scope: workspace '${projectId}' / global)`;
        await this.audit("workspace.open.denied", server.id, projectId, reason);
        report.denied.push({ serverId: server.id, reason });
        continue;
      }
      const timeoutMs = opts.timeoutMs ?? server.connectTimeoutMs ?? this.connectTimeoutMs;
      const runtime = this.runtimeFor(server.id);
      runtime.status = "connecting";
      runtime.info = { ...blankInfo(server.id), status: "connecting", attempts: 1 };
      try {
        await this.attemptConnect(server.id, server, projectId, { signal: opts.signal, timeoutMs });
        runtime.status = "connected";
        runtime.info.status = "connected";
        await this.audit("connect.ok", server.id, projectId, runtime.info.serverName ?? null);
        report.connected.push(server.id);
      } catch (error) {
        const normalized = normalizeError(error, `MCP connect '${server.id}'`);
        runtime.status = "failed";
        runtime.info.status = "failed";
        runtime.info.lastError = normalized.message;
        await this.audit("connect.failed", server.id, projectId, normalized.message.slice(0, 300));
        report.failed.push({ serverId: server.id, error: normalized.message });
      }
    }
    return report;
  }

  async disconnect(serverId: string, projectId?: string): Promise<void> {
    await this.disconnectQuiet(serverId);
    await this.audit("disconnect", serverId, projectId ?? null, null);
  }

  private async disconnectQuiet(serverId: string): Promise<void> {
    const runtime = this.runtimes.get(serverId);
    if (!runtime) return;
    const { client, transport } = runtime;
    runtime.client = undefined;
    runtime.transport = undefined;
    runtime.status = "disconnected";
    runtime.info = { ...blankInfo(serverId), attempts: runtime.info.attempts, lastError: runtime.info.lastError };
    if (transport) {
      try {
        await transport.close();
      } catch {
        // Cierre best-effort: el estado ya es disconnected.
      }
    }
    if (client) {
      try {
        await client.close();
      } catch {
        // Idem.
      }
    }
  }

  /**
   * Accesor de solo lectura al `Client` conectado (Todo 29, aditivo).
   * La puerta de confianza NO se relaja: solo devuelve el cliente cuando el
   * estado es `connected` (handshake + capacidades negociadas). La fachada
   * de gestión (Todo 29) lo envuelve con `SdkClientBinding`/`SdkContentBinding`
   * de los puentes 27/28 sin cambiarlos.
   */
  connectedClient(serverId: string): Client | undefined {
    const runtime = this.runtimes.get(serverId);
    if (!runtime || runtime.status !== "connected" || !runtime.client) return undefined;
    return runtime.client;
  }

  /** Disponibilidad = conexión + handshake vigentes (espejo de `status`). */
  isAvailable(serverId: string): boolean {
    return this.runtimes.get(serverId)?.status === "connected";
  }

  /**
   * Revoca el secreto del almacén del SO, corta la conexión viva y lo audita
   * (Todo 29). Sin secreto no hay Authorization Bearer en HTTP ni env STDIO:
   * el siguiente `connect` opera sin credencial hasta que se rote una nueva.
   */
  async clearServerSecret(id: string): Promise<void> {
    const current = await this.getServer(id);
    if (!current) throw new OctusError("not_found", `Unknown MCP server '${id}'`);
    // Cortar primero: ningún transporte vivo conserva la credencial en memoria.
    await this.disconnectQuiet(id);
    try {
      await this.secrets.delete(mcpSecretRef(id));
    } catch {
      // Best-effort: si el almacén ya no lo tiene, el estado es el deseado.
    }
    await this.audit("server.secret_revoked", id, null, "secret removed from OS store; live connection cut");
  }

  async close(): Promise<void> {
    for (const serverId of [...this.runtimes.keys()]) {
      await this.disconnectQuiet(serverId);
    }
  }

  // -- handshake ---------------------------------------------------------------

  private async attemptConnect(
    serverId: string,
    config: McpServerConfig,
    _projectId: string,
    opts: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<void> {
    const runtime = this.runtimeFor(serverId);
    const transport = await this.buildTransport(config);
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
    try {
      await withDeadline(
        (signal) => client.connect(transport, { signal, timeout: opts.timeoutMs }),
        { signal: opts.signal, timeoutMs: opts.timeoutMs, dispose: () => quietDispose(client, transport), ctx: `MCP connect '${serverId}'` },
      );
      const version = client.getServerVersion();
      const capabilities = client.getServerCapabilities() ?? {};
      const tools = await withDeadline((signal) => client.listTools(undefined, { signal, timeout: opts.timeoutMs }), {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        dispose: () => quietDispose(client, transport),
        ctx: `MCP tools/list '${serverId}'`,
      });
      // Recursos y prompts: descubrimiento best-effort; lo no negociado
      // queda en false y lo usa la Todo 28, nunca se anuncia de más.
      let hasResources = false;
      let hasPrompts = false;
      try {
        await withDeadline((signal) => client.listResources(undefined, { signal, timeout: opts.timeoutMs }), {
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
          dispose: async () => undefined,
          ctx: `MCP resources/list '${serverId}'`,
        });
        hasResources = true;
      } catch {
        hasResources = false;
      }
      try {
        await withDeadline((signal) => client.listPrompts(undefined, { signal, timeout: opts.timeoutMs }), {
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
          dispose: async () => undefined,
          ctx: `MCP prompts/list '${serverId}'`,
        });
        hasPrompts = true;
      } catch {
        hasPrompts = false;
      }
      runtime.client = client;
      runtime.transport = transport;
      runtime.info = {
        serverId,
        status: "connecting",
        serverName: version?.name,
        serverVersion: version?.version,
        capabilities: capabilities as Record<string, unknown>,
        tools: (tools.tools ?? []).map((t) => t.name),
        hasResources,
        hasPrompts,
        attempts: runtime.info.attempts || 1,
        connectedAt: now(),
      };
    } catch (error) {
      await quietDispose(client, transport);
      throw error;
    }
  }

  private async buildTransport(config: McpServerConfig): Promise<StdioClientTransport | StreamableHTTPClientTransport> {
    if (config.transport === "stdio") {
      const secret = await this.readSecret(config.id);
      return new StdioClientTransport({
        command: config.command!,
        args: config.args,
        cwd: config.cwd ?? undefined,
        env: secret?.env ? { ...process.env as Record<string, string>, ...secret.env } : undefined,
      });
    }
    const url = assertValidHttpUrl(config.url!);
    const secret = await this.readSecret(config.id);
    return new StreamableHTTPClientTransport(url, {
      requestInit: secret?.token ? { headers: { Authorization: `Bearer ${secret.token}` } } : undefined,
    });
  }

  private async readSecret(serverId: string): Promise<McpServerSecret | undefined> {
    const raw = await this.secrets.get(mcpSecretRef(serverId));
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as McpServerSecret;
      return undefined;
    } catch {
      throw new OctusError("invalid_state", `MCP secret for '${serverId}' is corrupt; reset it in the OS store`);
    }
  }

  // -- auditoría -----------------------------------------------------------------

  private async audit(action: string, serverId: string, projectId: string | null, reason: string | null): Promise<void> {
    await this.db.exec("INSERT INTO mcp_audit (id, server_id, project_id, action, reason, occurred_at) VALUES (?, ?, ?, ?, ?, ?)", [
      createId("mau"),
      serverId,
      projectId,
      action,
      reason,
      now(),
    ]);
  }

  async auditLog(serverId?: string, limit = 200): Promise<McpAuditEntry[]> {
    const rows =
      serverId === undefined
        ? await this.db.query<Record<string, string | number | null>>("SELECT * FROM mcp_audit ORDER BY occurred_at ASC LIMIT ?", [limit])
        : await this.db.query<Record<string, string | number | null>>("SELECT * FROM mcp_audit WHERE server_id = ? ORDER BY occurred_at ASC LIMIT ?", [serverId, limit]);
    return rows.map((row) => ({
      id: String(row.id),
      serverId: String(row.server_id),
      projectId: row.project_id === null ? null : String(row.project_id),
      action: String(row.action),
      reason: row.reason === null ? null : String(row.reason),
      occurredAt: Number(row.occurred_at),
    }));
  }
}

function deserializeConfig(row: Record<string, string | number | null>): McpServerConfig {
  let args: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.args ?? "[]"));
    if (Array.isArray(parsed)) args = parsed.filter((a): a is string => typeof a === "string");
  } catch {
    args = [];
  }
  const transport = String(row.transport) === "http" ? "http" : "stdio";
  return {
    id: String(row.id),
    name: String(row.name),
    transport,
    command: row.command === null ? null : String(row.command),
    args,
    cwd: row.cwd === null ? null : String(row.cwd),
    url: row.url === null ? null : String(row.url),
    enabled: Number(row.enabled) !== 0,
    connectTimeoutMs: row.connect_timeout_ms === null ? null : Number(row.connect_timeout_ms),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

async function quietDispose(client: Client, transport: StdioClientTransport | StreamableHTTPClientTransport): Promise<void> {
  try {
    await transport.close();
  } catch {
    // Best-effort.
  }
  try {
    await client.close();
  } catch {
    // Best-effort.
  }
}

/**
 * Plazo + cancelación uniformes sobre el SDK: el temporizador y la señal
 * externa cierran el transporte (mata el subproceso STDIO) antes de rechazar.
 */
async function withDeadline<T>(
  task: (signal: AbortSignal) => Promise<T>,
  opts: { signal?: AbortSignal; timeoutMs: number; dispose: () => Promise<void>; ctx: string },
): Promise<T> {
  if (opts.signal?.aborted) throw abortedError(opts.ctx);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onExternalAbort);
      fn();
    };
    const onExternalAbort = () => {
      void opts.dispose().catch(() => undefined);
      controller.abort();
      settle(() => reject(abortedError(opts.ctx)));
    };
    const onTimeout = () => {
      void opts.dispose().catch(() => undefined);
      controller.abort();
      settle(() => reject(new OctusError("timeout", `${opts.ctx} timed out after ${opts.timeoutMs}ms`)));
    };
    opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
    timer = setTimeout(onTimeout, opts.timeoutMs);
    task(controller.signal).then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => {
        if (opts.signal?.aborted) settle(() => reject(abortedError(opts.ctx)));
        else settle(() => reject(error));
      },
    );
  });
}
