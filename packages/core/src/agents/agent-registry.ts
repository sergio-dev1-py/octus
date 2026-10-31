/**
 * @octus/core — registro de definiciones de agente (Etapa 2: YAML declarativo versionado).
 * Upsert por promptVersion: cambiar un prompt nunca toca el runtime ni instancias vivas.
 */
import type { AgentDefinition } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import {
  assertKnownTools,
  loadDefinitionsDirectory,
  promptHashOf,
  toAgentDefinition,
  type ValidatedDefinition,
} from "./definition-loader.js";

export const DEFINITION_BUILD = "coordinator-build";
export const DEFINITION_PLAN = "coordinator-plan";

export interface RegistryOptions {
  /** Directorio con los YAML builtin. Por defecto, junto a este módulo (tests/dev). */
  definitionsDir?: string;
}

function defaultDefinitionsDir(): string {
  return new URL("./definitions", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

export class AgentRegistry {
  private readonly dir: string;

  constructor(
    private readonly db: PersistenceService,
    options: RegistryOptions = {},
  ) {
    this.dir = options.definitionsDir ?? defaultDefinitionsDir();
  }

  /**
   * Carga, valida e inserta/actualiza (por promptVersion) todas las definiciones.
   * `knownTools` (manifiestos del gateway) hace estricta la validación de nombres.
   */
  async ensureSeeded(knownTools?: string[]): Promise<AgentDefinition[]> {
    const defs = loadDefinitionsDirectory(this.dir);
    const out: AgentDefinition[] = [];
    for (const def of defs) {
      if (knownTools) assertKnownTools(def, knownTools);
      out.push(await this.upsert(def));
    }
    return out;
  }

  private async upsert(def: ValidatedDefinition): Promise<AgentDefinition> {
    const existing = await this.db.queryOne<{ prompt_version: number }>("SELECT prompt_version FROM agent_definitions WHERE id = ?", [def.id]);
    const full = toAgentDefinition(def);
    if (!existing) {
      await this.db.exec(
        "INSERT INTO agent_definitions (id, kind, name, description, profile, default_model, max_steps, timeout_ms, idle_timeout_ms, system_prompt, tools, denied_tools, permission_rules, delivery_format, can_delegate_to, prompt_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          full.id,
          full.kind,
          full.name,
          full.description,
          full.profile ?? null,
          JSON.stringify(full.defaultModel),
          full.maxSteps,
          full.timeoutMs,
          full.idleTimeoutMs,
          full.systemPrompt,
          JSON.stringify(full.tools),
          JSON.stringify(full.deniedTools),
          JSON.stringify(full.permissionRules),
          full.deliveryFormat,
          JSON.stringify(full.canDelegateTo),
          full.promptVersion,
        ],
      );
      return full;
    }
    if (Number(existing.prompt_version) >= def.promptVersion) {
      const current = await this.get(def.id);
      if (!current) throw new OctusError("not_found", `Agent definition disappeared: ${def.id}`);
      return current;
    }
    await this.db.exec(
      "UPDATE agent_definitions SET kind = ?, name = ?, description = ?, profile = ?, default_model = ?, max_steps = ?, timeout_ms = ?, idle_timeout_ms = ?, system_prompt = ?, tools = ?, denied_tools = ?, permission_rules = ?, delivery_format = ?, can_delegate_to = ?, prompt_version = ? WHERE id = ?",
      [
        full.kind,
        full.name,
        full.description,
        full.profile ?? null,
        JSON.stringify(full.defaultModel),
        full.maxSteps,
        full.timeoutMs,
        full.idleTimeoutMs,
        full.systemPrompt,
        JSON.stringify(full.tools),
        JSON.stringify(full.deniedTools),
        JSON.stringify(full.permissionRules),
        full.deliveryFormat,
        JSON.stringify(full.canDelegateTo),
        full.promptVersion,
        full.id,
      ],
    );
    return full;
  }

  async get(id: string): Promise<AgentDefinition | undefined> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM agent_definitions WHERE id = ?", [id]);
    if (!row) return undefined;
    return deserialize(row);
  }

  async list(): Promise<AgentDefinition[]> {
    const rows = await this.db.query<Record<string, string | number | null>>("SELECT * FROM agent_definitions ORDER BY id ASC");
    return rows.map(deserialize);
  }

  async forProfile(profile: "plan" | "build"): Promise<AgentDefinition> {
    const def = await this.get(profile === "plan" ? DEFINITION_PLAN : DEFINITION_BUILD);
    if (!def) throw new OctusError("not_found", `coordinator definition for profile '${profile}' is missing`);
    return def;
  }
}

function deserialize(row: Record<string, string | number | null>): AgentDefinition {
  return {
    id: String(row.id),
    kind: row.kind as AgentDefinition["kind"],
    name: String(row.name),
    description: String(row.description),
    profile: row.profile ? (String(row.profile) as AgentDefinition["profile"]) : undefined,
    defaultModel: JSON.parse(String(row.default_model)) as AgentDefinition["defaultModel"],
    maxSteps: Number(row.max_steps),
    timeoutMs: Number(row.timeout_ms),
    idleTimeoutMs: Number(row.idle_timeout_ms),
    systemPrompt: String(row.system_prompt),
    tools: JSON.parse(String(row.tools)) as string[],
    deniedTools: JSON.parse(String(row.denied_tools ?? "[]")) as string[],
    permissionRules: JSON.parse(String(row.permission_rules ?? "[]")) as AgentDefinition["permissionRules"],
    deliveryFormat: String(row.delivery_format ?? ""),
    canDelegateTo: JSON.parse(String(row.can_delegate_to ?? "[]")) as AgentDefinition["canDelegateTo"],
    promptVersion: Number(row.prompt_version),
  };
}

export { promptHashOf };
