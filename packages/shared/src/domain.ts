/**
 * @octus/shared — dominio. Única fuente de tipos para core, main, preload y renderer.
 * Etapa 1: las entidades de etapas futuras existen solo como tipos (persistencia por migraciones).
 */
import type { PermissionRule } from "./permissions.js";

/** Generador de identificadores con prefijo. Puro: funciona en Node, Bun y navegador. */
export function createId(prefix: string): string {
  const rand = globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  return `${prefix}_${rand}`;
}

export type Milliseconds = number;
export type IsoDateTime = string;

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
}

export type CoordinatorProfile = "plan" | "build";

export interface Session {
  id: string;
  projectId: string;
  title: string;
  /** Directorio de trabajo efectivo de la sesión. */
  directory: string;
  /** Perfil activo del coordinador único (ADR-006). */
  profile: CoordinatorProfile;
  model?: ModelSelection;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
  effort?: string;
}

export type RunStatus =
  | "planning"
  | "executing"
  | "integrating"
  | "awaiting_approval"
  | "promoting"
  | "done"
  | "rejected"
  | "failed"
  | "cancelled";

export interface Run {
  id: string;
  sessionId: string;
  /** Mensaje del usuario que originó el run. */
  prompt: string;
  status: RunStatus;
  /** Modo del coordinador que ejecuta este run. */
  mode: CoordinatorProfile;
  /** Revisión aprobada que ejecuta Build (fijada por el usuario, ADR-022). */
  planRevisionId?: string;
  error?: string;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
  completedAt?: Milliseconds;
}

export type AgentKind = "coordinator" | "explorer" | "researcher" | "implementer" | "reviewer" | "utility";

export interface AgentDefinition {
  id: string;
  kind: AgentKind;
  name: string;
  description: string;
  /** Perfil del coordinador al que aplica (solo kind=coordinator). */
  profile?: CoordinatorProfile;
  defaultModel: ModelSelection;
  maxSteps: number;
  timeoutMs: number;
  idleTimeoutMs: number;
  systemPrompt: string;
  tools: string[];
  /** Herramientas explícitamente denegadas (gana sobre `tools`). */
  deniedTools: string[];
  /** Reglas de permiso propias de la definición (tras los defaults, antes de sesión). */
  permissionRules: PermissionRule[];
  /** Contrato de entrega que el perfil debe respetar en su resultado. */
  deliveryFormat: string;
  /** Perfiles a los que puede delegar (vacío = no delega). */
  canDelegateTo: AgentKind[];
  /** Versión del texto de comportamiento (prompts versionados). */
  promptVersion: number;
}

/** Foto inmutable de la definición vigente al crear la instancia (ADR-028). */
export interface AgentDefinitionSnapshot {
  definitionId: string;
  definitionVersion: number;
  kind: AgentKind;
  defaultModel: ModelSelection;
  maxSteps: number;
  timeoutMs: number;
  idleTimeoutMs: number;
  tools: string[];
  deniedTools: string[];
  permissionRules: PermissionRule[];
  deliveryFormat: string;
  canDelegateTo: AgentKind[];
}

export type InstanceStatus =
  | "created"
  | "running"
  | "waiting_permission"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentInstance {
  id: string;
  sessionId: string;
  runId: string;
  /** Task del DAG que origina la instancia (Etapa 3). Ausente en delegación simple. */
  taskId?: string;
  /** Worktree asignado (Etapa 4). Ausente en delegación simple y camino legacy. */
  worktreeId?: string;
  definitionId: string;
  parentInstanceId?: string;
  status: InstanceStatus;
  model: ModelSelection;
  /** Directorio de trabajo efectivo (workspace en Etapa 1; worktree desde Etapa 4). */
  directory: string;
  /** Foto de la definición vigente al crearla; el runtime la usa al continuar (ADR-028). */
  definitionVersion: number;
  promptHash: string;
  definitionSnapshot: AgentDefinitionSnapshot;
  error?: string;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
  completedAt?: Milliseconds;
}

// ---------------------------------------------------------------------------
// Mensajes y partes
// ---------------------------------------------------------------------------

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ReasoningSummaryPart {
  type: "reasoning_summary";
  /** Resumen visible opcional del proveedor. Nunca cadena privada de razonamiento. */
  text: string;
}

export interface ToolCallPart {
  type: "tool_call";
  toolCallId: string;
  name: string;
  /** Argumentos validados localmente, serializados. */
  argumentsJson: string;
}

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  /** Identificador del proveedor para emparejar llamada↔resultado (call_id / tool_use_id…). */
  providerCallId: string;
  ok: boolean;
  /** Resumen truncado; el contenido completo vive en Artifact si excede el tope. */
  text: string;
  artifactId?: string;
}

export type MessagePart = TextPart | ReasoningSummaryPart | ToolCallPart | ToolResultPart;

export interface Message {
  id: string;
  sessionId: string;
  runId: string;
  /** Dueña: la instancia cuya conversación integra este mensaje. Nunca se mezclan. */
  instanceId: string;
  role: MessageRole;
  /** Modo con el que se envió (coordinador). Ausente en mensajes de subagentes. */
  mode?: CoordinatorProfile;
  parts: MessagePart[];
  /** Estado opaco ligado al proveedor (p. ej. reasoning cifrado de Meta). Sensible: no se muestra ni se registra. */
  providerState?: unknown;
  /** Origen del contenido para la separación de confianza (ADR-015.12). */
  trust: "system" | "user" | "tool" | "untrusted";
  seq: number;
  createdAt: Milliseconds;
}

export interface ToolCallRecord {
  id: string;
  sessionId: string;
  runId: string;
  instanceId: string;
  name: string;
  argumentsJson: string;
  status: "pending" | "running" | "completed" | "failed" | "denied" | "cancelled";
  /** Identificador del proveedor para emparejar con el resultado del modelo. Único por instancia. */
  providerCallId?: string;
  /** Clave de idempotencia: un reintento nunca re-ejecuta un efecto ya aplicado. */
  idempotencyKey: string;
  permission: { decision: "allow" | "ask" | "deny"; rule?: string };
  resultText?: string;
  artifactId?: string;
  error?: string;
  startedAt?: Milliseconds;
  completedAt?: Milliseconds;
}

export interface Artifact {
  id: string;
  sessionId: string;
  runId?: string;
  instanceId?: string;
  toolCallId?: string;
  kind: "tool_output" | "diff" | "log" | "report";
  mime: string;
  /** Contenido completo cuando excede el tope de truncado en línea. */
  text: string;
  byteSize: number;
  createdAt: Milliseconds;
}

// ---------------------------------------------------------------------------
// Planes y revisiones (Plan Manager, ADR-022/023)
// ---------------------------------------------------------------------------

export type PlanStatus = "active" | "archived";
export type RevisionLifecycle = "unpresented" | "presented" | "orphaned";
export type RevisionApproval = "pending" | "approved" | "rejected";

export interface Plan {
  id: string;
  projectId: string;
  sessionId: string;
  objective: string;
  status: PlanStatus;
  /** Última revisión presentada (FK lógica a plan_revisions.id). */
  currentRevisionId?: string;
  /** Última revisión aprobada (independiente de la actual). */
  approvedRevisionId?: string;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
}

/** Contenido estructurado de una revisión: fuente de verdad para la lógica. */
export interface PlanStructuredContent {
  objective: string;
  steps: Array<{ title: string; detail?: string; files?: string[]; verification?: string }>;
  acceptanceCriteria: string[];
  dependencies?: string[];
  risks?: string[];
  alternatives?: string[];
  openQuestions?: string[];
}

export interface PlanRevision {
  id: string;
  planId: string;
  /** Número consecutivo dentro del plan (único por plan). */
  version: number;
  structuredContent: PlanStructuredContent;
  /** Render determinista del estructurado; misma fila, inmutable, sin divergencia. */
  contentMarkdown: string;
  /** Mensaje asistente que presentó esta revisión (sin vínculo no es aprobable). */
  sourceMessageId?: string;
  createdInRunId: string;
  createdBy: string;
  lifecycle: RevisionLifecycle;
  presentedAt?: Milliseconds;
  approval: RevisionApproval;
  approvedAt?: Milliseconds;
  createdAt: Milliseconds;
}

export interface ApprovalRequest {
  id: string;
  planId: string;
  revisionId: string;
  sessionId: string;
  runId: string;
  status: "pending" | "decided" | "expired";
  decision?: "approved" | "rejected";
  decidedAt?: Milliseconds;
  createdAt: Milliseconds;
}

// ---------------------------------------------------------------------------
// Tasks y planificación (TaskGraph/Scheduler, ADR-030…042)
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "draft"
  | "ready"
  | "assigned"
  | "running"
  | "blocked"
  | "failed"
  | "completed"
  | "reviewed"
  | "integrated"
  | "cancelled"
  | "interrupted";

export type TaskBlockedReason =
  | "waiting-deps"
  | "no-workspace"
  | "no-capacity"
  | "needs-approval"
  | "waiting-review-target"
  | "no-repository"
  | "repo-blocked"
  | "deps-unavailable";

export type AttemptStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ReviewVerdict = "accept" | "request-changes";

export interface Task {
  id: string;
  runId: string;
  planningId: string;
  planId: string;
  revisionId: string;
  title: string;
  description: string;
  agentRole: AgentKind;
  priority: number;
  acceptanceCriteria: string[];
  requiredTools: string[];
  writeScope: string[];
  validationCommands: string[];
  /** Solo reviewer tasks vinculadas a un target usan este campo. */
  reviewTargetTaskId?: string;
  needsReview: boolean;
  status: TaskStatus;
  blockedReason?: TaskBlockedReason;
  blockedDetails?: Record<string, unknown>;
  reviewedByTaskId?: string;
  reviewedAt?: Milliseconds;
  /** Nº de intentos creados (0 = ninguno). Solo avanza en retry transaccional. */
  attempt: number;
  error?: string;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
}

export interface TaskDependency {
  taskId: string;
  dependsOn: string;
  kind: "requires";
}

export interface TaskAttempt {
  taskId: string;
  attempt: number;
  instanceId?: string;
  status: AttemptStatus;
  errorCode?: string;
  errorMessage?: string;
  errorDetails?: Record<string, unknown>;
  artifacts?: Array<{ artifactId?: string; kind: string; path?: string; summary?: string }>;
  startedAt?: Milliseconds;
  completedAt?: Milliseconds;
  createdAt: Milliseconds;
}

export type PlanningStatus = "valid" | "rejected";

export interface Planning {
  id: string;
  runId: string;
  planId: string;
  revisionId: string;
  requestHash: string;
  status: PlanningStatus;
  reason?: string;
  taskIds: string[];
  createdAt: Milliseconds;
}

export interface TaskReviewVerdict {
  reviewerTaskId: string;
  targetTaskId: string;
  verdict: ReviewVerdict;
  detail?: Record<string, unknown>;
  createdAt: Milliseconds;
}

export type ReservationKind = "slot-session" | "slot-project" | "slot-role" | "scope-write";

export interface Reservation {
  id: string;
  kind: ReservationKind;
  resourceKey: string;
  sessionId: string;
  projectId: string;
  taskId: string;
  attempt: number;
  instanceId?: string;
  acquiredAt: Milliseconds;
}

// ---------------------------------------------------------------------------
// Worktrees y repositorios (Worktree Manager, Etapa 4, ADR-043…052)
// ---------------------------------------------------------------------------

export type RepositoryStatus = "clean" | "dirty" | "blocked";

export interface Repository {
  id: string;
  projectId: string;
  rootPath: string;
  worktreesRoot: string;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
}

export interface RepositorySummary {
  repositoryId?: string;
  rootPath: string;
  isGit: boolean;
  branch?: string;
  head?: string;
  status: RepositoryStatus;
  staged: number;
  unstaged: number;
  untracked: number;
  incompleteOperation?: "merge" | "cherry-pick" | "rebase" | "rebase-merge" | "rebase-apply";
  incompleteDetail?: string;
  worktrees: Array<{ path: string; branch?: string; locked?: string; prunable?: boolean }>;
  branches: string[];
  gitCommonDir?: string;
}

export type WorktreeStatus =
  | "provisioning"
  | "available"
  | "assigned"
  | "running"
  | "finished"
  | "suspended"
  | "cleanup_pending"
  | "removed"
  | "retained"
  | "orphaned";

export interface Worktree {
  id: string;
  projectId: string;
  repositoryId: string;
  runId: string;
  taskId: string;
  branchName: string;
  baseCommit: string;
  /** Origen de la base: 'head' o 'task:<id>' del writer-predecesor. */
  baseSource: string;
  producedCommit?: string;
  canonicalPath: string;
  status: WorktreeStatus;
  attempt: number;
  instanceId?: string;
  dirtyExcluded: boolean;
  dirtySummary?: string;
  error?: string;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
}

export type WorktreeOpKind = "provision" | "assign" | "release" | "cleanup" | "recover" | "reconcile";
export type WorktreeOpStatus = "started" | "done" | "failed";

export interface WorktreeOperation {
  id: string;
  worktreeId?: string;
  taskId?: string;
  op: WorktreeOpKind;
  status: WorktreeOpStatus;
  step?: string;
  detail?: string;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
}

export type IntegrationStatus =
  | "building"
  | "conflicted"
  | "validating"
  | "preview_ready"
  | "approved"
  | "rejected"
  | "promoted"
  | "stale"
  | "aborted"
  | "invalidated"
  | "failed"
  | "interrupted";

export interface Integration {
  id: string;
  projectId: string;
  repositoryId: string;
  runId: string;
  /** Rama destino observada al crear la integración (p. ej. main). */
  targetBranch: string;
  /** SHA del destino observado al crear la integración (base de validez). */
  targetBaseCommit: string;
  /** Rama intermedia gestionada: harness/integration/run-<runId>[-rN]. */
  integrationBranch: string;
  /** Worktree de integración (ruta canónica). */
  canonicalPath: string;
  /** SHA candidato exacto (tip integrado + validado). */
  head?: string;
  /** Intento de integración dentro del run (rebuild = attempt+1, fila nueva). */
  attempt: number;
  /** Integración anterior que esta fila reemplaza (rebuild). */
  supersedes?: string;
  status: IntegrationStatus;
  error?: string;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
}

export type IntegrationCommitKind = "original" | "resolution";

export interface IntegrationCommit {
  id: string;
  integrationId: string;
  taskId: string;
  attempt: number;
  instanceId?: string;
  worktreeId?: string;
  /** SHA producido por el worker (inmutable, verificado). */
  originalSha: string;
  /** SHA resultante dentro de la rama de integración (== original si FF). */
  integratedSha: string;
  kind: IntegrationCommitKind;
  createdAt: Milliseconds;
}

export type IntegrationOpKind = "create" | "incorporate" | "rebuild" | "abort" | "reconcile";
export type IntegrationOpStatus = "started" | "done" | "failed";

export interface IntegrationOperation {
  id: string;
  integrationId?: string;
  op: IntegrationOpKind;
  status: IntegrationOpStatus;
  step?: string;
  detail?: string;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
}

/** Base de trabajo para una task con múltiples predecesores escritores. */
export type WorkBaseStatus = "building" | "ready" | "conflicted" | "stale";

export interface WorkBase {
  id: string;
  projectId: string;
  repositoryId: string;
  runId: string;
  /** Task dependiente (una workbase por task). */
  taskId: string;
  /** SHAs predecesores combinados, en orden determinista. */
  predecessorShas: string[];
  /** Tip de la rama workbase (merge de predecesores). */
  tipSha: string;
  branchName: string;
  canonicalPath: string;
  status: WorkBaseStatus;
  error?: string;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
}

export type ConflictScope = "integration" | "work_base";
export type ConflictStatus = "open" | "resolving" | "resolved" | "aborted";

export interface IntegrationConflict {
  id: string;
  scope: ConflictScope;
  /** integrationId o workBaseId según scope. */
  scopeRef: string;
  files: string[];
  oursSha: string;
  theirsSha: string;
  baseSha?: string;
  /** Task cuyo incorporate abrió el conflicto (workbase: la dependiente). */
  taskId?: string;
  attempt?: number;
  status: ConflictStatus;
  resolutionSha?: string;
  /** Instancia implementer asignada a la resolución (una activa cada vez). */
  resolutionInstanceId?: string;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
}

export interface ConflictResolution {
  id: string;
  conflictId: string;
  /** Instancia que resolvió (ausente si se reutilizó o resolvió el harness). */
  instanceId?: string;
  /** Merge commit creado por el harness en el worktree de resolución. */
  resolutionSha: string;
  /** true si se reutilizó una resolución previa con los mismos padres. */
  reused: boolean;
  createdAt: Milliseconds;
}

export type ValidationKind = "command" | "review" | "suite";
export type ValidationStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "blocked";

export interface Validation {
  id: string;
  integrationId: string;
  /** SHA exacto evaluado (pinneado). */
  sha: string;
  kind: ValidationKind;
  /** Id de la entrada allowlist (kind command) o marcador. */
  entryId?: string;
  status: ValidationStatus;
  /** Salida truncada o motivo del skip/bloqueo. */
  detail?: string;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
}

export interface IntegrationReview {
  id: string;
  integrationId: string;
  /** SHA exacto revisado. */
  sha: string;
  instanceId: string;
  verdict: "accept" | "request-changes";
  summary?: string;
  createdAt: Milliseconds;
}

export type PreviewStatus = "starting" | "running" | "reachable" | "stopped" | "completed" | "failed" | "orphaned";

export interface Preview {
  id: string;
  integrationId: string;
  /** SHA exacto en preview (detached). */
  sha: string;
  /** Worktree detached de solo-preview (ruta canónica). */
  canonicalPath: string;
  /** argv exactos ejecutados (fases install/start de la allowlist). */
  argv: string[];
  port: number;
  url: string;
  pid?: number;
  status: PreviewStatus;
  logPath: string;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
}

export type ApprovalDecision = "approved" | "rejected";

export interface Approval {
  id: string;
  integrationId: string;
  /** SHA exacto aprobado (pin inmutable). */
  candidateSha: string;
  /** Preview verificado, o ausente con waiver explícito y motivo. */
  previewId?: string;
  waiverReason?: string;
  targetBranch: string;
  targetShaObserved: string;
  /** Hash del informe de validaciones vigente al aprobar. */
  validationsHash: string;
  decision: ApprovalDecision;
  /** Solo el usuario aprueba (actor fijo). */
  actor: "user";
  grantedAt: Milliseconds;
  createdAt: Milliseconds;
}

export type PromotionStatus = "started" | "completed" | "failed" | "diverged";

export interface Promotion {
  id: string;
  integrationId: string;
  approvalId: string;
  targetBranch: string;
  /** Valor esperado del destino (CAS); si difiere → diverged. */
  expectedOldSha: string;
  newSha: string;
  status: PromotionStatus;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
}

export type PromotionOpStatus = "started" | "done" | "failed";

export interface PromotionOperation {
  id: string;
  promotionId: string;
  op: "promote" | "reconcile";
  status: PromotionOpStatus;
  step?: string;
  detail?: string;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
}

export type MemoryScope = "project" | "session" | "run" | "task" | "instance";
export type MemoryStatus = "proposed" | "verified" | "approved" | "stale" | "superseded" | "rejected";
export type MemoryConfidence = "low" | "medium" | "high";

export interface MemoryOriginRef {
  path?: string;
  section?: string;
  commit?: string;
  /** Hash del contenido de origen (revalidación por cambio, no por mera existencia). */
  contentHash?: string;
}

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  scopeId: string;
  category: string;
  topic: string;
  content: string;
  source: string;
  originRef: MemoryOriginRef;
  status: MemoryStatus;
  confidence: MemoryConfidence;
  version: number;
  supersedes?: string;
  reviewNote?: string;
  createdAt: Milliseconds;
  updatedAt: Milliseconds;
}
