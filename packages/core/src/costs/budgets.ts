/**
 * @octus/core — presupuestos: gasto por ámbito y evaluación warn/block (ADR-019).
 * Sin límites configurados por el usuario no hay llamadas de pago (puerta del propietario).
 */
import type { Budget, BudgetUsage } from "@octus/shared";
import { createId } from "@octus/shared";
import { now } from "../util.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import type { SqlParam } from "../persistence/protocol.js";

export const BUDGETS_CONFIGURED_KEY = "budgets.configured";

export async function budgetsConfigured(db: PersistenceService): Promise<boolean> {
  const row = await db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", [BUDGETS_CONFIGURED_KEY]);
  return row?.value === "1";
}

export async function markBudgetsConfigured(db: PersistenceService): Promise<void> {
  await db.exec("INSERT INTO kv (key, value, updated_at) VALUES (?, '1', ?) ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at", [
    BUDGETS_CONFIGURED_KEY,
    now(),
  ]);
}

export function monthStartUtc(at: Date = new Date()): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
}

export function monthKeyUtc(at: Date = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface SpendScope {
  providerId?: string;
  modelId?: string;
  agentDefinitionId?: string;
  sessionId?: string;
  runId?: string;
}

export interface Spend {
  microUsd: number;
  tokens: number;
  costIncomplete: boolean;
}

export async function spendInWindow(
  db: PersistenceService,
  scope: SpendScope,
  window: "month" | "span",
  at: Date = new Date(),
): Promise<Spend> {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (scope.providerId) {
    clauses.push("provider_id = ?");
    params.push(scope.providerId);
  }
  if (scope.modelId) {
    clauses.push("model_id = ?");
    params.push(scope.modelId);
  }
  if (scope.agentDefinitionId) {
    clauses.push("agent_definition_id = ?");
    params.push(scope.agentDefinitionId);
  }
  if (scope.sessionId) {
    clauses.push("session_id = ?");
    params.push(scope.sessionId);
  }
  if (scope.runId) {
    clauses.push("run_id = ?");
    params.push(scope.runId);
  }
  if (window === "month") {
    clauses.push("created_at >= ?");
    params.push(monthStartUtc(at));
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = await db.queryOne<{ micro_usd: number | null; tokens: number | null; missing: number }>(
    `SELECT COALESCE(SUM(cost_micro_usd), 0) AS micro_usd,
            COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
            COALESCE(SUM(CASE WHEN cost_micro_usd IS NULL THEN 1 ELSE 0 END), 0) AS missing
     FROM usage_records ${where}`,
    params,
  );
  return { microUsd: row?.micro_usd ?? 0, tokens: row?.tokens ?? 0, costIncomplete: (row?.missing ?? 0) > 0 };
}

export interface BudgetEvaluation {
  budget: Budget;
  spend: Spend;
  warned: boolean;
  exceeded: boolean;
  windowKey: string;
}

function scopeOf(budget: Budget, ctx: SpendScope): SpendScope {
  switch (budget.scope.kind) {
    case "global":
      return {};
    case "provider":
      return { providerId: budget.scope.ref };
    case "model": {
      const [providerId, modelId] = budget.scope.ref.split("/");
      return { providerId, modelId };
    }
    case "agent":
      return { agentDefinitionId: budget.scope.ref };
    case "session":
      return { sessionId: ctx.sessionId };
    case "run":
      return { runId: ctx.runId };
  }
}

function budgetApplies(budget: Budget, ctx: Required<SpendScope>): boolean {
  if (!budget.enabled) return false;
  switch (budget.scope.kind) {
    case "global":
      return true;
    case "provider":
      return budget.scope.ref === ctx.providerId;
    case "model":
      return budget.scope.ref === `${ctx.providerId}/${ctx.modelId}`;
    case "agent":
      return budget.scope.ref === ctx.agentDefinitionId;
    case "session":
      return true;
    case "run":
      return true;
  }
}

export async function listBudgets(db: PersistenceService): Promise<Budget[]> {
  const rows = await db.query<Record<string, string | number | null>>("SELECT * FROM budgets ORDER BY created_at ASC");
  return rows.map((row) => ({
    id: String(row.id),
    scope: { kind: row.scope_kind as Budget["scope"]["kind"], ref: String(row.scope_ref ?? "") },
    limitMicroUsd: row.limit_micro_usd === null ? undefined : Number(row.limit_micro_usd),
    limitTokens: row.limit_tokens === null ? undefined : Number(row.limit_tokens),
    warnRatio: Number(row.warn_ratio),
    action: row.action as Budget["action"],
    window: row.window as Budget["window"],
    enabled: Number(row.enabled) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

export async function saveBudgets(
  db: PersistenceService,
  budgets: Array<Omit<Budget, "id" | "createdAt" | "updatedAt">>,
): Promise<Budget[]> {
  const timestamp = now();
  const statements: Array<{ sql: string; params: SqlParam[] }> = [{ sql: "DELETE FROM budgets", params: [] }];
  const saved = budgets.map((b) => ({ ...b, id: createId("bud"), createdAt: timestamp, updatedAt: timestamp }));
  for (const b of saved) {
    statements.push({
      sql: "INSERT INTO budgets (id, scope_kind, scope_ref, limit_micro_usd, limit_tokens, warn_ratio, action, window, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params: [
        b.id,
        b.scope.kind,
        b.scope.ref,
        b.limitMicroUsd ?? null,
        b.limitTokens ?? null,
        b.warnRatio,
        b.action,
        b.window,
        b.enabled ? 1 : 0,
        b.createdAt,
        b.updatedAt,
      ],
    });
  }
  await db.batch(statements);
  await markBudgetsConfigured(db);
  return saved;
}

export async function evaluateBudgets(
  db: PersistenceService,
  ctx: Required<SpendScope>,
  at: Date = new Date(),
): Promise<BudgetEvaluation[]> {
  const budgets = await listBudgets(db);
  const out: BudgetEvaluation[] = [];
  for (const budget of budgets) {
    if (!budgetApplies(budget, ctx)) continue;
    const spend = await spendInWindow(db, scopeOf(budget, ctx), budget.window, at);
    const windowKey = budget.window === "month" ? monthKeyUtc(at) : "span";
    const moneyExceeded = budget.limitMicroUsd !== undefined && spend.microUsd >= budget.limitMicroUsd;
    const tokensExceeded = budget.limitTokens !== undefined && spend.tokens >= budget.limitTokens;
    const exceeded = moneyExceeded || tokensExceeded;
    const moneyWarned = budget.limitMicroUsd !== undefined && spend.microUsd >= budget.limitMicroUsd * budget.warnRatio;
    const tokensWarned = budget.limitTokens !== undefined && spend.tokens >= budget.limitTokens * budget.warnRatio;
    out.push({ budget, spend, warned: moneyWarned || tokensWarned, exceeded, windowKey });
  }
  return out;
}

/** Aviso idempotente por presupuesto y ventana: devuelve true solo la primera vez. */
export async function claimWarning(db: PersistenceService, budgetId: string, windowKey: string): Promise<boolean> {
  const key = `budget.warned.${budgetId}.${windowKey}`;
  const existing = await db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", [key]);
  if (existing) return false;
  await db.exec("INSERT INTO kv (key, value, updated_at) VALUES (?, '1', ?)", [key, now()]);
  return true;
}

export async function usageByBudget(db: PersistenceService, ctx: Required<SpendScope>): Promise<BudgetUsage[]> {
  const evaluations = await evaluateBudgets(db, ctx);
  return evaluations.map((e) => ({
    budgetId: e.budget.id,
    spentMicroUsd: e.spend.microUsd,
    spentTokens: e.spend.tokens,
    warned: e.warned,
    exceeded: e.exceeded,
    costIncomplete: e.spend.costIncomplete,
  }));
}
