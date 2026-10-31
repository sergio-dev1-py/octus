/**
 * @octus/core — almacenes de secretos. Interfaz única; el SO la implementa en desktop.
 * Prioridad: almacén seguro del SO → variable de entorno (ADR-009).
 */

export interface SecretStore {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export function secretRefForProvider(providerId: string): string {
  return `octus.provider.${providerId}.api_key`;
}

export function envVarForProvider(providerId: string): string | undefined {
  if (providerId === "meta") return "MODEL_API_KEY";
  if (providerId === "opencode-go") return "OPENCODE_API_KEY";
  return undefined;
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  async get(ref: string): Promise<string | undefined> {
    return this.values.get(ref);
  }

  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }

  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }
}

/** Solo lectura: variables de entorno del proceso. */
export class EnvSecretStore implements SecretStore {
  async get(ref: string): Promise<string | undefined> {
    const match = ref.match(/^octus\.provider\.(.+)\.api_key$/);
    if (!match) return undefined;
    const envVar = envVarForProvider(match[1]!);
    if (!envVar) return undefined;
    return process.env[envVar] || undefined;
  }

  async set(): Promise<void> {
    throw new Error("environment secret store is read-only");
  }

  async delete(): Promise<void> {
    throw new Error("environment secret store is read-only");
  }
}

/** Composición: primario (SO) con fallback a entorno solo en lectura. */
export class CompositeSecretStore implements SecretStore {
  constructor(
    private readonly primary: SecretStore,
    private readonly fallback: SecretStore,
  ) {}

  async get(ref: string): Promise<string | undefined> {
    return (await this.primary.get(ref)) ?? (await this.fallback.get(ref));
  }

  async set(ref: string, value: string): Promise<void> {
    await this.primary.set(ref, value);
  }

  async delete(ref: string): Promise<void> {
    await this.primary.delete(ref);
  }
}
