/**
 * @octus/shared — costes: registro de uso y presupuestos (ADR-019).
 */
import type { Milliseconds } from "./domain.js";

export interface UsageRecord {
  id: string;
  providerId: string;
  modelId: string;
  agentDefinitionId: string;
  agentInstanceId: string;
  runId: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  durationMs: Milliseconds;
  status: "completed" | "failed" | "cancelled";
  /** Snapshot de tarifas aplicadas (USD por 1M). */
  priceInputPerM?: number;
  priceOutputPerM?: number;
  priceCacheReadPerM?: number;
  pricingSource?: string;
  pricingDate?: string;
  /** Coste estimado en micro-USD (entero). NULL si pricingMissing. */
  costMicroUsd: number | null;
  pricingMissing: boolean;
  createdAt: Milliseconds;
}

export type BudgetScopeKind = "global" | "provider" | "model" | "agent" | "session" | "run";

export interface BudgetScope {
  kind: BudgetScopeKind;
  /** providerId, providerId/modelId, definitionId, sessionId o runId según kind. Vacío en global. */
  ref: string;
}

export interface Budget {
  id: string;
  scope: BudgetScope;
  limitMicroUsd?: number;
  limitTokens?: number;
  warnRatio: number;
  action: "warn" | "block";
  /** month (mes natural UTC) o span (vida del ámbito). */
  window: "month" | "span";
  enabled: boolean;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
}

export interface BudgetUsage {
  budgetId: string;
  spentMicroUsd: number | null;
  spentTokens: number;
  warned: boolean;
  exceeded: boolean;
  /** true si alguna fila del ámbito carece de tarifa (el gasto es una cota inferior). */
  costIncomplete: boolean;
}
