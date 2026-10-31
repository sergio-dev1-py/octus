/**
 * @octus/core — configuración no secreta (config.json). Sin claves jamás (ADR-009).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ModelSelection } from "@octus/shared";

export interface ProviderConfig {
  enabled: boolean;
  defaultModelId?: string;
  defaultEffort?: string;
}

export interface AgentLimitsConfig {
  maxPerSession: number;
  maxPerProject: number;
  maxDepth: number;
  /** Etapa 3: límites por rol (ADR-030). Sin rol integrador. */
  maxImplementers: number;
  maxReaders: number;
  maxReviewers: number;
}

export interface SchedulerConfig {
  /** Intentos máximos por tarea (incluye el primero). */
  maxAttemptsPerTask: number;
  /** Base del backoff entre reintentos explícitos. */
  backoffBaseMs: number;
}

export interface OctusConfig {
  version: 1;
  providers: Record<string, ProviderConfig>;
  defaultProviderId: string;
  defaultModel?: ModelSelection;
  shellTimeoutMs: number;
  maxOutputChars: number;
  agentLimits: AgentLimitsConfig;
  scheduler: SchedulerConfig;
}

export const DEFAULT_CONFIG: OctusConfig = {
  version: 1,
  providers: {
    meta: { enabled: true, defaultModelId: "muse-wonder-1.0", defaultEffort: "high" },
    "opencode-go": { enabled: true, defaultModelId: "glm-5.3-flash" },
  },
  defaultProviderId: "meta",
  shellTimeoutMs: 120_000,
  maxOutputChars: 30_000,
  agentLimits: { maxPerSession: 4, maxPerProject: 6, maxDepth: 2, maxImplementers: 2, maxReaders: 2, maxReviewers: 1 },
  scheduler: { maxAttemptsPerTask: 3, backoffBaseMs: 1000 },
};

export class ConfigStore {
  private readonly file: string;
  private value: OctusConfig;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "config.json");
    this.value = ConfigStore.load(this.file);
  }

  private static load(file: string): OctusConfig {
    if (!existsSync(file)) return structuredClone(DEFAULT_CONFIG);
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<OctusConfig>;
      return {
        ...structuredClone(DEFAULT_CONFIG),
        ...raw,
        providers: { ...structuredClone(DEFAULT_CONFIG.providers), ...(raw.providers ?? {}) },
        agentLimits: { ...structuredClone(DEFAULT_CONFIG.agentLimits), ...(raw.agentLimits ?? {}) },
        scheduler: { ...structuredClone(DEFAULT_CONFIG.scheduler), ...(raw.scheduler ?? {}) },
      };
    } catch {
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  get(): OctusConfig {
    return this.value;
  }

  path(): string {
    return this.file;
  }

  update(patch: Partial<OctusConfig>): OctusConfig {
    this.value = {
      ...this.value,
      ...patch,
      providers: { ...this.value.providers, ...(patch.providers ?? {}) },
    };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.value, null, 2));
    renameSync(tmp, this.file);
    return this.value;
  }
}
