import { afterEach, describe, expect, test } from "bun:test";
import type { GenerateInput, ProviderStreamEvent } from "@octus/shared";
import { ChatTransport } from "../src/providers/chat-transport.js";
import { GoAdapter } from "../src/providers/go-adapter.js";
import { MetaAdapter } from "../src/providers/meta-adapter.js";
import { ResponsesTransport } from "../src/providers/responses-transport.js";

interface SeenRequest {
  method: string;
  path: string;
  headers: Record<string, string | null>;
  body: Record<string, unknown>;
}

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
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ sequence_number: seq++, ...events[i++] })} \n\n`.replace(" \n", "\n")));
    },
  });
}

/** Mock Responses estilo Meta/OpenAI con control por modelo. */
function startResponsesMock(options?: { mode?: "ok" | "unauth" | "rate_limit" | "bad_context" }): { url: string; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      seen.push({
        method: req.method,
        path: url.pathname,
        headers: { authorization: req.headers.get("authorization"), "x-opencode-session": req.headers.get("x-opencode-session"), "user-agent": req.headers.get("user-agent") },
        body,
      });
      const mode = options?.mode ?? "ok";
      if (mode === "unauth" || !req.headers.get("authorization")) {
        return Response.json({ error: { message: "Unauthorized", type: "authentication_error", param: null, code: "invalid_api_key" } }, { status: 401 });
      }
      if (mode === "rate_limit") {
        return Response.json({ error: { message: "slow down", type: "rate_limit_error", param: null, code: "rate_limit_exceeded" } }, { status: 429, headers: { "retry-after": "2" } });
      }
      if (mode === "bad_context") {
        return Response.json({ error: { message: "input tokens exceed the context window", type: "invalid_request_error", param: null, code: null } }, { status: 400 });
      }
      const created = Math.floor(Date.now() / 1000);
      const include = (body.include as string[] | undefined) ?? [];
      if (body.stream) {
        return new Response(
          sse([
            { type: "response.created", response: { id: "resp_1", object: "response", created_at: created, status: "in_progress", model: body.model } },
            // Fiel al SDK: output_item.* NO traen item_id de nivel superior (solo item.id).
            { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", status: "in_progress", summary: [] } },
            { type: "response.output_item.done", output_index: 0, item: { id: "rs_1", type: "reasoning", status: "completed", summary: [], encrypted_content: "ENC_BLOB" } },
            { type: "response.output_item.added", output_index: 1, item: { id: "fc_1", type: "function_call", status: "in_progress", call_id: "call_wx1", name: "get_weather", arguments: "" } },
            { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: '{"loc' },
            { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: 'ation":"S"}' },
            { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1, arguments: '{"location":"S"}' },
            { type: "response.output_item.done", output_index: 1, item: { id: "fc_1", type: "function_call", status: "completed", call_id: "call_wx1", name: "get_weather", arguments: '{"location":"S"}' } },
            {
              type: "response.completed",
              response: { id: "resp_1", object: "response", created_at: created, status: "completed", model: body.model, usage: { input_tokens: 90, output_tokens: 20, total_tokens: 110 } },
            },
          ]),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      const reasoning: Record<string, unknown> = { id: "rs_1", type: "reasoning", summary: [] };
      if (include.includes("reasoning.encrypted_content")) reasoning.encrypted_content = "ENC_BLOB";
      return Response.json({
        id: "resp_1",
        object: "response",
        status: "completed",
        model: body.model,
        output: [reasoning, { id: "fc_1", type: "function_call", status: "completed", call_id: "call_wx1", name: "get_weather", arguments: '{"location":"S"}' }],
        usage: { input_tokens: 90, output_tokens: 20, total_tokens: 110 },
      });
    },
  });
  servers.push({ stop: () => server.stop() });
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

/** Mock Responses con secuencia de eventos programable (casos límite fieles al SDK). */
function startScriptedResponsesMock(script: Array<Record<string, unknown>>): { url: string; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      seen.push({ method: req.method, path: url.pathname, headers: {}, body });
      if (!req.headers.get("authorization")) {
        return Response.json({ error: { message: "Unauthorized", type: "authentication_error", param: null, code: "invalid_api_key" } }, { status: 401 });
      }
      if (!body.stream) return Response.json({ id: "r", object: "response", status: "completed", model: body.model, output: [], usage: {} });
      return new Response(sse(script), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  servers.push({ stop: () => server.stop() });
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

function startChatMock(): { url: string; seen: SeenRequest[] } {  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      seen.push({ method: req.method, path: url.pathname, headers: { "x-opencode-session": req.headers.get("x-opencode-session") }, body });
      if (!req.headers.get("authorization")) return Response.json({ error: { type: "auth", message: "no key" } }, { status: 401 });
      const enc = new TextEncoder();
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_g1", type: "function", function: { name: "read", arguments: '{"pa' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 40, completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 5 } } },
      ];
      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  servers.push({ stop: () => server.stop() });
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

const TOOL = { name: "get_weather", description: "weather", parametersJsonSchema: { type: "object" } };

function baseInput(modelId: string, providerId: string): GenerateInput {
  return {
    providerId,
    modelId,
    effort: "high",
    instructions: "test instructions",
    messages: [{ role: "user", blocks: [{ type: "text", text: "weather?" }] }],
    tools: [TOOL],
    conversationId: "ses_test_1",
  };
}

async function collect(stream: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe("meta adapter + responses transport", () => {
  test("streams tool calls with call_id preserved and encrypted replay state", async () => {
    const mock = startResponsesMock();
    const adapter = new MetaAdapter({ baseURL: `${mock.url}/v1`, getApiKey: async () => "test" });
    const events = await collect(adapter.generateStream(baseInput("muse-wonder-1.0", "meta"), new AbortController().signal));
    const completed = events.filter((e) => e.type === "tool_call.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ providerCallId: "call_wx1", name: "get_weather" });
    expect(events.some((e) => e.type === "provider_state")).toBe(true);
    expect(events.filter((e) => e.type === "completed")).toHaveLength(1);
    const sent = mock.seen[0]!.body;
    expect(sent).toMatchObject({ model: "muse-wonder-1.0", store: false, tool_choice: "auto" });
    expect(sent.include).toContain("reasoning.encrypted_content");
    expect(sent.reasoning).toMatchObject({ effort: "high" });
  });

  test("completes exactly once from the terminal item even without arguments.done", async () => {
    const created = Math.floor(Date.now() / 1000);
    const mock = startScriptedResponsesMock([
      { type: "response.created", response: { id: "r", object: "response", created_at: created, status: "in_progress", model: "m" } },
      { type: "response.output_item.added", output_index: 0, item: { id: "fc_9", type: "function_call", status: "in_progress", call_id: "call_9", name: "read", arguments: "" } },
      { type: "response.output_item.done", output_index: 0, item: { id: "fc_9", type: "function_call", status: "completed", call_id: "call_9", name: "read", arguments: '{"path":"a"}' } },
      { type: "response.completed", response: { id: "r", object: "response", created_at: created, status: "completed", model: "m", usage: {} } },
    ]);
    const transport = new ResponsesTransport({ baseURL: `${mock.url}/v1`, getApiKey: async () => "t", label: "t" });
    const events = await collect(transport.generateStream(baseInput("muse-spark-1.3", "meta"), new AbortController().signal));
    const completed = events.filter((e) => e.type === "tool_call.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ providerCallId: "call_9", name: "read", argumentsJson: '{"path":"a"}' });
  });

  test("never completes incomplete items and recovers terminal ones idempotently", async () => {
    const created = Math.floor(Date.now() / 1000);
    const terminalItem = { id: "fc_r", type: "function_call", status: "completed", call_id: "call_r", name: "read", arguments: '{"path":"b"}' };
    const mock = startScriptedResponsesMock([
      { type: "response.created", response: { id: "r", object: "response", created_at: created, status: "in_progress", model: "m" } },
      // Sin added ni done de streaming: solo aparece en response.completed.output (recuperación).
      { type: "response.output_item.added", output_index: 0, item: { id: "fc_x", type: "function_call", status: "in_progress", call_id: "call_x", name: "read", arguments: "" } },
      { type: "response.output_item.done", output_index: 0, item: { id: "fc_x", type: "function_call", status: "incomplete", call_id: "call_x", name: "read", arguments: '{"path":' } },
      { type: "response.completed", response: { id: "r", object: "response", created_at: created, status: "completed", model: "m", usage: {}, output: [terminalItem] } },
    ]);
    const transport = new ResponsesTransport({ baseURL: `${mock.url}/v1`, getApiKey: async () => "t", label: "t" });
    const events = await collect(transport.generateStream(baseInput("muse-spark-1.3", "meta"), new AbortController().signal));
    const completed = events.filter((e) => e.type === "tool_call.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ providerCallId: "call_r" });
  });

  test("failed responses drop pending calls without completing them", async () => {
    const created = Math.floor(Date.now() / 1000);
    const mock = startScriptedResponsesMock([
      { type: "response.created", response: { id: "r", object: "response", created_at: created, status: "in_progress", model: "m" } },
      { type: "response.output_item.added", output_index: 0, item: { id: "fc_z", type: "function_call", status: "in_progress", call_id: "call_z", name: "read", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_z", output_index: 0, delta: '{"pa' },
      { type: "response.failed", response: { id: "r", status: "failed", error: { code: "server_error", message: "boom" } } },
    ]);
    const transport = new ResponsesTransport({ baseURL: `${mock.url}/v1`, getApiKey: async () => "t", label: "t" });
    const events = await collect(transport.generateStream(baseInput("muse-spark-1.3", "meta"), new AbortController().signal));
    expect(events.filter((e) => e.type === "tool_call.completed")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "server", retryable: true } });
  });

  test("replay preserves order, call_id, commentary phase and reasoning state", async () => {
    const mock = startResponsesMock();
    const adapter = new MetaAdapter({ baseURL: `${mock.url}/v1`, getApiKey: async () => "test" });
    await collect(
      adapter.generateStream(
        {
          ...baseInput("muse-spark-1.3", "meta"),
          messages: [
            { role: "user", blocks: [{ type: "text", text: "read it" }] },
            {
              role: "assistant",
              blocks: [{ type: "text", text: "on it" }],
              toolCalls: [{ providerCallId: "call_orig_1", name: "read", argumentsJson: '{"path":"f"}' }],
              providerState: [{ type: "reasoning", id: "rs_orig", summary: [], encrypted_content: "ENC_FIXTURE" }],
            },
            { role: "tool", blocks: [{ type: "tool_result", providerCallId: "call_orig_1", ok: true, text: "file bytes" }] },
            { role: "assistant", blocks: [{ type: "text", text: "final words" }] },
          ],
        },
        new AbortController().signal,
      ),
    );
    const input = mock.seen[0]!.body.input as Array<Record<string, unknown>>;
    const kinds = input.map((item) => (item.type === "message" || !item.type ? `${item.role}` : String(item.type)));
    expect(kinds).toEqual(["user", "reasoning", "assistant", "function_call", "function_call_output", "assistant"]);
    const withCalls = input.find((item) => item.role === "assistant" && (item as { phase?: string }).phase === "commentary");
    expect(withCalls).toBeDefined();
    const output = input.find((item) => item.type === "function_call_output")!;
    expect(output.call_id).toBe("call_orig_1");
    expect(output.output).toBe("file bytes");
    const call = input.find((item) => item.type === "function_call")!;
    expect(call.call_id).toBe("call_orig_1");
    const reasoning = input.find((item) => item.type === "reasoning")!;
    expect(reasoning.id).toBe("rs_orig");
    expect(reasoning.encrypted_content).toBe("ENC_FIXTURE");
    const finals = input.filter((item) => item.role === "assistant" && !("phase" in (item as object)));
    expect(finals).toHaveLength(1);
  });

  test("rejects unsupported effort/model without HTTP", async () => {
    const mock = startResponsesMock();
    const adapter = new MetaAdapter({ baseURL: `${mock.url}/v1`, getApiKey: async () => "test" });
    const bad = await collect(
      adapter.generateStream({ ...baseInput("muse-wonder-1.0", "meta"), effort: "none" as never }, new AbortController().signal),
    );
    expect(bad[0]!.type).toBe("error");
    expect(mock.seen).toHaveLength(0);
  });

  test("maps 401/429/400-context to typed retryable/non-retryable errors", async () => {
    const unauth = startResponsesMock({ mode: "unauth" });
    const transport = new ResponsesTransport({ baseURL: `${unauth.url}/v1`, getApiKey: async () => "bad", label: "t" });
    const e401 = await collect(transport.generateStream(baseInput("m", "meta"), new AbortController().signal));
    expect(e401[0]).toMatchObject({ type: "error", error: { code: "auth", retryable: false } });

    const limited = startResponsesMock({ mode: "rate_limit" });
    const transport2 = new ResponsesTransport({ baseURL: `${limited.url}/v1`, getApiKey: async () => "k", label: "t" });
    const e429 = await collect(transport2.generateStream(baseInput("m", "meta"), new AbortController().signal));
    expect(e429[0]).toMatchObject({ type: "error", error: { code: "rate_limit", retryable: true, retryAfterMs: 2000 } });

    const ctx = startResponsesMock({ mode: "bad_context" });
    const transport3 = new ResponsesTransport({ baseURL: `${ctx.url}/v1`, getApiKey: async () => "k", label: "t" });
    const e400 = await collect(transport3.generateStream(baseInput("m", "meta"), new AbortController().signal));
    expect(e400[0]).toMatchObject({ type: "error", error: { code: "context_overflow", retryable: false } });
  });

  test("missing key fails locally as auth without HTTP", async () => {
    const mock = startResponsesMock();
    const adapter = new MetaAdapter({ baseURL: `${mock.url}/v1`, getApiKey: async () => undefined });
    const events = await collect(adapter.generateStream(baseInput("muse-spark-1.3", "meta"), new AbortController().signal));
    expect(events[0]).toMatchObject({ type: "error", error: { code: "auth" } });
    expect(mock.seen).toHaveLength(0);
  });
});

describe("go adapter routing (ADR-021)", () => {
  test("chat-native models hit chat/completions with session header and nested tools", async () => {
    const mock = startChatMock();
    const adapter = new GoAdapter({
      baseURL: mock.url,
      getApiKey: async () => "test",
      getSessionHeader: (input) => input.conversationId ?? "",
    });
    const events = await collect(
      adapter.generateStream({ ...baseInput("glm-5.3-flash", "opencode-go"), tools: [{ name: "read", description: "r", parametersJsonSchema: { type: "object" } }] }, new AbortController().signal),
    );
    expect(events.filter((e) => e.type === "tool_call.completed")).toHaveLength(1);
    expect(mock.seen[0]!.path).toBe("/openai/v1/chat/completions");
    expect(mock.seen[0]!.headers["x-opencode-session"]).toBe("ses_test_1");
    const body = mock.seen[0]!.body as Record<string, unknown>;
    expect(body.tool_choice).toBe("auto");
    expect(body.reasoning_effort).toBe("high");
    expect((body.stream_options as Record<string, unknown>).include_usage).toBe(true);
  });

  test("responses-native models hit /responses", async () => {
    const mock = startResponsesMock();
    const adapter = new GoAdapter({
      baseURL: mock.url,
      getApiKey: async () => "test",
      getSessionHeader: (input) => input.conversationId ?? "",
    });
    const events = await collect(adapter.generateStream(baseInput("grok-4.7", "opencode-go"), new AbortController().signal));
    expect(mock.seen[0]!.path).toBe("/openai/v1/responses");
    expect(mock.seen[0]!.headers["x-opencode-session"]).toBe("ses_test_1");
    expect(events.some((e) => e.type === "completed")).toBe(true);
  });

  test("model-specific effort lists are enforced without HTTP", async () => {
    const chat = startChatMock();
    const adapter = new GoAdapter({ baseURL: chat.url, getApiKey: async () => "t", getSessionHeader: () => "s" });
    const events = await collect(
      adapter.generateStream({ ...baseInput("kimi-k3", "opencode-go"), effort: "low" }, new AbortController().signal),
    );
    expect(events[0]).toMatchObject({ type: "error", error: { code: "bad_request" } });
    expect(chat.seen).toHaveLength(0);
    expect(adapter.models().some((m) => m.modelId === "kimi-k3")).toBe(true);
  });

  test("contributor models are excluded by default and visible with opt-in", () => {
    const closed = new GoAdapter({ getApiKey: async () => "t", getSessionHeader: () => "s" });
    expect(closed.models().some((m) => m.modelId.includes("contributor"))).toBe(false);
    const open = new GoAdapter({ getApiKey: async () => "t", getSessionHeader: () => "s", allowContributor: true });
    expect(open.models().some((m) => m.modelId === "muse-spark-1.3-contributor")).toBe(true);
  });

  test("refreshCatalog rebuilds the table from the public endpoint; unimplemented natives fail clearly", async () => {
    const fixture = {
      object: "list",
      data: [
        {
          id: "chat-a",
          name: "Chat A",
          capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ["low", "high"] } },
          limit: { context: 1000, output: 100 },
          cost: { text: { input: { price: 1, cache: { read: 0.1 } }, output: { price: 2 } } },
          modalities: { input: ["text"], output: ["text"] },
          api: { "chat-completions": { base_url: "x", capabilities: { tools: { choice: ["auto"] } } } },
        },
        {
          id: "msg-b",
          name: "Messages B",
          capabilities: { tools: { supported: true } },
          limit: { context: 1000, output: 100 },
          modalities: { input: ["text"], output: ["text"] },
          api: { messages: { base_url: "x", capabilities: { tools: { choice: ["auto"] } } } },
        },
        {
          id: "beam-contributor",
          name: "Beam C",
          capabilities: { tools: { supported: false } },
          limit: { context: 100, output: 10 },
          modalities: { input: ["text"], output: ["text"] },
          api: { "chat-completions": { base_url: "x" } },
        },
      ],
    };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        if (new URL(req.url).pathname === "/v1/models") return Response.json(fixture);
        return new Response("not found", { status: 404 });
      },
    });
    servers.push({ stop: () => server.stop() });
    const adapter = new GoAdapter({ baseURL: `http://127.0.0.1:${server.port}`, getApiKey: async () => "t", getSessionHeader: () => "s" });
    const refreshed = await adapter.refreshCatalog();
    expect(refreshed).toMatchObject({ ok: true, count: 3 });
    expect(adapter.models().map((m) => m.modelId).sort()).toEqual(["chat-a", "msg-b"]);
    const noEffort = { ...baseInput("msg-b", "opencode-go") };
    delete (noEffort as { effort?: unknown }).effort;
    const events = await collect(adapter.generateStream(noEffort, new AbortController().signal));
    expect(events[0]).toMatchObject({ type: "error", error: { providerCode: "protocol_not_implemented" } });
  });
});

describe("chat transport", () => {
  test("accumulates tool_calls deltas by index and reads reasoning usage", async () => {
    const mock = startChatMock();
    const transport = new ChatTransport({ baseURL: `${mock.url}/x`, getApiKey: async () => "t", label: "t" });
    const events = await collect(
      transport.generateStream({ ...baseInput("glm-5.3-flash", "opencode-go"), effort: "low" }, new AbortController().signal),
    );
    const done = events.filter((e) => e.type === "tool_call.completed");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ providerCallId: "call_g1", name: "read", argumentsJson: '{"path":"a"}' });
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toMatchObject({ usage: { inputTokens: 40, outputTokens: 12, reasoningTokens: 5 } });
  });
});
