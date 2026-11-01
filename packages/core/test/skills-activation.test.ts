/**
 * Todo 22 — Activación, administración, alcances y persistencia.
 * Datos fijos: skill `qa-skill@1.0.0` (misma que Todos 18/20/21).
 * Determinista: sin temporizadores, sin azar; DBs efímeras en tmp con limpieza.
 * - Happy: matriz habilitar/deshabilitar por proyecto + persistencia tras reinicio simulado.
 * - Failure: skill deshabilitada en el proyecto NUNCA llega al contexto de sus runs.
 * - Activar NUNCA otorga permisos de herramientas (permission_rules intacta + no-importación).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OctusError } from "../src/errors.js";
import { PersistenceService } from "../src/persistence/persistence-service.js";
import {
  SkillActivationStore,
  detectUpdates,
} from "../src/skills/skill-activation.js";

const QA = { name: "qa-skill", version: "1.0.0" };
const QA_PROVENANCE = { kind: "folder", sourcePath: "/tmp/origen/qa-skill" } as const;

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function openDb(dir: string): Promise<PersistenceService> {
  return PersistenceService.open({ dbPath: path.join(dir, "test.db") });
}

async function permissionRuleCount(db: PersistenceService): Promise<number> {
  const row = await db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM permission_rules");
  return Number(row?.n ?? -1);
}

describe("skills activation/admin/scopes/persistence (Todo 22)", () => {
  test("matriz habilitar/deshabilitar por proyecto con aislamiento", async () => {
    const t = tempDir("octus-qa-22-matrix-");
    const db = await openDb(t.dir);
    try {
      const store = new SkillActivationStore(db);
      // Estado inicial: nada habilitado en ningún proyecto.
      expect(await store.isEnabled("proj-a", QA.name)).toBe(false);
      expect(await store.isEnabled("proj-b", QA.name)).toBe(false);

      // Habilitar en A no afecta a B (aislamiento por proyecto).
      await store.enable("proj-a", QA);
      expect(await store.isEnabled("proj-a", QA.name)).toBe(true);
      expect(await store.isEnabled("proj-b", QA.name)).toBe(false);

      // Habilitar en B con otro alcance; cada proyecto conserva el suyo.
      await store.enable("proj-b", QA, "global");
      expect((await store.get("proj-a", QA.name))?.scope).toBe("project");
      expect((await store.get("proj-b", QA.name))?.scope).toBe("global");

      // Deshabilitar en A no afecta a B.
      await store.disable("proj-a", QA.name);
      expect(await store.isEnabled("proj-a", QA.name)).toBe(false);
      expect(await store.isEnabled("proj-b", QA.name)).toBe(true);

      // Deshabilitar es idempotente y vale para nombres sin estado.
      await store.disable("proj-a", QA.name);
      expect(await store.isEnabled("proj-a", QA.name)).toBe(false);
    } finally {
      await db.close();
      t.cleanup();
    }
  });

  test("cambiar alcance persiste y el inválido se rechaza", async () => {
    const t = tempDir("octus-qa-22-scope-");
    const db = await openDb(t.dir);
    try {
      const store = new SkillActivationStore(db);
      await store.enable("proj-a", QA);
      expect((await store.setScope("proj-a", QA.name, "managed"))?.scope).toBe("managed");
      expect((await store.get("proj-a", QA.name))?.scope).toBe("managed");
      // El cambio de alcance no habilita ni deshabilita por sí solo.
      await store.disable("proj-a", QA.name);
      await store.setScope("proj-a", QA.name, "global");
      expect(await store.isEnabled("proj-a", QA.name)).toBe(false);
      expect((await store.get("proj-a", QA.name))?.scope).toBe("global");

      let err: unknown = null;
      try {
        await store.setScope("proj-a", QA.name, "xx" as never);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(OctusError);
      expect((err as OctusError).code).toBe("invalid_definition");
    } finally {
      await db.close();
      t.cleanup();
    }
  });

  test("installed frente a enabled siempre distintos, con procedencia visible", async () => {
    const t = tempDir("octus-qa-22-admin-");
    const db = await openDb(t.dir);
    try {
      const store = new SkillActivationStore(db);
      const installed = [{ name: QA.name, version: QA.version, scope: "project" as const, provenance: QA_PROVENANCE }];

      // Instalada pero jamás habilitada: installed=true, enabled=false.
      let view = await store.adminView("proj-a", installed);
      expect(view).toHaveLength(1);
      expect(view[0]).toMatchObject({ name: "qa-skill", installed: true, enabled: false });
      expect(view[0]!.provenance).toEqual(QA_PROVENANCE);

      // Habilitar no reinstala: installed sigue true, enabled pasa a true.
      await store.enable("proj-a", QA);
      view = await store.adminView("proj-a", installed);
      expect(view[0]).toMatchObject({ name: "qa-skill", installed: true, enabled: true });
      expect(view[0]!.provenance).toEqual(QA_PROVENANCE);
      expect(view[0]!.installedVersion).toBe("1.0.0");
      expect(view[0]!.knownVersion).toBe("1.0.0");

      // Deshabilitar no desinstala: installed sigue true, enabled vuelve a false.
      await store.disable("proj-a", QA.name);
      view = await store.adminView("proj-a", installed);
      expect(view[0]).toMatchObject({ name: "qa-skill", installed: true, enabled: false });

      // Estado sin registro instalado (p. ej. tras desinstalar): huérfano visible.
      view = await store.adminView("proj-a", []);
      expect(view).toHaveLength(1);
      expect(view[0]).toMatchObject({ name: "qa-skill", installed: false, enabled: false, orphanState: true });
    } finally {
      await db.close();
      t.cleanup();
    }
  });

  test("persistencia con recuperación tras reinicio simulado", async () => {
    const t = tempDir("octus-qa-22-persist-");
    const dbPath = path.join(t.dir, "test.db");
    let db = await PersistenceService.open({ dbPath });
    try {
      const store = new SkillActivationStore(db);
      await store.enable("proj-a", QA, "managed");
      await store.disable("proj-b", QA.name);
      await store.enable("proj-b", { name: "other-skill", version: "2.3.0" }, "global");
    } finally {
      await db.close();
    }
    // Reinicio simulado: reabrir la misma DB con un store nuevo.
    db = await PersistenceService.open({ dbPath });
    try {
      const store2 = new SkillActivationStore(db);
      expect(await store2.isEnabled("proj-a", QA.name)).toBe(true);
      expect((await store2.get("proj-a", QA.name))?.scope).toBe("managed");
      expect((await store2.get("proj-a", QA.name))?.version).toBe("1.0.0");
      expect(await store2.isEnabled("proj-b", QA.name)).toBe(false);
      expect(await store2.isEnabled("proj-b", "other-skill")).toBe(true);
      expect((await store2.get("proj-b", "other-skill"))?.scope).toBe("global");
      // Aislamiento intacto tras el reinicio: un tercer proyecto sigue vacío.
      expect(await store2.list("proj-c")).toHaveLength(0);
    } finally {
      await db.close();
      t.cleanup();
    }
  });

  test("failure: skill deshabilitada en el proyecto nunca llega al contexto de sus runs", async () => {
    const t = tempDir("octus-qa-22-failure-");
    const db = await openDb(t.dir);
    try {
      const store = new SkillActivationStore(db);
      const candidates = [{ name: "qa-skill" }, { name: "other-skill" }];
      // Habilitada en A: llega; deshabilitada/sin estado en B: no llega.
      await store.enable("proj-a", QA);
      await store.enable("proj-a", { name: "other-skill", version: "2.0.0" });
      await store.disable("proj-b", QA.name);
      expect((await store.selectForRun("proj-a", candidates)).map((c) => c.name)).toEqual(["qa-skill", "other-skill"]);
      // En B qa-skill está deshabilitada y other-skill sin estado: ninguna llega.
      expect(await store.selectForRun("proj-b", candidates)).toEqual([]);
      // Tras deshabilitar en A, tampoco llega en A aunque siga instalada.
      await store.disable("proj-a", QA.name);
      expect((await store.selectForRun("proj-a", candidates)).map((c) => c.name)).toEqual(["other-skill"]);
      // Sin candidatas o sin estado: vacío, nunca inventa.
      expect(await store.selectForRun("proj-a", [])).toEqual([]);
      expect(await store.selectForRun("proj-z", candidates)).toEqual([]);
    } finally {
      await db.close();
      t.cleanup();
    }
  });

  test("detectar actualizaciones: update, new y sin cambios", () => {
    expect(detectUpdates([{ name: "qa-skill", version: "1.0.0" }], [{ name: "qa-skill", version: "1.1.0" }])).toEqual([
      { name: "qa-skill", kind: "update", from: "1.0.0", to: "1.1.0" },
    ]);
    expect(detectUpdates([{ name: "qa-skill", version: "1.0.0" }], [{ name: "qa-skill", version: "1.0.0" }])).toEqual([]);
    expect(detectUpdates([], [{ name: "qa-skill", version: "1.0.0" }])).toEqual([{ name: "qa-skill", kind: "new", to: "1.0.0" }]);
    expect(detectUpdates([{ name: "qa-skill", version: "1.0.0" }], [])).toEqual([]);
  });

  test("activar NUNCA otorga permisos de herramientas", async () => {
    const t = tempDir("octus-qa-22-noperm-");
    const db = await openDb(t.dir);
    try {
      expect(await permissionRuleCount(db)).toBe(0);
      const store = new SkillActivationStore(db);
      // Matriz completa de administración…
      await store.enable("proj-a", QA, "managed");
      await store.setScope("proj-a", QA.name, "global");
      await store.disable("proj-a", QA.name);
      await store.enable("proj-b", QA);
      await store.enable("proj-b", { name: "other-skill", version: "9.9.9" }, "global");
      // …sin que aparezca ni una regla de permisos.
      expect(await permissionRuleCount(db)).toBe(0);
      // Y el módulo ni siquiera puede importar permisos (verificación estática).
      const src = readFileSync(new URL("../src/skills/skill-activation.ts", import.meta.url), "utf8");
      for (const banned of ["permission-manager", "tool-gateway", "permission_rules", "PermissionManager", "ToolGateway"]) {
        expect(src.includes(banned), `importación prohibida presente: ${banned}`).toBe(false);
      }
    } finally {
      await db.close();
      t.cleanup();
    }
  });

  test("recuperación ante kv corrupto: degrada a vacío sin romper", async () => {
    const t = tempDir("octus-qa-22-corrupt-");
    const dbPath = path.join(t.dir, "test.db");
    let db = await PersistenceService.open({ dbPath });
    try {
      await db.exec("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)", [
        SkillActivationStore.keyFor("proj-a"),
        "{corrupto",
        Date.now(),
      ]);
    } finally {
      await db.close();
    }
    db = await PersistenceService.open({ dbPath });
    try {
      const store = new SkillActivationStore(db);
      expect(await store.get("proj-a", QA.name)).toBeUndefined();
      expect(await store.isEnabled("proj-a", QA.name)).toBe(false);
      // Y el store sigue operativo tras la corrupción.
      await store.enable("proj-a", QA);
      expect(await store.isEnabled("proj-a", QA.name)).toBe(true);
    } finally {
      await db.close();
      t.cleanup();
    }
  });
});
