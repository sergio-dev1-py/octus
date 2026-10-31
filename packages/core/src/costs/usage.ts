/**
 * @octus/core — registro de uso por llamada (ADR-019). Ninguna llamada sin fila.
 */
import type { TokenUsage, UsageRecord } from "@octus/shared";
import { createId } from "@octus/shared";
import { now } from "../util.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { costMicroUsd, tariffFor } from "../providers/pricing.js";

export interface UsageContext {
  providerId: string;
  modelId: string;
  agentDefinitionId: string;
  agentInstanceId: string;
  runId: string;
  sessionId: string;
}

export async function recordUsage(
  db: PersistenceService,
  ctx: UsageContext,
  usage: TokenUsage,
  durationMs: number,
  status: UsageRecord["status"],
  at: Date = new Date(),
): Promise<UsageRecord> {
  const tariff = tariffFor(ctx.providerId, ctx.modelId);
  const record: UsageRecord = {
    id: createId("use"),
    ...ctx,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedTokens: usage.cachedTokens,
    durationMs,
    status,
    priceInputPerM: tariff?.priceInputPerM,
    priceOutputPerM: tariff?.priceOutputPerM,
    priceCacheReadPerM: tariff?.priceCacheReadPerM,
    pricingSource: tariff?.source,
    pricingDate: tariff?.date,
    costMicroUsd: tariff ? costMicroUsd(tariff, usage, at) : null,
    pricingMissing: !tariff,
    createdAt: now(),
  };
  await db.exec(
    `INSERT INTO usage_records (id, provider_id, model_id, agent_definition_id, agent_instance_id, run_id, session_id,
      input_tokens, output_tokens, reasoning_tokens, cached_tokens, duration_ms, status,
      price_input_per_m, price_output_per_m, price_cache_read_per_m, pricing_source, pricing_date,
      cost_micro_usd, pricing_missing, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.providerId,
      record.modelId,
      record.agentDefinitionId,
      record.agentInstanceId,
      record.runId,
      record.sessionId,
      record.inputTokens,
      record.outputTokens,
      record.reasoningTokens,
      record.cachedTokens,
      record.durationMs,
      record.status,
      record.priceInputPerM ?? null,
      record.priceOutputPerM ?? null,
      record.priceCacheReadPerM ?? null,
      record.pricingSource ?? null,
      record.pricingDate ?? null,
      record.costMicroUsd,
      record.pricingMissing ? 1 : 0,
      record.createdAt,
    ],
  );
  return record;
}

export async function usageForRun(db: PersistenceService, runId: string): Promise<UsageRecord[]> {
  const rows = await db.query<Record<string, string | number | null>>(
    "SELECT * FROM usage_records WHERE run_id = ? ORDER BY created_at ASC",
    [runId],
  );
  return rows.map(deserialize);
}

export async function usageForSession(db: PersistenceService, sessionId: string): Promise<UsageRecord[]> {
  const rows = await db.query<Record<string, string | number | null>>(
    "SELECT * FROM usage_records WHERE session_id = ? ORDER BY created_at ASC",
    [sessionId],
  );
  return rows.map(deserialize);
}

function deserialize(row: Record<string, string | number | null>): UsageRecord {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    modelId: String(row.model_id),
    agentDefinitionId: String(row.agent_definition_id),
    agentInstanceId: String(row.agent_instance_id),
    runId: String(row.run_id),
    sessionId: String(row.session_id),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    cachedTokens: Number(row.cached_tokens),
    durationMs: Number(row.duration_ms),
    status: row.status as UsageRecord["status"],
    priceInputPerM: row.price_input_per_m === null ? undefined : Number(row.price_input_per_m),
    priceOutputPerM: row.price_output_per_m === null ? undefined : Number(row.price_output_per_m),
    priceCacheReadPerM: row.price_cache_read_per_m === null ? undefined : Number(row.price_cache_read_per_m),
    pricingSource: row.pricing_source ? String(row.pricing_source) : undefined,
    pricingDate: row.pricing_date ? String(row.pricing_date) : undefined,
    costMicroUsd: row.cost_micro_usd === null ? null : Number(row.cost_micro_usd),
    pricingMissing: Number(row.pricing_missing) === 1,
    createdAt: Number(row.created_at),
  };
}
