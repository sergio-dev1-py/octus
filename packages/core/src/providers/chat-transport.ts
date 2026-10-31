/**
 * @octus/core — transporte Chat Completions sobre el SDK oficial `openai`.
 * Lo usa la ruta chat-nativa de OpenCode Go. Siempre en streaming.
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

export interface ChatTransportOptions {
  baseURL: string;
  getApiKey: () => Promise<string | undefined>;
  extraHeaders?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  timeoutMs?: number;
  label: string;
}

function messageToChat(message: NormalizedMessage): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const text = message.blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (message.role === "developer" || message.role === "user") {
    out.push({ role: message.role, content: text });
    return out;
  }
  if (message.role === "tool") {
    for (const block of message.blocks) {
      if (block.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: block.providerCallId, content: block.text });
      }
    }
    return out;
  }
  const assistant: Record<string, unknown> = { role: "assistant", content: text || null };
  if (message.toolCalls?.length) {
    assistant.tool_calls = message.toolCalls.map((call) => ({
      id: call.providerCallId,
      type: "function",
      function: { name: call.name, arguments: call.argumentsJson },
    }));
  }
  out.push(assistant);
  return out;
}

function toChatTool(tool: NormalizedTool): Record<string, unknown> {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parametersJsonSchema },
  };
}

function mapSdkError(error: unknown): ProviderError {
  if (error instanceof OpenAI.AuthenticationError) {
    return { code: "auth", status: 401, message: String(error.message).slice(0, 2000), retryable: false };
  }
  if (error instanceof OpenAI.RateLimitError) {
    const retryAfter = error.headers?.get?.("retry-after");
    return {
      code: "rate_limit",
      status: 429,
      message: String(error.message).slice(0, 2000),
      retryable: true,
      retryAfterMs: retryAfter ? Number.parseFloat(retryAfter) * 1000 : undefined,
    };
  }
  if (error instanceof OpenAI.BadRequestError) {
    const message = String(error.message).slice(0, 2000);
    if (/context|token|too large|maximum/i.test(message)) {
      return { code: "context_overflow", status: 400, message, retryable: false };
    }
    return { code: "bad_request", status: 400, message, retryable: false };
  }
  if (error instanceof OpenAI.NotFoundError) {
    return { code: "not_found", status: 404, message: String(error.message).slice(0, 2000), retryable: false };
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError || error instanceof OpenAI.APIConnectionError) {
    return { code: "timeout", message: String(error.message).slice(0, 2000), retryable: true };
  }
  if (error instanceof OpenAI.APIUserAbortError || (error as { name?: string })?.name === "AbortError") {
    return { code: "aborted", message: "request aborted", retryable: false };
  }
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 0;
    if (status >= 500) return { code: "server", status, message: String(error.message).slice(0, 2000), retryable: true };
    return { code: "unknown", status, message: String(error.message).slice(0, 2000), retryable: false };
  }
  return { code: "unknown", message: error instanceof Error ? error.message.slice(0, 2000) : String(error), retryable: false };
}

export class ChatTransport {
  constructor(private readonly options: ChatTransportOptions) {}

  async *generateStream(input: GenerateInput, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    const started = now();
    const apiKey = await this.options.getApiKey();
    if (!apiKey) {
      yield { type: "error", error: { code: "auth", message: `provider '${this.options.label}' has no API key configured`, retryable: false } };
      return;
    }
    const extra =
      typeof this.options.extraHeaders === "function" ? await this.options.extraHeaders() : (this.options.extraHeaders ?? {});
    const client = new OpenAI({
      baseURL: this.options.baseURL,
      apiKey,
      timeout: this.options.timeoutMs ?? 120_000,
      maxRetries: 0,
      defaultHeaders: { ...extra },
    });
    const messages: Record<string, unknown>[] = [];
    // Sin system/developer, el modelo solo vería los mensajes de usuario (el
    // planner pasaría el brief en `instructions` y el modelo improvisaría).
    if (input.instructions) messages.push({ role: "developer", content: input.instructions });
    for (const message of input.messages) messages.push(...messageToChat(message));
    const params: Record<string, unknown> = {
      model: input.modelId,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    // tool_choice sin tools lo rechaza el upstream (400): solo enviarlo con tools.
    if (input.tools?.length) {
      params.tools = input.tools.map(toChatTool);
      params.tool_choice = "auto";
      params.parallel_tool_calls = input.parallelToolCalls ?? true;
    }
    if (input.effort) params.reasoning_effort = input.effort;
    if (input.maxOutputTokens) params.max_completion_tokens = input.maxOutputTokens;

    let stream: AsyncIterable<Record<string, unknown>>;
    try {
      stream = (await client.chat.completions.stream(params as never, { signal })) as unknown as AsyncIterable<Record<string, unknown>>;
    } catch (error) {
      yield { type: "error", error: mapSdkError(error) };
      return;
    }

    const calls = new Map<number, { id: string; name: string; args: string; started: boolean }>();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
    let finishReason: string | undefined;
    try {
      for await (const chunk of stream) {
        if (signal.aborted) {
          yield { type: "error", error: { code: "aborted", message: "request aborted", retryable: false } };
          return;
        }
        const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
        const delta = choice?.delta as { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } | undefined;
        if (typeof delta?.content === "string" && delta.content) {
          yield { type: "text.delta", delta: delta.content };
        }
        for (const call of delta?.tool_calls ?? []) {
          let tracked = calls.get(call.index);
          if (!tracked) {
            tracked = { id: call.id ?? "", name: call.function?.name ?? "", args: "", started: false };
            calls.set(call.index, tracked);
          }
          if (call.id) tracked.id = call.id;
          if (call.function?.name) tracked.name = call.function.name;
          if (!tracked.started && tracked.id && tracked.name) {
            tracked.started = true;
            yield { type: "tool_call.started", providerCallId: tracked.id, name: tracked.name };
          }
          if (call.function?.arguments) {
            tracked.args += call.function.arguments;
            if (tracked.started) yield { type: "tool_call.delta", providerCallId: tracked.id, argumentsDelta: call.function.arguments };
          }
        }
        if (typeof choice?.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
        const u = chunk.usage as
          | { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number }; prompt_tokens_details?: { cached_tokens?: number } }
          | undefined;
        if (u) {
          usage = {
            inputTokens: u.prompt_tokens ?? 0,
            outputTokens: u.completion_tokens ?? 0,
            reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
            cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
          };
        }
      }
    } catch (error) {
      yield { type: "error", error: mapSdkError(error) };
      return;
    }
    const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, call] of ordered) {
      if (call.started) yield { type: "tool_call.completed", providerCallId: call.id, name: call.name, argumentsJson: call.args || "{}" };
    }
    yield { type: "usage", usage, durationMs: now() - started };
    yield {
      type: "completed",
      finishReason: finishReason === "tool_calls" || ordered.length > 0 ? "tool_calls" : finishReason === "length" ? "length" : "stop",
      usage,
      durationMs: now() - started,
    };
  }
}
