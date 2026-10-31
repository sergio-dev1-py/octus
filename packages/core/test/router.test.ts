import { describe, expect, test } from "bun:test";
import { isOctusError } from "../src/errors.js";
import { expectRejects, makeTestCore } from "./helpers.js";

const CTX = (overrides = {}) => ({
  sessionId: "ses_r",
  runId: "run_r",
  agentInstanceId: "ins_r",
  agentDefinitionId: "coordinator-build",
  providerId: "fake-meta",
  modelId: "muse-wonder-1.0",
  correlationId: "cor_r",
  ...overrides,
});

describe("model router", () => {
  test("resolve follows instance > session > profile > global without silent fallback", async () => {
    const t = await makeTestCore();
    try {
      const global = { providerId: "fake-meta", modelId: "muse-wonder-1.0" };
      expect(t.core.router.resolve({ globalDefault: global }).model.modelId).toBe("muse-wonder-1.0");
      expect(
        t.core.router.resolve({ globalDefault: global, session: { providerId: "fake-go", modelId: "glm-5.3-flash" } }).provider.id,
      ).toBe("fake-go");
      const err = await expectRejects(
        (async () => t.core.router.resolve({ globalDefault: { providerId: "nope", modelId: "x" } }))(),
        /not registered/,
      );
      expect(isOctusError(err, "provider_unavailable")).toBe(true);
      const err2 = await expectRejects(
        (async () => t.core.router.resolve({ globalDefault: { providerId: "fake-meta", modelId: "nope" } }))(),
        /not offered/,
      );
      expect(isOctusError(err2, "model_not_supported")).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  test("paid calls are blocked until budgets are configured", async () => {
    const t = await makeTestCore({ billableFakes: true });
    try {
      const resolution = t.core.router.resolve({ globalDefault: { providerId: "fake-meta", modelId: "muse-wonder-1.0" } });
      const controller = new AbortController();
      const error = await expectRejects(
        (async () => {
          for await (const _ of t.core.router.generateStream(
            resolution,
            { providerId: "fake-meta", modelId: "muse-wonder-1.0", messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }] },
            CTX(),
            controller.signal,
          )) {
            // consume
          }
        })(),
        /not configured/,
      );
      expect(isOctusError(error, "budgets_not_configured")).toBe(true);
      expect(t.fakeMeta.seen).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });

  test("block budget stops generation; every attempt records usage", async () => {
    const t = await makeTestCore({ billableFakes: true });
    try {
      await t.core.configureBudgets([
        { scope: { kind: "run", ref: "" }, limitTokens: 10_000, warnRatio: 0.8, action: "block", window: "span", enabled: true },
      ]);
      const resolution = t.core.router.resolve({ globalDefault: { providerId: "fake-meta", modelId: "muse-wonder-1.0" } });
      const controller = new AbortController();
      const seen: string[] = [];
      for await (const event of t.core.router.generateStream(
        resolution,
        { providerId: "fake-meta", modelId: "muse-wonder-1.0", messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }] },
        CTX(),
        controller.signal,
      )) {
        seen.push(event.type);
      }
      expect(seen).toContain("completed");
      const rows = await t.core.db.query("SELECT * FROM usage_records WHERE run_id = 'run_r'");
      expect(rows).toHaveLength(1);
      // Ahora un presupuesto agotado bloquea antes de llamar
      await t.core.configureBudgets([
        { scope: { kind: "run", ref: "" }, limitTokens: 1, warnRatio: 0.5, action: "block", window: "span", enabled: true },
      ]);
      const callsBefore = t.fakeMeta.seen.length;
      await expectRejects(
        (async () => {
          for await (const _ of t.core.router.generateStream(
            resolution,
            { providerId: "fake-meta", modelId: "muse-wonder-1.0", messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }] },
            CTX(),
            controller.signal,
          )) {
            // consume
          }
        })(),
        /Budget exceeded/,
      );
      expect(t.fakeMeta.seen.length).toBe(callsBefore);
    } finally {
      await t.cleanup();
    }
  });

  test("warnings fire once per budget and window", async () => {
    const t = await makeTestCore({ billableFakes: true });
    try {
      await t.core.configureBudgets([
        { scope: { kind: "global", ref: "" }, limitTokens: 200, warnRatio: 0.5, action: "warn", window: "span", enabled: true },
      ]);
      const warnings: unknown[] = [];
      const stop = t.core.bus.subscribe((e) => {
        if (e.type === "budget.warning") warnings.push(e);
      });
      const resolution = t.core.router.resolve({ globalDefault: { providerId: "fake-meta", modelId: "muse-wonder-1.0" } });
      const run = async () => {
        for await (const _ of t.core.router.generateStream(
          resolution,
          { providerId: "fake-meta", modelId: "muse-wonder-1.0", messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }] },
          CTX(),
          new AbortController().signal,
        )) {
          // consume
        }
      };
      await run(); // 150 tokens: supera el 50% de 200 → avisa
      await run(); // ya avisado: no repite
      stop();
      expect(warnings).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });
});
