/**
 * Todo 21 — Instalación, importación, desinstalación e inspección.
 * Datos fijos: skill `qa-skill@1.0.0` (misma que Todos 18/20).
 * Sin red, sin ejecutar nada del skill, fixtures efímeros en tmp con limpieza.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OctusError } from "../src/errors.js";
import { createZip, installedId, SkillInstaller } from "../src/skills/skill-installer.js";

const SKILL_MD = `---
name: qa-skill
description: Skill de QA para pruebas deterministas de instalacion (Todo 21).
metadata:
  version: 1.0.0
  author: octus-qa
---
# qa-skill

Cuerpo de la skill de QA. Nada ejecutable.
`;

function makeTmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "octus-qa-21-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Carpeta skill válida `qa-skill` bajo `parent`. */
function writeSkillFolder(parent: string, name = "qa-skill", skillMd = SKILL_MD): string {
  const dir = path.join(parent, name);
  mkdirSync(path.join(dir, "helpers"), { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), skillMd);
  writeFileSync(path.join(dir, "helpers", "notes.md"), "# notas\n");
  return dir;
}

function errorOf(promise: Promise<unknown>): Promise<OctusError> {
  return promise.then(
    () => {
      throw new Error("se esperaba rechazo y resolvió");
    },
    (error) => {
      if (!(error instanceof OctusError)) throw new Error(`no es OctusError: ${String(error)}`);
      return error;
    },
  );
}

describe("skills install/import/uninstall/inspect (Todo 21)", () => {
  test("instala qa-skill@1.0.0 desde carpeta con procedencia visible", () => {
    const t = makeTmp();
    try {
      const src = writeSkillFolder(path.join(t.dir, "src"));
      const installer = new SkillInstaller(path.join(t.dir, "installed"));
      const record = installer.installFromFolder(src);
      expect(record.id).toBe("qa-skill"); // id == name (convención Todo 20)
      expect(installedId(record)).toBe("qa-skill@1.0.0");
      expect(record.version).toBe("1.0.0");
      expect(record.name).toBe("qa-skill");
      expect(record.provenance).toEqual({ kind: "folder", sourcePath: src });
      expect(record.enabled).toBe(false); // installed != enabled (C-08)
      expect(existsSync(path.join(record.path, "SKILL.md"))).toBe(true);
      expect(installer.list()).toHaveLength(1);
      const seen = installer.inspect("qa-skill");
      expect(seen.provenance.kind).toBe("folder");
      expect(seen.files).toContain("SKILL.md");
    } finally {
      t.cleanup();
    }
  });

  test("instala qa-skill@1.0.0 desde zip compatible", async () => {
    const t = makeTmp();
    try {
      const zipBytes = createZip([
        { name: "qa-skill/SKILL.md", data: SKILL_MD },
        { name: "qa-skill/helpers/notes.md", data: "# notas\n" },
      ]);
      const zipPath = path.join(t.dir, "qa-skill.zip");
      writeFileSync(zipPath, zipBytes);
      const installer = new SkillInstaller(path.join(t.dir, "installed"));
      const record = await installer.installFromZip(zipPath);
      expect(installedId(record)).toBe("qa-skill@1.0.0");
      expect(record.provenance).toEqual({ kind: "zip", sourcePath: zipPath });
      expect(readFileSync(path.join(record.path, "SKILL.md"), "utf8")).toBe(SKILL_MD);
    } finally {
      t.cleanup();
    }
  });

  test("rechaza duplicado sin tocar la instalación vigente", async () => {
    const t = makeTmp();
    try {
      const src = writeSkillFolder(path.join(t.dir, "src"));
      const installer = new SkillInstaller(path.join(t.dir, "installed"));
      installer.installFromFolder(src);
      const before = readFileSync(path.join(t.dir, "installed", "qa-skill", "SKILL.md"), "utf8");
      const err = await errorOf(
        (async () => installer.installFromFolder(src))(),
      );
      expect(err.code).toBe("already_exists");
      expect(String(err.message)).toMatch(/duplicada/);
      // La vigente queda intacta y listada una sola vez.
      expect(installer.list()).toHaveLength(1);
      expect(readFileSync(path.join(t.dir, "installed", "qa-skill", "SKILL.md"), "utf8")).toBe(before);
    } finally {
      t.cleanup();
    }
  });

  test("desinstala limpio con procedencia visible antes y después", async () => {
    const t = makeTmp();
    try {
      const src = writeSkillFolder(path.join(t.dir, "src"));
      const installer = new SkillInstaller(path.join(t.dir, "installed"));
      const record = installer.installFromFolder(src);
      const seen = installer.inspect("qa-skill");
      expect(seen.provenance).toEqual({ kind: "folder", sourcePath: src }); // procedencia visible
      installer.uninstall("qa-skill");
      expect(installer.list()).toHaveLength(0);
      expect(existsSync(record.path)).toBe(false); // sin restos
      expect(existsSync(path.join(t.dir, "installed", "qa-skill"))).toBe(false);
      const err = await errorOf((async () => installer.inspect("qa-skill"))());
      expect(err.code).toBe("not_found");
    } finally {
      t.cleanup();
    }
  });

  test("zip malicioso con path traversal se rechaza sin escribir nada", async () => {
    const t = makeTmp();
    try {
      const zipBytes = createZip([
        { name: "qa-skill/SKILL.md", data: SKILL_MD },
        { name: "../evil.txt", data: "payload" },
        { name: "qa-skill/../../evil2.txt", data: "payload" },
        { name: "/abs.txt", data: "payload" },
      ]);
      const zipPath = path.join(t.dir, "evil.zip");
      writeFileSync(zipPath, zipBytes);
      const root = path.join(t.dir, "installed");
      const installer = new SkillInstaller(root);
      const err = await errorOf(installer.installFromZip(zipPath));
      expect(err.code).toBe("invalid_definition");
      expect(String(err.message)).toMatch(/fuera de la skill/);
      // Nada escrito: ni registro, ni directorio, ni staging, ni escapes.
      expect(installer.list()).toHaveLength(0);
      expect(readdirSync(root)).toHaveLength(0);
      expect(existsSync(path.join(t.dir, "evil.txt"))).toBe(false);
      expect(existsSync(path.join(t.dir, "evil2.txt"))).toBe(false);
      expect(existsSync(path.join(t.dir, "abs.txt"))).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("zip sin SKILL.md y frontal inválido se rechazan (malformed input)", async () => {
    const t = makeTmp();
    try {
      const installer = new SkillInstaller(path.join(t.dir, "installed"));
      const noSkill = path.join(t.dir, "noskill.zip");
      writeFileSync(noSkill, createZip([{ name: "qa-skill/notes.md", data: "# sin frontal\n" }]));
      expect((await errorOf(installer.installFromZip(noSkill))).code).toBe("invalid_definition");

      const mismatch = path.join(t.dir, "mismatch.zip");
      writeFileSync(
        mismatch,
        createZip([{ name: "other/SKILL.md", data: SKILL_MD.replace("name: qa-skill", "name: qa-skill") }]),
      );
      // name `qa-skill` != directorio `other` → C4.
      const err = await errorOf(installer.installFromZip(mismatch));
      expect(err.code).toBe("invalid_definition");
      expect(String(err.message)).toMatch(/C4/);
      expect(installer.list()).toHaveLength(0);
      expect(readdirSync(path.join(t.dir, "installed"))).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  test("carpeta con frontal inválido se rechaza con su cláusula (C3/C4/C5)", () => {
    const t = makeTmp();
    try {
      const installer = new SkillInstaller(path.join(t.dir, "installed"));
      const badName = writeSkillFolder(path.join(t.dir, "bad"), "qa-skill", SKILL_MD.replace("name: qa-skill", "name: Bad_Name"));
      expect(() => installer.installFromFolder(badName)).toThrow(/C3/);
      const mismatch = writeSkillFolder(path.join(t.dir, "mm"), "mismatch", SKILL_MD.replace("name: qa-skill", "name: other-name"));
      expect(() => installer.installFromFolder(mismatch)).toThrow(/C4/);
      const emptyDesc = writeSkillFolder(
        path.join(t.dir, "ed"),
        "qa-skill",
        SKILL_MD.replace("description: Skill de QA para pruebas deterministas de instalacion (Todo 21).", "description: \"\""),
      );
      expect(() => installer.installFromFolder(emptyDesc)).toThrow(/C5/);
      expect(installer.list()).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  test("instala desde git con fuente explícita y procedencia visible; sin copia exige autorización", () => {
    const t = makeTmp();
    try {
      // La copia ya fue obtenida por el operador con autorización explícita
      // (fuera de este módulo, que nunca clona por red).
      const fetched = writeSkillFolder(path.join(t.dir, "fetched"));
      const installer = new SkillInstaller(path.join(t.dir, "installed"));
      const repoUrl = "https://example.com/org/qa-skill.git";
      const record = installer.installFromGit(repoUrl, "v1.0.0", { sourceDir: fetched });
      expect(installedId(record)).toBe("qa-skill@1.0.0");
      expect(record.provenance).toEqual({ kind: "git", repoUrl, ref: "v1.0.0" });
      expect(installer.inspect("qa-skill").provenance).toEqual({ kind: "git", repoUrl, ref: "v1.0.0" });

      const installer2 = new SkillInstaller(path.join(t.dir, "installed2"));
      let stateError: OctusError | null = null;
      try {
        installer2.installFromGit(repoUrl, "v1.0.0");
      } catch (error) {
        stateError = error as OctusError;
      }
      expect(stateError).not.toBeNull();
      expect(stateError!.code).toBe("invalid_state");
      expect(String(stateError!.message)).toMatch(/autorizaci/);
      expect(installer2.list()).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });
});
