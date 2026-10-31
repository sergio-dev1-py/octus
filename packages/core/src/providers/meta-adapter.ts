/**
 * @octus/core — adaptador Meta Model API (Responses, SDK oficial). Verificado Hito 0.
 */
import type {
  GenerateInput,
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
    return [WONDER, SPARK];
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

  /** Prueba de conexión: lista modelos con la clave (no genera coste de generación). */
  async test(): Promise<{ ok: boolean; error?: string; models?: number }> {
    const apiKey = await this.getApiKey();
    if (!apiKey) return { ok: false, error: "no API key configured" };
    try {
      const res = await fetch(`${this.baseURL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const body = (await res.json()) as { data?: unknown[] };
      return { ok: true, models: body.data?.length ?? 0 };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function effortAllowed(caps: ModelCapabilities, effort: ReasoningEffort | undefined): boolean {
  if (!effort) return true;
  return caps.reasoningEfforts.includes(effort);
}
