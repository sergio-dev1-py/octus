/**
 * @octus/core — transporte Responses sobre el SDK oficial `openai` (P-02).
 * Lo usan el adaptador Meta y la ruta responses-nativa de OpenCode Go.
 * Siempre en streaming: deltas de tool calls + evita el límite de tiempo no-streaming.
 */
import OpenAI from "openai";
import type {
  GenerateInput,
  NormalizedMessage,
  NormalizedTool,
  ProviderError,
  ProviderStreamEvent,
  TokenUsage,
} from "@octus/shared";
import { now } from "../util.js";

export interface ResponsesTransportOptions {
  baseURL: string;
  getApiKey: () => Promise<string | undefined>;
  extraHeaders?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  timeoutMs?: number;
  /** Etiqueta para errores (p. ej. "meta", "opencode-go/responses"). */
  label: string;
}

interface ReasoningItem {
  type: "reasoning";
  id?: string;
  summary: unknown[];
  encrypted_content?: string;
}

/** Nombres de herramienta válidos en Responses: ^[a-zA-Z0-9_.-]+$ con ≤1 punto. */
export function assertValidToolName(name: string): void {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name.split(".").length > 2) {
    throw toolNameError(name);
  }
}

function toolNameError(name: string): ProviderError {
  return {
    code: "bad_request",
    message: `invalid tool name for Responses API (max one dot): ${name}`,
    retryable: false,
  };
}

function messageToItems(message: NormalizedMessage): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  const text = message.blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (message.role === "developer") {
    items.push({ role: "developer", content: [{ type: "input_text", text }] });
    return items;
  }
  if (message.role === "user") {
    items.push({ role: "user", content: [{ type: "input_text", text }] });
    return items;
  }
  if (message.role === "tool") {
    for (const block of message.blocks) {
      if (block.type === "tool_result") {
        items.push({ type: "function_call_output", call_id: block.providerCallId, output: block.text });
      }
    }
    return items;
  }
  // assistant: los items de razonamiento preceden al mensaje (orden exigido por Meta).
  const states = Array.isArray(message.providerState) ? (message.providerState as ReasoningItem[]) : [];
  for (const item of states) {
    if (item?.type === "reasoning" && typeof item.encrypted_content === "string") {
      const replay: Record<string, unknown> = { type: "reasoning", summary: [], encrypted_content: item.encrypted_content };
      if (item.id) replay.id = item.id;
      items.push(replay);
    }
  }
  const toolCalls = message.toolCalls ?? [];
  const content = text ? [{ type: "output_text", text }] : [{ type: "output_text", text: "" }];
  // Todo texto assistant que precede a function_call es comentario intermedio por definición.
  const assistant: Record<string, unknown> = { role: "assistant", content };
  if (toolCalls.length > 0) assistant.phase = "commentary";
  items.push(assistant);
  for (const call of toolCalls) {
    items.push({ type: "function_call", call_id: call.providerCallId, name: call.name, arguments: call.argumentsJson });
  }
  return items;
}

function toResponseTool(tool: NormalizedTool): Record<string, unknown> {
  assertValidToolName(tool.name);
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parametersJsonSchema,
    strict: false,
  };
}

function mapSdkError(error: unknown): ProviderError {
  if (error instanceof OpenAI.AuthenticationError) {
    return { code: "auth", status: 401, message: redact(error.message), retryable: false, providerCode: "invalid_api_key" };
  }
  if (error instanceof OpenAI.RateLimitError) {
    const retryAfter = error.headers?.get?.("retry-after");
    const retryAfterMs = retryAfter ? Number.parseFloat(retryAfter) * 1000 : undefined;
    return { code: "rate_limit", status: 429, message: redact(error.message), retryable: true, retryAfterMs };
  }
  if (error instanceof OpenAI.BadRequestError) {
    const message = redact(error.message);
    if (/context|token|too large|maximum/i.test(message)) {
      return { code: "context_overflow", status: 400, message, retryable: false };
    }
    return { code: "bad_request", status: 400, message, retryable: false };
  }
  if (error instanceof OpenAI.NotFoundError) {
    return { code: "not_found", status: 404, message: redact(error.message), retryable: false };
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError || error instanceof OpenAI.APIConnectionError) {
    return { code: "timeout", message: redact(error.message), retryable: true };
  }
  if (error instanceof OpenAI.APIUserAbortError || (error as { name?: string })?.name === "AbortError") {
    return { code: "aborted", message: "request aborted", retryable: false };
  }
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 0;
    if (status === 402 || status === 403) return { code: "billing", status, message: redact(error.message), retryable: false };
    if (status >= 500) return { code: "server", status, message: redact(error.message), retryable: true };
    return { code: "unknown", status, message: redact(error.message), retryable: false };
  }
  return { code: "unknown", message: error instanceof Error ? redact(error.message) : String(error), retryable: false };
}

/** Las claves nunca viajan en mensajes de error; por si el SDK ecoa cabeceras, se sanean. */
function redact(message: string): string {
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*?/g, "Bearer [redacted]").slice(0, 2000);
}

function toUsage(u: {
  input_tokens?: number;
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  input_tokens_details?: { cached_tokens?: number };
}): TokenUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: u.input_tokens_details?.cached_tokens ?? 0,
  };
}

export class ResponsesTransport {
  constructor(private readonly options: ResponsesTransportOptions) {}

  private async buildClient(): Promise<OpenAI | ProviderError> {
    const apiKey = await this.options.getApiKey();
    if (!apiKey) {
      return { code: "auth", message: `provider '${this.options.label}' has no API key configured`, retryable: false };
    }
    const extra =
      typeof this.options.extraHeaders === "function" ? await this.options.extraHeaders() : (this.options.extraHeaders ?? {});
    return new OpenAI({
      baseURL: this.options.baseURL,
      apiKey,
      timeout: this.options.timeoutMs ?? 120_000,
      maxRetries: 0,
      defaultHeaders: { ...extra },
    });
  }

  async *generateStream(input: GenerateInput, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    const started = now();
    const client = await this.buildClient();
    if (!(client instanceof OpenAI)) {
      yield { type: "error", error: client };
      return;
    }
    for (const tool of input.tools ?? []) {
      try {
        assertValidToolName(tool.name);
      } catch (error) {
        yield { type: "error", error: error as ProviderError };
        return;
      }
    }
    const items: Record<string, unknown>[] = [];
    for (const message of input.messages) items.push(...messageToItems(message));

    const params: Record<string, unknown> = {
      model: input.modelId,
      input: items,
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
    };
    // tool_choice sin tools lo rechaza el upstream (400): solo enviarlo con tools.
    if (input.tools?.length) {
      params.tools = input.tools.map(toResponseTool);
      params.tool_choice = "auto";
      params.parallel_tool_calls = input.parallelToolCalls ?? true;
    }
    if (input.instructions) params.instructions = input.instructions;
    if (input.effort) params.reasoning = { effort: input.effort };
    if (input.maxOutputTokens) params.max_output_tokens = input.maxOutputTokens;

    let stream: AsyncIterable<Record<string, unknown>>;
    try {
      stream = (await client.responses.stream(params as never, { signal })) as unknown as AsyncIterable<Record<string, unknown>>;
    } catch (error) {
      yield { type: "error", error: mapSdkError(error) };
      return;
    }

    // Identificadores (no intercambiables):
    // - item.id: correlaciona eventos de streaming del MISMO elemento
    //   (output_item.added/done lo traen en item.id; los eventos de argumentos en item_id).
    // - item.call_id: identifica la LLAMADA ante el proveedor; es el que viaja
    //   en function_call_output. Nunca se altera ni se sustituye por ids internos.
    interface TrackedCall {
      itemId: string;
      callId: string;
      name: string;
      args: string;
      argsDone: boolean;
    }
    const tracked = new Map<string, TrackedCall>();
    /** call_id ya emitidos como completados: garantiza idempotencia (incl. recuperación). */
    const emitted = new Set<string>();
    const reasoningItems: ReasoningItem[] = [];
    const reasoningIds = new Set<string>();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
    let sawToolCall = false;

    /** Emite tool_call.completed una única vez por call_id y solo con llamada validada. */
    function* completeCall(call: { callId: string; name: string; args: string }): Generator<ProviderStreamEvent> {
      if (!call.callId || !call.name || typeof call.args !== "string") return;
      if (emitted.has(call.callId)) return;
      emitted.add(call.callId);
      sawToolCall = true;
      yield { type: "tool_call.completed", providerCallId: call.callId, name: call.name, argumentsJson: call.args };
    }

    function captureReasoning(item: Record<string, unknown>): ReasoningItem | undefined {
      if (item?.type !== "reasoning" || typeof item.encrypted_content !== "string") return undefined;
      if (item.status !== undefined && item.status !== "completed") return undefined;
      const id = typeof item.id === "string" ? item.id : undefined;
      if (id && reasoningIds.has(id)) return undefined;
      if (id) reasoningIds.add(id);
      const captured: ReasoningItem = { type: "reasoning", summary: [], encrypted_content: item.encrypted_content };
      if (id) captured.id = id;
      reasoningItems.push(captured);
      return captured;
    }

    try {
      for await (const event of stream) {
        if (signal.aborted) {
          yield { type: "error", error: { code: "aborted", message: "request aborted", retryable: false } };
          return;
        }
        switch (event.type) {
          case "response.output_text.delta":
            if (typeof event.delta === "string" && event.delta) yield { type: "text.delta", delta: event.delta };
            break;
          case "response.reasoning_summary_text.delta":
            if (typeof event.delta === "string" && event.delta) yield { type: "reasoning_summary.delta", delta: event.delta };
            break;
          case "response.output_item.added": {
            const item = event.item as Record<string, unknown> | undefined;
            // Correlación por item.id (los eventos output_item.* NO traen item_id de nivel superior).
            if (item?.type === "function_call" && typeof item.id === "string") {
              const callId = typeof item.call_id === "string" ? item.call_id : "";
              const name = typeof item.name === "string" ? item.name : "";
              tracked.set(item.id, { itemId: item.id, callId, name, args: "", argsDone: false });
              if (callId && name) yield { type: "tool_call.started", providerCallId: callId, name };
            }
            break;
          }
          case "response.function_call_arguments.delta":
            // Los eventos de argumentos SÍ traen item_id (= item.id del elemento).
            if (typeof event.item_id === "string" && typeof event.delta === "string") {
              const entry = tracked.get(event.item_id);
              if (entry) {
                entry.args += event.delta;
                if (entry.callId) yield { type: "tool_call.delta", providerCallId: entry.callId, argumentsDelta: event.delta };
              }
            }
            break;
          case "response.function_call_arguments.done": {
            if (typeof event.item_id === "string" && typeof event.arguments === "string") {
              const entry = tracked.get(event.item_id);
              if (entry) {
                // Los argumentos finales son autoritativos: sustituyen al buffer de deltas.
                entry.args = event.arguments;
                entry.argsDone = true;
              }
            }
            // NUNCA se completa aquí: solo response.output_item.done con status terminal.
            break;
          }
          case "response.output_item.done": {
            const item = event.item as Record<string, unknown> | undefined;
            captureReasoning(item ?? {});
            if (item?.type === "function_call" && typeof item.id === "string") {
              const entry = tracked.get(item.id);
              const callId = typeof item.call_id === "string" ? item.call_id : (entry?.callId ?? "");
              const name = typeof item.name === "string" && item.name ? item.name : (entry?.name ?? "");
              // Respaldo: si no hubo arguments.done, los argumentos del item final mandan.
              const args = entry?.argsDone && entry ? entry.args : typeof item.arguments === "string" ? item.arguments : undefined;
              tracked.delete(item.id);
              // Solo terminales: una llamada incompleta jamás se da por completada.
              if (item.status === "completed" && args !== undefined) {
                yield* completeCall({ callId, name, args });
              }
            }
            break;
          }
          case "response.completed": {
            const response = event.response as Record<string, unknown> | undefined;
            const u = (response?.usage ?? {}) as Parameters<typeof toUsage>[0];
            usage = toUsage(u);
            // Recuperación idempotente: items terminales que no llegaron por streaming.
            const output = response?.output;
            if (Array.isArray(output)) {
              for (const raw of output) {
                const item = raw as Record<string, unknown>;
                captureReasoning(item ?? {});
                if (
                  item?.type === "function_call" &&
                  item.status === "completed" &&
                  typeof item.call_id === "string" &&
                  typeof item.name === "string" &&
                  typeof item.arguments === "string"
                ) {
                  const entry = typeof item.id === "string" ? tracked.get(item.id) : undefined;
                  if (entry && !emitted.has(item.call_id)) {
                    yield { type: "tool_call.started", providerCallId: item.call_id, name: item.name };
                  }
                  yield* completeCall({ callId: item.call_id, name: item.name, args: item.arguments });
                  if (typeof item.id === "string") tracked.delete(item.id);
                }
              }
            }
            tracked.clear();
            if (reasoningItems.length > 0) yield { type: "provider_state", state: reasoningItems };
            yield { type: "usage", usage, durationMs: now() - started };
            yield { type: "completed", finishReason: sawToolCall ? "tool_calls" : "stop", usage, durationMs: now() - started };
            return;
          }
          case "response.incomplete": {
            // Incompleto = truncado: se descartan las llamadas pendientes, nunca se completan.
            tracked.clear();
            const response = event.response as Record<string, unknown> | undefined;
            const u = (response?.usage ?? {}) as Parameters<typeof toUsage>[0];
            usage = toUsage(u);
            if (reasoningItems.length > 0) yield { type: "provider_state", state: reasoningItems };
            yield { type: "usage", usage, durationMs: now() - started };
            yield { type: "completed", finishReason: "length", usage, durationMs: now() - started };
            return;
          }
          case "response.failed": {
            tracked.clear();
            const response = event.response as Record<string, unknown> | undefined;
            const err = (response?.error ?? {}) as { code?: string; message?: string };
            yield {
              type: "error",
              error: { code: "server", message: redact(err.message ?? "response failed"), retryable: true, providerCode: err.code },
            };
            return;
          }
          case "error": {
            tracked.clear();
            const err = event as { code?: string; message?: string };
            const retryable = err.code === "server_error" || err.code === "server_shutting_down" || err.code === "rate_limit_exceeded";
            yield {
              type: "error",
              error: {
                code: err.code === "rate_limit_exceeded" ? "rate_limit" : "server",
                message: redact(err.message ?? "stream error"),
                retryable,
                providerCode: err.code,
              },
            };
            return;
          }
          default:
            break;
        }
      }
      yield { type: "error", error: { code: "server", message: "stream ended without a terminal event", retryable: true } };
    } catch (error) {
      yield { type: "error", error: mapSdkError(error) };
    }
  }
}
