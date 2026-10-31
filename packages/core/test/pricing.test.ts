import { describe, expect, test } from "bun:test";
import { costMicroUsd, tariffFor } from "../src/providers/pricing.js";

describe("pricing", () => {
  test("meta tariffs are known with source and date", () => {
    const wonder = tariffFor("meta", "muse-wonder-1.0")!;
    expect(wonder.priceInputPerM).toBe(4.0);
    expect(wonder.priceOutputPerM).toBe(20.0);
    expect(wonder.source).toContain("dev.meta.ai");
    expect(wonder.date).toBe("2026-10-30");
    expect(tariffFor("meta", "nope")).toBeUndefined();
  });

  test("cache is billed at cache rate instead of input rate", () => {
    const spark = tariffFor("meta", "muse-spark-1.3")!;
    // 1M input (200K cached) + 100K output, in micro-USD
    const cost = costMicroUsd(spark, { inputTokens: 1_000_000, outputTokens: 100_000, reasoningTokens: 20_000, cachedTokens: 200_000 });
    const expected = Math.round(800_000 * 1.25 + 200_000 * 0.15 + 100_000 * 4.25);
    expect(cost).toBe(expected);
  });

  test("deepseek peak multiplier doubles off-peak cost on weekday mornings (UTC)", () => {
    const tariff = tariffFor("opencode-go", "deepseek-v4.1-flash")!;
    const usage = { inputTokens: 10_000, outputTokens: 1_000, reasoningTokens: 0, cachedTokens: 0 };
    const peak = new Date(Date.UTC(2026, 9, 30, 7, 0, 0)); // Friday 07:00 UTC
    const offPeak = new Date(Date.UTC(2026, 10, 1, 7, 0, 0)); // Sunday 07:00 UTC
    expect(costMicroUsd(tariff, usage, peak)).toBe(2 * costMicroUsd(tariff, usage, offPeak));
  });

  test("grok context override doubles beyond 200K tokens", () => {
    const tariff = tariffFor("opencode-go", "grok-4.7")!;
    const small = { inputTokens: 10_000, outputTokens: 1_000, reasoningTokens: 0, cachedTokens: 0 };
    const big = { inputTokens: 200_000, outputTokens: 10_000, reasoningTokens: 0, cachedTokens: 0 };
    const at = new Date();
    expect(costMicroUsd(tariff, small, at)).toBe(Math.round(10_000 * 2 + 1_000 * 6));
    expect(costMicroUsd(tariff, big, at)).toBe(Math.round((200_000 * 2 + 10_000 * 6) * 2));
  });
});
