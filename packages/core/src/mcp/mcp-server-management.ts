/**
 * @octus/core — Gestión de servidores, credenciales y seguridad MCP (Todo 29, contrato C-13).
 *
 * Fachada sobre `McpClientManager` (Todo 26) y los puentes 27/28 SIN cambiarlos:
 * el `Client` conectado se obtiene vía `manager.connectedClient()` (accesor
 * aditivo del Todo 29) y se envuelve con `SdkClientBinding`/`SdkContentBinding`.
 *
 * Decisiones (una sola pieza coherente, trazables a la spec 2026-07-28):
 * - `security_best_practices` SSRF: HTTPS exigido salvo loopback de desarrollo;
 *   bloqueo de rangos privados/reservados (10/8, 172.16/12, 192.168/16,
 *   127/8, 169.254/16 incl. metadatos cloud, fc00::/7, fe80::/10), hostnames
 *   privados (`localhost`, `*.localhost`, `*.local`, `*.internal`, `*.lan`),
 *   SIN credenciales en la URL y revalidación de redirecciones. Patrón
 *   compartido con `tools/web-tools.ts` (guardas SSRF existentes).
 * - `authorization`: STDIO nunca lleva token (credenciales por entorno del
 *   subproceso, solo desde el almacén del SO); HTTP lleva `Authorization:
 *   Bearer` solo desde el secreto del SO, jamás de la URL ni del JSON/SQLite.
 * - Secretos SOLO en `SecretStore` (SO-primero); el import JSON rechaza claves
 *   con material secreto; `redactSecrets` sanea cualquier texto para logs.
 * - Límites: tope de caracteres por snapshot, timeout por defecto y cancelación
 *   por `AbortSignal` en toda operación de red/protocolo.
 */
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { OctusError } from "../errors.js";
import { now } from "../util.js";
import {
  McpClientManager,
  type McpConnectionInfo,
  type McpServerConfig,
  type McpServerInput,
  type McpTrustScope,
} from "./mcp-client-manager.js";
import { SdkClientBinding, type McpToolDescription } from "./mcp-tool-bridge.js";
import { SdkContentBinding, type McpPromptInfo, type McpResourceInfo } from "./mcp-resources.js";

export const MCP_MANAGEMENT_VERSION = "C-13";
export const DEFAULT_QUERY_TIMEOUT_MS = 15_000;
export const DEFAULT_SNAPSHOT_MAX_CHARS = 20_000;
const LOOPBACK_HTTP_MESSAGE = "MCP server URL must use https (plain http is only allowed for loopback development addresses)";

/** Claves que indican material secreto: el import JSON/SQLite las rechaza. */
const SECRET_KEY_RE = /(token|secret|password|passwd|api[-_ ]?key|authorization|bearer|cookie|private[-_ ]?key)/i;

function abortedError(ctx: string): OctusError {
  return new OctusError("aborted", `${ctx} aborted`);
}

// ---------------------------------------------------------------------------
// SSRF + HTTPS (patrón compartido con tools/web-tools.ts)
// ---------------------------------------------------------------------------

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, "");
  return lower === "localhost" || lower === "127.0.0.1" || lower === "::1" || lower === "[::1]";
}

/** 127.0.0.0/8 y ::1 como literales: loopback de desarrollo, http permitido. */
function isLoopbackLiteral(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  if (isIP(bare) === 4) return bare === "127.0.0.1" || bare.startsWith("127.");
  if (isIP(bare) === 6) return bare === "::1";
  return false;
}

function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, "");
  if (lower === "localhost") return true;
  if (lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal") || lower.endsWith(".lan")) return true;
  return false;
}

function isPrivateLiteralIP(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("ff")) return true;
    return false;
  }
  return true;
}

/**
 * Validación síncrona (sin DNS): esquema, credenciales, HTTPS y literales.
 * Rechaza `http://169.254.169.254` y rangos privados SIN resolución DNS.
 */
export function assertMcpServerUrlSync(raw: string): URL {
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
  if (isLoopbackHostname(url.hostname)) {
    // Loopback de desarrollo (localhost, 127.0.0.1, ::1): http permitido.
    return url;
  }
  if (isPrivateHostname(url.hostname)) {
    throw new OctusError("scope_violation", `Blocked private/local host: ${url.hostname}`);
  }
  const hostForIp = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostForIp)) {
    if (isLoopbackLiteral(hostForIp)) return url;
    if (isPrivateLiteralIP(hostForIp)) {
      throw new OctusError("scope_violation", `Blocked non-public address in MCP server URL: ${url.hostname}`);
    }
    if (url.protocol !== "https:") {
      throw new OctusError("invalid_tool_args", LOOPBACK_HTTP_MESSAGE);
    }
  } else if (url.protocol !== "https:") {
    throw new OctusError("invalid_tool_args", LOOPBACK_HTTP_MESSAGE);
  }
  return url;
}

export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultLookup: DnsLookupFn = (hostname: string) =>
  dnsLookup(hostname, { all: true }) as Promise<Array<{ address: string }>>;

/**
 * Revalidación con DNS (con `lookup` inyectable para pruebas deterministas).
 * Rechaza hostnames que resuelvan a rangos privados (TOCTOU documentado:
 * la conexión HTTP del SDK resuelve de nuevo; defensa en profundidad).
 */
export async function assertMcpServerUrlResolves(raw: string, lookup: DnsLookupFn = defaultLookup): Promise<URL> {
  const url = assertMcpServerUrlSync(raw);
  const hostForIp = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostForIp)) return url;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname);
  } catch {
    throw new OctusError("tool_failed", `DNS resolution failed for ${url.hostname}`);
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateLiteralIP(a.address.replace(/^\[|\]$/g, "")))) {
    throw new OctusError("scope_violation", `Blocked non-public address for host: ${url.hostname}`);
  }
  return url;
}

/** Revalidación de un destino de redirección con las mismas reglas del servidor. */
export function assertMcpRedirectTarget(raw: string): URL {
  try {
    return assertMcpServerUrlSync(raw);
  } catch (error) {
    if (error instanceof OctusError) {
      throw new OctusError(error.code, `Blocked MCP redirect target: ${error.message.slice(0, 200)}`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Formulario + JSON compatible (STDIO sin shell; HTTP con auth por secreto)
// ---------------------------------------------------------------------------

export interface McpStdioForm {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  enabled?: boolean;
  connectTimeoutMs?: number;
}

export interface McpHttpForm {
  name: string;
  url: string;
  enabled?: boolean;
  connectTimeoutMs?: number;
}

function assertNoSecretKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecretKeys(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        throw new OctusError(
          "invalid_tool_args",
          `MCP import at ${path}.${k}: secrets must go to the OS secret store, never to JSON/SQLite`,
        );
      }
      assertNoSecretKeys(v, `${path}.${k}`);
    }
  }
}

function toStdioInput(form: McpStdioForm): McpServerInput {
  return {
    name: form.name,
    transport: "stdio",
    command: form.command,
    args: form.args,
    cwd: form.cwd,
    enabled: form.enabled,
    connectTimeoutMs: form.connectTimeoutMs,
  };
}

function toHttpInput(form: McpHttpForm): McpServerInput {
  assertMcpServerUrlSync(form.url);
  return {
    name: form.name,
    transport: "http",
    url: form.url,
    enabled: form.enabled,
    connectTimeoutMs: form.connectTimeoutMs,
  };
}

/** Alta por formulario STDIO: comando y argumentos separados, sin shell. */
export async function addStdioServer(manager: McpClientManager, form: McpStdioForm): Promise<McpServerConfig> {
  assertNoSecretKeys(form, "form");
  return manager.addServer(toStdioInput(form));
}

/** Alta por formulario HTTP: URL con autenticación vía secreto del SO (ver `setServerAuth`). */
export async function addHttpServer(manager: McpClientManager, form: McpHttpForm): Promise<McpServerConfig> {
  assertNoSecretKeys(form, "form");
  return manager.addServer(toHttpInput(form));
}

/**
 * Import JSON compatible: objeto único o `{ servers: [...] }`.
 * Cada entrada con `transport` explícito; cualquier clave de secreto se rechaza.
 */
export function parseServerImportJson(raw: string): McpServerInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OctusError("invalid_tool_args", "MCP import is not valid JSON");
  }
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { servers?: unknown }).servers)
      ? ((parsed as { servers: unknown[] }).servers as unknown[])
      : [parsed];
  if (list.length === 0) throw new OctusError("invalid_tool_args", "MCP import contains no servers");
  if (list.length > 100) throw new OctusError("invalid_tool_args", "MCP import exceeds 100 servers");
  assertNoSecretKeys(list, "servers");
  return list.map((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new OctusError("invalid_tool_args", `MCP import servers[${i}]: expected an object`);
    }
    const e = entry as Record<string, unknown> & { transport?: unknown };
    if (e.transport === "stdio") {
      return toStdioInput(e as unknown as McpStdioForm);
    }
    if (e.transport === "http") {
      if (typeof e.url !== "string") throw new OctusError("invalid_tool_args", `MCP import servers[${i}]: http requires a url`);
      assertMcpServerUrlSync(e.url);
      return toHttpInput(e as unknown as McpHttpForm);
    }
    throw new OctusError("invalid_tool_args", `MCP import servers[${i}]: transport must be 'stdio' or 'http'`);
  });
}

/** Importa JSON validado; NUNCA escribe secretos (el JSON no puede traerlos). */
export async function importServers(manager: McpClientManager, raw: string): Promise<McpServerConfig[]> {
  const inputs = parseServerImportJson(raw);
  const configs: McpServerConfig[] = [];
  for (const input of inputs) {
    configs.push(await manager.addServer(input));
  }
  return configs;
}

// ---------------------------------------------------------------------------
// Credenciales: solo safeStorage/SecretStore + redacción
// ---------------------------------------------------------------------------

export interface McpAuthMaterial {
  token?: string;
  env?: Record<string, string>;
}

/** Guarda el material de auth SOLO en el almacén del SO (jamás SQLite/JSON). */
export async function setServerAuth(manager: McpClientManager, serverId: string, auth: McpAuthMaterial): Promise<void> {
  if (!auth || (auth.token === undefined && auth.env === undefined)) {
    throw new OctusError("invalid_tool_args", "MCP auth must include a token and/or env");
  }
  if (auth.token !== undefined && (typeof auth.token !== "string" || auth.token.length === 0)) {
    throw new OctusError("invalid_tool_args", "MCP auth token must be a non-empty string");
  }
  await manager.setServerSecret(serverId, auth);
}

/**
 * Revoca el token: borra el secreto del SO, corta la conexión viva y lo audita.
 * El servidor queda desconectado hasta rotar una credencial nueva.
 */
export async function revokeServerAuth(manager: McpClientManager, serverId: string): Promise<void> {
  await manager.clearServerSecret(serverId);
}

/** Sanea valores secretos conocidos de cualquier texto (logs, motivos, evidencia). */
export function redactSecrets(text: string, values: Array<string | undefined>): string {
  let out = text;
  for (const value of values) {
    if (!value) continue;
    if (out.includes(value)) out = out.split(value).join("[REDACTED]");
  }
  return out;
}

/** Log de auditoría con los secretos conocidos ya redactados. */
export async function serverLogs(
  manager: McpClientManager,
  serverId: string,
  secrets: Array<string | undefined> = [],
  limit = 200,
): Promise<
  Array<{ id: string; action: string; projectId: string | null; reason: string | null; occurredAt: number }>
> {
  const entries = await manager.auditLog(serverId, limit);
  return entries.map((e) => ({
    id: e.id,
    action: e.action,
    projectId: e.projectId,
    reason: e.reason === null ? null : redactSecrets(e.reason, secrets),
    occurredAt: e.occurredAt,
  }));
}

// ---------------------------------------------------------------------------
// Verificar, consultar, permisos (timeouts + cancelación + topes)
// ---------------------------------------------------------------------------

export interface McpOpOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function withOpTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  opts: { signal?: AbortSignal; timeoutMs: number; ctx: string },
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
      controller.abort();
      settle(() => reject(abortedError(opts.ctx)));
    };
    const onTimeout = () => {
      controller.abort();
      settle(() => reject(new OctusError("timeout", `${opts.ctx} timed out after ${opts.timeoutMs}ms`)));
    };
    opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
    timer = setTimeout(onTimeout, opts.timeoutMs);
    task(controller.signal).then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => {
        if (opts.signal?.aborted || controller.signal.aborted) settle(() => reject(abortedError(opts.ctx)));
        else if (error instanceof Error && /timed out|timeout/i.test(error.message)) {
          settle(() => reject(new OctusError("timeout", `${opts.ctx} timed out after ${opts.timeoutMs}ms`)));
        } else settle(() => reject(error));
      },
    );
  });
}

/**
 * Verifica un servidor: revalida SSRF/DNS (HTTP), exige confianza del workspace
 * (puerta del Todo 26) y corre el handshake con timeout + cancelación.
 */
export async function verifyServer(
  manager: McpClientManager,
  serverId: string,
  projectId: string,
  opts: McpOpOptions = {},
): Promise<McpConnectionInfo> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const config = await manager.getServer(serverId);
  if (!config) throw new OctusError("not_found", `Unknown MCP server '${serverId}'`);
  if (config.transport === "http" && config.url) {
    await assertMcpServerUrlResolves(config.url);
  }
  return withOpTimeout((signal) => manager.connect(serverId, { projectId, signal, timeoutMs }), {
    signal: opts.signal,
    timeoutMs: timeoutMs + 2_000,
    ctx: `MCP verify '${serverId}'`,
  });
}

function requireClient(manager: McpClientManager, serverId: string): Client {
  const client = manager.connectedClient(serverId);
  if (!client) {
    throw new OctusError("invalid_state", `MCP server '${serverId}' is not connected; verify it first`);
  }
  return client;
}

/** Binding de herramientas sobre el `Client` conectado (puente 27 sin cambios). */
export function toolBindingFor(manager: McpClientManager, serverId: string): SdkClientBinding {
  return new SdkClientBinding(serverId, requireClient(manager, serverId));
}

/** Binding de recursos/prompts sobre el `Client` conectado (puente 28 sin cambios). */
export function contentBindingFor(manager: McpClientManager, serverId: string): SdkContentBinding {
  return new SdkContentBinding(serverId, requireClient(manager, serverId));
}

export interface McpServerSnapshot {
  serverId: string;
  connectedAt: number;
  tools: McpToolDescription[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
  truncated: boolean;
  notes: string[];
}

/**
 * Consulta herramientas, recursos y prompts con timeout, cancelación y tope de
 * tamaño. Lo no negociado se registra en `notes` en vez de romper la consulta.
 */
export async function queryServerSnapshot(
  manager: McpClientManager,
  serverId: string,
  opts: McpOpOptions & { maxChars?: number } = {},
): Promise<McpServerSnapshot> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const maxChars = opts.maxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS;
  const client = requireClient(manager, serverId);
  const notes: string[] = [];
  const tools: McpToolDescription[] = [];
  const resources: McpResourceInfo[] = [];
  const prompts: McpPromptInfo[] = [];

  const run = async <T>(ctx: string, task: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
    try {
      return await withOpTimeout(task, { signal: opts.signal, timeoutMs, ctx });
    } catch (error) {
      if (error instanceof OctusError && (error.code === "timeout" || error.code === "aborted")) throw error;
      notes.push(`${ctx}: unavailable (${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)})`);
      return undefined;
    }
  };

  const listed = await run(`MCP tools/list '${serverId}'`, (signal) =>
    client.listTools(undefined, { signal, timeout: timeoutMs }),
  );
  for (const t of listed?.tools ?? []) {
    tools.push({ name: t.name, description: t.description, inputSchema: (t.inputSchema ?? undefined) as Record<string, unknown> | undefined });
  }
  const res = await run(`MCP resources/list '${serverId}'`, (signal) =>
    client.listResources(undefined, { signal, timeout: timeoutMs }),
  );
  for (const r of res?.resources ?? []) {
    resources.push({ uri: r.uri, name: r.name });
  }
  const pr = await run(`MCP prompts/list '${serverId}'`, (signal) =>
    client.listPrompts(undefined, { signal, timeout: timeoutMs }),
  );
  for (const p of pr?.prompts ?? []) {
    prompts.push({ name: p.name, description: p.description ?? undefined });
  }

  let truncated = false;
  const size = JSON.stringify({ tools, resources, prompts }).length;
  if (size > maxChars) {
    truncated = true;
    notes.push(`snapshot exceeded ${maxChars} chars (${size}); lists truncated`);
    while (JSON.stringify({ tools, resources, prompts }).length > maxChars) {
      if (prompts.length > 0) prompts.pop();
      else if (resources.length > 0) resources.pop();
      else if (tools.length > 0) tools.pop();
      else break;
    }
  }
  return { serverId, connectedAt: now(), tools, resources, prompts, truncated, notes };
}

export interface McpAccessChange {
  enabled?: boolean;
  trust?: { scope: McpTrustScope; trusted: boolean };
}

/**
 * Cambia permisos: habilitación y/o confianza por workspace. Deshabilitar o
 * desconfiar corta la conexión viva (puerta del Todo 26, sin relajar nada).
 */
export async function changeServerAccess(
  manager: McpClientManager,
  serverId: string,
  change: McpAccessChange,
): Promise<McpServerConfig> {
  if (change.enabled !== undefined) {
    await manager.updateServer(serverId, { enabled: change.enabled });
  }
  if (change.trust !== undefined) {
    await manager.setTrust(serverId, change.trust.scope, change.trust.trusted);
  }
  const config = await manager.getServer(serverId);
  if (!config) throw new OctusError("not_found", `Unknown MCP server '${serverId}'`);
  return config;
}
