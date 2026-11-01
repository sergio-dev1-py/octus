import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UI_PREFS_KEY, parseStoredUiPrefs, type UiPrefs } from "@octus/shared";
import { PersistenceService } from "../src/persistence/persistence-service.js";

/**
 * Todo 6 — persistencia de preferencias en `kv ui.prefs.v1` (contrato C-01):
 * ida y vuelta con reinicio simulado (close + reopen) y degradación ante
 * corrupción sin romper el arranque.
 */
describe("ui prefs persistence (Todo 6)", () => {
  test("cambiar tema, tamano y densidad sobrevive al reinicio", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octus-uiprefs-"));
    const dbPath = path.join(dir, "test.db");
    const changed: UiPrefs = { theme: "dark", fontSize: 12, density: "comfortable" };
    let db = await PersistenceService.open({ dbPath });
    try {
      await db.exec("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [
        UI_PREFS_KEY,
        JSON.stringify(changed),
        Date.now(),
      ]);
    } finally {
      await db.close();
    }
    // Reinicio simulado: reabrir y afirmar valores.
    db = await PersistenceService.open({ dbPath });
    try {
      const row = await db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", [UI_PREFS_KEY]);
      expect(parseStoredUiPrefs(row?.value)).toEqual(changed);
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preferencia corrupta en disco degrada al defecto sin romper el arranque", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octus-uiprefs-"));
    const dbPath = path.join(dir, "test.db");
    let db = await PersistenceService.open({ dbPath });
    try {
      await db.exec("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [
        UI_PREFS_KEY,
        "{corrupto",
        Date.now(),
      ]);
    } finally {
      await db.close();
    }
    db = await PersistenceService.open({ dbPath });
    try {
      const row = await db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", [UI_PREFS_KEY]);
      expect(parseStoredUiPrefs(row?.value)).toEqual({ theme: "system", fontSize: 14, density: "normal" });
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
