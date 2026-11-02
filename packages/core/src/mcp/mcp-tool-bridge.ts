/**
 * @octus/core — Puente de herramientas MCP (Todo 27, contrato C-11).
 *
 * Descubrimiento de herramientas por protocolo, nombres aislados por servidor
 * (`<server>.<tool>`), registro en ToolGateway y uso solo con servidor
 * autorizado, herramienta disponible, perfil con permiso y aprobación cumplida.
 * Los resultados MCP son contenido NO CONFIABLE: se envuelven con marca de
 * origen (servidor + herramienta) y cada invocación queda auditada en
 * `tool_invocations` bajo el nombre aislado.
 *
 * Costura con el Todo 26 (contrato C-10; McpClientManager YA existe en este
 * worktree con confianza por workspace, handshake y reconexión, pero SIN
 * accesor público de tools/call): el Todo 26 expone conexiones como
 * `McpServerBinding` vía `CallbackBinding` (refresh desde
 * `isTrusted(serverId, projectId)` + estado de conexión) o vía
 * `SdkClientBinding` sobre un `Client` ya conectado. Si la API final del
 * manager difiere, se adapta el envoltorio; este puente no cambia.
 * SUPUESTO documentado: `authorized` refleja la confianza explícita del
 * workspace (ningún servidor desconocido conecta solo) y `available`
 * refleja conexión + handshake + capacidades negociadas.
 *
 * Sin colisiones: dos servidores con la misma herramienta producen nombres
 * distintos (`a.qa_echo` frente a `b.qa_echo`). Sin elusión de
 * PermissionManager: la `permissionAction` ES el nombre aislado, el techo
 * duro del perfil (`definitionTools`) debe incluirlo explícitamente y el
 * defecto para lo desconocido es `ask` (aprobación cumplida vía ask-once).
 */
import { z } from "zod";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { OctusError } from "../errors.js";
import type { ToolDefinition } from "../tools/tool-definitions.js";
import type { ToolGateway } from "../tools/tool-gateway.js";

const NAME_PART = /^[A-Za-z0-9_-]{1,64}$/;

function assertNamePart(kind: "server" | "tool", value: string): void {
  if (!NAME_PART.test(value)) {
    throw new OctusError(
      "invalid_tool_args",
      `Invalid MCP ${kind} name ${JSON.stringify(value)}: only [A-Za-z0-9_-], 1-64 chars`,
    );
  }
}

/** Nombre aislado: `<server>.<tool>`. Determinista y sin colisiones entre servidores. */
export function isolatedName(serverId: string, toolName: string): string {
  assertNamePart("server", serverId);
  assertNamePart("tool", toolName);
  return `${serverId}.${toolName}`;
}

/** Origen de un nombre aislado (`undefined` si no tiene forma `<server>.<tool>`). */
export function parseIsolatedName(name: string): { serverId: string; toolName: string } | undefined {
  const dot = name.indexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  const serverId = name.slice(0, dot);
  const toolName = name.slice(dot + 1);
  if (!NAME_PART.test(serverId) || !NAME_PART.test(toolName)) return undefined;
  return { serverId, toolName };
}

export interface McpToolDescription {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}

/**
 * Costura con el Todo 26 (C-10). El manager de conexiones envuelve cada
 * servidor autorizado/conectado en un binding con esta forma.
 */
export interface McpServerBinding {
  readonly serverId: string;
  /** Confianza explícita del workspace (C-10). Sin ella no hay registro ni llamada. */
  readonly authorized: boolean;
  /** Conexión + handshake + capacidades negociadas. Sin ella no hay registro ni llamada. */
  readonly available: boolean;
  /** Hook opcional: sincroniza `authorized`/`available` antes de cada uso
   *  (p. ej. CallbackBinding lo lee del manager). Sin él, mandan los campos. */
  refresh?(): Promise<void>;
  listTools(): Promise<McpToolDescription[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

/** Envoltorio directo de un `Client` del SDK sobre una conexión ya establecida
 *  (usado en tests contra transportes reales y por el runtime tras `connect`). */
export class SdkClientBinding implements McpServerBinding {
  authorized: boolean;
  available: boolean;

  constructor(
    readonly serverId: string,
    private readonly client: Client,
    options?: { authorized?: boolean; available?: boolean },
  ) {
    assertNamePart("server", serverId);
    this.authorized = options?.authorized ?? true;
    this.available = options?.available ?? true;
  }

  async listTools(): Promise<McpToolDescription[]> {
    const listed = await this.client.listTools();
    return (listed.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema ?? undefined) as Record<string, unknown> | undefined,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as McpContentBlock[];
    return { content, isError: (result as { isError?: boolean }).isError };
  }
}

/**
 * Adaptador para el Todo 26 (McpClientManager) sin acoplarse a su archivo.
 * El manager sincroniza `binding.authorized` / `binding.available` desde
 * `isTrusted(serverId, projectId)` y su estado de conexión antes de cada uso;
 * la puerta de confianza y la defensa en profundidad del run hacen el resto.
 */
export interface ManagerBindingDeps {
  isTrusted: () => boolean | Promise<boolean>;
  isAvailable: () => boolean | Promise<boolean>;
  listTools: () => Promise<McpToolDescription[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpCallResult>;
}

export class CallbackBinding implements McpServerBinding {
  authorized = true;
  available = true;

  constructor(
    readonly serverId: string,
    private readonly deps: ManagerBindingDeps,
  ) {
    assertNamePart("server", serverId);
  }

  /** Sincroniza confianza/disponibilidad desde el manager (también la usa la puerta). */
  async refresh(): Promise<void> {
    this.authorized = await this.deps.isTrusted();
    this.available = await this.deps.isAvailable();
  }

  async listTools(): Promise<McpToolDescription[]> {
    await this.refresh();
    return this.deps.listTools();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.refresh();
    return this.deps.callTool(name, args);
  }
}

/** Descubrimiento por protocolo (`tools/list`). Exige servidor autorizado y disponible. */
export async function discoverMcpTools(binding: McpServerBinding): Promise<McpToolDescription[]> {
  await binding.refresh?.();
  if (!binding.authorized) {
    throw new OctusError("tool_denied", `MCP server '${binding.serverId}' is not trusted for this workspace`);
  }
  if (!binding.available) {
    throw new OctusError("tool_denied", `MCP server '${binding.serverId}' is not connected`);
  }
  const tools = await binding.listTools();
  const seen = new Set<string>();
  for (const tool of tools) {
    assertNamePart("tool", tool.name);
    if (seen.has(tool.name)) {
      throw new OctusError("already_exists", `MCP server '${binding.serverId}' lists duplicated tool '${tool.name}'`);
    }
    seen.add(tool.name);
  }
  return tools;
}

/** Marca de contenido no confiable con servidor y herramienta registrados. */
export function untrustedBanner(serverId: string, toolName: string, isolated: string): string {
  return `[untrusted MCP content — server '${serverId}', tool '${toolName}' (registered as '${isolated}')]`;
}

function mcpResultText(serverId: string, toolName: string, isolated: string, result: McpCallResult): string {
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else {
      parts.push(`[non-text MCP content block of type '${block.type}', omitted]`);
    }
  }
  const body = parts.length > 0 ? parts.join("\n") : "(empty MCP result)";
  return `${untrustedBanner(serverId, toolName, isolated)}\n${body}`;
}

/** Definición ToolGateway para una herramienta MCP descubierta (puerta completa del gateway). */
export function buildMcpToolDefinition(binding: McpServerBinding, desc: McpToolDescription): ToolDefinition {
  const isolated = isolatedName(binding.serverId, desc.name);
  const serverId = binding.serverId;
  const toolName = desc.name;
  return {
    manifest: {
      name: isolated,
      description: `MCP tool '${toolName}' on server '${serverId}' (untrusted content).${desc.description ? ` ${desc.description}` : ""}`,
      inputJsonSchema: desc.inputSchema ?? { type: "object" },
      // La acción de permiso ES el nombre aislado: el perfil debe concederlo
      // explícitamente; sin elusión posible del techo duro de PermissionManager.
      permissionAction: isolated,
    },
    // Args arbitrarios por protocolo: se aceptan tal cual y se reenvían.
    schema: z.looseObject({}),
    permissionDetail: (args: unknown) =>
      `MCP tool '${isolated}' on server '${serverId}' (workspace-trusted server, untrusted content).\nArguments: ${JSON.stringify(args ?? {}).slice(0, 1500)}`,
    async run(args, _ctx) {
      // Defensa en profundidad: la confianza puede revocarse entre el registro y la llamada.
      await binding.refresh?.();
      if (!binding.authorized) {
        throw new OctusError("tool_denied", `MCP server '${serverId}' is not trusted for this workspace`);
      }
      if (!binding.available) {
        throw new OctusError("tool_denied", `MCP server '${serverId}' is not connected`);
      }
      const params = (args ?? {}) as Record<string, unknown>;
      let result: McpCallResult;
      try {
        result = await binding.callTool(toolName, params);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new OctusError("tool_failed", `MCP call '${isolated}' failed: ${message.slice(0, 1000)}`);
      }
      if (result.isError) {
        throw new OctusError("tool_failed", `MCP tool '${isolated}' returned an error result`);
      }
      const text = mcpResultText(serverId, toolName, isolated, result);
      return { text, fullText: text.length > 4000 ? text : undefined };
    },
  };
}

/**
 * Descubre (`tools/list`) y registra en el gateway. La puerta de confianza
 * precede: servidor no autorizado o no disponible no se registra.
 * Devuelve los nombres aislados registrados.
 */
export async function registerMcpServer(gateway: ToolGateway, binding: McpServerBinding): Promise<string[]> {
  const tools = await discoverMcpTools(binding);
  const names: string[] = [];
  for (const desc of tools) {
    gateway.registerDefinition(buildMcpToolDefinition(binding, desc));
    names.push(isolatedName(binding.serverId, desc.name));
  }
  return names;
}

/** Retira del gateway todas las herramientas aisladas de un servidor. Devuelve las retiradas. */
export function unregisterMcpServer(gateway: ToolGateway, serverId: string): string[] {
  assertNamePart("server", serverId);
  const prefix = `${serverId}.`;
  return gateway.unregisterWhere((name) => name.startsWith(prefix));
}
