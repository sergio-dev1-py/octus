/**
 * Configuración de modelos para pruebas live (solo harness live, sin producción).
 *
 * Variables:
 *   OCTUS_LIVE_META_MODEL: modelId de Meta usado por TODAS las pruebas live de Meta.
 *     Valor predeterminado documentado: "muse-spark-1.3" (barato, Standard).
 *   OCTUS_LIVE_META_REASONING_EFFORT: esfuerzo de razonamiento para las solicitudes Meta.
 *     Valor predeterminado documentado: "low".
 *
 * Reglas:
 * - Sin variable: se usa el predeterminado y se muestra "(default)" al inicio.
 * - Con variable: se usa tal cual y se muestra "(env)". Sin fallback silencioso a
 *   modelos más caros (nunca se sustituye por Muse Wonder de forma oculta).
 * - Esfuerzo inválido: error claro y salida inmediata (no se continúa con otro valor).
 * - Si el modelo configurado no lo ofrece el adaptador Meta y es variante
 *   `-contributor`, el harness live amplía el catálogo SOLO en memoria para la
 *   validación (la producción sigue ofreciendo únicamente wonder/spark). Para
 *   cualquier otro modelo desconocido se falla rápido listando la oferta real.
 */
import type { ModelDescriptor, ReasoningEffort } from "@octus/shared";

export const DEFAULT_LIVE_META_MODEL = "muse-spark-1.3";
export const DEFAULT_LIVE_META_EFFORT: ReasoningEffort = "low";

const KNOWN_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface LiveMetaConfig {
  modelId: string;
  effort: ReasoningEffort;
  modelSource: "env" | "default";
  effortSource: "env" | "default";
}

export function resolveLiveMetaConfig(env: Record<string, string | undefined> = process.env): LiveMetaConfig {
  const rawModel = env.OCTUS_LIVE_META_MODEL?.trim();
  const rawEffort = env.OCTUS_LIVE_META_REASONING_EFFORT?.trim().toLowerCase();
  const modelId = rawModel ? rawModel : DEFAULT_LIVE_META_MODEL;
  const modelSource = rawModel ? ("env" as const) : ("default" as const);
  if (!modelId) {
    throw new Error("OCTUS_LIVE_META_MODEL must not be empty");
  }
  let effort: ReasoningEffort = DEFAULT_LIVE_META_EFFORT;
  let effortSource: "env" | "default" = "default";
  if (rawEffort) {
    if (!(KNOWN_EFFORTS as string[]).includes(rawEffort)) {
      throw new Error(
        `Invalid OCTUS_LIVE_META_REASONING_EFFORT '${env.OCTUS_LIVE_META_REASONING_EFFORT}': expected one of ${KNOWN_EFFORTS.join("|")}. Refusing to fall back silently.`,
      );
    }
    effort = rawEffort as ReasoningEffort;
    effortSource = "env";
  }
  return { modelId, effort, modelSource, effortSource };
}

export function liveConfigBanner(config: LiveMetaConfig): string {
  return `live config: meta model=${config.modelId} (${config.modelSource}) effort=${config.effort} (${config.effortSource}) — defaults: model=${DEFAULT_LIVE_META_MODEL} effort=${DEFAULT_LIVE_META_EFFORT}`;
}

export function isContributorModel(modelId: string): boolean {
  return /contributor/i.test(modelId);
}

/** Descriptor live-only para variantes -contributor de Meta (sin max, sin precio inventado). */
export function liveContributorDescriptor(modelId: string): ModelDescriptor {
  return {
    providerId: "meta",
    modelId,
    displayName: `${modelId} (live-only)`,
    capabilities: {
      toolCall: true,
      reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
      maxContextTokens: 1_048_576,
      maxOutputTokens: 131_072,
      supportsImages: true,
    },
  };
}

export function supportsEffort(models: ModelDescriptor[], modelId: string, effort: ReasoningEffort): boolean {
  return models.find((m) => m.modelId === modelId)?.capabilities.reasoningEfforts.includes(effort) ?? false;
}

export interface LiveMetaCatalogResult {
  extended: boolean;
  alreadyOffered: boolean;
}

/**
 * Garantiza que el proveedor Meta del harness ofrezca el modelo configurado.
 * Solo amplía en memoria para `-contributor` (live-only). Para otro modelo
 * desconocido no inventa nada: devuelve extended=false y el llamante debe
 * fallar rápido mostrando la oferta real (sin fallback a Wonder).
 */
export function ensureLiveMetaModel(
  metaProvider: { models(): ModelDescriptor[] },
  modelId: string,
): LiveMetaCatalogResult {
  const alreadyOffered = metaProvider.models().some((m) => m.modelId === modelId);
  if (alreadyOffered) return { extended: false, alreadyOffered: true };
  if (!isContributorModel(modelId)) return { extended: false, alreadyOffered: false };
  const originalModels = metaProvider.models.bind(metaProvider);
  const descriptor = liveContributorDescriptor(modelId);
  (metaProvider as { models(): ModelDescriptor[] }).models = () => [...originalModels(), descriptor];
  return { extended: true, alreadyOffered: false };
}
