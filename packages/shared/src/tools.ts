/**
 * @octus/shared — herramientas: manifiesto visible y contratos del gateway.
 */

export interface ToolManifest {
  name: string;
  description: string;
  inputJsonSchema: Record<string, unknown>;
  /** Acción de permiso que la gobierna. Toda herramienta tiene puerta (ADR-008). */
  permissionAction: string;
}

export interface ToolExecuteRequest {
  toolCallId: string;
  idempotencyKey: string;
  sessionId: string;
  runId: string;
  instanceId: string;
  definitionId: string;
  /** Directorio de trabajo efectivo de la instancia. */
  directory: string;
  name: string;
  args: unknown;
  signal?: AbortSignal;
  onPermissionRequest?: (resources: string[], detail?: string) => void;
}

export interface ToolExecuteResult {
  ok: boolean;
  /** Texto resumido/truncado según política. */
  text: string;
  /** Contenido completo cuando excede el tope (se persiste como Artifact). */
  fullText?: string;
  error?: string;
}
