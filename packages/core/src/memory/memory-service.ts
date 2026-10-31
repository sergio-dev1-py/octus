/**
 * @octus/core — MemoryService: persistencia de entradas de memoria (Etapa 6).
 * CRUD delgado sobre `memory_entries`; la gobernanza vive en MemoryWriter.
 * Las transiciones ilegales las bloquea el trigger `trg_memory_status_upd`;
 * aquí se traducen a OctusError. Sin auto-run, sin alterar estado operativo.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createId, type MemoryConfidence, type MemoryItem, type MemoryOriginRef, type MemoryScope, type MemoryStatus } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { runGit } from "../repositories/git-exec.js";
import { sameOrInside } from "../tools/path-scope.js";
import { now } from "../util.js";

export interface ProposeInput {
  scope: MemoryScope;
  scopeId: string;
  category: string;
  topic: string;
  content: string;
  source: string;
  originRef?: MemoryOriginRef;
  confidence?: MemoryConfidence;
}

export interface MemoryFilter {
  scope?: MemoryScope;
  scopeId?: string;
  status?: MemoryStatus | MemoryStatus[];
  category?: string;
  topic?: string;
  limit?: number;
}

export interface RevalidateResult {
  applied: boolean;
  changed: boolean;
  reason: string;
}

const MAX_CONTENT_CHARS = 20_000;
const MAX_HASH_BYTES = 8 * 1024 * 1024;

const SCOPES: MemoryScope[] = ["project", "session", "run", "task", "instance"];

export class MemoryService {
  constructor(
    private readonly db: PersistenceService,
    private readonly events: EventStore,
    private readonly bus: EventBus,
  ) {}

  // ------------------------------------------------------------------ lectura
  async get(id: string): Promise<MemoryItem> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM memory_entries WHERE id = ?", [id]);
    if (!row) throw new OctusError("not_found", `Memory entry not found: ${id}`);
    return deserializeMemory(row);
  }

  async list(filter: MemoryFilter = {}): Promise<MemoryItem[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.scope) {
      clauses.push("scope = ?");
      params.push(filter.scope);
    }
    if (filter.scopeId) {
      clauses.push("scope_id = ?");
      params.push(filter.scopeId);
    }
    if (filter.status) {
      const list = Array.isArray(filter.status) ? filter.status : [filter.status];
      clauses.push(`status IN (${list.map(() => "?").join(",")})`);
      params.push(...list);
    }
    if (filter.category) {
      clauses.push("category = ?");
      params.push(filter.category);
    }
    if (filter.topic) {
      clauses.push("topic = ?");
      params.push(filter.topic);
    }
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    const rows = await this.db.query<Record<string, string | number | null>>(
      `SELECT * FROM memory_entries ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ${limit}`,
      params as import("../persistence/protocol.js").SqlParam[],
    );
    return rows.map(deserializeMemory);
  }

  /** Hermanos aprobados del mismo (scope,scopeId,topic): candidatos a contradicción. */
  async findApprovedSiblings(scope: MemoryScope, scopeId: string, topic: string, excludeId?: string): Promise<MemoryItem[]> {
    const rows = await this.db.query<Record<string, string | number | null>>(
      `SELECT * FROM memory_entries WHERE scope = ? AND scope_id = ? AND topic = ? AND status = 'approved' ${excludeId ? "AND id <> ?" : ""} ORDER BY updated_at DESC`,
      excludeId ? [scope, scopeId, topic, excludeId] : [scope, scopeId, topic],
    );
    return rows.map(deserializeMemory);
  }

  /** Grupo en posible contradicción: aprobados/verificados del mismo (scope,scopeId,topic). */
  async conflictGroup(scope: MemoryScope, scopeId: string, topic: string): Promise<MemoryItem[]> {
    const rows = await this.db.query<Record<string, string | number | null>>(
      "SELECT * FROM memory_entries WHERE scope = ? AND scope_id = ? AND topic = ? AND status IN ('approved','verified') ORDER BY updated_at DESC",
      [scope, scopeId, topic],
    );
    return rows.map(deserializeMemory);
  }

  // ------------------------------------------------- consultas de procedencia
  /** Kind de la definición de una instancia (para exigir coordinador). */
  async instanceKind(instanceId: string): Promise<string | undefined> {
    const row = await this.db.queryOne<{ kind: string }>(
      "SELECT d.kind AS kind FROM agent_instances i JOIN agent_definitions d ON d.id = i.definition_id WHERE i.id = ?",
      [instanceId],
    ).catch(() => null);
    return row ? String(row.kind) : undefined;
  }

  async taskRunId(taskId: string): Promise<string | undefined> {
    const row = await this.db.queryOne<{ run_id: string }>("SELECT run_id FROM tasks WHERE id = ?", [taskId]).catch(() => null);
    return row ? String(row.run_id) : undefined;
  }

  async sessionProject(sessionId: string): Promise<string | undefined> {
    const row = await this.db.queryOne<{ project_id: string }>("SELECT project_id FROM sessions WHERE id = ?", [sessionId]).catch(() => null);
    return row ? String(row.project_id) : undefined;
  }

  // ---------------------------------------------------------------- escritura
  /** Crea una entrada siempre en `proposed`. Valida campos y existencia del scope. */
  async propose(input: ProposeInput): Promise<MemoryItem> {
    this.validateFields(input);
    await this.requireScopeRow(input.scope, input.scopeId);
    const id = createId("mem");
    const timestamp = now();
    await this.db.exec(
      "INSERT INTO memory_entries (id, scope, scope_id, category, topic, content, source, origin_ref, status, confidence, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, 1, ?, ?)",
      [id, input.scope, input.scopeId, input.category.trim(), input.topic.trim(), input.content, input.source.trim(), JSON.stringify(input.originRef ?? {}), input.confidence ?? "medium", timestamp, timestamp],
    );
    const event = await this.events.append({ type: "memory.recorded", aggregate: { kind: "memory", id }, correlationId: createId("cor"), payload: { scope: input.scope, scopeId: input.scopeId, status: "proposed" } });
    this.bus.publish(event);
    return this.get(id);
  }

  /** Transición gobernada; el trigger valida la lista blanca (FINAL-2). */
  async setStatus(id: string, status: MemoryStatus, by?: string): Promise<MemoryItem> {
    const current = await this.get(id);
    if (current.status === status) return current;
    try {
      await this.db.exec("UPDATE memory_entries SET status = ?, updated_at = ? WHERE id = ?", [status, now(), id]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new OctusError("invalid_state", `Memory status transition ${current.status}→${status} rejected: ${msg.slice(0, 200)}`);
    }
    const event = await this.events.append({ type: "memory.status_changed", aggregate: { kind: "memory", id }, correlationId: createId("cor"), payload: { from: current.status, to: status, by: by ?? "system" } });
    this.bus.publish(event);
    return this.get(id);
  }

  /** Nueva versión con contenido distinto; la anterior queda `superseded`. */
  async supersede(id: string, fields: { content: string; source?: string; originRef?: MemoryOriginRef; confidence?: MemoryConfidence }, by?: string): Promise<MemoryItem> {
    const current = await this.get(id);
    if (!["verified", "approved", "stale"].includes(current.status)) {
      throw new OctusError("invalid_state", `Cannot supersede a ${current.status} entry (only verified, approved or stale carry a version chain)`);
    }
    if (!fields.content || fields.content.length > MAX_CONTENT_CHARS) {
      throw new OctusError("invalid_tool_args", "Superseding content is required (max 20000 chars)");
    }
    const newId = createId("mem");
    const timestamp = now();
    await this.db.batch([
      {
        sql: "INSERT INTO memory_entries (id, scope, scope_id, category, topic, content, source, origin_ref, status, confidence, version, supersedes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)",
        params: [newId, current.scope, current.scopeId, current.category, current.topic, fields.content, fields.source ?? current.source, JSON.stringify(fields.originRef ?? current.originRef), fields.confidence ?? current.confidence, current.version + 1, id, timestamp, timestamp],
      },
      { sql: "UPDATE memory_entries SET status = 'superseded', updated_at = ? WHERE id = ?", params: [timestamp, id] },
    ]);
    const recorded = await this.events.append({ type: "memory.recorded", aggregate: { kind: "memory", id: newId }, correlationId: createId("cor"), payload: { scope: current.scope, scopeId: current.scopeId, status: "proposed", supersedes: id } });
    this.bus.publish(recorded);
    const changed = await this.events.append({ type: "memory.status_changed", aggregate: { kind: "memory", id }, correlationId: createId("cor"), payload: { from: current.status, to: "superseded", by: by ?? "system", supersededBy: newId } });
    this.bus.publish(changed);
    return this.get(newId);
  }

  /** Solo vía gobernanza (`decide`/resolución); nunca edición libre. */
  async setReviewNote(id: string, note: string | null, by?: string): Promise<MemoryItem> {
    await this.get(id);
    await this.db.exec("UPDATE memory_entries SET review_note = ?, updated_at = ? WHERE id = ?", [note, now(), id]);
    const event = await this.events.append({ type: "memory.status_changed", aggregate: { kind: "memory", id }, correlationId: createId("cor"), payload: { reviewNote: note, by: by ?? "governance" } });
    this.bus.publish(event);
    return this.get(id);
  }

  // ------------------------------------------------------------ revalidación
  /**
   * Verifica el origen contra el hash registrado (FINAL-precisión): el cambio
   * de contenido marca `stale`; la mera existencia no basta. Solo aplica a
   * `verified`/`approved` (y puede promover `stale`→`verified` si coincide).
   * Nunca altera contenido ni historial.
   */
  async revalidate(id: string): Promise<RevalidateResult & { entry: MemoryItem }> {
    const entry = await this.get(id);
    if (!["verified", "approved", "stale"].includes(entry.status)) {
      return { applied: false, changed: false, reason: "only verified, approved or stale entries are revalidated", entry };
    }
    const origin = entry.originRef ?? {};
    if (!origin.path && !origin.commit) {
      return { applied: false, changed: false, reason: "no origin to verify", entry };
    }
    const baseDir = await this.scopeDir(entry.scope, entry.scopeId);
    if (!baseDir) {
      return { applied: true, changed: true, reason: "scope directory gone", entry: await this.markStale(entry, "scope directory gone") };
    }
    if (origin.path) {
      const abs = path.normalize(path.join(baseDir, origin.path));
      if (!sameOrInside(baseDir, abs)) {
        return { applied: true, changed: true, reason: "origin outside scope", entry: await this.markStale(entry, "origin outside scope") };
      }
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        return { applied: true, changed: true, reason: "origin file missing", entry: await this.markStale(entry, "origin file missing") };
      }
      if (origin.contentHash) {
        let size = 0;
        try {
          size = statSync(abs).size;
        } catch {
          return { applied: true, changed: true, reason: "origin unreadable", entry: await this.markStale(entry, "origin unreadable") };
        }
        if (size > MAX_HASH_BYTES) {
          return { applied: true, changed: true, reason: "origin too large to hash", entry: await this.markStale(entry, "origin too large to hash") };
        }
        const digest = createHash("sha256").update(readFileSync(abs)).digest("hex");
        if (digest !== origin.contentHash) {
          return { applied: true, changed: true, reason: "origin content changed", entry: await this.markStale(entry, "origin content changed") };
        }
      } else {
        return { applied: false, changed: false, reason: "origin has no content hash; existence is not enough", entry };
      }
    }
    if (origin.commit) {
      const reachable = await this.commitReachable(baseDir, origin.commit);
      if (!reachable) {
        return { applied: true, changed: true, reason: "origin commit unreachable", entry: await this.markStale(entry, "origin commit unreachable") };
      }
    }
    // Origen verificado: una `stale` coincidente vuelve a `verified`.
    if (entry.status === "stale") {
      const promoted = await this.setStatus(id, "verified", "revalidate");
      return { applied: true, changed: false, reason: "origin verified", entry: promoted };
    }
    return { applied: true, changed: false, reason: "origin verified", entry };
  }

  // ---------------------------------------------------------------- internas
  private validateFields(input: ProposeInput): void {
    if (!SCOPES.includes(input.scope)) throw new OctusError("invalid_tool_args", `Invalid memory scope: ${input.scope}`);
    if (!input.scopeId?.trim()) throw new OctusError("invalid_tool_args", "Memory scopeId is required");
    if (!input.category?.trim() || input.category.length > 40) throw new OctusError("invalid_tool_args", "Memory category is required (max 40 chars)");
    if (!input.topic?.trim() || input.topic.length > 200) throw new OctusError("invalid_tool_args", "Memory topic is required (max 200 chars)");
    if (!input.content?.trim() || input.content.length > MAX_CONTENT_CHARS) throw new OctusError("invalid_tool_args", "Memory content is required (max 20000 chars)");
    if (!input.source?.trim() || input.source.length > 64) throw new OctusError("invalid_tool_args", "Memory source is required (max 64 chars)");
    if (input.confidence && !["low", "medium", "high"].includes(input.confidence)) {
      throw new OctusError("invalid_tool_args", `Invalid confidence: ${input.confidence}`);
    }
    const haystack = `${input.topic}\n${input.content}`;
    if (SECRET_LIKE.test(haystack)) {
      throw new OctusError("scope_violation", "Memory content looks like a secret or credential: proposals with secrets are rejected and never persisted");
    }
    const origin = input.originRef ?? {};
    if (origin.path && origin.path.length > 500) throw new OctusError("invalid_tool_args", "originRef.path too long");
    if (origin.section && origin.section.length > 200) throw new OctusError("invalid_tool_args", "originRef.section too long");
    if (origin.commit && origin.commit.length > 100) throw new OctusError("invalid_tool_args", "originRef.commit too long");
    if (origin.contentHash && !/^[0-9a-f]{64}$/i.test(origin.contentHash)) {
      throw new OctusError("invalid_tool_args", "originRef.contentHash must be a sha256 hex digest");
    }
  }

  /** La memoria solo referencia scopes reales (sin filas huérfanas). */
  async requireScopeRow(scope: MemoryScope, scopeId: string): Promise<void> {
    const checks: Record<MemoryScope, string> = {
      project: "SELECT id FROM projects WHERE id = ?",
      session: "SELECT id FROM sessions WHERE id = ?",
      run: "SELECT id FROM runs WHERE id = ?",
      task: "SELECT id FROM tasks WHERE id = ?",
      instance: "SELECT id FROM agent_instances WHERE id = ?",
    };
    const row = await this.db.queryOne<{ id: string }>(checks[scope], [scopeId]);
    if (!row) throw new OctusError("not_found", `Memory scope ${scope}:${scopeId} does not exist`);
  }

  /** Directorio base del scope para resolver `originRef.path`. */
  async scopeDir(scope: MemoryScope, scopeId: string): Promise<string | undefined> {
    try {
      if (scope === "project") {
        const row = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM projects WHERE id = ?", [scopeId]);
        return row ? String(row.root_path) : undefined;
      }
      if (scope === "session") {
        const row = await this.db.queryOne<{ directory: string }>("SELECT directory FROM sessions WHERE id = ?", [scopeId]);
        return row ? String(row.directory) : undefined;
      }
      if (scope === "run") {
        const row = await this.db.queryOne<{ directory: string }>("SELECT s.directory AS directory FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ?", [scopeId]);
        return row ? String(row.directory) : undefined;
      }
      if (scope === "task") {
        const row = await this.db.queryOne<{ directory: string }>("SELECT s.directory AS directory FROM tasks t JOIN runs r ON r.id = t.run_id JOIN sessions s ON s.id = r.session_id WHERE t.id = ?", [scopeId]);
        return row ? String(row.directory) : undefined;
      }
      const row = await this.db.queryOne<{ directory: string }>("SELECT directory FROM agent_instances WHERE id = ?", [scopeId]);
      return row ? String(row.directory) : undefined;
    } catch {
      return undefined;
    }
  }

  private async commitReachable(baseDir: string, commit: string): Promise<boolean> {
    let toplevel = baseDir;
    try {
      toplevel = (await runGit(baseDir, ["rev-parse", "--show-toplevel"])).stdout.trim();
    } catch {
      return false;
    }
    try {
      await runGit(toplevel, ["cat-file", "-e", commit]);
      return true;
    } catch {
      return false;
    }
  }

  private async markStale(entry: MemoryItem, reason: string): Promise<MemoryItem> {
    const stale = await this.setStatus(entry.id, "stale", "revalidate");
    return this.setReviewNote(stale.id, `stale: ${reason}`, "revalidate");
  }
}

/** Deny-list a nivel servicio: secretos aparentes jamás se persisten. */
const SECRET_LIKE = /api[_-]?key|secret|passwd|password|credential|private[_-]?key|bearer|access_token|auth_token|client_secret|session_token/i;

/** Fila → MemoryItem (reutilizado por ContextBuilder para no duplicar mapeo). */
export function deserializeMemory(row: Record<string, string | number | null>): MemoryItem {
  let originRef: MemoryOriginRef = {};
  try {
    const parsed = JSON.parse(String(row.origin_ref ?? "{}")) as unknown;
    if (parsed && typeof parsed === "object") originRef = parsed as MemoryOriginRef;
  } catch {
    originRef = {};
  }
  return {
    id: String(row.id),
    scope: row.scope as MemoryScope,
    scopeId: String(row.scope_id),
    category: String(row.category),
    topic: String(row.topic),
    content: String(row.content),
    source: String(row.source),
    originRef,
    status: row.status as MemoryStatus,
    confidence: (row.confidence ? String(row.confidence) : "medium") as MemoryItem["confidence"],
    version: Number(row.version ?? 1),
    supersedes: row.supersedes ? String(row.supersedes) : undefined,
    reviewNote: row.review_note ? String(row.review_note) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
