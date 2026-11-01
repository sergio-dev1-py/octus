/**
 * @octus/core — SkillRuntime: integración de Skills con runtime y agentes (Todo 23).
 *
 * Carga progresiva en tres niveles (nunca todas completas en cada llamada):
 * 1. Metadatos: `- nombre@versión: descripción` de las habilitadas en el proyecto.
 * 2. Selección por tarea: de las habilitadas, solo la relevante (solape de
 *    tokens entre tarea y nombre+descripción; sin tarea o sin solape, ninguna).
 * 3. Instrucciones completas: cuerpo de SKILL.md (sin frontal) solo de la
 *    relevante, con tope de caracteres. Recursos bajo demanda vía `readResource`.
 *
 * Puertas que consume y respeta:
 * - `selectForRun` del Todo 22: la única vía por la que una skill llega al
 *   contexto de un run (deshabilitada o sin estado NUNCA pasa).
 * - Scopes: el aislamiento vive por proyecto (kv del Todo 22). NO se añaden
 *   capas `projectRules`/`runRules`/`taskRules` a PermissionLayers: las brechas
 *   19-A..D siguen ABIERTAS por decisión explícita (estrechar el modelo de
 *   permisos exige su propio subtodo con matriz; este Todo no relaja nada y el
 *   deny-by-default más el techo `definitionTools`/`deniedTools` siguen intactos).
 * - Registro por run: `recordRun`/`skillsForRun` en kv `skills.runs.v1.<runId>`
 *   (sin migración de esquema, precedente Todos 6/22).
 * - Evasión: `skillAllowsTool` es DESCRIPTIVO (lee `allowed-tools`); una skill
 *   NUNCA autoriza herramienta prohibida. El ToolGateway lo veta y lo audita
 *   (`noteBypass` en kv `skills.bypass.v1.<runId>` + marca `[skill-bypass-denied]`
 *   en `tool_invocations` + `skillBypassAttempt: true` en el evento).
 * - Workers: `assertSpawnAllowed` es la puerta que AgentManager exige en `spawn`
 *   (`skillNames` con alguna no habilitada → `scope_violation`).
 *
 * PROHIBICIONES (por construcción):
 * - No importa PermissionManager ni ToolGateway (grep estático en tests).
 * - No ejecuta nada dentro de una skill: solo lee SKILL.md y recursos de datos.
 * - No toca red ni archivos de los Todos 18–22 (módulo NUEVO + edición aditiva).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { OctusError } from "../errors.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { SkillActivationStore } from "./skill-activation.js";
import { SkillManager, type SkillRecord } from "./skill-manager.js";

/** Prefijos kv (sin migración, precedente Todos 6/22). */
export const SKILL_RUN_KV_PREFIX = "skills.runs.v1.";
export const SKILL_BYPASS_KV_PREFIX = "skills.bypass.v1.";

/** Topes de carga progresiva: metadatos (líneas), completas (nº y chars). */
export const SKILL_MAX_METADATA = 20;
export const SKILL_MAX_FULL = 1;
export const SKILL_MAX_FULL_CHARS = 6000;
export const SKILL_MAX_RESOURCE_CHARS = 20_000;

export interface SkillPromptInput {
  projectId: string;
  /** Texto de la tarea delegada (brief del run o del spawn). Sin texto, sin completa. */
  taskBrief?: string;
  taskId?: string;
  runId: string;
  instanceId?: string;
}

export interface SkillPromptSections {
  /** `- nombre@versión: descripción` por habilitada (puede ser ""). */
  metadata: string;
  /** `<skill name=...>cuerpo</skill>` solo de la relevante (puede ser ""). */
  full: string;
  /** Nombres usados en `full` (lo que se registra por run). */
  used: string[];
}

/** Gancho que AgentRuntime consume por instancia (coordinador y workers). */
export type SkillSectionsHook = (input: SkillPromptInput) => Promise<SkillPromptSections>;

/** Puerta que AgentManager exige en `spawn` para `skillNames`. */
export interface SkillSpawnGate {
  isAllowed(projectId: string, name: string): Promise<boolean>;
}

interface RunRecord {
  version: 1;
  skills: string[];
  at: number;
}

interface BypassRecord {
  version: 1;
  attempts: Array<{ skill: string; action: string; at: number }>;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "sobre", "para", "con", "los", "las", "una", "unos", "unas", "del", "que", "los", "por", "como", "esta", "este", "hay", "son",
]);

function tokensOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9áéíóúñü]+/i)) {
    const w = raw.trim();
    if (w.length > 2 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/** Puntuación determinista tarea↔skill: solape de tokens (nombre pesa doble). */
export function relevanceScore(taskText: string, skill: Pick<SkillRecord, "name" | "description">): number {
  const task = tokensOf(taskText);
  if (task.size === 0) return 0;
  const nameTokens = tokensOf(skill.name.replace(/-/g, " "));
  const descTokens = tokensOf(skill.description);
  let score = 0;
  for (const t of task) {
    if (nameTokens.has(t)) score += 2;
    else if (descTokens.has(t)) score += 1;
  }
  return score;
}

/** `allowed-tools` es una lista CSV descriptiva; el parseo es exacto por token. */
export function skillAllowsAction(skill: Pick<SkillRecord, "allowedTools">, action: string): boolean {
  if (!skill.allowedTools) return false;
  return skill.allowedTools
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .includes(action);
}

/** Cuerpo de SKILL.md sin el frontal `---...---` (C2 del Todo 18). */
export function stripFrontmatter(text: string): string {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---" || lines[i]!.trim() === "...") {
      return lines.slice(i + 1).join("\n").trim();
    }
  }
  return text;
}

export class SkillRuntime implements SkillSpawnGate {
  constructor(
    private readonly db: PersistenceService,
    private readonly manager: SkillManager,
    private readonly activation: SkillActivationStore,
  ) {}

  /**
   * Puerta de runs (CONSUME `selectForRun` del Todo 22): solo habilitadas.
   * Descubre en fresco en cada llamada: sin caché rancia entre runs.
   */
  async resolveForRun(projectId: string): Promise<SkillRecord[]> {
    const { skills } = this.manager.discover();
    return this.activation.selectForRun(projectId, skills);
  }

  /** Selección por tarea: top-N relevantes con puntuación > 0 (determinista). */
  selectRelevant(candidates: SkillRecord[], taskText: string, limit: number = SKILL_MAX_FULL): SkillRecord[] {
    if (!taskText.trim() || candidates.length === 0) return [];
    const ranked = candidates
      .map((c) => ({ skill: c, score: relevanceScore(taskText, c) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || (a.skill.name < b.skill.name ? -1 : 1));
    return ranked.slice(0, Math.max(0, limit)).map((r) => r.skill);
  }

  /** Línea de metadatos: `- nombre@versión: descripción` (tope SKILL_MAX_METADATA). */
  metadataLine(skill: SkillRecord): string {
    const id = skill.version ? `${skill.name}@${skill.version}` : skill.name;
    return `- ${id}: ${skill.description}`;
  }

  buildMetadata(enabled: SkillRecord[]): string {
    return enabled.slice(0, SKILL_MAX_METADATA).map((s) => this.metadataLine(s)).join("\n");
  }

  /** Instrucciones completas de una skill (cuerpo topado; nunca el frontal). */
  loadFullInstructions(skill: SkillRecord): string {
    let text: string;
    try {
      text = readFileSync(path.join(skill.path, "SKILL.md"), "utf8");
    } catch {
      throw new OctusError("not_found", `SKILL.md ilegible para '${skill.name}'`, { details: { area: "skills" } });
    }
    const body = stripFrontmatter(text);
    const capped = body.length > SKILL_MAX_FULL_CHARS ? `${body.slice(0, SKILL_MAX_FULL_CHARS)}\n<!-- truncado por tope de carga progresiva -->` : body;
    const version = skill.version ? ` version="${skill.version}"` : "";
    return `<skill name="${skill.name}"${version}>\n${capped}\n</skill>`;
  }

  /**
   * Recurso bajo demanda de una skill habilitada (rutas relativas internas,
   * sin `..`, sin absolutos, sin enlaces; tope SKILL_MAX_RESOURCE_CHARS).
   */
  readResource(skill: SkillRecord, relativePath: string): string {
    const unified = relativePath.replace(/\\/g, "/");
    if (unified.length === 0 || unified.startsWith("/") || /^[A-Za-z]:\//.test(unified)) {
      throw new OctusError("scope_violation", `recurso fuera de la skill: ${JSON.stringify(relativePath)}`, { details: { area: "skills" } });
    }
    for (const part of unified.split("/")) {
      if (part === ".." || part === "" || part === ".") {
        throw new OctusError("scope_violation", `recurso fuera de la skill: ${JSON.stringify(relativePath)}`, { details: { area: "skills" } });
      }
    }
    let text: string;
    try {
      text = readFileSync(path.join(skill.path, ...unified.split("/")), "utf8");
    } catch {
      throw new OctusError("not_found", `recurso inexistente en '${skill.name}': ${JSON.stringify(relativePath)}`, { details: { area: "skills" } });
    }
    return text.length > SKILL_MAX_RESOURCE_CHARS ? `${text.slice(0, SKILL_MAX_RESOURCE_CHARS)}\n<!-- truncado por tope de recurso -->` : text;
  }

  /**
   * Secciones progresivas para el prompt + registro por run.
   * Metadatos de TODAS las habilitadas; completa SOLO de la relevante.
   */
  async sectionsFor(input: SkillPromptInput): Promise<SkillPromptSections> {
    const enabled = await this.resolveForRun(input.projectId);
    const metadata = this.buildMetadata(enabled);
    const taskText = [input.taskBrief ?? "", input.taskId ?? ""].join("\n");
    const relevant = this.selectRelevant(enabled, taskText);
    const full = relevant.map((s) => this.loadFullInstructions(s)).join("\n\n");
    const used = relevant.map((s) => s.name);
    if (used.length > 0) await this.recordRun(input.runId, used);
    return { metadata, full, used };
  }

  /** Registro por run en kv (sobrescribe: un run, una lista usada). */
  async recordRun(runId: string, skillNames: string[]): Promise<void> {
    const record: RunRecord = { version: 1, skills: [...skillNames].sort(), at: Date.now() };
    await this.db.exec(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [`${SKILL_RUN_KV_PREFIX}${runId}`, JSON.stringify(record), Date.now()],
    );
  }

  /** Lee el registro de skills usadas por un run (vacío si no hay). */
  async skillsForRun(runId: string): Promise<string[]> {
    const row = await this.db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", [`${SKILL_RUN_KV_PREFIX}${runId}`]);
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.value) as RunRecord;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.skills)) return parsed.skills.filter((s) => typeof s === "string");
    } catch {
      // Corrupto → vacío, sin romper (precedente Todos 6/22).
    }
    return [];
  }

  /** Auditoría de intento de evasión: la skill decía permitir, el permiso negó. */
  async noteBypass(runId: string, skill: string, action: string): Promise<void> {
    const key = `${SKILL_BYPASS_KV_PREFIX}${runId}`;
    const row = await this.db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", [key]);
    let record: BypassRecord = { version: 1, attempts: [] };
    if (row) {
      try {
        const parsed = JSON.parse(row.value) as BypassRecord;
        if (parsed && parsed.version === 1 && Array.isArray(parsed.attempts)) record = parsed;
      } catch {
        record = { version: 1, attempts: [] };
      }
    }
    record.attempts.push({ skill, action, at: Date.now() });
    await this.db.exec(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [key, JSON.stringify(record), Date.now()],
    );
  }

  /** Lee los intentos de evasión auditados de un run. */
  async bypassForRun(runId: string): Promise<Array<{ skill: string; action: string; at: number }>> {
    const row = await this.db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", [`${SKILL_BYPASS_KV_PREFIX}${runId}`]);
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.value) as BypassRecord;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.attempts)) return parsed.attempts;
    } catch {
      // Corrupto → vacío, sin romper.
    }
    return [];
  }

  /** `allowed-tools` descriptivo para el veto del ToolGateway (descubre en fresco). */
  skillAllows(skillName: string, action: string): boolean {
    const { skills } = this.manager.discover();
    const skill = skills.find((s) => s.name === skillName);
    if (!skill) return false;
    return skillAllowsAction(skill, action);
  }

  /** Puerta de `spawn` (la exige AgentManager): habilitada en el proyecto o nada. */
  async isAllowed(projectId: string, name: string): Promise<boolean> {
    return this.activation.isEnabled(projectId, name);
  }

  /**
   * Administración delegada al store ÚNICO de este runtime: usar estos métodos
   * (no un segundo SkillActivationStore) evita cachés rancias entre la
   * habilitación y la puerta de runs/spawn.
   */
  async enable(projectId: string, skill: { name: string; version?: string }, scope?: SkillRecord["scope"]): Promise<void> {
    await this.activation.enable(projectId, skill, scope);
  }

  async disable(projectId: string, name: string): Promise<void> {
    await this.activation.disable(projectId, name);
  }

  async setScope(projectId: string, name: string, scope: SkillRecord["scope"]): Promise<void> {
    await this.activation.setScope(projectId, name, scope);
  }

  /** Rechaza con `scope_violation` la primera skill no habilitada (deny-by-default). */
  async assertSpawnAllowed(projectId: string, skillNames: string[]): Promise<void> {
    for (const name of skillNames) {
      if (!(await this.isAllowed(projectId, name))) {
        throw new OctusError("scope_violation", `Skill '${name}' no habilitada en este proyecto`, { details: { area: "skills" } });
      }
    }
  }

  /** Gancho listo para AgentRuntime: secciones + registro por run en un paso. */
  hook(): SkillSectionsHook {
    return (input) => this.sectionsFor(input);
  }
}
