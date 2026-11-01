/** Renderer/store — estado raíz, tipos de UI y banderas globales. */
import { DEFAULT_LAYOUT, DEFAULT_UI_PREFS } from "@octus/shared";
import { createStore } from "solid-js/store";
import type { WorkbenchLayout, AgentDefinition, AgentInstance, Approval, ApprovalRequest, Budget, BudgetUsage, Integration, IntegrationCommit, IntegrationConflict, IntegrationOperation, IntegrationReview, MemoryItem, Message, PermissionRequest, Plan, PlanRevision, Preview, Project, Promotion, ProviderDescriptor, QuestionRequest, RepositorySummary, Run, Session, Task, TaskDependency, TaskAttempt, ToolCallRecord, UiPrefs, UsageRecord, Validation, Worktree, WorktreeOperation } from "@octus/shared";

export interface LiveMessage {
  id: string;
  text: string;
  reasoning: string;
  toolArgs: Record<string, string>;
}


interface UIState {
  projects: Project[];
  sessions: Session[];
  activeProjectId?: string;
  activeSessionId?: string;
  messages: Message[];
  runs: Run[];
  busy: boolean;
  live: Record<string, LiveMessage>;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  providers: ProviderDescriptor[];
  budgetsConfigured: boolean;
  budgets: Budget[];
  budgetUsage: BudgetUsage[];
  usage: UsageRecord[];
  /** Todo 16 — run seleccionado en la vista de agentes y su ficha (runs.get). */
  selectedRunId?: string;
  runDetail?: { run: Run; instances: AgentInstance[]; toolCalls: ToolCallRecord[] };
  view: "chat" | "settings";
  sessionNotice?: string;
  welcomeError?: string;
  brokenProjectIds: string[];
  prefs: UiPrefs;
  layout: WorkbenchLayout;
  layoutNotice?: string;
  error?: string;
  plans: Plan[];
  planRevisions: Record<string, PlanRevision[]>;
  approvals: ApprovalRequest[];
  agentInstances: AgentInstance[];
  definitions: AgentDefinition[];
  agentLimits: { maxPerSession: number; maxPerProject: number; maxDepth: number };
  isolatedDirs: Array<{ id: string; path: string; realPath: string; kind: string; branch?: string }>;
  testAllowlist: Array<{ id: string; name: string; argv: string[] }>;
  trustedFiles: string[];
  tasks: Task[];
  taskDeps: Record<string, TaskDependency[]>;
  taskAttempts: Record<string, TaskAttempt[]>;
  worktrees: Worktree[];
  worktreeOps: Record<string, WorktreeOperation[]>;
  repoSummary?: RepositorySummary;
  integrations: Integration[];
  integrationCommits: Record<string, IntegrationCommit[]>;
  integrationOps: Record<string, IntegrationOperation[]>;
  integrationConflicts: IntegrationConflict[];
  integrationReviews: Record<string, IntegrationReview[]>;
  integrationValidations: Record<string, Validation[]>;
  integrationApprovals: Record<string, Approval[]>;
  previews: Record<string, Preview[]>;
  previewLogs: Record<string, string>;
  promotions: Record<string, Promotion[]>;
  memories: MemoryItem[];
  recoveryStatus?: { pendingOps: number; startedPromotions: number; livePreviews: number; staleMemories: number; pendingContradictions: number };
}

const [state, setState] = createStore<UIState>({
  projects: [],
  sessions: [],
  messages: [],
  runs: [],
  busy: false,
  live: {},
  permissions: [],
  questions: [],
  providers: [],
  budgetsConfigured: false,
  budgets: [],
  budgetUsage: [],
  usage: [],
  selectedRunId: undefined,
  runDetail: undefined,
  view: "chat",
  sessionNotice: undefined,
  brokenProjectIds: [],
  prefs: { ...DEFAULT_UI_PREFS },
  layout: { ...DEFAULT_LAYOUT },
  layoutNotice: undefined,
  plans: [],
  planRevisions: {},
  approvals: [],
  agentInstances: [],
  definitions: [],
  agentLimits: { maxPerSession: 4, maxPerProject: 6, maxDepth: 2 },
  isolatedDirs: [],
  testAllowlist: [],
  trustedFiles: [],
  tasks: [],
  taskDeps: {},
  taskAttempts: {},
  worktrees: [],
  worktreeOps: {},
  repoSummary: undefined,
  integrations: [],
  integrationCommits: {},
  integrationOps: {},
  integrationConflicts: [],
  integrationReviews: {},
  integrationValidations: {},
  integrationApprovals: {},
  previews: {},
  previewLogs: {},
  promotions: {},
  memories: [],
  recoveryStatus: undefined,
});

export { state, setState };

export function setView(view: UIState["view"]): void {
  setState("view", view);
}

export function setError(message?: string): void {
  setState("error", message);
}
