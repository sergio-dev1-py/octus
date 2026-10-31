/**
 * @octus/shared — permisos y preguntas al usuario.
 */
import type { Milliseconds } from "./domain.js";

export type PermissionEffect = "allow" | "deny" | "ask";

export interface PermissionRule {
  /** Acción de herramienta o comodín `*`. */
  action: string;
  /** Recurso/patrón o comodín `*`. */
  resource: string;
  effect: PermissionEffect;
}

/** Regla guardada ("siempre permitir") con revocación individual. */
export interface SavedPermissionRule extends PermissionRule {
  id: string;
  projectId: string;
  createdAt: Milliseconds;
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  runId: string;
  instanceId: string;
  toolCallId: string;
  action: string;
  resources: string[];
  /** Detalle legible para el diálogo (comando exacto, diff resumido…). */
  detail?: string;
  createdAt: Milliseconds;
}

export type PermissionDecision = "once" | "always" | "reject";

export interface PermissionReply {
  requestId: string;
  decision: PermissionDecision;
  message?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionPrompt {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
}

export interface QuestionRequest {
  id: string;
  sessionId: string;
  runId: string;
  instanceId: string;
  toolCallId: string;
  questions: QuestionPrompt[];
  createdAt: Milliseconds;
}

export interface QuestionAnswer {
  question: string;
  answers: string[];
}

export interface QuestionReply {
  requestId: string;
  answers: QuestionAnswer[];
}
