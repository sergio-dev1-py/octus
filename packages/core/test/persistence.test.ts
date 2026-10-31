import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PersistenceService } from "../src/persistence/persistence-service.js";
import { expectRejects } from "./helpers.js";

function tempDb(): { service: Promise<PersistenceService>; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "octus-persist-"));
  return { service: PersistenceService.open({ dbPath: path.join(dir, "test.db") }), dir };
}

describe("persistence worker", () => {
  test("applies migration 0001 and creates core tables", async () => {
    const { service, dir } = tempDb();
    const db = await service;
    try {
      const tables = await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
      const names = tables.map((t) => t.name);
      for (const expected of ["projects", "sessions", "runs", "agent_instances", "messages", "tool_invocations", "events", "artifacts", "provider_configs", "permission_rules", "usage_records", "budgets", "kv", "schema_migrations"]) {
        expect(names).toContain(expected);
      }
      // Sin tablas de etapas futuras (Etapa 5+: integrations/memory). En Etapa 4,
      // repositories/worktrees/managed_branches/worktree_ops ya existen legítimamente.
      for (const future of ["integrations", "approvals", "memory_entries"]) {
        expect(names).not.toContain(future);
      }
      // Tablas de la Etapa 3 presentes tras migrar a latest.
      for (const stage3 of ["tasks", "task_dependencies", "task_attempts", "plannings", "scheduler_reservations", "scheduler_fairness"]) {
        expect(names).toContain(stage3);
      }
      // Tablas de la Etapa 4 presentes tras migrar a latest.
      for (const stage4 of ["repositories", "worktrees", "managed_branches", "worktree_ops"]) {
        expect(names).toContain(stage4);
      }
      const journal = await db.queryOne<{ journal_mode: string }>("PRAGMA journal_mode");
      expect(journal?.journal_mode.toLowerCase()).toBe("wal");
      const fk = await db.queryOne<{ foreign_keys: number }>("PRAGMA foreign_keys");
      expect(fk?.foreign_keys).toBe(1);
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("batch is atomic: a failing statement rolls everything back", async () => {
    const { service, dir } = tempDb();
    const db = await service;
    try {
      await expectRejects(
        db.batch([
          { sql: "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)", params: ["a", "1", 1] },
          { sql: "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)", params: ["a", "2", 2] },
        ]),
        /UNIQUE constraint failed/,
      );
      expect(await db.queryOne("SELECT * FROM kv WHERE key = ?", ["a"])).toBeNull();
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("foreign keys are enforced with cascade", async () => {
    const { service, dir } = tempDb();
    const db = await service;
    try {
      await db.exec("INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('p1', 'P', '/tmp', 1, 1)");
      await expectRejects(
        db.exec("INSERT INTO sessions (id, project_id, title, directory, profile, created_at, updated_at) VALUES ('s9', 'missing', 'T', '/tmp', 'build', 1, 1)"),
        /FOREIGN KEY/i,
      );
      await db.exec("INSERT INTO sessions (id, project_id, title, directory, profile, created_at, updated_at) VALUES ('s1', 'p1', 'T', '/tmp', 'build', 1, 1)");
      await db.exec("INSERT INTO runs (id, session_id, prompt, status, created_at, updated_at) VALUES ('r1', 's1', 'hi', 'done', 1, 1)");
      await db.exec("DELETE FROM sessions WHERE id = 's1'");
      expect(await db.queryOne("SELECT * FROM runs WHERE id = 'r1'")).toBeNull();
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("data survives close and reopen", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octus-persist-"));
    const dbPath = path.join(dir, "test.db");
    const first = await PersistenceService.open({ dbPath });
    await first.exec("INSERT INTO kv (key, value, updated_at) VALUES ('k', 'v', 1)");
    await first.close();
    const second = await PersistenceService.open({ dbPath });
    try {
      expect(await second.queryOne("SELECT value FROM kv WHERE key = 'k'")).toMatchObject({ value: "v" });
    } finally {
      await second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
