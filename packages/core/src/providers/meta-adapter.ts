/**
 * @octus/core — adaptador Meta Model API (Responses, SDK oficial). Verificado Hito 0.
 */
import type {
  GenerateInput,
  ImageGenerateInput,
  ImageGenerateResult,
  ModelCapabilities,
  ModelDescriptor,
  ModelProvider,
  ProviderStreamEvent,
  ReasoningEffort,
} from "@octus/shared";
import { ResponsesTransport } from "./responses-transport.js";

export const META_BASE_URL = "https://api.meta.ai/v1";
const PRICING_SOURCE = "https://dev.meta.ai/docs/pricing-rate-limits";
const PRICING_DATE = "2026-10-30";

const WONDER: ModelDescriptor = {
  providerId: "meta",
  modelId: "muse-wonder-1.0",
  displayName: "Muse Wonder 1.0",
  capabilities: {
    toolCall: true,
    reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 131_072,
    supportsImages: true,
    priceInputPerM: 4.0,
    priceOutputPerM: 20.0,
    priceCacheReadPerM: 0.2,
    pricingSource: PRICING_SOURCE,
    pricingDate: PRICING_DATE,
  },
};

const SPARK: ModelDescriptor = {
  providerId: "meta",
  modelId: "muse-spark-1.3",
  displayName: "Muse Spark 1.3",
  capabilities: {
    toolCall: true,
    reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 131_072,
    supportsImages: true,
    priceInputPerM: 1.25,
    priceOutputPerM: 4.25,
    priceCacheReadPerM: 0.15,
    pricingSource: PRICING_SOURCE,
    pricingDate: PRICING_DATE,
  },
};

/** Límites reales del catálogo Meta (la API no los declara en /v1/models).
 *  Muse Wonder y todas las versiones de Muse Spark comparten 1M de contexto. */
const KNOWN_META_LIMITS: Record<string, { context: number; output: number; efforts: ReasoningEffort[] }> = {
  "muse-wonder-1.0": { context: 1_048_576, output: 131_072, efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  "muse-spark-1.3": { context: 1_048_576, output: 131_072, efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  "muse-spark-1.3-contributor": { context: 1_048_576, output: 131_072, efforts: ["minimal", "low", "medium", "high", "xhigh"] },
  "muse-spark-1.2": { context: 1_048_576, output: 131_072, efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  "muse-spark-1.2-contributor": { context: 1_048_576, output: 131_072, efforts: ["minimal", "low", "medium", "high", "xhigh"] },
  "muse-spark-1.1": { context: 1_048_576, output: 131_072, efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] },
};

/** Modelos que Meta publica pero no son de conversación/tool-calling. */
const META_NON_CHAT = /^(muse-image|muse-voice-transcribe|sam-)/i;

/** Modelo de imagen por defecto cuando el catálogo aún no está disponible. */
const MUSE_IMAGE: ModelDescriptor = {
  providerId: "meta",
  modelId: "muse-image-1.0",
  displayName: "Muse Image 1.0",
  capabilities: {
    toolCall: false,
    reasoningEfforts: [],
    maxContextTokens: 131_072,
    maxOutputTokens: 8192,
    supportsImages: true,
    imageGeneration: true,
    pricingSource: PRICING_SOURCE,
    pricingDate: PRICING_DATE,
  },
};

/** Niveles de razonamiento verificados por modelo (la API no siempre los declara).
 *  Sin entrada aquí y sin metadatos de la API se ofrece el set completo. */
const KNOWN_MODEL_EFFORTS: Record<string, ReasoningEffort[]> = {
  "muse-spark-1.3-contributor": ["minimal", "low", "medium", "high", "xhigh"],
};

export interface MetaAdapterOptions {
  baseURL?: string;
  getApiKey: () => Promise<string | undefined>;
  timeoutMs?: number;
}

export class MetaAdapter implements ModelProvider {
  readonly id = "meta";
  readonly displayName = "Meta Model API";
  readonly billable = true;
  private readonly transport: ResponsesTransport;
  private readonly baseURL: string;
  private readonly getApiKey: () => Promise<string | undefined>;
  /** Catálogo vivo de la API (refreshCatalog); sin él, los 2 fijos. */
  private table: ModelDescriptor[] | undefined;

  constructor(options: MetaAdapterOptions) {
    this.baseURL = options.baseURL ?? META_BASE_URL;
    this.getApiKey = options.getApiKey;
    this.transport = new ResponsesTransport({
      baseURL: this.baseURL,
      getApiKey: options.getApiKey,
      timeoutMs: options.timeoutMs,
      label: "meta",
    });
  }

  models(): ModelDescriptor[] {
    return this.table ?? [WONDER, SPARK, MUSE_IMAGE];
  }

  /** Imagen de una sola pasada vía /images/generations (OpenAI Images API). */
  async generateImage(input: ImageGenerateInput, signal: AbortSignal): Promise<ImageGenerateResult> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error("Meta image generation requires an API key");
    const response = await fetch(`${this.baseURL}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.modelId,
        prompt: input.prompt,
        n: input.n ?? 1,
        ...(input.size ? { size: input.size } : {}),
      }),
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Meta image API HTTP ${response.status}: ${detail.slice(0, 500)}`);
    }
    const body = (await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
    const images: Array<{ base64?: string; url?: string; mimeType: string }> = [];
    for (const item of body.data ?? []) {
      if (item.b64_json) images.push({ base64: item.b64_json, mimeType: "image/png" });
      else if (item.url) images.push({ url: item.url, mimeType: "image/png" });
    }
    if (images.length === 0) throw new Error("Meta image API returned no images");
    return { images, modelId: input.modelId, providerId: "meta" };
  }

  /**
   * Catálogo vivo: GET /models con la key guardada (estilo OpenAI
   * `{data:[...]}`). Entradas defensivas: los conocidos WONDER/SPARK se
   * conservan con sus capacidades verificadas; el resto entra con valores
   * conservadores y el set completo de esfuerzos salvo que la API declare
   * otros. Sin key o sin red, se conserva lo anterior (nunca se vacía).
   */
  async refreshCatalog(): Promise<{ ok: boolean; count?: number; error?: string }> {
    try {
      const apiKey = await this.getApiKey();
      if (!apiKey) return { ok: false, error: "No API key saved" };
      const res = await fetch(`${this.baseURL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
      const entries: ModelDescriptor[] = [];
      for (const item of body.data ?? []) {
        if (typeof item.id !== "string" || !item.id) continue;
        const known = KNOWN_META_LIMITS[item.id];
        const nonChat = META_NON_CHAT.test(item.id);
        entries.push({
          providerId: "meta",
          modelId: item.id,
          displayName: typeof item.name === "string" ? item.name : item.id,
          capabilities: {
            toolCall: nonChat ? false : ((item.capabilities as { tools?: { supported?: boolean } } | undefined)?.tools?.supported ?? true),
            reasoningEfforts: nonChat ? [] : (known?.efforts ?? parseEfforts(item)),
            maxContextTokens: nonChat
              ? 131_072
              : (known?.context ?? num(item.limit, item.context_window, item.max_context_length, item.context_length) ?? 131_072),
            maxOutputTokens: nonChat
              ? 8192
              : (known?.output ?? num(item.limit, item.max_output_tokens, item.output_length) ?? 8192),
            supportsImages: modalitiesIncludeImage(item.modalities),
            imageGeneration: /^muse-image/i.test(item.id),
            pricingSource: `${this.baseURL}/models`,
            pricingDate: new Date().toISOString().slice(0, 10),
          },
        });
      }
      if (entries.length > 0) this.table = entries;
      return { ok: true, count: entries.length };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  capabilitiesOf(modelId: string): ModelCapabilities | undefined {
    return this.models().find((m) => m.modelId === modelId)?.capabilities;
  }

  async *generateStream(input: GenerateInput, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    const caps = this.capabilitiesOf(input.modelId);
    if (!caps) {
      yield {
        type: "error",
        error: { code: "not_found", message: `unknown Meta model '${input.modelId}'`, retryable: false },
      };
      return;
    }
    if (!effortAllowed(caps, input.effort)) {
      yield {
        type: "error",
        error: {
          code: "bad_request",
          message: `reasoning effort '${input.effort}' is not supported by ${input.modelId}`,
          retryable: false,
          providerCode: "effort_not_supported",
        },
      };
      return;
    }
    if (input.tools?.length && !caps.toolCall) {
      yield {
        type: "error",
        error: { code: "bad_request", message: `${input.modelId} does not support tool calling`, retryable: false },
      };
      return;
    }
    yield* this.transport.generateStream(input, signal);
  }

  /** Prueba de conexión: lista modelos con la clave (refresca el catálogo). */
  async test(): Promise<{ ok: boolean; error?: string; models?: number }> {
    const refreshed = await this.refreshCatalog();
    if (!refreshed.ok) return { ok: false, error: refreshed.error };
    return { ok: true, models: refreshed.count ?? 0 };
  }
}

const KNOWN_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

function num(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) return Math.floor(candidate);
    if (candidate !== null && typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      for (const key of ["context", "output", "input"]) {
        const value = nested[key];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
      }
    }
  }
  return undefined;
}

function parseEfforts(item: Record<string, unknown>): ReasoningEffort[] {
  const caps = item.capabilities as { reasoning?: { supported?: boolean; effort?: unknown }; effort?: unknown } | undefined;
  const raw = caps?.reasoning?.effort ?? caps?.effort ?? item.reasoning_options ?? item.effort_options;
  if (Array.isArray(raw)) {
    const efforts = raw.filter((e): e is ReasoningEffort => typeof e === "string" && (KNOWN_EFFORTS as string[]).includes(e));
    if (efforts.length > 0) return efforts;
  }
  const curated = typeof item.id === "string" ? KNOWN_MODEL_EFFORTS[item.id] : undefined;
  if (curated) return [...curated];
  return [...KNOWN_EFFORTS];
}

function modalitiesIncludeImage(modalities: unknown): boolean {
  if (modalities !== null && typeof modalities === "object") {
    const values = Object.values(modalities as Record<string, unknown>).flat();
    if (values.some((m) => typeof m === "string" && m.toLowerCase().includes("image"))) return true;
  }
  return false;
}

function effortAllowed(caps: ModelCapabilities, effort: ReasoningEffort | undefined): boolean {
  if (!effort) return true;
  return caps.reasoningEfforts.includes(effort);
}
