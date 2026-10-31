import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OctusCore } from "../src/sessions/octus-core.js";
import { MemorySecretStore } from "../src/secrets/secret-store.js";
import { MetaAdapter } from "../src/providers/meta-adapter.js";

let servers: Array<{ stop: () => void }> = [];
afterEach(() => {
  for (const s of servers) s.stop();
  servers = [];
});

function sse(events: Array<Record<string, unknown>>): ReadableStream {
  const enc = new TextEncoder();
  let i = 0;
  let seq = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= events.length) {
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ sequence_number: seq++, ...events[i++] })}\n\n`));
    },
  });
}

describe("integration: ResponsesTransport + Gateway + Runtime (live-shaped)", () => {
  test("tool executes exactly once, result returns with the original call_id, model is asked again", async () => {
    const seen: Array<Record<string, unknown>> = [];
    let calls = 0;
    const created = Math.floor(Date.now() / 1000);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        seen.push(body);
        calls++;
        if (!req.headers.get("authorization")) {
          return Response.json({ error: { message: "Unauthorized", type: "authentication_error", param: null, code: "invalid_api_key" } }, { status: 401 });
        }
        if (calls === 1) {
          // Turno 1: una function_call terminal (SDK-shaped: sin item_id en output_item.*).
          return new Response(
            sse([
              { type: "response.created", response: { id: "r1", object: "response", created_at: created, status: "in_progress", model: body.model } },
              { type: "response.output_item.added", output_index: 0, item: { id: "fc_live", type: "function_call", status: "in_progress", call_id: "call_live_1", name: "read", arguments: "" } },
              { type: "response.function_call_arguments.delta", item_id: "fc_live", output_index: 0, delta: '{"path":' },
              { type: "response.function_call_arguments.delta", item_id: "fc_live", output_index: 0, delta: '"live.txt"}' },
              { type: "response.function_call_arguments.done", item_id: "fc_live", output_index: 0, arguments: '{"path":"live.txt"}' },
              { type: "response.output_item.done", output_index: 0, item: { id: "fc_live", type: "function_call", status: "completed", call_id: "call_live_1", name: "read", arguments: '{"path":"live.txt"}' } },
              { type: "response.completed", response: { id: "r1", object: "response", created_at: created, status: "completed", model: body.model, usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 } } },
            ]),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        // Turno 2: respuesta final en texto.
        return new Response(
          sse([
            { type: "response.created", response: { id: "r2", object: "response", created_at: created, status: "in_progress", model: body.model } },
            { type: "response.output_item.added", output_index: 0, item: { id: "m_1", type: "message", status: "in_progress", role: "assistant", content: [] } },
            { type: "response.content_part.added", item_id: "m_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
            { type: "response.output_text.delta", item_id: "m_1", output_index: 0, content_index: 0, delta: "says integ" },
            { type: "response.output_text.delta", item_id: "m_1", output_index: 0, content_index: 0, delta: "ration-7" },
            { type: "response.content_part.done", item_id: "m_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "says integration-7", annotations: [] } },
            { type: "response.output_item.done", output_index: 0, item: { id: "m_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "says integration-7", annotations: [] }] } },
            { type: "response.completed", response: { id: "r2", object: "response", created_at: created, status: "completed", model: "m", usage: { input_tokens: 120, output_tokens: 8, total_tokens: 128 } } },
          ]),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    servers.push({ stop: () => server.stop() });

    const dir = mkdtempSync(path.join(tmpdir(), "octus-int-"));
    const workspace = path.join(dir, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "live.txt"), "integration-7\n");
    const secrets = new MemorySecretStore();
    const adapter = new MetaAdapter({ baseURL: `http://127.0.0.1:${server.port}/v1`, getApiKey: () => secrets.get("octus.provider.meta.api_key") });
    // Registra el adaptador real apuntando al mock: misma clase que en producción.
    const core = await OctusCore.create({ dataDir: path.join(dir, "data"), primarySecrets: secrets, providers: [adapter] });
    try {
      await secrets.set("octus.provider.meta.api_key", "test-key");
      await core.configureBudgets([
        { scope: { kind: "global", ref: "" }, limitMicroUsd: 1_000_000, warnRatio: 0.8, action: "block", window: "span", enabled: true },
      ]);
      const project = await core.createProject("live", workspace);
      const session = await core.createSession({ projectId: project.id });
      await core.setSessionModel(session.id, { providerId: "meta", modelId: "muse-spark-1.3" });
      const { runId } = await core.prompt(session.id, "Read live.txt and reply with its content.");
      await core.waitForIdle(session.id);

      // El modelo fue preguntado dos veces (segunda solicitud con el resultado).
      expect(seen).toHaveLength(2);
      const second = seen[1]!.input as Array<Record<string, unknown>>;
      const output = second.find((item) => item.type === "function_call_output")!;
      expect(output).toBeDefined();
      expect(output.call_id).toBe("call_live_1");
      expect(String(output.output)).toContain("integration-7");
      const replayedCall = second.find((item) => item.type === "function_call")!;
      expect(replayedCall.call_id).toBe("call_live_1");

      // La herramienta se ejecutó exactamente una vez y completada.
      const invocations = await core.db.query<Record<string, unknown>>("SELECT * FROM tool_invocations WHERE run_id = ?", [runId]);
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toMatchObject({ name: "read", status: "completed" });

      const { run } = await core.getRun(runId);
      expect(run.status).toBe("done");
      const messages = await core.sessionMessages(session.id);
      expect(JSON.stringify(messages)).toContain("integration-7");
    } finally {
      await core.close();
      const { rmSync } = await import("node:fs");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
