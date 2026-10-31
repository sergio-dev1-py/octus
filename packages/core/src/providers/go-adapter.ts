/**
 * @octus/core — adaptador OpenCode Go (ADR-021).
 * Encamina por protocolo NATIVO de cada modelo según el catálogo público /v1/models.
 * Etapa 1: rutas `responses` y `chat-completions` (SDK oficial). Sin Console.
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
import { ChatTransport } from "./chat-transport.js";

export const GO_BASE_URL = "https://opencode.ai/inference/go";
const GO_OPENAI_BASE = `${GO_BASE_URL}/openai/v1`;
const CATALOG_SOURCE = "https://opencode.ai/inference/go/v1/models";
const CATALOG_DATE = "2026-10-30";
const USER_AGENT = "octus/0.1";

export type GoNativeApi = "responses" | "chat-completions" | "messages" | "generate-content";

export interface GoModelEntry extends ModelDescriptor {
  native: GoNativeApi;
  toolChoice: string[];
  /** Modelos que entrenan con el contenido: excluidos salvo opt-in explícito (ADR-005). */
  restricted?: "contributor-training";
}

function entry(
  modelId: string,
  displayName: string,
  native: GoNativeApi,
  toolChoice: string[],
  capabilities: ModelCapabilities,
  restricted?: GoModelEntry["restricted"],
): GoModelEntry {
  return { providerId: "opencode-go", modelId, displayName, native, toolChoice, capabilities, restricted };
}

/** Tabla verificada el 2026-10-30 contra el catálogo público (Hito 0). */
const INITIAL_TABLE: GoModelEntry[] = [
  entry("glm-5.3-flash", "GLM-5.3-Flash", "chat-completions", ["auto"], {
    toolCall: true,
    reasoningEfforts: ["low", "high", "max"],
    maxContextTokens: 1_000_000,
    maxOutputTokens: 131_072,
    supportsImages: true,
    priceInputPerM: 0.15,
    priceOutputPerM: 0.5,
    priceCacheReadPerM: 0.03,
    pricingSource: CATALOG_SOURCE,
    pricingDate: CATALOG_DATE,
  }),
  entry("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "chat-completions", ["auto", "none", "required", "tool"], {
    toolCall: true,
    reasoningEfforts: ["low", "high", "max"],
    maxContextTokens: 1_000_000,
    maxOutputTokens: 384_000,
    supportsImages: true,
    priceInputPerM: 0.15,
    priceOutputPerM: 0.6,
    priceCacheReadPerM: 0.003,
    pricingSource: CATALOG_SOURCE,
    pricingDate: CATALOG_DATE,
  }),
  entry("glm-5.3", "GLM-5.3", "chat-completions", ["auto"], {
    toolCall: true,
    reasoningEfforts: ["low", "high", "max"],
    maxContextTokens: 1_000_000,
    maxOutputTokens: 131_072,
    supportsImages: false,
    priceInputPerM: 1.4,
    priceOutputPerM: 4.4,
    priceCacheReadPerM: 0.26,
    pricingSource: CATALOG_SOURCE,
    pricingDate: CATALOG_DATE,
  }),
  entry("grok-4.7", "Grok 4.7", "responses", ["auto", "none", "required", "tool"], {
    toolCall: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    maxContextTokens: 500_000,
    maxOutputTokens: 500_000,
    supportsImages: true,
    priceInputPerM: 2.0,
    priceOutputPerM: 6.0,
    priceCacheReadPerM: 0.5,
    pricingSource: CATALOG_SOURCE,
    pricingDate: CATALOG_DATE,
  }),
  entry("gpt-6-luna", "GPT 6 Luna", "responses", ["auto", "none", "required", "tool"], {
    toolCall: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    maxContextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    priceInputPerM: 0.1,
    priceOutputPerM: 0.5,
    priceCacheReadPerM: 0.01,
    pricingSource: CATALOG_SOURCE,
    pricingDate: CATALOG_DATE,
  }),
  entry("kimi-k3", "Kimi K3", "chat-completions", ["auto", "none", "required"], {
    toolCall: true,
    reasoningEfforts: ["max"],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 131_072,
    supportsImages: true,
    priceInputPerM: 3.0,
    priceOutputPerM: 15.0,
    priceCacheReadPerM: 0.3,
    pricingSource: CATALOG_SOURCE,
    pricingDate: CATALOG_DATE,
  }),
  entry("kimi-k3.1-pro", "Kimi K3.1 Pro", "chat-completions", ["auto", "none", "required"], {
    toolCall: true,
    reasoningEfforts: ["low", "high", "max"],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 131_072,
    supportsImages: true,
    priceInputPerM: 2.0,
    priceOutputPerM: 10.0,
    priceCacheReadPerM: 0.2,
    pricingSource: CATALOG_SOURCE,
    pricingDate: CATALOG_DATE,
  }),
  entry("beam-free", "Beam Free", "chat-completions", ["auto", "none", "required", "tool"], {
    toolCall: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 131_072,
    supportsImages: false,
    priceInputPerM: 0,
    priceOutputPerM: 0,
    priceCacheReadPerM: 0,
    pricingSource: CATALOG_SOURCE,
    pricingDate: CATALOG_DATE,
  }),
  entry("muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor", "responses", ["auto"], {
    toolCall: true,
    reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 131_072,
    supportsImages: true,
    priceInputPerM: 0.1,
    priceOutputPerM: 0.2,
    priceCacheReadPerM: 0.002,
    pricingSource: CATALOG_SOURCE,
    pricingDate: CATALOG_DATE,
  }, "contributor-training"),
];

const KNOWN_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface GoAdapterOptions {
  baseURL?: string;
  getApiKey: () => Promise<string | undefined>;
  /** Sesión estable por conversación (Go la exige). */
  getSessionHeader: (input: GenerateInput) => string;
  allowContributor?: boolean;
  timeoutMs?: number;
}

export class GoAdapter implements ModelProvider {
  readonly id = "opencode-go";
  readonly displayName = "OpenCode Go";
  readonly billable = true;
  private table: GoModelEntry[] = [...INITIAL_TABLE];
  private readonly baseURL: string;
  private readonly options: GoAdapterOptions;

  constructor(options: GoAdapterOptions) {
    this.options = options;
    this.baseURL = options.baseURL ?? GO_BASE_URL;
  }

  models(): ModelDescriptor[] {
    return this.table
      .filter((m) => !m.restricted || this.options.allowContributor)
      .map(({ native: _native, toolChoice: _choice, restricted: _r, ...rest }) => rest);
  }

  capabilitiesOf(modelId: string): ModelCapabilities | undefined {
    return this.table.find((m) => m.modelId === modelId)?.capabilities;
  }

  private headersFor(input: GenerateInput): Record<string, string> {
    return {
      "x-opencode-session": this.options.getSessionHeader(input),
      "User-Agent": USER_AGENT,
    };
  }

  async *generateStream(input: GenerateInput, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    const found = this.table.find((m) => m.modelId === input.modelId);
    if (!found || (found.restricted && !this.options.allowContributor)) {
      yield {
        type: "error",
        error: {
          code: "not_found",
          message: found ? `model '${input.modelId}' requires explicit contributor opt-in` : `unknown OpenCode Go model '${input.modelId}'`,
          retryable: false,
        },
      };
      return;
    }
    if (input.effort && !found.capabilities.reasoningEfforts.includes(input.effort)) {
      yield {
        type: "error",
        error: {
          code: "bad_request",
          message: `reasoning effort '${input.effort}' is not supported by ${input.modelId} (supports: ${found.capabilities.reasoningEfforts.join(", ") || "none"})`,
          retryable: false,
          providerCode: "effort_not_supported",
        },
      };
      return;
    }
    if (input.tools?.length && !found.capabilities.toolCall) {
      yield {
        type: "error",
        error: { code: "bad_request", message: `${input.modelId} does not support tool calling`, retryable: false },
      };
      return;
    }
    if (input.tools?.length && !found.toolChoice.includes("auto")) {
      yield {
        type: "error",
        error: { code: "bad_request", message: `${input.modelId} does not support tool_choice 'auto'`, retryable: false },
      };
      return;
    }
    const sessionHeader = this.options.getSessionHeader(input);
    if (!sessionHeader) {
      yield {
        type: "error",
        error: { code: "bad_request", message: "x-opencode-session header is required but empty", retryable: false },
      };
      return;
    }
    const openaiBase = `${this.baseURL}/openai/v1`;
    if (found.native === "responses") {
      const transport = new ResponsesTransport({
        baseURL: openaiBase,
        getApiKey: this.options.getApiKey,
        extraHeaders: () => this.headersFor(input),
        timeoutMs: this.options.timeoutMs,
        label: "opencode-go/responses",
      });
      yield* transport.generateStream(input, signal);
      return;
    }
    if (found.native === "chat-completions") {
      const transport = new ChatTransport({
        baseURL: openaiBase,
        getApiKey: this.options.getApiKey,
        extraHeaders: () => this.headersFor(input),
        timeoutMs: this.options.timeoutMs,
        label: "opencode-go/chat",
      });
      yield* transport.generateStream(input, signal);
      return;
    }
    yield {
      type: "error",
      error: {
        code: "bad_request",
        message: `model '${input.modelId}' uses native protocol '${found.native}', not implemented in Etapa 1`,
        retryable: false,
        providerCode: "protocol_not_implemented",
      },
    };
  }

  /**
   * Refresca la tabla desde el catálogo público (sin auth). No toca Console ni cuentas.
   * Entradas defensivas: solo esfuerzos conocidos; protocolos no implementados se marcan igual.
   */
  async refreshCatalog(): Promise<{ ok: boolean; count?: number; error?: string }> {
    try {
      const res = await fetch(`${this.baseURL}/v1/models`);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
      const entries: GoModelEntry[] = [];
      for (const item of body.data ?? []) {
        const id = item.id;
        if (typeof id !== "string") continue;
        const api = item.api as Record<string, { capabilities?: { tools?: { choice?: string[] } } }> | undefined;
        const native = Object.keys(api ?? {})[0] as GoNativeApi | undefined;
        if (!native) continue;
        const caps = item.capabilities as
          | { tools?: { supported?: boolean }; reasoning?: { supported?: boolean; effort?: string[] } }
          | undefined;
        const limit = item.limit as { context?: number; output?: number } | undefined;
        const cost = (item.cost as { text?: { input?: { price?: number; cache?: { read?: number } }; output?: { price?: number } } } | undefined)?.text;
        const modalities = item.modalities as { input?: string[] } | undefined;
        const efforts = (caps?.reasoning?.effort ?? []).filter((e): e is ReasoningEffort =>
          (KNOWN_EFFORTS as string[]).includes(e),
        );
        entries.push({
          providerId: "opencode-go",
          modelId: id,
          displayName: typeof item.name === "string" ? item.name : id,
          native,
          toolChoice: api?.[native]?.capabilities?.tools?.choice ?? [],
          capabilities: {
            toolCall: caps?.tools?.supported === true,
            reasoningEfforts: efforts,
            maxContextTokens: limit?.context ?? 0,
            maxOutputTokens: limit?.output ?? 0,
            supportsImages: (modalities?.input ?? []).some((m) => m.startsWith("image/")),
            priceInputPerM: cost?.input?.price,
            priceOutputPerM: cost?.output?.price,
            priceCacheReadPerM: cost?.input?.cache?.read,
            pricingSource: `${this.baseURL}/v1/models`,
            pricingDate: new Date().toISOString().slice(0, 10),
          },
          restricted: /contributor/i.test(id) ? "contributor-training" : undefined,
        });
      }
      if (entries.length > 0) this.table = entries;
      return { ok: true, count: entries.length };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Prueba de conexión con coste mínimo documentado: el catálogo es público y no
   * valida la clave, así que genera 1 token en el modelo más barato de la shortlist.
   */
  async test(): Promise<{ ok: boolean; error?: string; spentInputTokens?: number }> {
    const found = this.table.find((m) => m.modelId === "glm-5.3-flash" && !m.restricted) ?? this.table.find((m) => !m.restricted);
    if (!found) return { ok: false, error: "no model available for probe" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      let inputTokens = 0;
      for await (const event of this.generateStream(
        {
          providerId: this.id,
          modelId: found.modelId,
          messages: [{ role: "user", blocks: [{ type: "text", text: "Reply with exactly: ok" }] }],
          maxOutputTokens: 8,
          conversationId: `octus-probe-${Date.now()}`,
        },
        controller.signal,
      )) {
        if (event.type === "usage") inputTokens = event.usage.inputTokens;
        if (event.type === "error") return { ok: false, error: `${event.error.code}: ${event.error.message}` };
        if (event.type === "completed") return { ok: true, spentInputTokens: inputTokens };
      }
      return { ok: false, error: "no terminal event" };
    } finally {
      clearTimeout(timeout);
    }
  }
}
