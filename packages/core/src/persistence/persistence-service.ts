/**
 * @octus/core — cliente asíncrono del worker SQLite (ADR-020).
 * El hilo principal nunca toca `node:sqlite` directamente.
 */
import { Worker } from "node:worker_threads";
import { OctusError } from "../errors.js";
import { MIGRATIONS } from "./schema.js";
import type { ExecResult, MigrateResult, SqlParam, SqlRow, WorkerRequest, WorkerResponse } from "./protocol.js";

export interface PersistenceOptions {
  dbPath: string;
  /** URL del worker. Por defecto, el .mjs junto a este módulo (tests/Bun/Node). Electron pasa la ruta empaquetada. */
  workerUrl?: URL | string;
  /** Timeout por operación (ms). */
  opTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PersistenceService {
  private worker: Worker | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private readonly opTimeoutMs: number;
  private closed = false;

  private constructor(
    private readonly dbPath: string,
    private readonly workerUrl: URL | string,
    opTimeoutMs?: number,
  ) {
    this.opTimeoutMs = opTimeoutMs ?? 30_000;
  }

  static async open(options: PersistenceOptions): Promise<PersistenceService> {
    const workerUrl = options.workerUrl ?? new URL("./store-worker.mjs", import.meta.url);
    const service = new PersistenceService(options.dbPath, workerUrl, options.opTimeoutMs);
    await service.start();
    return service;
  }

  private start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        this.worker = new Worker(this.workerUrl);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.worker.on("message", (msg: WorkerResponse) => {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new OctusError("persistence_unavailable", msg.error ?? "worker error"));
      });
      this.worker.on("error", (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
          return;
        }
        this.failAll(error);
      });
      this.worker.on("exit", (code: number) => {
        if (!this.closed) this.failAll(new Error(`persistence worker exited with code ${code}`));
      });
      void (async () => {
        try {
          await this.call("ping", {});
          await this.call("open", { dbPath: this.dbPath });
          await this.call("migrate", { migrations: MIGRATIONS });
          settled = true;
          resolve();
        } catch (error) {
          settled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private call(op: WorkerRequest["op"], fields: Partial<WorkerRequest>): Promise<unknown> {
    if (this.closed || !this.worker) return Promise.reject(new OctusError("persistence_unavailable", "persistence is closed"));
    const id = this.nextId++;
    const request: WorkerRequest = { id, op, ...fields };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OctusError("timeout", `persistence op '${op}' timed out after ${this.opTimeoutMs}ms`));
      }, this.opTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker!.postMessage(request);
    });
  }

  async exec(sql: string, params?: SqlParam[]): Promise<ExecResult> {
    return (await this.call("exec", { sql, params })) as ExecResult;
  }

  async query<T = SqlRow>(sql: string, params?: SqlParam[]): Promise<T[]> {
    return (await this.call("query", { sql, params })) as T[];
  }

  async queryOne<T = SqlRow>(sql: string, params?: SqlParam[]): Promise<T | null> {
    return (await this.call("queryOne", { sql, params })) as T | null;
  }

  /** Lote atómico: una transacción en el worker (estado + evento juntos). */
  async batch(statements: Array<{ sql: string; params?: SqlParam[] }>): Promise<ExecResult> {
    return (await this.call("batch", { statements })) as ExecResult;
  }

  async checkpoint(): Promise<void> {
    await this.call("checkpoint", {});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // Envía el op `close` ANTES de marcar closed: `call` rechaza si closed ya es true
    // y el worker nunca cerraría la DB (locks EBUSY en Windows).
    try {
      await this.call("close", {});
    } catch {
      // ignore: el worker puede haber caído ya
    }
    this.closed = true;
    await this.worker?.terminate();
    this.worker = undefined;
  }

  get path(): string {
    return this.dbPath;
  }
}
