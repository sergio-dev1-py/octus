/**
 * Octus desktop main — SkillsService (Todo 24, montaje aditivo documentado).
 *
 * Une los servicios de la ola 12 SIN tocar sus archivos (Todos 18–23 intactos):
 * - Descubrimiento: `SkillManager` (Todo 20) en tres ámbitos:
 *   global = `<dataDir>/skills-global` (usuario), project = `<root>/.octus/skills`
 *   (proyecto), managed = `<dataDir>/skills-managed` (gestionado por Octus).
 * - Instalación: `SkillInstaller` (Todo 21) con raíz `<dataDir>/skills-installed`.
 * - Activación: `SkillActivationStore` (Todo 22) sobre `core.db` (kv, por proyecto).
 * - Runtime: `SkillRuntime` (Todo 23) construido sobre EL MISMO manager y store
 *   (sin segundo store: evita cachés rancias entre habilitar y la puerta de runs).
 *
 * Decisiones (auditable aquí, no dispersas):
 * - `installed` ≠ `enabled` SIEMPRE: el catálogo los expone como campos
 *   distintos; instalar nace deshabilitado (lo garantiza el instalador).
 * - Habilitar con error de validación se BLOQUEA: `enable` revalida el
 *   `SKILL.md` en disco (`validateSkillDir` del Todo 20) y rechaza con el
 *   mensaje de la cláusula C1..C8; además consulta los errores del
 *   descubrimiento para la misma ruta.
 * - Leer un recurso (`resource`) es inspección: no exige habilitación.
 *   La puerta de runs (`selectForRun`, Todo 22/23) sigue intacta en el core.
 * - Este módulo NUNCA ejecuta nada dentro de una skill ni toca red: solo
 *   lectura/escritura de datos vía los servicios del core.
 */
import path from "node:path";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import {
  SkillActivationStore,
  SkillInstaller,
  SkillManager,
  SkillRuntime,
  validateSkillDir,
  type PersistenceService,
  type SkillRecord,
  type SkillScope,
  type InstalledSkill,
} from "@octus/core";
import type { SkillCatalogError, SkillCatalogItem, SkillDetail, SkillScopeName } from "@octus/shared";

const VALID_SCOPES: readonly SkillScope[] = ["global", "project", "managed"];

function asScope(value: unknown, fallback: SkillScope = "project"): SkillScope {
  return typeof value === "string" && (VALID_SCOPES as readonly string[]).includes(value) ? (value as SkillScope) : fallback;
}

function checkScope(value: unknown): SkillScope {
  if (typeof value !== "string" || !(VALID_SCOPES as readonly string[]).includes(value)) {
    throw new Error(`invalid scope (global|project|managed): ${JSON.stringify(value)}`);
  }
  return value as SkillScope;
}

/** Archivos relativos dentro de un directorio (recursos de la skill). */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const relPath = rel.length > 0 ? `${rel}/${entry}` : entry;
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full, relPath);
      else if (st.isFile()) out.push(relPath);
    }
  };
  walk(root, "");
  return out.sort();
}

/** Divide SKILL.md en frontal (texto) y cuerpo, sin interpretar el YAML. */
function splitSkillFile(text: string): { frontmatterText: string; body: string } {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { frontmatterText: "", body: text };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---" || lines[i]!.trim() === "...") {
      return { frontmatterText: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n").trim() };
    }
  }
  return { frontmatterText: "", body: text };
}

export class MainSkillsService {
  private readonly manager: SkillManager;
  private readonly installer: SkillInstaller;
  private readonly activation: SkillActivationStore;
  private readonly runtime: SkillRuntime;
  private readonly globalDir: string;
  private readonly managedDir: string;
  private readonly installRoot: string;

  constructor(db: PersistenceService, dataDir: string) {
    this.globalDir = path.join(dataDir, "skills-global");
    this.managedDir = path.join(dataDir, "skills-managed");
    this.installRoot = path.join(dataDir, "skills-installed");
    this.manager = new SkillManager({ globalDir: this.globalDir, managedDir: this.managedDir });
    this.installer = new SkillInstaller(this.installRoot);
    this.activation = new SkillActivationStore(db);
    // MISMO manager y store que expone este servicio (puerta única, Todo 23).
    this.runtime = new SkillRuntime(db, this.manager, this.activation);
  }

  private projectDir(projectRoot?: string): string | undefined {
    return projectRoot ? path.join(projectRoot, ".octus", "skills") : undefined;
  }

  private toItem(record: SkillRecord, installed: InstalledSkill | undefined, enabled: boolean): SkillCatalogItem {
    const item: SkillCatalogItem = {
      id: record.id,
      name: record.name,
      description: record.description,
      origin: record.origin as SkillScopeName,
      scope: record.scope as SkillScopeName,
      path: record.path,
      installed: installed !== undefined,
      enabled,
      errors: [...record.errors],
      seenIn: record.seenIn.map((s) => ({ scope: s.scope as SkillScopeName, path: s.path })),
      provenance: installed ? installed.provenance : null,
    };
    if (record.version !== undefined) item.version = record.version;
    if (record.compatibility !== undefined) item.compatibility = record.compatibility;
    if (record.allowedTools !== undefined) item.allowedTools = record.allowedTools;
    return item;
  }

  /** Catálogo unido: descubrimiento + instaladas, con installed/enabled distintos. */
  async catalog(projectId?: string, projectRoot?: string): Promise<{ skills: SkillCatalogItem[]; errors: SkillCatalogError[] }> {
    const { skills, errors } = this.manager.discover({ projectDir: this.projectDir(projectRoot) });
    const installedByName = new Map(this.installer.list().map((s) => [s.name, s]));
    const enabledByName = new Map<string, boolean>();
    if (projectId) {
      for (const entry of await this.activation.list(projectId)) enabledByName.set(entry.name, entry.enabled);
    }
    const items = new Map<string, SkillCatalogItem>();
    for (const record of skills) {
      const installed = installedByName.get(record.name);
      items.set(record.name, this.toItem(record, installed, enabledByName.get(record.name) === true));
    }
    for (const installed of installedByName.values()) {
      if (items.has(installed.name)) continue;
      // Instalada pero fuera de los ámbitos descubiertos: visible igual (no se pierde).
      items.set(
        installed.name,
        this.toItem(installed, installed, enabledByName.get(installed.name) === true),
      );
    }
    return {
      skills: [...items.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
      errors: errors.map((e) => ({ path: e.path, scope: e.scope as SkillScopeName, clause: e.clause, message: e.message })),
    };
  }

  /** Resuelve el registro IS (instalada gana; si no, descubierta). */
  private resolve(name: string, projectRoot?: string): { record: SkillRecord; installed: InstalledSkill | undefined } {
    const installed = this.installer.list().find((s) => s.name === name);
    if (installed) return { record: installed, installed };
    const { skills } = this.manager.discover({ projectDir: this.projectDir(projectRoot) });
    const found = skills.find((s) => s.name === name);
    if (!found) throw new Error(`skill no instalada ni descubierta: ${name}`);
    return { record: found, installed: undefined };
  }

  async inspect(name: string, projectId?: string, projectRoot?: string): Promise<SkillDetail> {
    if (!name.trim()) throw new Error("invalid payload");
    const { record, installed } = this.resolve(name, projectRoot);
    const enabled = projectId ? await this.activation.isEnabled(projectId, name) : false;
    const item = this.toItem(record, installed, enabled);
    let frontmatterText = "";
    let body = "";
    let files: string[] = [];
    if (installed) {
      const full = this.installer.inspect(name);
      frontmatterText = Object.entries(full.frontmatter)
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("\n");
      files = full.files;
      body = this.runtime.loadFullInstructions(record).replace(/^<skill[^>]*>\n/, "").replace(/\n<\/skill>$/, "");
    } else {
      const text = readFileSync(path.join(record.path, "SKILL.md"), "utf8");
      const split = splitSkillFile(text);
      frontmatterText = split.frontmatterText;
      body = split.body.length > 6000 ? `${split.body.slice(0, 6000)}\n<!-- truncado por tope de carga progresiva -->` : split.body;
      try {
        files = listFiles(record.path);
      } catch {
        files = [];
      }
    }
    // Errores de descubrimiento para esta misma ruta (origen/alcance visibles).
    const { errors } = this.manager.discover({ projectDir: this.projectDir(projectRoot) });
    for (const e of errors) {
      if (e.path === record.path && !item.errors.includes(e.message)) item.errors.push(e.message);
    }
    return { ...item, frontmatterText, body, files };
  }

  private async importResult(skill: InstalledSkill): Promise<SkillCatalogItem> {
    return this.toItem(skill, skill, false);
  }

  async importFolder(dirPath: string, scope?: SkillScopeName): Promise<SkillCatalogItem> {
    const skill = this.installer.installFromFolder(dirPath, { scope: scope === undefined ? undefined : checkScope(scope) });
    return this.importResult(skill);
  }

  async importZip(zipPath: string, scope?: SkillScopeName): Promise<SkillCatalogItem> {
    const skill = await this.installer.installFromZip(zipPath, { scope: scope === undefined ? undefined : checkScope(scope) });
    return this.importResult(skill);
  }

  async installGit(repoUrl: string, ref: string, sourceDir: string | undefined, scope?: SkillScopeName): Promise<SkillCatalogItem> {
    const skill = this.installer.installFromGit(repoUrl, ref, {
      ...(sourceDir === undefined ? {} : { sourceDir }),
      scope: scope === undefined ? undefined : checkScope(scope),
    });
    return this.importResult(skill);
  }

  uninstall(name: string): void {
    if (!name.trim()) throw new Error("invalid payload");
    this.installer.uninstall(name);
  }

  /**
   * Habilita una skill en un proyecto. BLOQUEA si el SKILL.md en disco no
   * valida (cita la cláusula C1..C8) o si el descubrimiento la reporta con
   * error: una skill con error de validación muestra el error y no se habilita.
   */
  async enable(projectId: string, name: string, scope?: SkillScopeName, projectRoot?: string): Promise<void> {
    if (!projectId.trim() || !name.trim()) throw new Error("invalid payload");
    const { record } = this.resolve(name, projectRoot);
    const revalidated = validateSkillDir(record.path);
    if (!revalidated.record) throw new Error(revalidated.error!);
    const { errors } = this.manager.discover({ projectDir: this.projectDir(projectRoot) });
    const blocking = errors.find((e) => e.path === record.path);
    if (blocking) throw new Error(blocking.message);
    await this.runtime.enable(projectId, { name: record.name, version: record.version }, scope === undefined ? undefined : checkScope(scope));
  }

  async disable(projectId: string, name: string): Promise<void> {
    if (!projectId.trim() || !name.trim()) throw new Error("invalid payload");
    await this.runtime.disable(projectId, name);
  }

  async setScope(projectId: string, name: string, scope: SkillScopeName): Promise<void> {
    if (!projectId.trim() || !name.trim()) throw new Error("invalid payload");
    await this.runtime.setScope(projectId, name, checkScope(scope));
  }

  async history(runId: string): Promise<{ skills: string[]; bypass: Array<{ skill: string; action: string; at: number }> }> {
    if (!runId.trim()) throw new Error("invalid payload");
    const [skills, bypass] = await Promise.all([this.runtime.skillsForRun(runId), this.runtime.bypassForRun(runId)]);
    return { skills, bypass };
  }

  async resource(name: string, relativePath: string): Promise<string> {
    if (!name.trim() || !relativePath.trim()) throw new Error("invalid payload");
    const { record } = this.resolve(name);
    return this.runtime.readResource(record, relativePath);
  }

  /** Alcance por defecto para formularios (el proyecto es lo habitual). */
  defaultScope(): SkillScopeName {
    return asScope("project");
  }
}
