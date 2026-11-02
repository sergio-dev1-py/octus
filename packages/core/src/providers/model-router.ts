/**
 * @octus/core — ModelRouter: resolución y un intento con registro (sin puerta
 * de presupuestos: las llamadas de pago ya no se bloquean — plan todo 7).
 * El reintento vive en el runtime (paso idempotente); aquí cada intento registra su uso.
 */
import type {
  GenerateInput,
  ModelProvider,
  ModelResolution,
  ModelSelection,
  ProviderStreamEvent,
  ReasoningEffort,
  TokenUsage,
} from "@octus/shared";
import { OctusError } from "../errors.js";
import { now } from "../util.js";
import { costMicroUsd, tariffFor } from "./pricing.js";
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { recordUsage, type UsageContext } from "../costs/usage.js";

export interface ResolutionInput {
  instance?: ModelSelection;
  session?: ModelSelection;
  profileDefault?: ModelSelection;
  globalDefault: ModelSelection;
}

export interface RouterGenerateContext extends UsageContext {
  correlationId: string;
}

/** Uso representativo para comparar tarifas (10K entrada / 2K salida / 1K caché). */
const COMPARISON_USAGE: TokenUsage = { inputTokens: 10_000, outputTokens: 2_000, reasoningTokens: 0, cachedTokens: 1_000 };

export interface CheapestCandidate {
  providerId: string;
  modelId: string;
  capabilities: { toolCall: boolean; priceInputPerM?: number; priceOutputPerM?: number; priceCacheReadPerM?: number };
  /** Modelos que entrenan con el contenido: solo opt-in explícito (ADR-005). */
  restricted?: string;
}

function candidateCostMicroUsd(c: CheapestCandidate, at: Date): number {
  const tariff = tariffFor(c.providerId, c.modelId);
  if (tariff) return costMicroUsd(tariff, COMPARISON_USAGE, at);
  const { priceInputPerM, priceOutputPerM, priceCacheReadPerM } = c.capabilities;
  if (priceInputPerM === undefined || priceOutputPerM === undefined || priceCacheReadPerM === undefined) return Number.POSITIVE_INFINITY;
  const fresh = COMPARISON_USAGE.inputTokens - COMPARISON_USAGE.cachedTokens;
  return Math.round(fresh * priceInputPerM + COMPARISON_USAGE.cachedTokens * priceCacheReadPerM + COMPARISON_USAGE.outputTokens * priceOutputPerM);
}

/**
 * El modelo toolCall más barato según pricing.ts (tarifa verificada; si no hay
 * tarifa, precios del descriptor; sin precios queda al final). Solo modelos
 * registrados: el llamador valida con `resolve`. Empate → orden alfabético.
 * Sin candidato toolCall devuelve `undefined` (la UI informa, sin default).
 */
export function selectCheapestToolCallModel(candidates: CheapestCandidate[], at: Date = new Date()): ModelSelection | undefined {
  const eligible = candidates.filter((c) => c.capabilities.toolCall && !c.restricted);
  if (eligible.length === 0) return undefined;
  const ranked = eligible
    .map((c) => ({ c, cost: candidateCostMicroUsd(c, at) }))
    .sort((a, b) => a.cost - b.cost || (a.c.providerId < b.c.providerId ? -1 : a.c.providerId > b.c.providerId ? 1 : 0) || (a.c.modelId < b.c.modelId ? -1 : a.c.modelId > b.c.modelId ? 1 : 0));
  const winner = ranked[0]!.c;
  return { providerId: winner.providerId, modelId: winner.modelId };
}

export class ModelRouter {
  private readonly providers = new Map<string, ModelProvider>();

  constructor(
    private readonly db: PersistenceService,
    private readonly events: EventStore,
    private readonly bus: EventBus,
  ) {}

  register(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(providerId: string): ModelProvider | undefined {
    return this.providers.get(providerId);
  }

  list(): ModelProvider[] {
    return [...this.providers.values()];
  }

  /** Jerarquía Etapa 1: instancia > sesión > perfil > global. Sin fallbacks silenciosos. */
  resolve(input: ResolutionInput): ModelResolution {
    const selected = input.instance ?? input.session ?? input.profileDefault ?? input.globalDefault;
    const provider = this.providers.get(selected.providerId);
    if (!provider) {
      throw new OctusError("provider_unavailable", `provider '${selected.providerId}' is not registered`, {
        details: { providerId: selected.providerId },
      });
    }
    const model = provider.models().find((m) => m.modelId === selected.modelId);
    if (!model) {
      throw new OctusError("model_not_supported", `model '${selected.providerId}/${selected.modelId}' is not offered`, {
        details: { providerId: selected.providerId, modelId: selected.modelId },
      });
    }
    const effort = selected.effort as ReasoningEffort | undefined;
    if (effort && !model.capabilities.reasoningEfforts.includes(effort)) {
      throw new OctusError(
        "effort_not_supported",
        `reasoning effort '${effort}' is not supported by ${selected.providerId}/${selected.modelId}`,
        { details: { providerId: selected.providerId, modelId: selected.modelId, effort } },
      );
    }
    return { provider, model, effort };
  }

  /**
   * Un intento de generación: stream → registro de uso (sin puerta de pago).
   * Los errores retryable se propagan como evento `error`; el runtime decide el reintento.
   */
  async *generateStream(
    resolution: ModelResolution,
    input: GenerateInput,
    ctx: RouterGenerateContext,
    signal: AbortSignal,
  ): AsyncIterable<ProviderStreamEvent> {
    const started = now();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
    let status: "completed" | "failed" | "cancelled" = "failed";
    let recorded = false;
    const record = async () => {
      if (recorded) return;
      recorded = true;
      const row = await recordUsage(this.db, ctx, usage, now() - started, status);
      const event = await this.events.append({
        type: "provider.usage_recorded",
        aggregate: { kind: "provider", id: resolution.provider.id },
        correlationId: ctx.correlationId,
        payload: { usageRecordId: row.id, modelId: ctx.modelId, status, costMicroUsd: row.costMicroUsd, messageId: ctx.messageId ?? null },
      });
      this.bus.publish(event);
    };
    try {
      for await (const event of resolution.provider.generateStream(input, signal)) {
        if (event.type === "usage" || event.type === "completed") usage = event.usage;
        if (event.type === "completed") status = "completed";
        if (event.type === "error" && event.error.code === "aborted") status = "cancelled";
        // El registro precede al evento terminal: un consumidor que corte el stream
        // con `break` no debe poder saltarse la fila de uso (ADR-019).
        if (event.type === "completed" || event.type === "error") {
          await record();
        }
        yield event;
        if (event.type === "completed" || event.type === "error") {
          return;
        }
      }
      await record();
      yield { type: "error", error: { code: "server", message: "provider stream ended without a terminal event", retryable: true } };
    } catch (error) {
      await record();
      throw error;
    }
  }
}


