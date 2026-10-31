/**
 * Tests del override de modelos live (solo harness live).
 * Garantizan que un override nunca vuelva silenciosamente a un modelo caro.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LIVE_META_EFFORT,
  DEFAULT_LIVE_META_MODEL,
  ensureLiveMetaModel,
  isContributorModel,
  liveConfigBanner,
  resolveLiveMetaConfig,
  supportsEffort,
  type LiveMetaConfig,
} from "./live-config.js";
import type { ModelDescriptor } from "@octus/shared";

function sparkDescriptor(): ModelDescriptor {
  return {
    providerId: "meta",
    modelId: "muse-spark-1.3",
    displayName: "Spark",
    capabilities: {
      toolCall: true,
      reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
      maxContextTokens: 1,
      maxOutputTokens: 1,
      supportsImages: false,
    },
  };
}

describe("live-config overrides", () => {
  test("defaults are documented cheap values when env is missing", () => {
    const config = resolveLiveMetaConfig({});
    expect(config.modelId).toBe(DEFAULT_LIVE_META_MODEL);
    expect(config.effort).toBe(DEFAULT_LIVE_META_EFFORT);
    expect(config.modelSource).toBe("default");
    expect(config.effortSource).toBe("default");
    expect(DEFAULT_LIVE_META_MODEL).toBe("muse-spark-1.3");
    expect(DEFAULT_LIVE_META_EFFORT).toBe("low");
  });

  test("env override is respected exactly (contributor + low)", () => {
    const config = resolveLiveMetaConfig({
      OCTUS_LIVE_META_MODEL: "muse-spark-1.3-contributor",
      OCTUS_LIVE_META_REASONING_EFFORT: "low",
    });
    expect(config.modelId).toBe("muse-spark-1.3-contributor");
    expect(config.effort).toBe("low");
    expect(config.modelSource).toBe("env");
    expect(config.effortSource).toBe("env");
    expect(config.modelId).not.toContain("wonder");
  });

  test("invalid effort fails fast without silent fallback", () => {
    expect(() => resolveLiveMetaConfig({ OCTUS_LIVE_META_REASONING_EFFORT: "ultra" })).toThrow(/Invalid OCTUS_LIVE_META_REASONING_EFFORT/);
    // Modelo en blanco equivale a ausente: usa el predeterminado barato documentado.
    expect(resolveLiveMetaConfig({ OCTUS_LIVE_META_MODEL: "   " }).modelId).toBe(DEFAULT_LIVE_META_MODEL);
  });

  test("contributor does not support max (SKIP signal, never Wonder)", () => {
    const models: ModelDescriptor[] = [sparkDescriptor()];
    const provider = { models: () => models };
    const ensured = ensureLiveMetaModel(provider, "muse-spark-1.3-contributor");
    expect(ensured.extended).toBe(true);
    expect(isContributorModel("muse-spark-1.3-contributor")).toBe(true);
    expect(supportsEffort(provider.models(), "muse-spark-1.3-contributor", "max")).toBe(false);
    expect(supportsEffort(provider.models(), "muse-spark-1.3-contributor", "low")).toBe(true);
    // La extensión no introduce Wonder por la puerta de atrás.
    expect(provider.models().some((m) => m.modelId.includes("wonder"))).toBe(false);
  });

  test("already-offered models are not extended and unknown models are not invented", () => {
    const provider = { models: () => [sparkDescriptor()] };
    expect(ensureLiveMetaModel(provider, "muse-spark-1.3")).toEqual({ extended: false, alreadyOffered: true });
    expect(provider.models()).toHaveLength(1);
    expect(ensureLiveMetaModel(provider, "muse-ghost-9.9")).toEqual({ extended: false, alreadyOffered: false });
    expect(provider.models()).toHaveLength(1);
  });

  test("banner shows identifiers and sources clearly", () => {
    const config: LiveMetaConfig = { modelId: "muse-spark-1.3-contributor", effort: "low", modelSource: "env", effortSource: "env" };
    const banner = liveConfigBanner(config);
    expect(banner).toContain("muse-spark-1.3-contributor");
    expect(banner).toContain("low");
    expect(banner).toContain("(env)");
    expect(banner).toContain(DEFAULT_LIVE_META_MODEL);
  });
});
