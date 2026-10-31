/**
 * @octus/core — ModelRouter: resolución, puerta de presupuestos y un intento con registro.
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
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { budgetsConfigured, claimWarning, evaluateBudgets } from "../costs/budgets.js";
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
   * Un intento de generación: puerta de presupuestos → stream → registro de uso.
   * Los errores retryable se propagan como evento `error`; el runtime decide el reintento.
   */
  async *generateStream(
    resolution: ModelResolution,
    input: GenerateInput,
    ctx: RouterGenerateContext,
    signal: AbortSignal,
  ): AsyncIterable<ProviderStreamEvent> {
    const started = now();
    if (resolution.provider.billable) {
      await this.enforceBudgets(resolution, ctx);
    }
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
        payload: { usageRecordId: row.id, modelId: ctx.modelId, status, costMicroUsd: row.costMicroUsd },
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

  private async enforceBudgets(resolution: ModelResolution, ctx: RouterGenerateContext): Promise<void> {
    if (!(await budgetsConfigured(this.db))) {
      throw new OctusError(
        "budgets_not_configured",
        "Consumption limits are not configured. Open Settings → Budgets and save limits before enabling paid calls.",
      );
    }
    const evaluations = await evaluateBudgets(this.db, {
      providerId: resolution.provider.id,
      modelId: resolution.model.modelId,
      agentDefinitionId: ctx.agentDefinitionId,
      sessionId: ctx.sessionId,
      runId: ctx.runId,
    });
    for (const evaluation of evaluations) {
      if (evaluation.exceeded && evaluation.budget.action === "block") {
        const event = await this.events.append({
          type: "budget.exceeded",
          aggregate: { kind: "budget", id: evaluation.budget.id },
          correlationId: ctx.correlationId,
          payload: { scope: evaluation.budget.scope, spend: evaluation.spend },
        });
        this.bus.publish(event);
        throw new OctusError("budget_exceeded", `Budget exceeded (${evaluation.budget.scope.kind}). Generation blocked.`, {
          details: { budgetId: evaluation.budget.id },
        });
      }
    }
    for (const evaluation of evaluations) {
      if (evaluation.warned && (await claimWarning(this.db, evaluation.budget.id, evaluation.windowKey))) {
        const event = await this.events.append({
          type: "budget.warning",
          aggregate: { kind: "budget", id: evaluation.budget.id },
          correlationId: ctx.correlationId,
          payload: { scope: evaluation.budget.scope, spend: evaluation.spend },
        });
        this.bus.publish(event);
      }
    }
  }
}
