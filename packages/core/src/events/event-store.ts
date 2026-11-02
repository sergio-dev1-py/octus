/**
 * @octus/core — EventStore persistido + bus en memoria.
 * Regla: persistir primero (transacción con el cambio de estado) y publicar después.
 */
import { createId, type EventEnvelope, type PersistedEvent, type PersistedEventType } from "@octus/shared";
import { now } from "../util.js";
import type { PersistenceService } from "../persistence/persistence-service.js";

export interface NewEvent {
  type: PersistedEventType;
  aggregate: { kind: EventEnvelope["aggregate"]["kind"]; id: string };
  correlationId: string;
  causationId?: string;
  payload?: Record<string, unknown>;
}

export class EventStore {
  constructor(private readonly db: PersistenceService) {}

  /** Inserta con secuencia por agregado asignada atómicamente (INSERT…SELECT). */
  async append(input: NewEvent): Promise<PersistedEvent> {
    const id = createId("evt");
    const occurredAt = now();
    const idempotencyKey = createId("idem");
    const payload = JSON.stringify(input.payload ?? {});
    await this.db.exec(
      `INSERT INTO events (id, type, aggregate_kind, aggregate_id, seq, occurred_at, correlation_id, causation_id, idempotency_key, payload)
       SELECT ?, ?, ?, ?, COALESCE((SELECT MAX(seq) FROM events WHERE aggregate_kind = ? AND aggregate_id = ?), -1) + 1, ?, ?, ?, ?, ?`,
      [
        id,
        input.type,
        input.aggregate.kind,
        input.aggregate.id,
        input.aggregate.kind,
        input.aggregate.id,
        occurredAt,
        input.correlationId,
        input.causationId ?? null,
        idempotencyKey,
        payload,
      ],
    );
    const row = await this.db.queryOne<{ seq: number }>("SELECT seq FROM events WHERE id = ?", [id]);
    return {
      id,
      type: input.type,
      aggregate: input.aggregate,
      seq: row?.seq ?? 0,
      occurredAt,
      correlationId: input.correlationId,
      causationId: input.causationId,
      idempotencyKey,
      payload: input.payload ?? {},
    };
  }

  async listByAggregate(kind: string, id: string, limit = 500): Promise<PersistedEvent[]> {
    const rows = await this.db.query<Record<string, string | number | null>>(
      "SELECT * FROM events WHERE aggregate_kind = ? AND aggregate_id = ? ORDER BY seq ASC LIMIT ?",
      [kind, id, limit],
    );
    return rows.map(deserialize);
  }

  async listByType(type: PersistedEventType, limit = 500): Promise<PersistedEvent[]> {
    const rows = await this.db.query<Record<string, string | number | null>>(
      "SELECT * FROM events WHERE type = ? ORDER BY occurred_at DESC LIMIT ?",
      [type, limit],
    );
    return rows.map(deserialize);
  }

  /**
   * Poda por política (Todo 34, presupuesto §7: `events` ≤ 2.000 filas por
   * run típico). Solo toca agregados (`run`, `task`, `instance`) de runs ya
   * terminales (`done`/`failed`/`cancelled`) que superen el tope, y conserva
   * sus últimas `limitPerAggregate` filas. Los runs típicos están muy por
   * debajo del tope y conservan su auditoría completa; solo el crecimiento
   * patológico se recorta.
   */
  async pruneTerminalRunEvents(limitPerAggregate = 2000): Promise<{ pruned: number; aggregates: number }> {
    const keep = Math.max(1, Math.floor(limitPerAggregate));
    const scope =
      "(e.aggregate_kind = 'run' AND e.aggregate_id IN (SELECT id FROM runs WHERE status IN ('done','failed','cancelled')))" +
      " OR (e.aggregate_kind = 'task' AND e.aggregate_id IN (SELECT t.id FROM tasks t JOIN runs r ON r.id = t.run_id WHERE r.status IN ('done','failed','cancelled')))" +
      " OR (e.aggregate_kind = 'instance' AND e.aggregate_id IN (SELECT i.id FROM agent_instances i JOIN runs r ON r.id = i.run_id WHERE r.status IN ('done','failed','cancelled')))";
    const offenders = await this.db.query<{ kind: string; id: string }>(
      `SELECT e.aggregate_kind AS kind, e.aggregate_id AS id FROM events e WHERE ${scope} GROUP BY e.aggregate_kind, e.aggregate_id HAVING COUNT(*) > ?`,
      [keep],
    );
    let pruned = 0;
    for (const offender of offenders) {
      const result = await this.db.exec(
        "DELETE FROM events WHERE aggregate_kind = ? AND aggregate_id = ? AND id NOT IN (SELECT id FROM events WHERE aggregate_kind = ? AND aggregate_id = ? ORDER BY seq DESC LIMIT ?)",
        [offender.kind, offender.id, offender.kind, offender.id, keep],
      );
      pruned += result.changes ?? 0;
    }
    return { pruned, aggregates: offenders.length };
  }
}

function deserialize(row: Record<string, string | number | null>): PersistedEvent {
  return {
    id: String(row.id),
    type: row.type as PersistedEventType,
    aggregate: { kind: row.aggregate_kind as PersistedEvent["aggregate"]["kind"], id: String(row.aggregate_id) },
    seq: Number(row.seq),
    occurredAt: Number(row.occurred_at),
    correlationId: String(row.correlation_id),
    causationId: row.causation_id ? String(row.causation_id) : undefined,
    idempotencyKey: String(row.idempotency_key),
    payload: JSON.parse(String(row.payload ?? "{}")) as Record<string, unknown>,
  };
}

export type EventHandler = (event: PersistedEvent) => void;

/** Bus en memoria: solo recibe eventos ya persistidos. Deduplica por id. */
export class EventBus {
  private handlers = new Set<EventHandler>();
  private seen = new Set<string>();

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  publish(event: PersistedEvent): void {
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (this.seen.size > 10_000) {
      const oldest = this.seen.values().next().value as string;
      this.seen.delete(oldest);
    }
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Un suscriptor no debe tumbar al resto; el core registra el fallo.
      }
    }
  }
}
