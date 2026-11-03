/**
 * @octus/shared — costes: registro de uso (ADR-019).
 * Sin presupuestos (plan todo 7): las llamadas de pago ya no se bloquean.
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
  /** Mensaje asistente al que pertenece el intento. NULL = fila legacy sin footer. */
  messageId?: string | null;
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

/** Totales por mensaje para el footer bajo cada respuesta del asistente.
 *  JAMAS suma todo el run: solo las filas con messageId exacto. */
export interface MessageUsageFooter {
  messageId: string;
  /** Intentos registrados para este mensaje (reintentos incluidos). */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  durationMs: Milliseconds;
  /** Peor estado: failed > cancelled > completed. */
  status: "completed" | "failed" | "cancelled";
  /** Suma de costes conocidos; NULL si ninguna fila tenia precio. */
  costMicroUsd: number | null;
  /** true si alguna fila no tenia tarifa (el footer muestra 'unpriced'). */
  pricingMissing: boolean;
}

/** Footer puro por mensaje: filas con messageId exacto; legacy NULL = sin footer. */
export function footerForMessage(messageId: string, records: UsageRecord[]): MessageUsageFooter | undefined {
  const rows = records.filter((r) => r.messageId === messageId);
  if (rows.length === 0) return undefined;
  let status: MessageUsageFooter["status"] = "completed";
  if (rows.some((r) => r.status === "failed")) status = "failed";
  else if (rows.some((r) => r.status === "cancelled")) status = "cancelled";
  let cost: number | null = null;
  for (const r of rows) {
    if (r.costMicroUsd !== null) cost = (cost ?? 0) + r.costMicroUsd;
  }
  return {
    messageId,
    calls: rows.length,
    inputTokens: rows.reduce((a, r) => a + r.inputTokens, 0),
    outputTokens: rows.reduce((a, r) => a + r.outputTokens, 0),
    reasoningTokens: rows.reduce((a, r) => a + r.reasoningTokens, 0),
    cachedTokens: rows.reduce((a, r) => a + r.cachedTokens, 0),
    durationMs: rows.reduce((a, r) => a + r.durationMs, 0),
    status,
    costMicroUsd: cost,
    pricingMissing: rows.some((r) => r.pricingMissing || r.costMicroUsd === null),
  };
}

/** Duración legible: "7.3s", "12m" o "1h 9m" (estilo opencode). */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Linea del footer por mensaje: "7.3s · 2 tools · 224.2k tok · $0.0123".
 *  Sin toolCalls se conserva el formato anterior (compat con tests viejos). */
export function formatMessageFooter(footer: MessageUsageFooter, toolCalls?: number): string {
  const total = footer.inputTokens + footer.outputTokens;
  const tokens = total >= 1000 ? `${(total / 1000).toFixed(1)}k tok` : `${total} tok`;
  const cost = footer.costMicroUsd === null ? "unpriced" : `$${(footer.costMicroUsd / 1_000_000).toFixed(4)}`;
  const tools = toolCalls === undefined ? "" : ` · ${toolCalls} tool${toolCalls === 1 ? "" : "s"}`;
  return `${formatDuration(footer.durationMs)}${tools} · ${tokens} · ${cost}`;
}


