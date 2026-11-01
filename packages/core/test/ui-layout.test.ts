import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_LAYOUT, UI_LAYOUT_KEY, parseStoredLayout, resizeSidebarBy, toggleBottom, type WorkbenchLayout } from "@octus/shared";
import { PersistenceService } from "../src/persistence/persistence-service.js";

const UPSERT =
  "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at";

/**
 * Todo 8 — persistencia del layout en `kv ui.layout.v1`:
 * ida y vuelta con reinicio simulado (close + reopen) y degradación ante
 * corrupción sin romper el arranque (mismo mecanismo que el Todo 6).
 */
describe("workbench layout persistence (Todo 8)", () => {
  test("ocultar y redimensionar sobrevive al reinicio", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octus-layout-"));
    const dbPath = path.join(dir, "test.db");
    const changed: WorkbenchLayout = resizeSidebarBy(toggleBottom(DEFAULT_LAYOUT), 36);
    let db = await PersistenceService.open({ dbPath });
    try {
      await db.exec(UPSERT, [UI_LAYOUT_KEY, JSON.stringify(changed), Date.now()]);
    } finally {
      await db.close();
    }
    // Reinicio simulado: reabrir y afirmar valores.
    db = await PersistenceService.open({ dbPath });
    try {
      const row = await db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", [UI_LAYOUT_KEY]);
      expect(parseStoredLayout(row?.value)).toEqual(changed);
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("layout corrupto en disco degrada al defecto sin romper el arranque", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octus-layout-"));
    const dbPath = path.join(dir, "test.db");
    let db = await PersistenceService.open({ dbPath });
    try {
      await db.exec(UPSERT, [UI_LAYOUT_KEY, "{corrupto", Date.now()]);
    } finally {
      await db.close();
    }
    db = await PersistenceService.open({ dbPath });
    try {
      const row = await db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", [UI_LAYOUT_KEY]);
      expect(parseStoredLayout(row?.value)).toEqual({ ...DEFAULT_LAYOUT });
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
