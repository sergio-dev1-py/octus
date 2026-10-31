/**
 * @octus/shared — contratos de proveedores. El dominio solo conoce estos tipos;
 * los formatos de Meta/OpenCode Go viven en sus adaptadores (PROMPT MASTER §2.4).
 */
import type { Milliseconds } from "./domain.js";

export const PROVIDER_META = "meta";
export const PROVIDER_GO = "opencode-go";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelCapabilities {
  toolCall: boolean;
  reasoningEfforts: ReasoningEffort[];
  maxContextTokens: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  /** Precios de referencia por 1M de tokens (USD), con fuente y fecha. Nulos si no verificados. */
  priceInputPerM?: number;
  priceOutputPerM?: number;
  priceCacheReadPerM?: number;
  pricingSource?: string;
  pricingDate?: string;
}

export interface ModelDescriptor {
  providerId: string;
  modelId: string;
  displayName: string;
  capabilities: ModelCapabilities;
}

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  /** La UI solo ve este booleano, jamás la clave (ADR-009). */
  configured: boolean;
  models: ModelDescriptor[];
}

// ---------------------------------------------------------------------------
// Entrada normalizada al proveedor
// ---------------------------------------------------------------------------

export type NormalizedRole = "developer" | "user" | "assistant" | "tool";

export interface NormalizedTextBlock {
  type: "text";
  text: string;
}

export interface NormalizedToolResultBlock {
  type: "tool_result";
  providerCallId: string;
  ok: boolean;
  text: string;
}

export interface NormalizedMessage {
  role: NormalizedRole;
  blocks: Array<NormalizedTextBlock | NormalizedToolResultBlock>;
  /** Llamadas emitidas por el asistente en este turno (para reenvío al proveedor). */
  toolCalls?: Array<{ providerCallId: string; name: string; argumentsJson: string }>;
  /** Estado opaco del proveedor (p. ej. reasoning cifrado). El adaptador lo reinyecta verbatim. */
  providerState?: unknown;
}

export interface NormalizedTool {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

export interface GenerateInput {
  providerId: string;
  modelId: string;
  effort?: ReasoningEffort;
  instructions?: string;
  messages: NormalizedMessage[];
  tools?: NormalizedTool[];
  parallelToolCalls?: boolean;
  maxOutputTokens?: number;
  /** Id estable de conversación para el proveedor (sesión de Go, etc.). */
  conversationId?: string;
  metadata?: { sessionId: string; runId: string; instanceId: string };
}

// ---------------------------------------------------------------------------
// Salida normalizada (streaming)
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
}

export type ProviderStreamEvent =
  | { type: "text.delta"; delta: string }
  | { type: "reasoning_summary.delta"; delta: string }
  | { type: "tool_call.started"; providerCallId: string; name: string }
  | { type: "tool_call.delta"; providerCallId: string; argumentsDelta: string }
  | { type: "tool_call.completed"; providerCallId: string; name: string; argumentsJson: string }
  | { type: "provider_state"; state: unknown }
  | { type: "usage"; usage: TokenUsage; durationMs: Milliseconds }
  | { type: "completed"; finishReason: "stop" | "tool_calls" | "length" | "error"; usage: TokenUsage; durationMs: Milliseconds }
  | { type: "error"; error: ProviderError };

export type ProviderErrorCode =
  | "auth"
  | "not_found"
  | "bad_request"
  | "billing"
  | "rate_limit"
  | "server"
  | "overloaded"
  | "timeout"
  | "aborted"
  | "context_overflow"
  | "unknown";

export interface ProviderError {
  code: ProviderErrorCode;
  status?: number;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  providerCode?: string;
}

/** Contrato que implementa cada adaptador (Meta, Go, fakes de prueba). */
export interface ModelProvider {
  readonly id: string;
  readonly displayName: string;
  /** false en fakes de prueba: exime del gate de presupuestos (sin coste real). */
  readonly billable: boolean;
  models(): ModelDescriptor[];
  capabilitiesOf(modelId: string): ModelCapabilities | undefined;
  generateStream(input: GenerateInput, signal: AbortSignal): AsyncIterable<ProviderStreamEvent>;
}

export interface ModelResolution {
  provider: ModelProvider;
  model: ModelDescriptor;
  effort?: ReasoningEffort;
}
