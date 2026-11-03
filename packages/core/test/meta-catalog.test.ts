import { afterEach, describe, expect, test } from "bun:test";
import { MetaAdapter } from "../src/providers/meta-adapter.js";

let servers: Array<{ stop: () => void }> = [];
afterEach(() => {
  for (const s of servers) s.stop();
  servers = [];
});

function startModelsMock(data: unknown): string {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/models") return Response.json({ data });
      return new Response("not found", { status: 404 });
    },
  });
  servers.push({ stop: () => server.stop(true) });
  return `http://127.0.0.1:${server.port}`;
}

describe("meta catalog (modelos vivos con esfuerzos exactos)", () => {
  test("refresh trae el catálogo y aplica esfuerzos curados por modelo", async () => {
    const url = startModelsMock([
      { id: "muse-wonder-1.0" },
      { id: "muse-spark-1.3-contributor" },
      { id: "muse-nuevo-2.0", name: "Muse Nuevo", capabilities: { reasoning: { effort: ["low", "medium"] } } },
      { id: "muse-otro-1.0" },
    ]);
    const adapter = new MetaAdapter({ baseURL: url, getApiKey: async () => "k" });
    const res = await adapter.refreshCatalog();
    expect(res.ok).toBe(true);
    expect(res.count).toBe(4);
    const models = adapter.models();
    const contributor = models.find((m) => m.modelId === "muse-spark-1.3-contributor")!;
    expect(contributor.capabilities.reasoningEfforts).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(contributor.capabilities.reasoningEfforts).not.toContain("max");
    const declared = models.find((m) => m.modelId === "muse-nuevo-2.0")!;
    expect(declared.displayName).toBe("Muse Nuevo");
    expect(declared.capabilities.reasoningEfforts).toEqual(["low", "medium"]);
    // Los conocidos conservan sus capacidades verificadas.
    const wonder = models.find((m) => m.modelId === "muse-wonder-1.0")!;
    expect(wonder.capabilities.maxContextTokens).toBe(1_048_576);
    expect(wonder.capabilities.reasoningEfforts).toContain("max");
    // Sin metadatos: set completo (comportamiento anterior).
    expect(models.find((m) => m.modelId === "muse-otro-1.0")!.capabilities.reasoningEfforts).toContain("max");
  });

  test("sin key no vacía el catálogo por defecto", async () => {
    const adapter = new MetaAdapter({ baseURL: "http://127.0.0.1:1", getApiKey: async () => undefined });
    const res = await adapter.refreshCatalog();
    expect(res.ok).toBe(false);
    expect(adapter.models().map((m) => m.modelId)).toEqual(["muse-wonder-1.0", "muse-spark-1.3"]);
  });
});
