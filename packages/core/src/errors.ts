/** @octus/core — errores tipados del dominio. */

export type OctusErrorCode =
  | "budgets_not_configured"
  | "budget_exceeded"
  | "permission_denied"
  | "permission_declined"
  | "provider_not_configured"
  | "provider_unavailable"
  | "model_not_supported"
  | "effort_not_supported"
  | "tool_denied"
  | "tool_failed"
  | "tool_not_found"
  | "invalid_tool_args"
  | "scope_violation"
  | "not_found"
  | "already_exists"
  | "invalid_state"
  | "aborted"
  | "timeout"
  | "persistence_unavailable"
  | "invalid_definition"
  | "concurrency_limit"
  | "delegation_denied"
  | "scope_conflict"
  | "plan_conflict"
  | "internal";

export class OctusError extends Error {
  readonly code: OctusErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: OctusErrorCode, message: string, options?: { retryable?: boolean; details?: Record<string, unknown> }) {
    super(message);
    this.name = "OctusError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }
}

export function isOctusError(error: unknown, code?: OctusErrorCode): error is OctusError {
  return error instanceof OctusError && (code === undefined || error.code === code);
}
