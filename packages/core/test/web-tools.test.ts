import { afterEach, describe, expect, test } from "bun:test";
import { DuckDuckGoProvider, assertPublicHttpUrl, fetchPageText, htmlToText, parseDuckDuckGo } from "../src/tools/web-tools.js";
import { expectRejects, makeTestCore, workspaceOf } from "./helpers.js";

let servers: Array<{ stop: () => void }> = [];
afterEach(() => {
  for (const s of servers) s.stop();
  servers = [];
});

describe("web tools (SSRF + parsing)", () => {
  test("private/local URLs are blocked before any fetch", async () => {
    for (const url of ["http://127.0.0.1/", "http://localhost:9/", "http://169.254.169.254/", "http://10.0.0.5/", "file:///etc/passwd", "gopher://x/"]) {
      await expectRejects(assertPublicHttpUrl(url), /Blocked|Only http/);
    }
  });

  test("redirects to private targets are revalidated and blocked", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/go") return Response.redirect("http://127.0.0.1:1/local", 302);
        return new Response("public", { headers: { "content-type": "text/plain" } });
      },
    });
    servers.push({ stop: () => server.stop() });
    // El primer salto es localhost: bloqueado de entrada.
    await expectRejects(fetchPageText(`http://127.0.0.1:${server.port}/go`), /Blocked/);
  });

  test("duckduckgo parser extracts links, unwraps uddg and skips non-http", () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc">Doc <b>title</b></a>
      <a class="result__snippet">A snippet here.</a>
      <a class="result__a" href="https://plain.example/x">Plain</a>
      <a class="result__snippet">Second snippet.</a>
      <a class="result__a" href="/relative/path">Relative</a>`;
    const results = parseDuckDuckGo(html);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: "Doc title", url: "https://example.com/doc", snippet: "A snippet here." });
    expect(results[1]).toMatchObject({ url: "https://plain.example/x" });
    expect(htmlToText("<p>Hello <b>w</b></p><script>evil()</script>")).toBe("Hello w");
  });

  test("provider searches through an injectable base URL", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response('<a class="result__a" href="https://found.example/">Found</a><a class="result__snippet">Snip</a>', { headers: { "content-type": "text/html" } }),
    });
    servers.push({ stop: () => server.stop() });
    const provider = new DuckDuckGoProvider({ baseUrl: `http://127.0.0.1:${server.port}`, allowPrivate: true });
    const results = await provider.search("octus", 5, new AbortController().signal);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ url: "https://found.example/", snippet: "Snip" });
  });

  test("web tools are denied to explorer (outside its profile)", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES ('run_x', ?, 't', 'executing', 'build', 1, 1)", [session.id]);
      const definition = (await t.core.registry.get("explorer"))!;
      const { snapshotOf, promptHashOf } = await import("../src/agents/definition-loader.js");
      await t.core.db.exec(
        "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES ('ins_e', ?, 'run_x', ?, 'running', ?, ?, ?, ?, ?, 1, 1)",
        [session.id, definition.id, JSON.stringify(definition.defaultModel), workspaceOf(t), definition.promptVersion, promptHashOf(definition), JSON.stringify(snapshotOf(definition))],
      );
      const denied = await expectRejects(
        t.core.gateway.execute({ toolCallId: "t1", idempotencyKey: "i-t1", sessionId: session.id, runId: "run_x", instanceId: "ins_e", definitionId: "explorer", directory: workspaceOf(t), name: "websearch", args: { query: "x" } }),
        /denied/i,
      );
      expect(String(denied)).toMatch(/denied/i);
    } finally {
      await t.cleanup();
    }
  });
});
