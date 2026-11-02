/**
 * Todo 21 — Instalación, importación, desinstalación e inspección de Skills.
 *
 * CONVERGENCIA R1 (directriz del coordinador, obligatoria): NO se definen tipos
 * paralelos. `SkillRecord` y `SkillScope` se reutilizan del Todo 20
 * (`./skill-manager.ts`, commit 4edbdab); este módulo solo añade
 * `InstallProvenance` + `InstalledSkill extends SkillRecord`. La validación
 * C1..C8 también se reutiliza (`validateSkillDir` del Todo 20, que replica la
 * fuente fijada en el Todo 18); aquí solo se traduce su error a `OctusError`.
 *
 * Decisiones de convergencia (documentadas):
 * - `id` conserva la convención del Todo 20 (`id == name`, C4). La versión va en
 *   `version` (de `metadata.version`, Todo 18) y `nombre@versión` es
 *   presentación vía `installedId()` (p. ej. `qa-skill@1.0.0`).
 * - El ámbito `octus` del borrador inicial de este Todo equivale a `managed`
 *   ("gestionado por Octus") del Todo 20: NO se crea un cuarto ámbito, se usa
 *   `SkillScope` tal cual (`global | project | managed`).
 * - `origin: SkillScope` (Todo 20) = ámbito ganador/instalado; la procedencia
 *   explícita de la fuente (carpeta, zip o git con repo+ref, C-08) vive en
 *   `provenance`, siempre visible en `list()`/`inspect()`.
 *
 * Contrato: C-07 (registro) y C-08 (instalación/importación/administración) de
 * `.omo/design/octus-ux-skills-mcp/task-5-contracts.md` §1. Canales IPC
 * (`skills.install`, `skills.uninstall`, `skills.inspect`) y persistencia en
 * tablas `skills`/`skill_states` quedan para los Todos 20/22.
 *
 * PROHIBICIONES (se cumplen por construcción):
 * - Nunca se ejecuta nada dentro de un skill (sin `spawn`, sin `import` de su
 *   código, sin `eval`): solo lectura/escritura de archivos de datos.
 * - Nunca se descarga nada de red: `installFromGit` exige una copia ya
 *   obtenida por el operador (`sourceDir`, autorización explícita fuera de
 *   este módulo) y solo registra la procedencia (repo + ref).
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { OctusError } from "../errors.js";
import {
  validateSkillDir as validateDiscovered,
  type SkillRecord,
  type SkillScope,
} from "./skill-manager.js";
import { createZip, readZipEntries } from "./zip-util.js";

export type { SkillRecord, SkillScope };
export { createZip };

export const SKILL_FILE = "SKILL.md";

/** Procedencia explícita de la fuente (C-08: siempre visible). */
export type InstallProvenance =
  | { kind: "folder"; sourcePath: string }
  | { kind: "zip"; sourcePath: string }
  | { kind: "git"; repoUrl: string; ref: string };

/**
 * Skill instalada: el `SkillRecord` del Todo 20 más procedencia explícita.
 * `origin`/`scope` = ámbito donde se instaló; `path` = directorio instalado;
 * `version` siempre presente (el instalador la exige); `enabled` nace `false`
 * (`installed` frente a `enabled` siempre distintos, C-08; activar = Todo 22).
 */
export interface InstalledSkill extends SkillRecord {
  version: string;
  provenance: InstallProvenance;
}

/** Presentación `nombre@versión` (p. ej. `qa-skill@1.0.0`); `id` sigue siendo `name`. */
export function installedId(skill: InstalledSkill): string {
  return `${skill.name}@${skill.version}`;
}

function invalidSkill(message: string, details?: Record<string, unknown>): OctusError {
  return new OctusError("invalid_definition", message, { details: { area: "skills", ...details } });
}

/** Valida con el Todo 20 y traduce el error (ya cita la cláusula C1..C8). */
function validatedOrThrow(skillDir: string): SkillRecord {
  const validated = validateDiscovered(skillDir);
  if (!validated.record) throw invalidSkill(validated.error!);
  return validated.record as SkillRecord;
}

/** Normaliza un nombre interno de zip y rechaza traversal/absolutos. null = maliciosa. */
function safeZipName(raw: string): string | null {
  const unified = raw.replace(/\\/g, "/");
  if (unified.length === 0) return null;
  const withoutDirSuffix = unified.endsWith("/") ? unified.slice(0, -1) : unified;
  if (withoutDirSuffix.length === 0) return null;
  if (withoutDirSuffix.startsWith("/") || /^[A-Za-z]:\//.test(withoutDirSuffix)) return null;
  for (const part of withoutDirSuffix.split("/")) {
    if (part === ".." || part === "") return null;
  }
  return unified;
}

/** Copia recursiva solo de datos: rechaza enlaces simbólicos (podrían escapar). */
function copySkillTree(src: string, dest: string): void {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) {
    throw invalidSkill(`C1: enlace simbólico no permitido en skill: ${src}`);
  }
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      copySkillTree(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  if (st.isFile()) {
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest);
    return;
  }
  throw invalidSkill(`C1: entrada no regular no permitida en skill: ${src}`);
}

export interface InstallOptions {
  scope?: SkillScope;
}

/**
 * Instalador de Skills (Todo 21) sobre los tipos del Todo 20.
 * Raíz `rootDir`: directorio donde se materializan las skills instaladas.
 */
export class SkillInstaller {
  private readonly rootDir: string;
  private readonly records = new Map<string, InstalledSkill>();

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    mkdirSync(this.rootDir, { recursive: true });
  }

  list(): InstalledSkill[] {
    return [...this.records.values()];
  }

  /** Inspección sin ejecutar nada: registro + frontal + árbol relativo. */
  inspect(name: string): InstalledSkill & { frontmatter: Record<string, unknown>; files: string[] } {
    const record = this.records.get(name);
    if (!record) throw new OctusError("not_found", `skill no instalada: ${name}`);
    const text = readFileSync(path.join(record.path, SKILL_FILE), "utf8");
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const parsedFm = m ? (parseYaml(m[1]!) as Record<string, unknown>) : {};
    const frontmatter: Record<string, unknown> = parsedFm ?? {};
    const files: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        const relPath = rel.length > 0 ? `${rel}/${entry}` : entry;
        const st = lstatSync(full);
        if (st.isDirectory()) walk(full, relPath);
        else files.push(relPath);
      }
    };
    walk(record.path, "");
    files.sort();
    return { ...record, frontmatter, files };
  }

  /** Importa una carpeta local: valida, copia y registra con procedencia visible. */
  installFromFolder(sourceDir: string, options?: InstallOptions): InstalledSkill {
    const abs = path.resolve(sourceDir);
    const validated = validatedOrThrow(abs);
    return this.register(validated, { kind: "folder", sourcePath: abs }, options?.scope ?? "project", (dest) => {
      copySkillTree(abs, dest);
    });
  }

  /**
   * Importa un zip compatible: valida TODAS las entradas antes de escribir nada;
   * cualquier ruta fuera de la skill (`..`, absoluta, unidad) rechaza el zip
   * completo sin crear ni un archivo. El zip debe contener exactamente un
   * directorio superior `<name>/` con `SKILL.md`.
   */
  async installFromZip(zipPath: string, options?: InstallOptions): Promise<InstalledSkill> {
    const abs = path.resolve(zipPath);
    if (!existsSync(abs)) throw new OctusError("not_found", `zip inexistente: ${zipPath}`);
    const entries = await readZipEntries(new Uint8Array(readFileSync(abs)));
    // Fase 1 — validación pura, sin escribir nada.
    const safe = entries.map((e) => {
      const clean = safeZipName(e.name);
      if (clean === null) {
        throw new OctusError("invalid_definition", `zip rechazado: ruta fuera de la skill: ${JSON.stringify(e.name)}`, {
          details: { area: "skills", reason: "path_traversal" },
        });
      }
      return { entry: e, clean };
    });
    const tops = new Set<string>();
    for (const s of safe) {
      const base = s.clean.endsWith("/") ? s.clean.slice(0, -1) : s.clean;
      tops.add(base.includes("/") ? base.slice(0, base.indexOf("/")) : base);
    }
    if (tops.size !== 1) {
      throw invalidSkill(`zip rechazado: debe contener un único directorio de skill, hay ${tops.size}`, {
        tops: [...tops],
      });
    }
    const top = [...tops][0]!;
    const skillFile = safe.find((s) => s.clean === `${top}/${SKILL_FILE}`);
    if (!skillFile) {
      throw invalidSkill(`zip rechazado: falta ${top}/${SKILL_FILE}`);
    }
    // Fase 2 — materialización en staging temporal dentro de la raíz.
    const staging = path.join(this.rootDir, `.staging-${top}-${Date.now()}`);
    const cleanupStaging = () => rmSync(staging, { recursive: true, force: true });
    try {
      for (const s of safe) {
        if (s.entry.isDirectory) continue;
        const dest = path.join(staging, s.clean);
        // Cinturón y tirantes: el destino debe quedar bajo staging.
        const rel = path.relative(staging, dest);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          throw new OctusError("invalid_definition", `zip rechazado: escape de ruta: ${JSON.stringify(s.clean)}`, {
            details: { area: "skills", reason: "path_traversal" },
          });
        }
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, s.entry.data);
      }
      const validated = validatedOrThrow(path.join(staging, top));
      if (validated.name !== top) throw invalidSkill(`C4: \`name\`=${JSON.stringify(validated.name)} != directorio ${JSON.stringify(top)}`);
      return this.register(validated, { kind: "zip", sourcePath: abs }, options?.scope ?? "project", (dest) => {
        copySkillTree(path.join(staging, top), dest);
      });
    } finally {
      cleanupStaging();
    }
  }

  /**
   * Instala desde git con fuente explícita. NO descarga nada: `sourceDir` es la
   * copia ya obtenida por el operador con autorización explícita (fuera de este
   * módulo); aquí solo se valida, se copia y se registra la procedencia
   * (repo + ref). Sin `sourceDir` se rechaza sin tocar red ni disco destino.
   */
  installFromGit(repoUrl: string, ref: string, options?: InstallOptions & { sourceDir?: string }): InstalledSkill {
    if (!/^(https:\/\/|git@|file:\/\/|ssh:\/\/)/.test(repoUrl)) {
      throw invalidSkill(`origen git rechazado (URL no explícita): ${JSON.stringify(repoUrl)}`);
    }
    if (ref.trim().length === 0) {
      throw invalidSkill("origen git rechazado: ref vacía (fijar rama, etiqueta o SHA)");
    }
    if (!options?.sourceDir) {
      throw new OctusError(
        "invalid_state",
        "instalación git sin descarga: aporte sourceDir con la copia obtenida por el operador (autorización explícita); este módulo nunca clona por red",
        { details: { area: "skills", repoUrl, ref } },
      );
    }
    const abs = path.resolve(options.sourceDir);
    const validated = validatedOrThrow(abs);
    return this.register(validated, { kind: "git", repoUrl, ref }, options?.scope ?? "project", (dest) => {
      copySkillTree(abs, dest);
    });
  }

  /** Desinstala: elimina el directorio y el registro. Limpio = sin restos. */
  uninstall(name: string): void {
    const record = this.records.get(name);
    if (!record) throw new OctusError("not_found", `skill no instalada: ${name}`);
    rmSync(record.path, { recursive: true, force: true });
    this.records.delete(name);
  }

  private register(
    validated: SkillRecord,
    provenance: InstallProvenance,
    scope: SkillScope,
    materialize: (dest: string) => void,
  ): InstalledSkill {
    if (this.records.has(validated.name)) {
      throw new OctusError("already_exists", `skill duplicada: ${validated.name} (ya instalada, desinstale primero)`, {
        details: { area: "skills", name: validated.name },
      });
    }
    const dest = path.join(this.rootDir, validated.name);
    if (existsSync(dest)) {
      // Resto huérfano de una instalación previa: no se pisa, se rechaza.
      throw new OctusError("already_exists", `destino ocupado por resto previo: ${dest} (limpie antes de instalar)`, {
        details: { area: "skills", name: validated.name },
      });
    }
    // La validación ya pasó sobre el origen; si materializar falla, no se registra.
    materialize(dest);
    try {
      // Revalida la copia instalada (integridad post-copia, Todo 20 como fuente).
      validatedOrThrow(dest);
    } catch (error) {
      rmSync(dest, { recursive: true, force: true });
      throw error;
    }
    const record: InstalledSkill = {
      id: validated.name,
      name: validated.name,
      description: validated.description,
      origin: scope,
      path: dest,
      scope,
      version: validated.version ?? "0.0.0",
      enabled: false,
      ...(validated.compatibility !== undefined ? { compatibility: validated.compatibility } : {}),
      ...(validated.allowedTools !== undefined ? { allowedTools: validated.allowedTools } : {}),
      errors: [],
      seenIn: [{ scope, path: dest }],
      provenance,
    };
    this.records.set(validated.name, record);
    return record;
  }
}
