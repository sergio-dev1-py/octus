/**
 * @octus/core — SkillActivationStore: activación, administración, alcances y
 * persistencia de Skills (Todo 22).
 *
 * Qué hace:
 * - Habilitar / deshabilitar skills POR PROYECTO (aislamiento: el estado vive
 *   bajo una clave kv por proyecto; lo habilitado en A no afecta a B).
 * - Cambiar alcance (`global` | `project` | `managed`, tipos del Todo 20).
 * - Detectar actualizaciones (`detectUpdates`: versión instalada frente a
 *   versión disponible, función pura sin E/S).
 * - Revisar procedencia (`adminView`: une el registro instalado del Todo 21 —
 *   con su `provenance` siempre visible — y el estado de activación; la vista
 *   expone `installed` frente a `enabled` como campos SIEMPRE DISTINTOS).
 * - Persistencia con recuperación: el estado se guarda en la tabla `kv`
 *   (precedente del Todo 6, sin migración de esquema) bajo
 *   `skills.activation.v1.<projectId>`; reabrir la DB restaura el estado
 *   (reinicio simulado). Un valor corrupto degrada a vacío sin romper.
 * - Puerta para runs (`selectForRun`): solo las skills habilitadas en el
 *   proyecto llegan al contexto de sus runs; una deshabilitada NUNCA pasa
 *   (lo consume el Todo 23).
 *
 * PROHIBICIONES (se cumplen por construcción):
 * - Activar NUNCA otorga permisos de herramientas: este módulo no importa
 *   el gestor de permisos ni la puerta de herramientas, y no escribe ninguna
 *   regla de permiso (ni crea, ni modifica, ni borra; test
 *   `skills-activation.test.ts`: contador de reglas a 0 antes y después +
 *   grep estático de no-importación).
 * - No ejecuta nada dentro de una skill; no toca red; no inventa formato
 *   (reutiliza `SkillScope` del Todo 20 por tipo; `provenance` del Todo 21
 *   por forma estructural, sin importarlo en runtime).
 * - No toca archivos de los Todos 18–21: módulo NUEVO + test NUEVO + una
 *   línea de export en `index.ts` (extensión compatible documentada).
 */
import { OctusError } from "../errors.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import type { SkillScope } from "./skill-manager.js";

/** Prefijo de las claves kv por proyecto (v1: formato del payload). */
export const SKILL_ACTIVATION_KV_PREFIX = "skills.activation.v1.";

const VALID_SCOPES: readonly SkillScope[] = ["global", "project", "managed"];

/** Estado persistido de una skill en un proyecto. */
export interface SkillActivationEntry {
  /** Habilitada en este proyecto (administra el Todo 22; nace `false`). */
  enabled: boolean;
  /** Alcance aplicable en este proyecto. */
  scope: SkillScope;
  /** Versión conocida al habilitar/instalar (base para detectar updates). */
  version: string;
  updatedAt: number;
}

/** Forma mínima que el store necesita de una skill instalada (Todo 21). */
export interface ActivatableSkill {
  name: string;
  version?: string;
}

/** Fila de administración: instalado ≠ habilitado, siempre distintos. */
export interface SkillAdminRow {
  name: string;
  /** `true` si la skill está instalada (registro del Todo 21 presente). */
  installed: boolean;
  /** `true` si está habilitada en este proyecto (estado del Todo 22). */
  enabled: boolean;
  scope: SkillScope;
  /** Versión instalada (si hay registro) frente a conocida (estado). */
  installedVersion?: string;
  knownVersion?: string;
  /** Procedencia del instalador (carpeta/zip/git), copiada tal cual. */
  provenance: unknown;
  /** `true` si hay registro instalado pero ningún estado (huérfana de estado). */
  orphanState: boolean;
}

/** Aviso de actualización o novedad. */
export interface SkillUpdateNotice {
  name: string;
  kind: "update" | "new";
  /** Versión instalada/de referencia (`undefined` si es novedad). */
  from?: string;
  /** Versión disponible. */
  to: string;
}

interface StoredPayload {
  version: 1;
  skills: Record<string, SkillActivationEntry>;
}

function kvKey(projectId: string): string {
  return `${SKILL_ACTIVATION_KV_PREFIX}${projectId}`;
}

function checkProjectId(projectId: string): void {
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new OctusError("invalid_definition", "projectId ausente o vacío", { details: { area: "skills" } });
  }
  if (projectId.includes("..") || projectId.includes("/") || projectId.includes("\\")) {
    throw new OctusError("invalid_definition", `projectId con ruta no permitido: ${JSON.stringify(projectId)}`, {
      details: { area: "skills" },
    });
  }
}

function checkName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new OctusError("invalid_definition", "skill name ausente o vacío", { details: { area: "skills" } });
  }
}

function checkScope(scope: SkillScope): void {
  if (!VALID_SCOPES.includes(scope)) {
    throw new OctusError("invalid_definition", `alcance desconocido: ${JSON.stringify(scope)} (global|project|managed)`, {
      details: { area: "skills" },
    });
  }
}

/**
 * Compara versiones instaladas frente a disponibles (pura, sin E/S):
 * - instalada + disponible con distinta versión → `{ kind: "update", from, to }`;
 * - disponible sin instalada → `{ kind: "new", to }`;
 * - igual versión → sin aviso.
 */
export function detectUpdates(
  installed: Array<{ name: string; version?: string }>,
  available: Array<{ name: string; version?: string }>,
): SkillUpdateNotice[] {
  const known = new Map(installed.map((s) => [s.name, s.version ?? "0.0.0"]));
  const notices: SkillUpdateNotice[] = [];
  for (const cand of available) {
    const to = cand.version ?? "0.0.0";
    const from = known.get(cand.name);
    if (from === undefined) notices.push({ name: cand.name, kind: "new", to });
    else if (from !== to) notices.push({ name: cand.name, kind: "update", from, to });
  }
  return notices.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export class SkillActivationStore {
  private readonly cache = new Map<string, Map<string, SkillActivationEntry>>();

  constructor(private readonly db: PersistenceService) {}

  /** Clave kv exacta (auditable; el aislamiento por proyecto vive aquí). */
  static keyFor(projectId: string): string {
    checkProjectId(projectId);
    return kvKey(projectId);
  }

  private async load(projectId: string): Promise<Map<string, SkillActivationEntry>> {
    checkProjectId(projectId);
    const cached = this.cache.get(projectId);
    if (cached) return cached;
    const row = await this.db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", [kvKey(projectId)]);
    const entries = new Map<string, SkillActivationEntry>();
    if (row) {
      try {
        const parsed = JSON.parse(row.value) as StoredPayload;
        if (parsed && parsed.version === 1 && typeof parsed.skills === "object" && parsed.skills !== null) {
          for (const [name, e] of Object.entries(parsed.skills)) {
            if (
              typeof name === "string" &&
              name.length > 0 &&
              e &&
              typeof e.enabled === "boolean" &&
              typeof e.scope === "string" &&
              VALID_SCOPES.includes(e.scope as SkillScope) &&
              typeof e.version === "string" &&
              typeof e.updatedAt === "number"
            ) {
              entries.set(name, { enabled: e.enabled, scope: e.scope as SkillScope, version: e.version, updatedAt: e.updatedAt });
            }
            // Entradas malformadas se descartan (recuperación ante corrupción parcial).
          }
        }
        // Payload con forma desconocida → degradar a vacío (recuperación total).
      } catch {
        // JSON corrupto → degradar a vacío sin romper (precedente Todo 6).
      }
    }
    this.cache.set(projectId, entries);
    return entries;
  }

  private async save(projectId: string, entries: Map<string, SkillActivationEntry>): Promise<void> {
    const payload: StoredPayload = { version: 1, skills: Object.fromEntries(entries) };
    await this.db.exec(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [kvKey(projectId), JSON.stringify(payload), Date.now()],
    );
    this.cache.set(projectId, entries);
  }

  /** Descarta la caché (el siguiente acceso relee SQLite; base del reinicio simulado). */
  reload(projectId?: string): void {
    if (projectId === undefined) this.cache.clear();
    else this.cache.delete(projectId);
  }

  /** Habilita una skill en un proyecto. NO otorga permisos de herramientas. */
  async enable(projectId: string, skill: ActivatableSkill, scope?: SkillScope): Promise<SkillActivationEntry> {
    checkName(skill.name);
    if (scope !== undefined) checkScope(scope);
    const entries = await this.load(projectId);
    const prev = entries.get(skill.name);
    const entry: SkillActivationEntry = {
      enabled: true,
      scope: scope ?? prev?.scope ?? "project",
      version: skill.version ?? prev?.version ?? "0.0.0",
      updatedAt: Date.now(),
    };
    entries.set(skill.name, entry);
    await this.save(projectId, entries);
    return entry;
  }

  /** Deshabilita una skill en un proyecto (idempotente; nunca falla si no hay estado). */
  async disable(projectId: string, name: string): Promise<SkillActivationEntry> {
    checkName(name);
    const entries = await this.load(projectId);
    const prev = entries.get(name);
    const entry: SkillActivationEntry = {
      enabled: false,
      scope: prev?.scope ?? "project",
      version: prev?.version ?? "0.0.0",
      updatedAt: Date.now(),
    };
    entries.set(name, entry);
    await this.save(projectId, entries);
    return entry;
  }

  /** Cambia el alcance de una skill en un proyecto (persiste aunque esté deshabilitada). */
  async setScope(projectId: string, name: string, scope: SkillScope): Promise<SkillActivationEntry> {
    checkName(name);
    checkScope(scope);
    const entries = await this.load(projectId);
    const prev = entries.get(name);
    const entry: SkillActivationEntry = {
      enabled: prev?.enabled ?? false,
      scope,
      version: prev?.version ?? "0.0.0",
      updatedAt: Date.now(),
    };
    entries.set(name, entry);
    await this.save(projectId, entries);
    return entry;
  }

  async get(projectId: string, name: string): Promise<SkillActivationEntry | undefined> {
    const entries = await this.load(projectId);
    return entries.get(name);
  }

  async list(projectId: string): Promise<Array<{ name: string } & SkillActivationEntry>> {
    const entries = await this.load(projectId);
    return [...entries.entries()]
      .map(([name, e]) => ({ name, ...e }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async isEnabled(projectId: string, name: string): Promise<boolean> {
    const entries = await this.load(projectId);
    return entries.get(name)?.enabled === true;
  }

  /**
   * Puerta de runs (la consume el Todo 23): de las candidatas instaladas/
   * descubiertas, SOLO las habilitadas en este proyecto pasan al contexto del
   * run. Una skill deshabilitada (o sin estado) NUNCA llega al contexto.
   */
  async selectForRun<T extends { name: string }>(projectId: string, candidates: T[]): Promise<T[]> {
    const entries = await this.load(projectId);
    return candidates.filter((c) => entries.get(c.name)?.enabled === true);
  }

  /**
   * Vista de administración: une registros instalados (Todo 21, con
   * `provenance` siempre visible) y estado de activación (Todo 22).
   * `installed` y `enabled` son campos SIEMPRE DISTINTOS: instalar no habilita
   * y habilitar no instala. Los estados sin registro instalado aparecen como
   * `installed: false` (huérfanos de instalación, p. ej. tras desinstalar).
   */
  async adminView(
    projectId: string,
    installed: Array<{ name: string; version?: string; scope?: SkillScope; provenance?: unknown }>,
  ): Promise<SkillAdminRow[]> {
    const entries = await this.load(projectId);
    const rows: SkillAdminRow[] = [];
    const seen = new Set<string>();
    for (const rec of installed) {
      checkName(rec.name);
      seen.add(rec.name);
      const st = entries.get(rec.name);
      rows.push({
        name: rec.name,
        installed: true,
        enabled: st?.enabled === true,
        scope: st?.scope ?? rec.scope ?? "project",
        ...(rec.version !== undefined ? { installedVersion: rec.version } : {}),
        ...(st !== undefined ? { knownVersion: st.version } : {}),
        provenance: rec.provenance ?? null,
        orphanState: false,
      });
    }
    for (const [name, st] of entries) {
      if (seen.has(name)) continue;
      rows.push({
        name,
        installed: false,
        enabled: st.enabled,
        scope: st.scope,
        knownVersion: st.version,
        provenance: null,
        orphanState: true,
      });
    }
    return rows.sort((a, b) => (a.name < b.name ? -1 : 1));
  }
}
