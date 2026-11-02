/** Todo workbench-chat-terminal/4: footer puro por mensaje (helper + flujo). */
import { describe, expect, test } from "bun:test";
import { footerForMessage, formatMessageFooter, type UsageRecord } from "../src/costs.js";

function record(overrides: Partial<UsageRecord> & { id: string }): UsageRecord {
  return {
    providerId: "fake-meta",
    modelId: "muse-wonder-1.0",
    agentDefinitionId: "coordinator-build",
    agentInstanceId: "ins_1",
    runId: "run_1",
    sessionId: "ses_1",
    messageId: null,
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    cachedTokens: 0,
    durationMs: 1000,
    status: "completed",
    costMicroUsd: 1000,
    pricingMissing: false,
    createdAt: 1,
    ...overrides,
  };
}

describe("footerForMessage", () => {
  test("sums only the rows of the exact message (never the whole run)", () => {
    const records = [
      record({ id: "u1", messageId: "msg_a", inputTokens: 1000, outputTokens: 500, durationMs: 2000, costMicroUsd: 3000 }),
      record({ id: "u2", messageId: "msg_a", inputTokens: 4000, outputTokens: 2000, durationMs: 5300, costMicroUsd: 9000 }),
      record({ id: "u3", messageId: "msg_b", inputTokens: 99999, outputTokens: 99999, durationMs: 99999, costMicroUsd: 99999 }),
    ];
    const footer = footerForMessage("msg_a", records)!;
    expect(footer.calls).toBe(2);
    expect(footer.inputTokens).toBe(5000);
    expect(footer.outputTokens).toBe(2500);
    expect(footer.durationMs).toBe(7300);
    expect(footer.costMicroUsd).toBe(12000);
    expect(footer.status).toBe("completed");
  });

  test("legacy NULL rows produce no footer", () => {
    const records = [record({ id: "u1", messageId: null }), record({ id: "u2" })];
    expect(footerForMessage("msg_a", records)).toBeUndefined();
  });

  test("unpriced rows show unpriced and worst status wins", () => {
    const records = [
      record({ id: "u1", messageId: "msg_a", status: "completed", costMicroUsd: 500, pricingMissing: false }),
      record({ id: "u2", messageId: "msg_a", status: "cancelled", costMicroUsd: null, pricingMissing: true }),
    ];
    const footer = footerForMessage("msg_a", records)!;
    expect(footer.status).toBe("cancelled");
    expect(footer.costMicroUsd).toBe(500);
    expect(footer.pricingMissing).toBe(true);
    const failed = footerForMessage("msg_a", [
      ...records,
      record({ id: "u3", messageId: "msg_a", status: "failed" }),
    ])!;
    expect(failed.status).toBe("failed");
  });

  test("formats like the screenshot (seconds, k tok, cost or unpriced)", () => {
    const priced = footerForMessage("msg_a", [
      record({ id: "u1", messageId: "msg_a", inputTokens: 200000, outputTokens: 24200, durationMs: 7300, costMicroUsd: 12300 }),
    ])!;
    expect(formatMessageFooter(priced)).toBe("7.3s 224.2k tok · $0.0123");
    const unpriced = footerForMessage("msg_a", [record({ id: "u2", messageId: "msg_a", costMicroUsd: null, pricingMissing: true })])!;
    expect(formatMessageFooter(unpriced)).toContain("unpriced");
  });
});
