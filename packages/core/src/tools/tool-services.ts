/**
 * @octus/core — interfaces de servicios usadas por las herramientas de delegación y planes.
 * Viven aquí para evitar ciclos: los managers las implementan, las tools las consumen.
 */
import type { AgentDefinitionSnapshot, AgentKind, ModelSelection } from "@octus/shared";

export type SpawnMode = "foreground" | "background";

export interface SpawnRequest {
  definitionId: string;
  brief: string;
  mode: SpawnMode;
  directoryId?: string;
  model?: ModelSelection;
  parentInstanceId: string;
  /** Task del DAG que origina el spawn (Etapa 3). Sin task: delegación simple. */
  taskId?: string;
  /** Worktree asignado por el WorktreeManager (Etapa 4). Gana sobre directoryId. */
  worktreeId?: string;
  /** Para reviewer sobre worktree ajeno: task cuyo worktree se lee (P2). */
  reviewTargetTaskId?: string;
  /** Workspace de resolución de un conflicto (Etapa 5). Gana sobre directoryId. */
  resolutionWorkspaceId?: string;
  /** Worktree de integración para revisión (Etapa 5). Gana sobre directoryId. */
  integrationId?: string;
}

export interface SpawnResult {
  instanceId: string;
  definitionId: string;
  mode: SpawnMode;
  /** Solo foreground: entrega al terminar. Background: ausente (usar result/wait). */
  delivery?: AgentDelivery;
}

export interface AgentDelivery {
  instanceId: string;
  definitionId: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  error?: string;
}

export interface AgentStatusView {
  instanceId: string;
  definitionId: string;
  status: string;
  depth: number;
  directory: string;
  error?: string;
}

export interface AgentToolService {
  spawn(request: SpawnRequest): Promise<SpawnResult>;
  status(instanceId: string): Promise<AgentStatusView>;
  message(instanceId: string, text: string): Promise<void>;
  wait(instanceId: string, timeoutMs: number): Promise<AgentDelivery>;
  result(instanceId: string): Promise<AgentDelivery>;
  cancel(instanceId: string): Promise<{ cancelled: string[] }>;
}

export interface PlanCreateInput {
  sessionId: string;
  objective: string;
  structured: import("@octus/shared").PlanStructuredContent;
}

export interface PlanUpdateInput {
  planId: string;
  structured: import("@octus/shared").PlanStructuredContent;
}

export interface PlanToolService {
  create(input: PlanCreateInput & { runId: string; createdBy: string }): Promise<{ planId: string; revisionId: string; version: number }>;
  update(input: PlanUpdateInput & { runId: string; createdBy: string }): Promise<{ revisionId: string; version: number }>;
  get(planId: string, revisionId?: string): Promise<string>;
  list(sessionId: string): Promise<string>;
  requestApproval(planId: string, revisionId: string, sessionId: string, runId: string): Promise<import("@octus/shared").ApprovalRequest>;
}

export interface MemoryProposeInput {
  scope: "project" | "session" | "run" | "task" | "instance";
  scopeId: string;
  category: string;
  topic: string;
  content: string;
  source: string;
  originRef?: { path?: string; section?: string; commit?: string; contentHash?: string };
  confidence?: "low" | "medium" | "high";
}

export interface MemoryAgentProvenance {
  projectId: string;
  sessionId: string;
  runId: string;
  instanceId: string;
}

export interface MemoryToolService {
  propose(input: MemoryProposeInput, agent: MemoryAgentProvenance): Promise<{ id: string; status: string; scope: string; category: string; topic: string }>;
  validate(id: string, coordinatorInstanceId: string): Promise<{ id: string; status: string }>;
}

export interface ToolServices {
  agents?: AgentToolService;
  plans?: PlanToolService;
  tests?: TestRunnerService;
  tasks?: TaskPlannerService;
  memory?: MemoryToolService;
}

export interface TestAllowlistEntry {
  id: string;
  name: string;
  argv: string[];
}

export interface TestRunnerService {
  run(projectId: string, entryId: string, sourceDir: string, signal: AbortSignal): Promise<{ entryId: string; exitCode: number; output: string; truncated: boolean; durationMs: number }>;
}

export interface PlanTasksInput {
  runId: string;
  objective: string;
  brief?: string;
  planId?: string;
  revisionId?: string;
  nonce?: string;
  coordinatorInstanceId: string;
}

export interface RecordReviewInput {
  reviewerTaskId: string;
  targetTaskId: string;
  verdict: "accept" | "request-changes";
  detail?: Record<string, unknown>;
}

export interface TaskPlannerService {
  plan(input: PlanTasksInput): Promise<{ planningId: string; taskIds: string[]; created: boolean }>;
  review(input: RecordReviewInput): Promise<void>;
}

export function requireTasks(services: ToolServices | undefined): TaskPlannerService {
  if (!services?.tasks) throw new Error("task planner service is not available in this context");
  return services.tasks;
}

export function requireTests(services: ToolServices | undefined): TestRunnerService {
  if (!services?.tests) throw new Error("test runner is not available in this context");
  return services.tests;
}

export function requireAgents(services: ToolServices | undefined): AgentToolService {
  if (!services?.agents) throw new Error("agent service is not available in this context");
  return services.agents;
}

export function requirePlans(services: ToolServices | undefined): PlanToolService {
  if (!services?.plans) throw new Error("plan service is not available in this context");
  return services.plans;
}

export function requireMemory(services: ToolServices | undefined): MemoryToolService {
  if (!services?.memory) throw new Error("memory service is not available in this context");
  return services.memory;
}

export type { AgentDefinitionSnapshot, AgentKind };
