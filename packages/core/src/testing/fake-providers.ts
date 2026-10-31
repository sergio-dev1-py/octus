/**
 * @octus/core — proveedores falsos programables (solo pruebas; billable configurable).
 */
import type {
  GenerateInput,
  ModelDescriptor,
  ModelProvider,
  ProviderError,
  ProviderStreamEvent,
  TokenUsage,
} from "@octus/shared";

export interface FakeToolCall {
  name: string;
  args: unknown;
  providerCallId?: string;
}

export interface FakeTurn {
  text?: string;
  reasoningSummary?: string;
  toolCalls?: FakeToolCall[];
  providerState?: unknown;
  usage?: Partial<TokenUsage>;
  /** Si se indica, el intento termina con este error (tras emitir lo anterior). */
  error?: ProviderError;
}

export interface FakeProviderOptions {
  billable?: boolean;
  /** Turnos en orden; si se agotan se repite el último. También admite función. */
  turns: FakeTurn[] | ((callIndex: number, input: GenerateInput) => FakeTurn);
}

const DEFAULT_USAGE: TokenUsage = { inputTokens: 100, outputTokens: 50, reasoningTokens: 10, cachedTokens: 0 };

export class FakeProvider implements ModelProvider {
  readonly billable: boolean;
  readonly seen: GenerateInput[] = [];
  private calls = 0;

  constructor(
    readonly id: string,
    readonly displayName: string,
    private readonly descriptors: ModelDescriptor[],
    private readonly options: FakeProviderOptions,
  ) {
    this.billable = options.billable ?? false;
  }

  models(): ModelDescriptor[] {
    return this.descriptors;
  }

  capabilitiesOf(modelId: string) {
    return this.descriptors.find((m) => m.modelId === modelId)?.capabilities;
  }

  async *generateStream(input: GenerateInput, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    this.seen.push(input);
    const turn = typeof this.options.turns === "function" ? this.options.turns(this.calls, input) : (this.options.turns[Math.min(this.calls, this.options.turns.length - 1)] ?? {});
    this.calls++;
    if (signal.aborted) {
      yield { type: "error", error: { code: "aborted", message: "aborted", retryable: false } };
      return;
    }
    if (turn.text) {
      const mid = Math.ceil(turn.text.length / 2);
      yield { type: "text.delta", delta: turn.text.slice(0, mid) };
      yield { type: "text.delta", delta: turn.text.slice(mid) };
    }
    if (turn.reasoningSummary) {
      yield { type: "reasoning_summary.delta", delta: turn.reasoningSummary };
    }
    for (const call of turn.toolCalls ?? []) {
      const providerCallId = call.providerCallId ?? `call_${this.calls}_${call.name}`;
      const args = JSON.stringify(call.args ?? {});
      yield { type: "tool_call.started", providerCallId, name: call.name };
      const mid = Math.ceil(args.length / 2);
      yield { type: "tool_call.delta", providerCallId, argumentsDelta: args.slice(0, mid) };
      yield { type: "tool_call.delta", providerCallId, argumentsDelta: args.slice(mid) };
      yield { type: "tool_call.completed", providerCallId, name: call.name, argumentsJson: args };
    }
    if (turn.providerState !== undefined) {
      yield { type: "provider_state", state: turn.providerState };
    }
    const usage: TokenUsage = { ...DEFAULT_USAGE, ...(turn.usage ?? {}) };
    yield { type: "usage", usage, durationMs: 5 };
    if (turn.error) {
      yield { type: "error", error: turn.error };
      return;
    }
    yield {
      type: "completed",
      finishReason: (turn.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop",
      usage,
      durationMs: 5,
    };
  }
}

export function fakeMetaModels(): ModelDescriptor[] {
  return [
    {
      providerId: "fake-meta",
      modelId: "muse-wonder-1.0",
      displayName: "Fake Wonder",
      capabilities: {
        toolCall: true,
        reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
        maxContextTokens: 1_048_576,
        maxOutputTokens: 131_072,
        supportsImages: true,
      },
    },
  ];
}

export function fakeGoModels(): ModelDescriptor[] {
  return [
    {
      providerId: "fake-go",
      modelId: "glm-5.3-flash",
      displayName: "Fake GLM Flash",
      capabilities: {
        toolCall: true,
        reasoningEfforts: ["low", "high", "max"],
        maxContextTokens: 1_000_000,
        maxOutputTokens: 131_072,
        supportsImages: true,
      },
    },
  ];
}
