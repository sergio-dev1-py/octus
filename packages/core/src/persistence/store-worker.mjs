/**
 * @octus/core — worker SQLite dedicado (ADR-020).
 *
 * JavaScript plano autocontenido (sin TypeScript ni dependencias npm) para poder
 * cargarse sin transpilar en Bun, Node y Electron empaquetado. Toda la API de
 * `node:sqlite` es síncrona: vive SOLO aquí, nunca en el hilo principal.
 */
import { parentPort } from "node:worker_threads";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

if (!parentPort) {
  throw new Error("store-worker must run inside a worker thread");
}

/** @type {import("node:sqlite").DatabaseSync | undefined} */
let db;

function fail(id, message) {
  parentPort.postMessage({ id, ok: false, error: String(message).slice(0, 2000) });
}

function openDatabase(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  const handle = new DatabaseSync(dbPath);
  handle.exec("PRAGMA journal_mode = WAL;");
  handle.exec("PRAGMA synchronous = NORMAL;");
  handle.exec("PRAGMA busy_timeout = 5000;");
  handle.exec("PRAGMA foreign_keys = ON;");
  return handle;
}

function runBatch(handle, statements) {
  handle.exec("BEGIN IMMEDIATE;");
  let changes = 0;
  try {
    for (const st of statements) {
      const info = handle.prepare(st.sql).run(...(st.params ?? []));
      changes += Number(info.changes ?? 0);
    }
    handle.exec("COMMIT;");
    return changes;
  } catch (error) {
    try {
      handle.exec("ROLLBACK;");
    } catch {
      // ignore secondary failure; report the original
    }
    throw error;
  }
}

function migrate(handle, migrations) {
  handle.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);",
  );
  const appliedRows = handle.prepare("SELECT version FROM schema_migrations;").all();
  const applied = new Set(appliedRows.map((r) => Number(r.version)));
  const newly = [];
  const pending = [...migrations].sort((a, b) => a.version - b.version);
  for (const m of pending) {
    if (applied.has(m.version)) continue;
    handle.exec("BEGIN IMMEDIATE;");
    try {
      handle.exec(m.sql);
      handle.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?);").run(m.version, m.name, Date.now());
      handle.exec("COMMIT;");
      newly.push(m.version);
    } catch (error) {
      try {
        handle.exec("ROLLBACK;");
      } catch {
        // ignore
      }
      throw new Error(`migration ${m.version} (${m.name}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return newly;
}

parentPort.on("message", (msg) => {
  const { id, op } = msg ?? {};
  if (typeof id !== "number" || typeof op !== "string") return;
  try {
    handleOp(id, op, msg);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    // Diferido al siguiente tick: la respuesta nunca se emite durante el unwind.
    setImmediate(() => fail(id, text));
  }
});

function handleOp(id, op, msg) {
    switch (op) {
      case "ping": {
        parentPort.postMessage({ id, ok: true, result: "pong" });
        break;
      }
      case "open": {
        if (db) db.close();
        db = openDatabase(String(msg.dbPath));
        parentPort.postMessage({ id, ok: true, result: { opened: true } });
        break;
      }
      case "exec": {
        if (!db) throw new Error("database is not open");
        const info = db.prepare(String(msg.sql)).run(...(msg.params ?? []));
        parentPort.postMessage({ id, ok: true, result: { changes: Number(info.changes ?? 0) } });
        break;
      }
      case "query": {
        if (!db) throw new Error("database is not open");
        const rows = db.prepare(String(msg.sql)).all(...(msg.params ?? []));
        parentPort.postMessage({ id, ok: true, result: rows });
        break;
      }
      case "queryOne": {
        if (!db) throw new Error("database is not open");
        const row = db.prepare(String(msg.sql)).get(...(msg.params ?? []));
        parentPort.postMessage({ id, ok: true, result: row ?? null });
        break;
      }
      case "batch": {
        if (!db) throw new Error("database is not open");
        const changes = runBatch(db, msg.statements ?? []);
        parentPort.postMessage({ id, ok: true, result: { changes } });
        break;
      }
      case "migrate": {
        if (!db) throw new Error("database is not open");
        const applied = migrate(db, msg.migrations ?? []);
        parentPort.postMessage({ id, ok: true, result: { applied } });
        break;
      }
      case "checkpoint": {
        if (!db) throw new Error("database is not open");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        parentPort.postMessage({ id, ok: true, result: { checkpointed: true } });
        break;
      }
      case "close": {
        if (db) {
          try {
            db.exec("PRAGMA wal_checkpoint(PASSIVE);");
          } catch {
            // ignore
          }
          db.close();
          db = undefined;
        }
        parentPort.postMessage({ id, ok: true, result: { closed: true } });
        break;
      }
      default:
        fail(id, `unknown op: ${op}`);
    }
}
