/** Todo workbench-chat-terminal/4: messageId persiste y el flujo lo threadea. */
import { describe, expect, test } from "bun:test";
import { footerForMessage } from "@octus/shared";
import { recordUsage, usageForMessage, usageForRun } from "../src/costs/usage.js";
import { makeTestCore } from "./helpers.js";

const CTX = (overrides = {}) => ({
  sessionId: "ses_m",
  runId: "run_m",
  agentInstanceId: "ins_m",
  agentDefinitionId: "coordinator-build",
  providerId: "fake-meta",
  modelId: "muse-wonder-1.0",
  correlationId: "cor_m",
  ...overrides,
});

describe("usage messageId", () => {
  test("recordUsage persists messageId and legacy rows stay NULL", async () => {
    const t = await makeTestCore({ billableFakes: true });
    try {
      const usage = { inputTokens: 100, outputTokens: 50, reasoningTokens: 0, cachedTokens: 0 };
      await recordUsage(t.core.db, CTX({ messageId: "msg_a" }), usage, 1200, "completed");
      await recordUsage(t.core.db, CTX(), usage, 800, "completed");
      const forMsg = await usageForMessage(t.core.db, "msg_a");
      expect(forMsg).toHaveLength(1);
      expect(forMsg[0]!.messageId).toBe("msg_a");
      const run = await usageForRun(t.core.db, "run_m");
      expect(run).toHaveLength(2);
      const legacy = run.find((r) => r.messageId !== "msg_a");
      expect(legacy!.messageId).toBeNull();
      // El footer solo suma msg_a, nunca todo el run.
      expect(footerForMessage("msg_a", run)!.durationMs).toBe(1200);
      expect(footerForMessage("msg_other", run)).toBeUndefined();
    } finally {
      await t.cleanup();
    }
  });

  test("generateStream records the threaded messageId before the terminal event", async () => {
    const t = await makeTestCore({ billableFakes: true });
    try {
      const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
      const stop = t.core.bus.subscribe((e) => {
        events.push(e as { type: string; payload?: Record<string, unknown> });
      });
      const resolution = t.core.router.resolve({ globalDefault: { providerId: "fake-meta", modelId: "muse-wonder-1.0" } });
      const seen: string[] = [];
      for await (const event of t.core.router.generateStream(
        resolution,
        { providerId: "fake-meta", modelId: "muse-wonder-1.0", messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }] },
        CTX({ messageId: "msg_flow" }),
        new AbortController().signal,
      )) {
        seen.push(event.type);
      }
      stop();
      expect(seen).toContain("completed");
      const rows = await usageForMessage(t.core.db, "msg_flow");
      expect(rows).toHaveLength(1);
      const recorded = events.filter((e) => e.type === "provider.usage_recorded");
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.payload?.messageId).toBe("msg_flow");
    } finally {
      await t.cleanup();
    }
  });
});
