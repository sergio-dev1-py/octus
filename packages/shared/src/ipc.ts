/**
 * @octus/shared — contrato IPC único (ADR-014). Main, preload y renderer lo consumen;
 * prohibido `invoke` genérico con casts. Sin secretos en ninguna respuesta.
 */
import type {
  AgentDefinition,
  AgentInstance,
  Approval,
  ApprovalRequest,
  ConflictResolution,
  Integration,
  IntegrationCommit,
  IntegrationConflict,
  IntegrationOperation,
  IntegrationReview,
  Message,
  ModelSelection,
  Plan,
  PlanRevision,
  Preview,
  Project,
  Promotion,
  RepositorySummary,
  Run,
  Session,
  Task,
  TaskAttempt,
  TaskDependency,
  Planning,
  TaskReviewVerdict,
  TaskStatus,
  ToolCallRecord,
  Validation,
  Worktree,
  WorktreeOperation,
} from "./domain.js";
import type { CoreEvent } from "./events.js";
import type { ModelDescriptor, ProviderDescriptor } from "./model.js";
import type {
  PermissionReply,
  PermissionRequest,
  QuestionReply,
  QuestionRequest,
  SavedPermissionRule,
} from "./permissions.js";
import type { Budget, BudgetUsage, UsageRecord } from "./costs.js";

export const IPC_EVENT_CHANNEL = "octus:event";

export interface PromptRequest {
  sessionId: string;
  text: string;
}

export interface CreateSessionRequest {
  projectId: string;
  directory?: string;
  title?: string;
}

export interface SetKeyRequest {
  providerId: string;
  /** Viaja solo main→almacén seguro; nunca se devuelve ni se registra. */
  apiKey: string;
}

export interface ProviderTestResult {
  ok: boolean;
  error?: string;
  models?: number;
}

export interface ConfigureBudgetsRequest {
  budgets: Array<Omit<Budget, "id" | "createdAt" | "updatedAt">>;
}

/** Canal → { request, response }. */
export interface OctusIPC {
  "app.versions": { request: Record<string, never>; response: { octus: string; electron: string; node: string; bun?: string } };
  "app.pickDirectory": { request: Record<string, never>; response: { path?: string } };
  "projects.list": { request: Record<string, never>; response: { projects: Project[] } };
  "projects.create": { request: { name: string; rootPath: string }; response: { project: Project } };
  "sessions.list": { request: { projectId?: string }; response: { sessions: Session[] } };
  "sessions.create": { request: CreateSessionRequest; response: { session: Session } };
  "sessions.get": { request: { sessionId: string }; response: { session: Session; runs: Run[] } };
  "sessions.delete": { request: { sessionId: string }; response: { ok: boolean } };
  "sessions.rename": { request: { sessionId: string; title: string }; response: { ok: boolean } };
  "sessions.setProfile": { request: { sessionId: string; profile: "plan" | "build" }; response: { ok: boolean } };
  "sessions.setModel": { request: { sessionId: string; model: ModelSelection }; response: { ok: boolean; error?: string } };
  "sessions.messages": { request: { sessionId: string; runId?: string }; response: { messages: Message[] } };
  "sessions.prompt": { request: PromptRequest; response: { runId: string } };
  "sessions.interrupt": { request: { sessionId: string }; response: { ok: boolean } };
  "runs.get": { request: { runId: string }; response: { run: Run; instances: AgentInstance[]; toolCalls: ToolCallRecord[] } };
  "runs.usage": { request: { runId: string }; response: { records: UsageRecord[] } };
  "providers.list": { request: Record<string, never>; response: { providers: ProviderDescriptor[] } };
  "providers.models": { request: { providerId: string }; response: { models: ModelDescriptor[] } };
  "providers.setKey": { request: SetKeyRequest; response: { ok: boolean; error?: string } };
  "providers.removeKey": { request: { providerId: string }; response: { ok: boolean } };
  "providers.test": { request: { providerId: string }; response: ProviderTestResult };
  "budgets.status": { request: Record<string, never>; response: { configured: boolean; budgets: Budget[]; usage: BudgetUsage[] } };
  "budgets.configure": { request: ConfigureBudgetsRequest; response: { ok: boolean } };
  "permissions.pending": { request: { sessionId?: string }; response: { requests: PermissionRequest[] } };
  "permissions.reply": { request: PermissionReply; response: { ok: boolean } };
  "permissions.saved": { request: { projectId: string }; response: { rules: SavedPermissionRule[] } };
  "permissions.revokeSaved": { request: { ruleId: string }; response: { ok: boolean } };
  "questions.pending": { request: { sessionId?: string }; response: { requests: QuestionRequest[] } };
  "questions.reply": { request: QuestionReply; response: { ok: boolean } };
  "agents.definitions": { request: Record<string, never>; response: { definitions: AgentDefinition[] } };
  "agents.instances": { request: { sessionId: string }; response: { instances: AgentInstance[] } };
  "agents.cancel": { request: { instanceId: string }; response: { ok: boolean; error?: string } };
  "plans.list": { request: { sessionId: string }; response: { plans: Plan[] } };
  "plans.get": { request: { planId: string }; response: { plan: Plan; revisions: PlanRevision[] } };
  "plans.approve": { request: { planId: string; revisionId: string }; response: { ok: boolean; error?: string } };
  "plans.reject": { request: { planId: string; revisionId: string }; response: { ok: boolean; error?: string } };
  "plans.archive": { request: { planId: string }; response: { ok: boolean; error?: string } };
  "plans.export": { request: { planId: string; revisionId: string; path: string }; response: { ok: boolean; error?: string } };
  "plans.implement": { request: { sessionId: string; planId: string; revisionId: string }; response: { runId: string } };
  "approvals.pending": { request: { sessionId: string }; response: { requests: ApprovalRequest[] } };
  "approvals.decide": { request: { requestId: string; decision: "approved" | "rejected" }; response: { ok: boolean; error?: string } };
  "projects.isolatedDirs": { request: { projectId: string }; response: { directories: Array<{ id: string; path: string; realPath: string; kind: string; branch?: string }> } };
  "projects.addIsolatedDir": { request: { projectId: string; path: string; kind: "directory" | "worktree" }; response: { ok: boolean; error?: string } };
  "projects.removeIsolatedDir": { request: { id: string }; response: { ok: boolean; error?: string } };
  "projects.testAllowlist": { request: { projectId: string }; response: { entries: Array<{ id: string; name: string; argv: string[] }> } };
  "projects.saveTestAllowlist": { request: { projectId: string; entries: Array<{ id: string; name: string; argv: string[] }> }; response: { ok: boolean; error?: string } };
  "projects.trustedInstructions": { request: { projectId: string }; response: { files: string[] } };
  "projects.saveTrustedInstructions": { request: { projectId: string; files: string[] }; response: { ok: boolean; error?: string } };
  "agents.limits": { request: Record<string, never>; response: { limits: { maxPerSession: number; maxPerProject: number; maxDepth: number; maxImplementers: number; maxReaders: number; maxReviewers: number } } };
  "agents.setLimits": { request: { limits: { maxPerSession?: number; maxPerProject?: number; maxDepth?: number; maxImplementers?: number; maxReaders?: number; maxReviewers?: number } }; response: { ok: boolean; error?: string } };
  "agents.setDefinitionModel": { request: { definitionId: string; model: ModelSelection }; response: { ok: boolean; error?: string } };
  "tasks.list": { request: { sessionId?: string; runId?: string }; response: { tasks: Task[] } };
  "tasks.get": { request: { taskId: string }; response: { task: Task; dependencies: TaskDependency[]; attempts: TaskAttempt[] } };
  "tasks.cancel": { request: { taskId: string }; response: { ok: boolean; cancelled: string[]; error?: string } };
  "tasks.retry": { request: { taskId: string }; response: { ok: boolean; attempt?: number; instanceId?: string; error?: string } };
  "tasks.review": { request: { reviewerTaskId: string; targetTaskId: string; verdict: "accept" | "request-changes"; detail?: Record<string, unknown> }; response: { ok: boolean; error?: string } };
  "tasks.scheduler": { request: { sessionId: string }; response: { lastRunId?: string; active: { tasks: number; reservations: number } } };
  "integrations.create": { request: { projectId: string; runId: string; targetBranch?: string }; response: { integration: Integration; error?: string } };
  "integrations.get": { request: { integrationId: string }; response: { integration: Integration; commits: IntegrationCommit[]; operations: IntegrationOperation[]; error?: string } };
  "integrations.list": { request: { runId: string }; response: { integrations: Integration[] } };
  "integrations.rebuild": { request: { integrationId: string }; response: { ok: boolean; id?: string; attempt?: number; error?: string } };
  "integrations.abort": { request: { integrationId: string; reason?: string }; response: { ok: boolean; error?: string } };
  "integrations.incorporate": { request: { integrationId: string }; response: { ok: boolean; incorporated?: number; error?: string } };
  "integrations.spawnReviewer": { request: { integrationId: string; brief?: string }; response: { ok: boolean; instanceId?: string; error?: string } };
  "integrations.review": { request: { integrationId: string; instanceId: string; verdict: "accept" | "request-changes"; summary?: string }; response: { ok: boolean; error?: string } };
  "conflicts.list": { request: { scope?: "integration" | "work_base"; scopeRef?: string; status?: string }; response: { conflicts: IntegrationConflict[] } };
  "conflicts.get": { request: { conflictId: string }; response: { conflict: IntegrationConflict; resolutions: ConflictResolution[]; error?: string } };
  "conflicts.requestResolution": { request: { conflictId: string; briefSuffix?: string }; response: { ok: boolean; instanceId?: string; resolutionSha?: string; reused?: boolean; error?: string } };
  "conflicts.finalize": { request: { conflictId: string; instanceId: string }; response: { ok: boolean; resolutionSha?: string; error?: string } };
  "conflicts.incorporate": { request: { integrationId: string; conflictId: string }; response: { ok: boolean; integratedSha?: string; reused?: boolean; error?: string } };
  "conflicts.abort": { request: { conflictId: string; reason?: string }; response: { ok: boolean; error?: string } };
  "conflicts.cleanup": { request: { conflictId: string }; response: { ok: boolean; removed?: boolean; error?: string } };
  "validations.list": { request: { integrationId: string; sha?: string }; response: { validations: Validation[]; reviews: IntegrationReview[] } };
  "validations.rerun": { request: { integrationId: string; sha?: string }; response: { ok: boolean; validations?: Validation[]; error?: string } };
  "previews.create": { request: { integrationId: string }; response: { ok: boolean; preview?: Preview; error?: string } };
  "previews.list": { request: { integrationId: string }; response: { previews: Preview[] } };
  "previews.start": { request: { previewId: string; startEntryId?: string }; response: { ok: boolean; status?: string; url?: string; pid?: number; reachable?: boolean; error?: string } };
  "previews.stop": { request: { previewId: string }; response: { ok: boolean; stopped?: boolean; error?: string } };
  "previews.restart": { request: { previewId: string; startEntryId?: string }; response: { ok: boolean; status?: string; url?: string; pid?: number; reachable?: boolean; error?: string } };
  "previews.inspect": { request: { previewId: string }; response: { preview: Preview; shaMatchesHead: boolean; reachable: boolean; error?: string } };  "previews.logs": { request: { previewId: string; tailChars?: number }; response: { logs: string } };
  "previews.cleanup": { request: { previewId: string }; response: { ok: boolean; removed?: boolean; error?: string } };
  "previews.allowlist": { request: { projectId: string }; response: { entries: Array<{ id: string; name: string; phase: "install" | "start"; argv: string[]; timeoutMs?: number }> } };
  "previews.saveAllowlist": { request: { projectId: string; entries: Array<{ id: string; name: string; phase: "install" | "start"; argv: string[]; timeoutMs?: number }> }; response: { ok: boolean; entries?: Array<{ id: string; name: string; phase: "install" | "start"; argv: string[]; timeoutMs?: number }>; error?: string } };
  "approvals.approve": { request: { integrationId: string; previewId?: string; waiverReason?: string }; response: { ok: boolean; approvalId?: string; duplicate?: boolean; error?: string } };
  "approvals.reject": { request: { integrationId: string; reason?: string }; response: { ok: boolean; approvalId?: string; error?: string } };
  "approvals.status": { request: { integrationId: string }; response: { ok: boolean; reasons: string[]; approval?: Approval; error?: string } };
  "promotions.promote": { request: { integrationId: string }; response: { ok: boolean; promotionId?: string; newSha?: string; reused?: boolean; error?: string } };
  "promotions.status": { request: { integrationId: string }; response: { promotions: Promotion[] } };
  "worktrees.list": { request: { projectId: string }; response: { worktrees: Worktree[] } };
  "worktrees.get": { request: { worktreeId: string }; response: { ok: boolean; worktree?: Worktree; operations?: WorktreeOperation[]; error?: string } };
  "worktrees.cleanup": { request: { worktreeId: string; deleteBranch?: boolean }; response: { ok: boolean; error?: string } };
  "repos.inspect": { request: { projectId: string }; response: { summary: RepositorySummary } };
  "repos.setWorktreesRoot": { request: { projectId: string; path: string }; response: { ok: boolean; error?: string } };
}

export type IpcChannel = keyof OctusIPC;
export type IpcRequest<C extends IpcChannel> = OctusIPC[C]["request"];
export type IpcResponse<C extends IpcChannel> = OctusIPC[C]["response"];

export type { CoreEvent };
