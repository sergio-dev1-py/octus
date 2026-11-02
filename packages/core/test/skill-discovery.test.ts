/**
 * Todo 20 — SkillManager con descubrimiento en tres ámbitos.
 * - Happy: la misma skill en dos ámbitos (global + project) produce UN solo registro
 *   (gana project), sin duplicados ni cargas múltiples (re-descubrir no añade).
 * - Errores visibles: frontal inválido y descripción vacía se registran con cláusula.
 * - Failure: directorio sin SKILL.md → error C1 registrado, NO skill.
 * - No-ejecución: un script señuelo junto a la skill nunca se ejecuta (sin marcador).
 * Determinista: sin temporizadores, sin azar; fixtures con nombres fijos en tmp.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SkillManager } from "../src/skills/skill-manager.js";

const QA_SKILL = `---
name: qa-skill
description: Skill de prueba para QA determinista del descubrimiento en tres ambitos.
license: MIT
compatibility: octus >= 0.1.0
metadata:
  author: octus-qa
  version: "1.0.0"
allowed-tools: read grep
---

# qa-skill

Cuerpo de la skill de prueba.
`;

interface Fixture {
  root: string;
  globalDir: string;
  projectDir: string;
  managedDir: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "octus-skill20-"));
  const globalDir = path.join(root, "global");
  const projectDir = path.join(root, "project");
  const managedDir = path.join(root, "managed");
  for (const d of [globalDir, projectDir, managedDir]) mkdirSync(d, { recursive: true });
  return { root, globalDir, projectDir, managedDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeSkill(scopeDir: string, dirName: string, skillMd: string, withDecoyScript = false): string {
  const dir = path.join(scopeDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), skillMd);
  if (withDecoyScript) {
    // Señuelo: si algo lo ejecutara, crearía el marcador. Nada debe ejecutarlo.
    writeFileSync(
      path.join(dir, "run.sh"),
      `#!/bin/sh\ntouch "${path.join(dir, "PWNED.marker")}"\n`,
    );
  }
  return dir;
}

describe("SkillManager: descubrimiento en tres ámbitos", () => {
  test("misma skill en global + project: un solo registro, gana project, sin cargas múltiples", () => {
    const fx = makeFixture();
    try {
      writeSkill(fx.globalDir, "qa-skill", QA_SKILL, true);
      writeSkill(fx.projectDir, "qa-skill", QA_SKILL, true);
      writeSkill(fx.managedDir, "other-skill", QA_SKILL.replace("name: qa-skill", "name: other-skill"), true);

      const manager = new SkillManager();
      const first = manager.discover({ globalDir: fx.globalDir, projectDir: fx.projectDir, managedDir: fx.managedDir });

      expect(first.skills.map((s) => s.name)).toEqual(["other-skill", "qa-skill"]);
      const qa = manager.get("qa-skill")!;
      expect(qa.id).toBe("qa-skill");
      expect(qa.description).toContain("tres ambitos");
      expect(qa.origin).toBe("project");
      expect(qa.scope).toBe("project");
      expect(qa.path).toBe(path.join(fx.projectDir, "qa-skill"));
      expect(qa.version).toBe("1.0.0");
      expect(qa.compatibility).toBe("octus >= 0.1.0");
      expect(qa.enabled).toBe(false);
      expect(qa.seenIn).toHaveLength(2);
      expect(qa.seenIn.map((s) => s.scope)).toEqual(["project", "global"]);
      expect(qa.errors.join(" ")).toContain("precedencia");
      expect(first.errors).toHaveLength(0);

      // Cada candidato se lee exactamente una vez (3 dirs x 1 skill).
      expect(manager.readCount()).toBe(3);

      // Re-descubrir no duplica ni acumula: registro idéntico.
      const second = manager.discover({ globalDir: fx.globalDir, projectDir: fx.projectDir, managedDir: fx.managedDir });
      expect(second.skills).toHaveLength(2);
      expect(manager.list()).toHaveLength(2);
      expect(manager.get("qa-skill")!.seenIn).toHaveLength(2);

      // El señuelo nunca se ejecutó: sin marcador en ningún ámbito.
      expect(existsSync(path.join(fx.globalDir, "qa-skill", "PWNED.marker"))).toBe(false);
      expect(existsSync(path.join(fx.projectDir, "qa-skill", "PWNED.marker"))).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  test("errores de validación visibles: nombre inválido y descripción vacía no son skills", () => {
    const fx = makeFixture();
    try {
      writeSkill(fx.globalDir, "Bad_Name", QA_SKILL.replace("name: qa-skill", "name: Bad_Name"));
      writeSkill(fx.projectDir, "empty-desc", "---\nname: empty-desc\ndescription: \"\"\n---\n\nCuerpo.\n");

      const manager = new SkillManager();
      const result = manager.discover({ globalDir: fx.globalDir, projectDir: fx.projectDir, managedDir: fx.managedDir });

      expect(result.skills).toHaveLength(0);
      expect(result.errors).toHaveLength(2);
      const byPath = new Map(result.errors.map((e) => [path.basename(e.path), e]));
      expect(byPath.get("Bad_Name")!.clause).toBe("C3");
      expect(byPath.get("Bad_Name")!.scope).toBe("global");
      expect(byPath.get("empty-desc")!.clause).toBe("C5");
      expect(byPath.get("empty-desc")!.scope).toBe("project");
      expect(manager.get("Bad_Name")).toBeUndefined();
      expect(manager.get("empty-desc")).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });

  test("failure: directorio sin SKILL.md se registra como error C1, no como skill", () => {
    const fx = makeFixture();
    try {
      mkdirSync(path.join(fx.managedDir, "no-skill-here"), { recursive: true });
      writeFileSync(path.join(fx.managedDir, "no-skill-here", "README.md"), "# sin SKILL.md\n");
      writeSkill(fx.globalDir, "qa-skill", QA_SKILL);

      const manager = new SkillManager();
      const result = manager.discover({ globalDir: fx.globalDir, projectDir: fx.projectDir, managedDir: fx.managedDir });

      expect(result.skills.map((s) => s.name)).toEqual(["qa-skill"]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.clause).toBe("C1");
      expect(result.errors[0]!.scope).toBe("managed");
      expect(result.errors[0]!.message).toContain("SKILL.md");
      expect(manager.get("no-skill-here")).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });

  test("ámbito ausente no es error: solo descubre lo que existe", () => {
    const fx = makeFixture();
    try {
      writeSkill(fx.projectDir, "qa-skill", QA_SKILL);
      const manager = new SkillManager();
      const result = manager.discover({
        globalDir: path.join(fx.root, "no-existe-global"),
        projectDir: fx.projectDir,
      });
      expect(result.skills.map((s) => s.name)).toEqual(["qa-skill"]);
      expect(result.errors).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  test("el registro expone id, origen, ruta, alcance, versión, activación y compatibilidad", () => {
    const fx = makeFixture();
    try {
      writeSkill(fx.managedDir, "qa-skill", QA_SKILL);
      const manager = new SkillManager();
      manager.discover({ managedDir: fx.managedDir });
      const qa = manager.get("qa-skill")!;
      const snapshot = JSON.parse(JSON.stringify(qa)) as Record<string, unknown>;
      for (const key of ["id", "name", "description", "origin", "path", "scope", "version", "enabled", "compatibility", "errors"]) {
        expect(snapshot, `falta campo ${key}`).toHaveProperty(key);
      }
      expect(readFileSync(qa.path + "/SKILL.md", "utf8")).toContain("qa-skill");
    } finally {
      fx.cleanup();
    }
  });
});
