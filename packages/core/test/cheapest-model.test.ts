import { describe, expect, test } from "bun:test";
import { selectCheapestToolCallModel, type CheapestCandidate } from "../src/providers/model-router.js";
import { makeTestCore, workspaceOf } from "./helpers.js";

function cand(providerId: string, modelId: string, toolCall: boolean, prices?: { in: number; out: number; cache: number }, restricted?: string): CheapestCandidate {
  return {
    providerId,
    modelId,
    capabilities: {
      toolCall,
      ...(prices ? { priceInputPerM: prices.in, priceOutputPerM: prices.out, priceCacheReadPerM: prices.cache } : {}),
    },
    ...(restricted ? { restricted } : {}),
  };
}

describe("selectCheapestToolCallModel", () => {
  test("picks the cheapest toolCall model by verified tariff (beam-free is 0/0)", () => {
    const at = new Date(Date.UTC(2026, 10, 1, 12, 0, 0)); // Sunday noon: no peak multipliers
    const out = selectCheapestToolCallModel(
      [
        { providerId: "meta", modelId: "muse-spark-1.3", capabilities: { toolCall: true } },
        { providerId: "opencode-go", modelId: "glm-5.3-flash", capabilities: { toolCall: true } },
        { providerId: "opencode-go", modelId: "beam-free", capabilities: { toolCall: true } },
      ],
      at,
    );
    expect(out).toEqual({ providerId: "opencode-go", modelId: "beam-free" });
  });

  test("excludes non-toolCall models even when free", () => {
    const out = selectCheapestToolCallModel([cand("p", "free-no-tools", false, { in: 0, out: 0, cache: 0 }), cand("p", "paid-tools", true, { in: 1, out: 2, cache: 0.1 })]);
    expect(out).toEqual({ providerId: "p", modelId: "paid-tools" });
  });

  test("excludes restricted (contributor-training) models without opt-in", () => {
    const out = selectCheapestToolCallModel([
      cand("opencode-go", "muse-spark-1.3-contributor", true, undefined, "contributor-training"),
      cand("opencode-go", "glm-5.3-flash", true),
    ]);
    expect(out).toEqual({ providerId: "opencode-go", modelId: "glm-5.3-flash" });
  });

  test("falls back to descriptor prices without a verified tariff", () => {
    const out = selectCheapestToolCallModel([cand("p", "expensive", true, { in: 5, out: 10, cache: 1 }), cand("p", "cheap", true, { in: 0.1, out: 0.2, cache: 0.01 })]);
    expect(out).toEqual({ providerId: "p", modelId: "cheap" });
  });

  test("unpriced models rank after priced ones; ties break alphabetically", () => {
    const out = selectCheapestToolCallModel([cand("p", "mystery", true), cand("p", "cheap", true, { in: 0.1, out: 0.2, cache: 0.01 })]);
    expect(out).toEqual({ providerId: "p", modelId: "cheap" });
    const tie = selectCheapestToolCallModel([cand("b", "same", true, { in: 1, out: 1, cache: 1 }), cand("a", "same", true, { in: 1, out: 1, cache: 1 })]);
    expect(tie).toEqual({ providerId: "a", modelId: "same" });
  });

  test("returns undefined without toolCall candidates", () => {
    expect(selectCheapestToolCallModel([])).toBeUndefined();
    expect(selectCheapestToolCallModel([cand("p", "no-tools", false, { in: 0, out: 0, cache: 0 })])).toBeUndefined();
  });
});

describe("cheapest default + session/workspace memory (todo 9)", () => {
  test("setProviderKey applies one uniform cheapest default to all definitions", async () => {
    const t = await makeTestCore();
    try {
      await t.core.setProviderKey("fake-meta", "key-1");
      const defs = await t.core.agentDefinitions();
      expect(defs.length).toBeGreaterThan(0);
      const models = new Set(defs.map((d) => `${d.defaultModel.providerId}/${d.defaultModel.modelId}`));
      expect(models.size).toBe(1);
    } finally {
      await t.cleanup();
    }
  });

  test("session model persists and prevails; workspace last-model restores on reopen", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("p1", workspaceOf(t));
      const s1 = await t.core.createSession({ projectId: project.id });
      expect(s1.model).toBeUndefined();
      await t.core.setSessionModel(s1.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const got = await t.core.getSession(s1.id);
      expect(got.session.model).toEqual({ providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      // New session in the same workspace inherits the last model (memory wins over cheap default).
      const s2 = await t.core.createSession({ projectId: project.id });
      expect(s2.model).toEqual({ providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      // Another workspace starts without memory.
      const other = await t.core.createProject("p2", workspaceOf(t));
      const s3 = await t.core.createSession({ projectId: other.id });
      expect(s3.model).toBeUndefined();
    } finally {
      await t.cleanup();
    }
  });
});
