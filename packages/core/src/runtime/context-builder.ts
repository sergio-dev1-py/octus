/**
 * @octus/core — ContextBuilder: sistema por capas, historial a mensajes normalizados,
 * estimación de tokens y compactación con tramo reciente garantizado (ADR-015.6).
 */
import type {
  AgentDefinition,
  Message,
  MessagePart,
  NormalizedMessage,
  NormalizedTool,
  ToolCallPart,
  ToolResultPart,
} from "@octus/shared";
import { createId } from "@octus/shared";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { OCTUS_BASE_PROMPT } from "../prompts/prompts.js";
import { deserializeMemory } from "../memory/memory-service.js";
import { selectForContext } from "../memory/memory-select.js";

export interface BuiltContext {
  instructions: string;
  messages: NormalizedMessage[];
  systemChars: number;
}

export interface InstructionExtras {
  projectId?: string;
  sessionId?: string;
  runId?: string;
  taskId?: string;
  instanceId?: string;
  /** Instrucciones de la tarea delegada (brief) si aplica. */
  taskBrief?: string;
  /** Estado autoritativo de planes de la sesión (inyectado desde SQLite). */
  planState?: string;
  /** Entregas de subagentes pendientes de consumir. */
  deliveries?: string;
}

export class ContextBuilder {
  constructor(private readonly db: PersistenceService) {}

  /**
   * Capas: base Octus + sistema del perfil + instrucciones de proyecto APROBADAS
   * + memoria validada del contexto + tarea + estado de planes/entregas + tools.
   * (Prompt 2 §D, ADR-027; memoria Etapa 6: FINAL-1/FINAL-3.)
   */
  async buildInstructions(definition: AgentDefinition, directory: string, tools: NormalizedTool[], extras: InstructionExtras = {}): Promise<string> {
    const parts = [OCTUS_BASE_PROMPT, definition.systemPrompt];
    if (extras.taskBrief) {
      parts.push(`<task-brief>\n${extras.taskBrief}\n</task-brief>`);
    }
    if (extras.projectId) {
      parts.push(...(await this.approvedProjectInstructions(extras.projectId, directory)));
      parts.push(...(await this.buildMemorySection(extras)));
    }
    if (extras.planState) {
      parts.push(`<session-plans>\n${extras.planState}\n</session-plans>`);
    }
    if (extras.deliveries) {
      parts.push(`<subagent-deliveries>\n${extras.deliveries}\n</subagent-deliveries>`);
    }
    if (tools.length > 0) {
      const catalog = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
      parts.push(`Available tools (call them to act; never invent their results):\n${catalog}`);
    }
    if (definition.deliveryFormat) {
      parts.push(`<delivery-contract>\n${definition.deliveryFormat}\n</delivery-contract>`);
    }
    return parts.join("\n\n");
  }

  /**
   * Solo archivos aprobados explícitamente en ajustes del proyecto (ADR-027).
   * El repo no aprobado y la web son no confiables y no entran como sistema.
   */
  private async approvedProjectInstructions(projectId: string, directory: string): Promise<string[]> {
    const row = await this.db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", [`trusted_instructions.${projectId}`]);
    if (!row) return [];
    let names: unknown;
    try {
      names = JSON.parse(row.value);
    } catch {
      return [];
    }
    if (!Array.isArray(names)) return [];
    const out: string[] = [];
    for (const name of names.slice(0, 10)) {
      if (typeof name !== "string" || name.includes("..") || path.isAbsolute(name)) continue;
      const file = path.join(directory, name);
      if (!existsSync(file)) continue;
      try {
        const text = readFileSync(file, "utf8").slice(0, 20_000);
        out.push(`<project-instructions path="${file}" approved="true">\n${text}\n</project-instructions>`);
      } catch {
        continue;
      }
    }
    return out;
  }

  /**
   * Memoria validada del contexto (Etapa 6, FINAL-1/FINAL-3): cadena
   * proyecto→sesión→run→task→instancia, puerta por categoría+estado,
   * checkpoints de la recuperación en curso, exclusión de contradicciones
   * pendientes. Sin inyectar scopes ajenos.
   */
  async buildMemorySection(ids: { projectId?: string; sessionId?: string; runId?: string; taskId?: string; instanceId?: string }): Promise<string[]> {
    if (!ids.projectId) return [];
    const ors: string[] = ["(scope = 'project' AND scope_id = ?)"];
    const params: unknown[] = [ids.projectId];
    if (ids.sessionId) {
      ors.push("(scope = 'session' AND scope_id = ?)");
      params.push(ids.sessionId);
    }
    if (ids.runId) {
      ors.push("(scope = 'run' AND scope_id = ?)");
      params.push(ids.runId);
    }
    if (ids.taskId) {
      ors.push("(scope = 'task' AND scope_id = ?)");
      params.push(ids.taskId);
    }
    if (ids.instanceId) {
      ors.push("(scope = 'instance' AND scope_id = ?)");
      params.push(ids.instanceId);
    }
    const rows = await this.db.query<Record<string, string | number | null>>(
      `SELECT * FROM memory_entries WHERE (${ors.join(" OR ")}) AND status IN ('verified','approved') ORDER BY updated_at DESC LIMIT 200`,
      params as import("../persistence/protocol.js").SqlParam[],
    );
    const { selected, dropped } = selectForContext(rows.map(deserializeMemory), ids);
    if (selected.length === 0) return [];
    const out = selected.map((e) => {
      const origin = e.originRef.path ? ` origin="${e.originRef.path}${e.originRef.commit ? `#${e.originRef.commit.slice(0, 12)}` : ""}"` : "";
      return `<memory scope="${e.scope}" category="${e.category}" topic="${this.escapeAttr(e.topic)}" status="${e.status}" version="${e.version}" source="${this.escapeAttr(e.source)}"${origin}>\n${e.content}\n</memory>`;
    });
    if (dropped > 0) {
      out.push(`<!-- ${dropped} memorias relevantes omitidas por tope de contexto; pide resumen si las necesitas -->`);
    }
    return out;
  }

  private escapeAttr(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").slice(0, 200);
  }

  /** Historial de la instancia → mensajes normalizados, aplicando el corte de compactación. */
  async buildMessages(instanceId: string): Promise<{ messages: NormalizedMessage[]; cutoff: number }> {
    const cutoff = await this.compactionCutoff(instanceId);
    const rows = await this.db.query<Record<string, string | number | null>>(
      "SELECT * FROM messages WHERE instance_id = ? AND seq > ? ORDER BY seq ASC",
      [instanceId, cutoff.seq],
    );
    const messages = rows.map((row) => deserializeMessage(row));
    const normalized = toNormalized(messages);
    if (cutoff.checkpoint) {
      normalized.unshift({
        role: "developer",
        blocks: [{ type: "text", text: `<conversation-checkpoint>\n${cutoff.checkpoint}\n</conversation-checkpoint>` }],
      });
    }
    return { messages: normalized, cutoff: cutoff.seq };
  }

  /**
   * Conversación de sesión del coordinador: mensajes de todas sus instancias en
   * orden cronológico, con modo, excluyendo subagentes (ADR-024).
   */
  async buildSessionMessages(sessionId: string): Promise<{ messages: NormalizedMessage[] }> {
    const cutoff = await this.sessionCompactionCutoff(sessionId);
    const rows = await this.db.query<Record<string, string | number | null>>(
      `SELECT m.* FROM messages m
       JOIN agent_instances i ON i.id = m.instance_id
       JOIN agent_definitions d ON d.id = i.definition_id
       WHERE m.session_id = ? AND d.kind = 'coordinator'
         AND (m.created_at > ? OR (m.created_at = ? AND m.rowid > ?))
       ORDER BY m.created_at ASC, m.rowid ASC`,
      [sessionId, cutoff.createdAt, cutoff.createdAt, cutoff.rowid],
    );
    const messages = rows.map((row) => deserializeMessage(row));
    const normalized = toNormalized(withModeMarkers(messages));
    if (cutoff.checkpoint) {
      normalized.unshift({
        role: "developer",
        blocks: [{ type: "text", text: `<conversation-checkpoint>\n${cutoff.checkpoint}\n</conversation-checkpoint>` }],
      });
    }
    return { messages: normalized };
  }

  /** Historial visible (tras el corte): sobre esto decide la compactación (converge). */
  async visibleSessionHistory(sessionId: string): Promise<Array<Message & { rowid: number }>> {
    const cutoff = await this.sessionCompactionCutoff(sessionId);
    const rows = await this.db.query<Record<string, string | number | null>>(
      `SELECT m.*, m.rowid AS rowid FROM messages m
       JOIN agent_instances i ON i.id = m.instance_id
       JOIN agent_definitions d ON d.id = i.definition_id
       WHERE m.session_id = ? AND d.kind = 'coordinator'
         AND (m.created_at > ? OR (m.created_at = ? AND m.rowid > ?))
       ORDER BY m.created_at ASC, m.rowid ASC`,
      [sessionId, cutoff.createdAt, cutoff.createdAt, cutoff.rowid],
    );
    return rows.map((row) => ({ ...deserializeMessage(row), rowid: Number(row.rowid) }));
  }

  async fullSessionHistory(sessionId: string): Promise<Message[]> {
    const rows = await this.db.query<Record<string, string | number | null>>(
      `SELECT m.*, m.rowid AS rowid FROM messages m
       JOIN agent_instances i ON i.id = m.instance_id
       JOIN agent_definitions d ON d.id = i.definition_id
       WHERE m.session_id = ? AND d.kind = 'coordinator'
       ORDER BY m.created_at ASC, m.rowid ASC`,
      [sessionId],
    );
    return rows.map((row) => ({ ...deserializeMessage(row), rowid: Number(row.rowid) }) as Message & { rowid: number });
  }

  async sessionCompactionCutoff(sessionId: string): Promise<{ createdAt: number; rowid: number; checkpoint?: string }> {
    const row = await this.db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", [`compaction.session.${sessionId}`]);
    if (!row) return { createdAt: -1, rowid: -1 };
    try {
      const parsed = JSON.parse(row.value) as { createdAt?: number; rowid?: number; checkpoint?: string };
      return { createdAt: parsed.createdAt ?? -1, rowid: parsed.rowid ?? -1, checkpoint: parsed.checkpoint };
    } catch {
      return { createdAt: -1, rowid: -1 };
    }
  }

  async saveSessionCompaction(sessionId: string, cutoffCreatedAt: number, cutoffRowid: number, checkpoint: string): Promise<void> {
    await this.db.exec("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [
      `compaction.session.${sessionId}`,
      JSON.stringify({ createdAt: cutoffCreatedAt, rowid: cutoffRowid, checkpoint }),
      Date.now(),
    ]);
  }

  /** Estimación: sistema + esquemas de herramientas + historial (todo cuenta). */
  estimateTokens(instructions: string, tools: NormalizedTool[], messages: NormalizedMessage[]): number {
    const toolChars = tools.reduce((n, t) => n + t.name.length + t.description.length + JSON.stringify(t.parametersJsonSchema).length, 0);
    const messageChars = messages.reduce((n, m) => n + JSON.stringify(m).length, 0);
    return Math.ceil((instructions.length + toolChars + messageChars) / 4);
  }

  async compactionCutoff(instanceId: string): Promise<{ seq: number; checkpoint?: string }> {
    const row = await this.db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", [`compaction.${instanceId}`]);
    if (!row) return { seq: -1 };
    try {
      const parsed = JSON.parse(row.value) as { seq: number; checkpoint?: string };
      return { seq: parsed.seq ?? -1, checkpoint: parsed.checkpoint };
    } catch {
      return { seq: -1 };
    }
  }

  async saveCompaction(instanceId: string, cutoffSeq: number, checkpoint: string): Promise<void> {
    await this.db.exec("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [
      `compaction.${instanceId}`,
      JSON.stringify({ seq: cutoffSeq, checkpoint }),
      Date.now(),
    ]);
  }

  /** Tramo reciente que debe permanecer ante el modelo: últimos mensajes hasta keepTokens. */
  recentWindow(messages: Message[], keepTokens: number): { recent: Message[]; older: Message[] } {
    let tokens = 0;
    const recent: Message[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      tokens += Math.ceil(JSON.stringify(message.parts).length / 4);
      recent.unshift(message);
      if (tokens >= keepTokens) {
        return { recent, older: messages.slice(0, i) };
      }
    }
    return { recent, older: [] };
  }

  async fullHistory(instanceId: string): Promise<Message[]> {
    const rows = await this.db.query<Record<string, string | number | null>>(
      "SELECT * FROM messages WHERE instance_id = ? ORDER BY seq ASC",
      [instanceId],
    );
    return rows.map(deserializeMessage);
  }
}

export function deserializeMessage(row: Record<string, string | number | null>): Message {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    runId: String(row.run_id),
    instanceId: String(row.instance_id),
    role: row.role as Message["role"],
    mode: row.mode ? (String(row.mode) as Message["mode"]) : undefined,
    parts: JSON.parse(String(row.parts)) as MessagePart[],
    providerState: row.provider_state ? (JSON.parse(String(row.provider_state)) as unknown) : undefined,
    trust: row.trust as Message["trust"],
    seq: Number(row.seq),
    createdAt: Number(row.created_at),
  };
}

export function toNormalized(messages: Message[]): NormalizedMessage[] {
  const calls = new Map<string, { providerCallId: string; name: string; argumentsJson: string }>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_call") {
        const call = part as ToolCallPart;
        calls.set(call.toolCallId, { providerCallId: call.toolCallId, name: call.name, argumentsJson: call.argumentsJson });
      }
    }
    for (const part of message.parts) {
      if (part.type === "tool_result") {
        const result = part as ToolResultPart;
        const call = calls.get(result.toolCallId);
        if (call) call.providerCallId = result.providerCallId;
      }
    }
  }
  const out: NormalizedMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = message.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
      out.push({ role: "user", blocks: [{ type: "text", text }] });
      continue;
    }
    if (message.role === "system") {
      const text = message.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
      out.push({ role: "developer", blocks: [{ type: "text", text }] });
      continue;
    }
    if (message.role === "tool") {
      const blocks = message.parts
        .filter((p): p is ToolResultPart => p.type === "tool_result")
        .map((p) => ({ type: "tool_result" as const, providerCallId: p.providerCallId, ok: p.ok, text: p.text }));
      if (blocks.length > 0) out.push({ role: "tool", blocks });
      continue;
    }
    const text = message.parts.filter((p) => p.type === "text" || p.type === "reasoning_summary").map((p) => (p as { text: string }).text).join("\n");
    const toolCalls = message.parts
      .filter((p): p is ToolCallPart => p.type === "tool_call")
      .map((p) => {
        const known = calls.get(p.toolCallId);
        return {
          providerCallId: known?.providerCallId ?? p.toolCallId,
          name: p.name,
          argumentsJson: p.argumentsJson,
        };
      });
    out.push({ role: "assistant", blocks: [{ type: "text", text }], toolCalls: toolCalls.length > 0 ? toolCalls : undefined, providerState: message.providerState });
  }
  return out;
}

export function nextMessageId(): string {
  return createId("msg");
}

/**
 * Inserta marcadores de cambio de modo para que el modelo sitúe cada tramo.
 * Los mensajes conservan su orden cronológico; el marcador es solo contexto.
 */
export function withModeMarkers(messages: Message[]): Message[] {
  const out: Message[] = [];
  let lastMode: string | undefined;
  for (const message of messages) {
    if (message.mode && message.mode !== lastMode) {
      out.push({
        ...message,
        id: `mode-marker-${message.id}`,
        role: "system",
        parts: [{ type: "text", text: `[coordinator mode: ${message.mode}]` }],
      } as Message);
      lastMode = message.mode;
    }
    out.push(message);
  }
  return out;
}
