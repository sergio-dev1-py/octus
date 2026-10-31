/**
 * @octus/core — tarifas verificadas y cálculo de coste (ADR-019).
 * Toda tarifa lleva fuente y fecha. Sin tarifa verificada: coste NULL + pricingMissing.
 */
import type { TokenUsage } from "@octus/shared";

export interface Tariff {
  priceInputPerM: number;
  priceOutputPerM: number;
  priceCacheReadPerM: number;
  source: string;
  date: string;
  /** Multiplicador dependiente del instante y/o del uso (peak DeepSeek, tramos por contexto). 1 por defecto. */
  multiplierAt?: (at: Date, usage: TokenUsage) => number;
  multiplierNote?: string;
}

const META_SOURCE = "https://dev.meta.ai/docs/pricing-rate-limits";
const META_DATE = "2026-10-30";
const GO_SOURCE = "https://opencode.ai/inference/go/v1/models";
const GO_DATE = "2026-10-30";

/** Peak DeepSeek en Go: L–V 01:00–04:00 y 06:00–10:00 UTC (documentado en /console/go). */
function deepseekPeakMultiplier(at: Date): number {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return 1;
  const mins = at.getUTCHours() * 60 + at.getUTCMinutes();
  const inWindow = (a: number, b: number) => mins >= a && mins < b;
  return inWindow(60, 240) || inWindow(360, 600) ? 2 : 1;
}

const TARIFFS: Record<string, Tariff> = {
  "meta/muse-wonder-1.0": {
    priceInputPerM: 4.0,
    priceOutputPerM: 20.0,
    priceCacheReadPerM: 0.2,
    source: META_SOURCE,
    date: META_DATE,
  },
  "meta/muse-spark-1.3": {
    priceInputPerM: 1.25,
    priceOutputPerM: 4.25,
    priceCacheReadPerM: 0.15,
    source: META_SOURCE,
    date: META_DATE,
  },
  "opencode-go/glm-5.3-flash": {
    priceInputPerM: 0.15,
    priceOutputPerM: 0.5,
    priceCacheReadPerM: 0.03,
    source: GO_SOURCE,
    date: GO_DATE,
  },
  "opencode-go/deepseek-v4.1-flash": {
    priceInputPerM: 0.15,
    priceOutputPerM: 0.6,
    priceCacheReadPerM: 0.003,
    source: GO_SOURCE,
    date: GO_DATE,
    multiplierAt: deepseekPeakMultiplier,
    multiplierNote: "x2 en peak L–V 01:00–04:00 y 06:00–10:00 UTC",
  },
  "opencode-go/glm-5.3": {
    priceInputPerM: 1.4,
    priceOutputPerM: 4.4,
    priceCacheReadPerM: 0.26,
    source: GO_SOURCE,
    date: GO_DATE,
  },
  "opencode-go/grok-4.7": {
    priceInputPerM: 2.0,
    priceOutputPerM: 6.0,
    priceCacheReadPerM: 0.5,
    source: GO_SOURCE,
    date: GO_DATE,
    multiplierAt: (_at, usage) => (usage.inputTokens + usage.outputTokens > 200_000 ? 2 : 1),
    multiplierNote: "x2 con contexto >200K tokens",
  },
  "opencode-go/gpt-6-luna": {
    priceInputPerM: 0.1,
    priceOutputPerM: 0.5,
    priceCacheReadPerM: 0.01,
    source: GO_SOURCE,
    date: GO_DATE,
    multiplierAt: (_at, usage) => (usage.inputTokens + usage.outputTokens > 272_000 ? 2 : 1),
    multiplierNote: "x2 aprox. con contexto >272K tokens (tramos documentados)",
  },
  "opencode-go/kimi-k3": {
    priceInputPerM: 3.0,
    priceOutputPerM: 15.0,
    priceCacheReadPerM: 0.3,
    source: GO_SOURCE,
    date: GO_DATE,
  },
  "opencode-go/kimi-k3.1-pro": {
    priceInputPerM: 2.0,
    priceOutputPerM: 10.0,
    priceCacheReadPerM: 0.2,
    source: GO_SOURCE,
    date: GO_DATE,
  },
  "opencode-go/beam-free": {
    priceInputPerM: 0,
    priceOutputPerM: 0,
    priceCacheReadPerM: 0,
    source: GO_SOURCE,
    date: GO_DATE,
  },
  "opencode-go/muse-spark-1.3-contributor": {
    priceInputPerM: 0.1,
    priceOutputPerM: 0.2,
    priceCacheReadPerM: 0.002,
    source: GO_SOURCE,
    date: GO_DATE,
  },
};

export function tariffFor(providerId: string, modelId: string): Tariff | undefined {
  return TARIFFS[`${providerId}/${modelId}`];
}

/**
 * Coste estimado en micro-USD (entero). La caché se tarifa a su precio en lugar
 * del de entrada (estándar Meta/OpenAI); el razonamiento ya va dentro de output.
 */
export function costMicroUsd(tariff: Tariff, usage: TokenUsage, at: Date = new Date()): number {
  const mult = tariff.multiplierAt?.(at, usage) ?? 1;
  const freshInput = Math.max(0, usage.inputTokens - usage.cachedTokens);
  const per1M = freshInput * tariff.priceInputPerM + usage.cachedTokens * tariff.priceCacheReadPerM + usage.outputTokens * tariff.priceOutputPerM;
  return Math.round(per1M * mult);
}
