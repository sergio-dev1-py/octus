import { describe, expect, test } from "bun:test";
import { claimWarning, evaluateBudgets, listBudgets, saveBudgets, spendInWindow } from "../src/costs/budgets.js";
import { recordUsage } from "../src/costs/usage.js";
import { makeTestCore } from "./helpers.js";

const CTX = { providerId: "fake-meta", modelId: "muse-wonder-1.0", agentDefinitionId: "coordinator-build", sessionId: "ses_x", runId: "run_x" };

describe("budgets", () => {
  test("saving budgets marks them configured and persists", async () => {
    const t = await makeTestCore();
    try {
      const saved = await t.core.configureBudgets([
        { scope: { kind: "global", ref: "" }, limitMicroUsd: 1_000_000, warnRatio: 0.8, action: "block", window: "span", enabled: true },
      ]);
      expect(saved).toHaveLength(1);
      const status = await t.core.budgetsStatus();
      expect(status.configured).toBe(true);
      expect(await listBudgets(t.core.db)).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });

  test("spend sums tokens and money per scope", async () => {
    const t = await makeTestCore();
    try {
      await recordUsage(
        t.core.db,
        { ...CTX, agentInstanceId: "ins_1" },
        { inputTokens: 1000, outputTokens: 500, reasoningTokens: 100, cachedTokens: 0 },
        10,
        "completed",
      );
      const spend = await spendInWindow(t.core.db, { sessionId: "ses_x" }, "span");
      expect(spend.tokens).toBe(1500);
      expect(spend.costIncomplete).toBe(true); // fake-meta sin tarifa
    } finally {
      await t.cleanup();
    }
  });

  test("block budget triggers on tokens; warn is idempotent per window", async () => {
    const t = await makeTestCore();
    try {
      const [budget] = await t.core.configureBudgets([
        { scope: { kind: "run", ref: "" }, limitTokens: 1000, warnRatio: 0.5, action: "block", window: "span", enabled: true },
      ]);
      await recordUsage(t.core.db, { ...CTX, agentInstanceId: "ins_1" }, { inputTokens: 600, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 }, 1, "completed");
      let evaluations = await evaluateBudgets(t.core.db, CTX);
      expect(evaluations[0]!.warned).toBe(true);
      expect(evaluations[0]!.exceeded).toBe(false);
      expect(await claimWarning(t.core.db, budget!.id, "span")).toBe(true);
      expect(await claimWarning(t.core.db, budget!.id, "span")).toBe(false);
      await recordUsage(t.core.db, { ...CTX, agentInstanceId: "ins_1" }, { inputTokens: 600, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 }, 1, "completed");
      evaluations = await evaluateBudgets(t.core.db, CTX);
      expect(evaluations[0]!.exceeded).toBe(true);
    } finally {
      await t.cleanup();
    }
  });
});
