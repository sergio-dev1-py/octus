/** @octus/core — protocolo entre el hilo principal y el worker SQLite (ADR-020). */

export type SqlParam = string | number | null;
export type SqlRow = Record<string, string | number | null>;

export interface WorkerRequest {
  id: number;
  op: "open" | "exec" | "query" | "queryOne" | "batch" | "migrate" | "checkpoint" | "close" | "ping";
  dbPath?: string;
  sql?: string;
  params?: SqlParam[];
  statements?: Array<{ sql: string; params?: SqlParam[] }>;
  migrations?: Array<{ version: number; name: string; sql: string }>;
}

export interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ExecResult {
  changes: number;
}

export interface MigrateResult {
  applied: number[];
}
