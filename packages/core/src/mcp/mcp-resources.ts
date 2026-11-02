/**
 * @octus/core — Recursos y prompts MCP con aprobación (Todo 28, contrato C-12).
 *
 * Listado y lectura de recursos con plantillas, listado y obtención de prompts
 * y suscripciones cuando el protocolo las soporta. Nada no negociado: cada
 * operación exige la capacidad negociada en el handshake (`resources`,
 * `resources.subscribe`, `prompts`); lo ausente se niega con `invalid_state`
 * y nunca se anuncia. Todo contenido MCP es NO CONFIABLE: se envuelve con
 * marca de origen y los recursos/prompts sensibles exigen aprobación explícita
 * ANTES de leerse o inyectarse al contexto (`permission_denied` sin ella).
 *
 * Costura con el Todo 26 (contrato C-10; McpClientManager YA existe en este
 * worktree con confianza por workspace, handshake y reconexión, pero SIN
 * accesor público de `Client` para recursos/prompts): este módulo define la
 * costura `McpContentBinding` y el adaptador `SdkContentBinding` sobre un
 * `Client` ya conectado. Cuando el manager exponga su `Client` (Todo 29/30),
 * se envuelve igual que el Todo 27 envolvió herramientas con CallbackBinding;
 * este puente no cambia.
 * SUPUESTO documentado: `authorized` refleja la confianza explícita del
 * workspace (ningún servidor desconocido conecta solo) y `available` refleja
 * conexión + handshake + capacidades negociadas.
 *
 * Punto de inyección de context-builder (`runtime/context-builder.ts`,
 * `buildInstructions`): los bloques `formatMcp*ForContext` se concatenan a las
 * instrucciones SOLO tras pasar la puerta de aprobación; el builder no cambia
 * (aditivo, sin reabrir contratos de etapas 1–6).
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { OctusError } from "../errors.js";

/**
 * Esquema local de la notificación `notifications/resources/updated`.
 * No se importa de `@modelcontextprotocol/sdk/types.js` a propósito: la
 * puerta del Todo 26 (`mcp-trust.test.ts > production code never exposes
 * Octus as a server`) solo permite superficie SDK `client/` en `src/mcp`.
 * El enrutado de `setNotificationHandler` acepta esquemas del usuario
 * (duck-typing `_zod`, zod v4), así que este literal equivale al del SDK
 * sin ampliar la superficie importada.
 */
const ResourceUpdatedNotificationSchema = z
  .object({
    method: z.literal("notifications/resources/updated"),
    params: z.object({ uri: z.string() }).passthrough(),
  })
  .passthrough();

const SERVER_PART = /^[A-Za-z0-9_-]{1,64}$/;

/** URIs sensibles: exigen aprobación antes de leerse o inyectarse. */
const SENSITIVE_URI_RE = /(secret|credential|passwd|private|token|\.env|vault|auth|\bkey\b)/i;

export function isSensitiveResourceUri(uri: string): boolean {
  return SENSITIVE_URI_RE.test(uri);
}

export function isSensitivePromptName(name: string): boolean {
  return SENSITIVE_URI_RE.test(name);
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplateInfo {
  name: string;
  uriTemplate: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  /** Los blobs binarios NUNCA se inyectan al contexto (solo su marcador). */
  blob?: string;
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpPromptMessage {
  role: string;
  text: string;
}

export interface McpPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

/** Primitivas negociadas en el handshake. Nada más se anuncia ni se usa. */
export interface McpNegotiatedPrimitives {
  resources: boolean;
  resourceTemplates: boolean;
  prompts: boolean;
  subscriptions: boolean;
}

export function describeMcpPrimitives(capabilities: Record<string, unknown> | undefined | null): McpNegotiatedPrimitives {
  const caps = capabilities ?? {};
  const resources = caps["resources"];
  const prompts = caps["prompts"];
  const hasResources = resources !== undefined && resources !== null && resources !== false;
  const hasPrompts = prompts !== undefined && prompts !== null && prompts !== false;
  let subscriptions = false;
  if (hasResources && typeof resources === "object") {
    subscriptions = (resources as Record<string, unknown>)["subscribe"] === true;
  }
  // Las plantillas viajan sobre la misma capacidad `resources`
  // (`resources/list` + `resources/templates/list`); no hay bandera propia.
  return { resources: hasResources, resourceTemplates: hasResources, prompts: hasPrompts, subscriptions };
}

export interface McpApprovalRequest {
  serverId: string;
  kind: "resource" | "prompt";
  target: string;
  reason: string;
}

export type McpApprovalFn = (request: McpApprovalRequest) => Promise<boolean>;

export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Costura con el Todo 26 (C-10). El manager/harness envuelve cada servidor
 * autorizado/conectado en un binding con esta forma.
 */
export interface McpContentBinding {
  readonly serverId: string;
  /** Confianza explícita del workspace (C-10). Sin ella no hay listado ni lectura. */
  readonly authorized: boolean;
  /** Conexión + handshake + capacidades negociadas. Sin ella no hay listado ni lectura. */
  readonly available: boolean;
  /** Hook opcional: sincroniza `authorized`/`available` antes de cada uso. */
  refresh?(): Promise<void>;
  capabilities(): Record<string, unknown>;
  listResources(opts?: McpCallOptions): Promise<McpResourceInfo[]>;
  listResourceTemplates(opts?: McpCallOptions): Promise<McpResourceTemplateInfo[]>;
  readResource(uri: string, opts?: McpCallOptions): Promise<McpResourceContent[]>;
  subscribe(uri: string, opts?: McpCallOptions): Promise<void>;
  unsubscribe(uri: string, opts?: McpCallOptions): Promise<void>;
  listPrompts(opts?: McpCallOptions): Promise<McpPromptInfo[]>;
  getPrompt(name: string, args?: Record<string, string>, opts?: McpCallOptions): Promise<McpPromptResult>;
  onResourceUpdated(uri: string, handler: (uri: string) => void): () => void;
}

/** Envoltorio directo de un `Client` del SDK sobre una conexión ya establecida. */
export class SdkContentBinding implements McpContentBinding {
  authorized: boolean;
  available: boolean;
  private readonly watchers = new Map<string, Set<(uri: string) => void>>();
  private notifyInstalled = false;

  constructor(
    readonly serverId: string,
    private readonly client: Client,
    options?: { authorized?: boolean; available?: boolean },
  ) {
    if (!SERVER_PART.test(serverId)) {
      throw new OctusError("invalid_tool_args", `Invalid MCP server id ${JSON.stringify(serverId)}: only [A-Za-z0-9_-], 1-64 chars`);
    }
    this.authorized = options?.authorized ?? true;
    this.available = options?.available ?? true;
  }

  capabilities(): Record<string, unknown> {
    return (this.client.getServerCapabilities() ?? {}) as Record<string, unknown>;
  }

  async listResources(opts?: McpCallOptions): Promise<McpResourceInfo[]> {
    const listed = await this.client.listResources(undefined, requestOpts(opts));
    return (listed.resources ?? []).map((r) => ({
      uri: r.uri,
      name: r.name,
      title: (r as { title?: string }).title,
      description: (r as { description?: string }).description,
      mimeType: (r as { mimeType?: string }).mimeType,
    }));
  }

  async listResourceTemplates(opts?: McpCallOptions): Promise<McpResourceTemplateInfo[]> {
    const listed = await this.client.listResourceTemplates(undefined, requestOpts(opts));
    return (listed.resourceTemplates ?? []).map((t) => ({
      name: t.name,
      uriTemplate: t.uriTemplate,
      title: (t as { title?: string }).title,
      description: (t as { description?: string }).description,
      mimeType: (t as { mimeType?: string }).mimeType,
    }));
  }

  async readResource(uri: string, opts?: McpCallOptions): Promise<McpResourceContent[]> {
    const result = await this.client.readResource({ uri }, requestOpts(opts));
    return (result.contents ?? []).map((c) => ({
      uri: c.uri,
      mimeType: (c as { mimeType?: string }).mimeType,
      text: (c as { text?: string }).text,
      blob: (c as { blob?: string }).blob,
    }));
  }

  async subscribe(uri: string, opts?: McpCallOptions): Promise<void> {
    await this.client.subscribeResource({ uri }, requestOpts(opts));
  }

  async unsubscribe(uri: string, opts?: McpCallOptions): Promise<void> {
    await this.client.unsubscribeResource({ uri }, requestOpts(opts));
  }

  async listPrompts(opts?: McpCallOptions): Promise<McpPromptInfo[]> {
    const listed = await this.client.listPrompts(undefined, requestOpts(opts));
    return (listed.prompts ?? []).map((p) => ({
      name: p.name,
      description: p.description ?? undefined,
      arguments: (p.arguments ?? undefined) as McpPromptInfo["arguments"],
    }));
  }

  async getPrompt(name: string, args?: Record<string, string>, opts?: McpCallOptions): Promise<McpPromptResult> {
    const result = await this.client.getPrompt({ name, arguments: args }, requestOpts(opts));
    return {
      description: result.description ?? undefined,
      messages: (result.messages ?? []).map((m) => ({
        role: m.role,
        text: m.content.type === "text" ? m.content.text : `[non-text MCP prompt block of type '${m.content.type}', omitted]`,
      })),
    };
  }

  onResourceUpdated(uri: string, handler: (uri: string) => void): () => void {
    if (!this.notifyInstalled) {
      this.notifyInstalled = true;
      this.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
        const updated = (notification.params as { uri?: unknown })?.uri;
        if (typeof updated !== "string") return;
        const set = this.watchers.get(updated);
        if (!set) return;
        for (const fn of [...set]) {
          try {
            fn(updated);
          } catch {
            // Un observador roto no rompe a los demás ni la conexión.
          }
        }
      });
    }
    let set = this.watchers.get(uri);
    if (!set) {
      set = new Set();
      this.watchers.set(uri, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.watchers.delete(uri);
    };
  }

  /** Sin despacho manual: el flujo real entra por setNotificationHandler. */
}

function requestOpts(opts?: McpCallOptions): { signal?: AbortSignal; timeout?: number } | undefined {
  if (!opts || (opts.signal === undefined && opts.timeoutMs === undefined)) return undefined;
  return { signal: opts.signal, timeout: opts.timeoutMs };
}

// -- puertas -------------------------------------------------------------------

async function gate(binding: McpContentBinding): Promise<void> {
  await binding.refresh?.();
  if (!binding.authorized) {
    throw new OctusError("tool_denied", `MCP server '${binding.serverId}' is not trusted for this workspace`);
  }
  if (!binding.available) {
    throw new OctusError("tool_denied", `MCP server '${binding.serverId}' is not connected`);
  }
}

function requirePrimitive(binding: McpContentBinding, kind: "resources" | "prompts" | "subscriptions"): void {
  const negotiated = describeMcpPrimitives(binding.capabilities());
  const ok =
    kind === "resources" ? negotiated.resources || negotiated.resourceTemplates
    : kind === "prompts" ? negotiated.prompts
    : negotiated.subscriptions;
  if (!ok) {
    throw new OctusError(
      "invalid_state",
      `MCP server '${binding.serverId}' did not negotiate '${kind}'; refusing unnegotiated primitive`,
    );
  }
}

async function requireApproval(
  approve: McpApprovalFn | undefined,
  request: McpApprovalRequest,
): Promise<void> {
  if (approve === undefined) {
    throw new OctusError(
      "permission_denied",
      `MCP ${request.kind} '${request.target}' on server '${request.serverId}' is sensitive and requires approval; refusing before read`,
    );
  }
  let granted = false;
  try {
    granted = await approve(request);
  } catch {
    granted = false;
  }
  if (!granted) {
    throw new OctusError(
      "permission_denied",
      `MCP ${request.kind} '${request.target}' on server '${request.serverId}' was not approved; refusing before read`,
    );
  }
}

// -- operaciones -----------------------------------------------------------------

/** Listado de recursos (`resources/list`). Exige capacidad negociada. */
export async function listMcpResources(binding: McpContentBinding, opts?: McpCallOptions): Promise<McpResourceInfo[]> {
  await gate(binding);
  requirePrimitive(binding, "resources");
  return binding.listResources(opts);
}

/** Listado de plantillas (`resources/templates/list`). Exige capacidad negociada. */
export async function listMcpResourceTemplates(
  binding: McpContentBinding,
  opts?: McpCallOptions,
): Promise<McpResourceTemplateInfo[]> {
  await gate(binding);
  requirePrimitive(binding, "resources");
  return binding.listResourceTemplates(opts);
}

/**
 * Lectura de un recurso (`resources/read`). Lo sensible exige aprobación
 * explícita ANTES de leer: sin `approve` o con rechazo se niega con
 * `permission_denied` y el contenido jamás llega al contexto.
 */
export async function readMcpResource(
  binding: McpContentBinding,
  uri: string,
  opts?: { approve?: McpApprovalFn } & McpCallOptions,
): Promise<McpResourceContent[]> {
  await gate(binding);
  requirePrimitive(binding, "resources");
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 2000) {
    throw new OctusError("invalid_tool_args", `Invalid MCP resource uri (1-2000 chars required)`);
  }
  if (isSensitiveResourceUri(uri)) {
    await requireApproval(opts?.approve, {
      serverId: binding.serverId,
      kind: "resource",
      target: uri,
      reason: "resource uri matches the sensitive pattern; approval required before read or context injection",
    });
  }
  return binding.readResource(uri, opts);
}

/** Listado de prompts (`prompts/list`). Exige capacidad negociada. */
export async function listMcpPrompts(binding: McpContentBinding, opts?: McpCallOptions): Promise<McpPromptInfo[]> {
  await gate(binding);
  requirePrimitive(binding, "prompts");
  return binding.listPrompts(opts);
}

/**
 * Obtención de un prompt (`prompts/get`). Los mensajes son contenido NO
 * CONFIABLE; el prompt sensible exige aprobación igual que un recurso.
 */
export async function getMcpPrompt(
  binding: McpContentBinding,
  name: string,
  args?: Record<string, string>,
  opts?: { approve?: McpApprovalFn } & McpCallOptions,
): Promise<McpPromptResult> {
  await gate(binding);
  requirePrimitive(binding, "prompts");
  if (typeof name !== "string" || name.length === 0 || name.length > 200) {
    throw new OctusError("invalid_tool_args", `Invalid MCP prompt name (1-200 chars required)`);
  }
  if (isSensitivePromptName(name)) {
    await requireApproval(opts?.approve, {
      serverId: binding.serverId,
      kind: "prompt",
      target: name,
      reason: "prompt name matches the sensitive pattern; approval required before use",
    });
  }
  return binding.getPrompt(name, args, opts);
}

export interface McpWatch {
  uri: string;
  unsubscribe: () => Promise<void>;
}

/**
 * Suscripción a un recurso (`resources/subscribe`) con aviso de actualización.
 * Solo cuando el servidor negoció `resources.subscribe`; si no, se niega
 * (`invalid_state`) en vez de fingir la suscripción.
 */
export async function watchMcpResource(
  binding: McpContentBinding,
  uri: string,
  onUpdate: (uri: string) => void,
  opts?: { approve?: McpApprovalFn } & McpCallOptions,
): Promise<McpWatch> {
  await gate(binding);
  requirePrimitive(binding, "subscriptions");
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 2000) {
    throw new OctusError("invalid_tool_args", `Invalid MCP resource uri (1-2000 chars required)`);
  }
  if (isSensitiveResourceUri(uri)) {
    // Suscribirse ya expone el contenido futuro: la puerta también aplica aquí.
    await requireApproval(opts?.approve, {
      serverId: binding.serverId,
      kind: "resource",
      target: uri,
      reason: "subscribing to a sensitive resource exposes future content; approval required",
    });
  }
  await binding.subscribe(uri, opts);
  const off = binding.onResourceUpdated(uri, (updated) => {
    if (updated === uri) onUpdate(updated);
  });
  let done = false;
  return {
    uri,
    unsubscribe: async () => {
      if (done) return;
      done = true;
      off();
      try {
        await binding.unsubscribe(uri, opts);
      } catch {
        // Best-effort: la puerta ya validó; el estado local queda limpio.
      }
    },
  };
}

// -- inyección al contexto (punto: ContextBuilder.buildInstructions) --------------

const MAX_CONTEXT_CHARS_PER_BLOCK = 8000;

export function untrustedResourceBanner(serverId: string, uri: string): string {
  return `[untrusted MCP content — server '${serverId}', resource '${uri}']`;
}

export function untrustedPromptBanner(serverId: string, name: string): string {
  return `[untrusted MCP content — server '${serverId}', prompt '${name}']`;
}

/**
 * Bloque listo para concatenar a las instrucciones SOLO tras la puerta de
 * aprobación. Los blobs binarios se sustituyen por marcador (nunca base64 al
 * contexto) y cada bloque de texto se topa con marca de truncado.
 */
export function formatMcpResourceForContext(
  serverId: string,
  uri: string,
  contents: McpResourceContent[],
): string {
  const parts: string[] = [];
  for (const c of contents) {
    if (typeof c.text === "string") {
      parts.push(truncateBlock(c.text));
    } else if (typeof c.blob === "string") {
      parts.push(`[non-text MCP content (mime '${c.mimeType ?? "unknown"}', ${c.blob.length} base64 chars), omitted from context]`);
    } else {
      parts.push(`[empty MCP resource block (mime '${c.mimeType ?? "unknown"}')]`);
    }
  }
  const body = parts.length > 0 ? parts.join("\n") : "(empty MCP resource)";
  return `${untrustedResourceBanner(serverId, uri)}\n<mcp-resource server="${serverId}" uri="${uri}" untrusted="true">\n${body}\n</mcp-resource>`;
}

export function formatMcpPromptForContext(serverId: string, name: string, prompt: McpPromptResult): string {
  const parts = prompt.messages.map((m) => `<mcp-message role="${m.role}">\n${truncateBlock(m.text)}\n</mcp-message>`);
  const body = parts.length > 0 ? parts.join("\n") : "(empty MCP prompt)";
  const desc = prompt.description ? ` description="${prompt.description.slice(0, 200)}"` : "";
  return `${untrustedPromptBanner(serverId, name)}\n<mcp-prompt server="${serverId}" name="${name}"${desc} untrusted="true">\n${body}\n</mcp-prompt>`;
}

function truncateBlock(text: string): string {
  if (text.length <= MAX_CONTEXT_CHARS_PER_BLOCK) return text;
  return `${text.slice(0, MAX_CONTEXT_CHARS_PER_BLOCK)}\n[…truncated ${text.length - MAX_CONTEXT_CHARS_PER_BLOCK} chars omitted from context]`;
}
