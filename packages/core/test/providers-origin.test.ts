import { afterEach, describe, expect, test } from "bun:test";
import { makeTestCore } from "./helpers.js";

afterEach(() => {
  delete process.env.OPENCODE_API_KEY;
});

describe("origen de la key del proveedor", () => {
  test("vault tras guardar, null tras quitar", async () => {
    const t = await makeTestCore();
    try {
      await t.core.setProviderKey("fake-meta", "k");
      let providers = await t.core.listProviders();
      expect(providers.find((p) => p.id === "fake-meta")?.configured).toBe(true);
      expect(providers.find((p) => p.id === "fake-meta")?.keyOrigin).toBe("vault");
      await t.core.removeProviderKey("fake-meta");
      providers = await t.core.listProviders();
      expect(providers.find((p) => p.id === "fake-meta")?.configured).toBe(false);
      expect(providers.find((p) => p.id === "fake-meta")?.keyOrigin ?? null).toBe(null);
    } finally {
      await t.cleanup();
    }
  });
});
