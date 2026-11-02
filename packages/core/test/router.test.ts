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

  test("billable calls proceed with no spending-limit configuration (todo 7: paid calls ungated)", async () => {
    const t = await makeTestCore({ billableFakes: true });
    try {
      const resolution = t.core.router.resolve({ globalDefault: { providerId: "fake-meta", modelId: "muse-wonder-1.0" } });
      const seen: string[] = [];
      for await (const event of t.core.router.generateStream(
        resolution,
        { providerId: "fake-meta", modelId: "muse-wonder-1.0", messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }] },
        CTX(),
        new AbortController().signal,
      )) {
        seen.push(event.type);
      }
      expect(seen).toContain("completed");
      expect(t.fakeMeta.seen).toHaveLength(1);
      const rows = await t.core.db.query("SELECT * FROM usage_records WHERE run_id = 'run_r'");
      expect(rows).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });

  test("every billable attempt records usage (sin puerta de pago)", async () => {
    const t = await makeTestCore({ billableFakes: true });
    try {
      const resolution = t.core.router.resolve({ globalDefault: { providerId: "fake-meta", modelId: "muse-wonder-1.0" } });
      const run = async () => {
        const seen: string[] = [];
        for await (const event of t.core.router.generateStream(
          resolution,
          { providerId: "fake-meta", modelId: "muse-wonder-1.0", messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }] },
          CTX(),
          new AbortController().signal,
        )) {
          seen.push(event.type);
        }
        expect(seen).toContain("completed");
      };
      await run();
      await run();
      expect(t.fakeMeta.seen).toHaveLength(2);
      const rows = await t.core.db.query("SELECT * FROM usage_records WHERE run_id = 'run_r'");
      expect(rows).toHaveLength(2);
    } finally {
      await t.cleanup();
    }
  });

  test("no spending-gate events fire during billable generation (todo 7)", async () => {
    const t = await makeTestCore({ billableFakes: true });
    try {
      const seen: Array<{ type: string }> = [];
      const stop = t.core.bus.subscribe((e) => {
        seen.push(e as { type: string });
      });
      const resolution = t.core.router.resolve({ globalDefault: { providerId: "fake-meta", modelId: "muse-wonder-1.0" } });
      for await (const _ of t.core.router.generateStream(
        resolution,
        { providerId: "fake-meta", modelId: "muse-wonder-1.0", messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }] },
        CTX(),
        new AbortController().signal,
      )) {
        // consume
      }
      stop();
      expect(seen.filter((e) => e.type.includes("budget"))).toHaveLength(0);
      expect(seen.filter((e) => e.type === "provider.usage_recorded")).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });
});
