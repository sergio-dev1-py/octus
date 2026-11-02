/** Renderer/store — estado raíz, tipos de UI y banderas globales. */
import { DEFAULT_LAYOUT, DEFAULT_UI_PREFS } from "@octus/shared";
import { createStore } from "solid-js/store";
import type { WorkbenchLayout, AgentDefinition, AgentInstance, Approval, ApprovalRequest, Budget, BudgetUsage, Integration, IntegrationCommit, IntegrationConflict, IntegrationOperation, IntegrationReview, MemoryItem, Message, ModelDescriptor, PermissionRequest, Plan, PlanRevision, Preview, Project, Promotion, ProviderDescriptor, QuestionRequest, RepositorySummary, Run, Session, SkillCatalogError, SkillCatalogItem, SkillDetail, Task, TaskDependency, TaskAttempt, ToolCallRecord, UiPrefs, UsageRecord, Validation, Worktree, WorktreeOperation } from "@octus/shared";
import type { ChatAttachment, LiveFrame } from "../timeline.js";

/** Marco de streaming visible (Todo 13, N-C-12a/12b): forma pura en timeline.ts. */
export type LiveMessage = LiveFrame;
export type { ChatAttachment };


interface UIState {
  projects: Project[];
  sessions: Session[];
  activeProjectId?: string;
  activeSessionId?: string;
  messages: Message[];
  runs: Run[];
  busy: boolean;
  live: Record<string, LiveMessage>;
  /** Ventana cargada del historial (N-C-06): el timeline solo pinta lo cargado. */
  timelineTotal: number;
  timelineHasOlder: boolean;
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
  /** Motivo de la última cancelación visible (N-C-12c). */
  cancelReason?: string;
  /** Adjuntos del composer pendientes de envío (N-C-13). */
  attachments: ChatAttachment[];
  /** Modelos por proveedor para el selector (caché de providers.models). */
  modelsByProvider: Record<string, ModelDescriptor[]>;
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
  // Todo 24: Skills — catálogo unido; installed ≠ enabled siempre.
  skillsCatalog: SkillCatalogItem[];
  skillsErrors: SkillCatalogError[];
  skillsFilter: "all" | "installed" | "enabled";
  skillsSearch: string;
  skillsSelected?: string;
  skillsDetail?: SkillDetail;
  skillsHistoryRun: string;
  skillsHistory: string[];
  skillsHistoryBypass: Array<{ skill: string; action: string; at: number }>;
  skillsNotice?: string;
  recoveryStatus?: { pendingOps: number; startedPromotions: number; livePreviews: number; staleMemories: number; pendingContradictions: number };
}

const [state, setState] = createStore<UIState>({
  projects: [],
  sessions: [],
  messages: [],
  runs: [],
  busy: false,
  live: {},
  timelineTotal: 0,
  timelineHasOlder: false,
  permissions: [],
  questions: [],
  providers: [],
  budgetsConfigured: false,
  budgets: [],
  budgetUsage: [],
  usage: [],
  selectedRunId: undefined,
  runDetail: undefined,
  cancelReason: undefined,
  attachments: [],
  modelsByProvider: {},
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
  skillsCatalog: [],
  skillsErrors: [],
  skillsFilter: "all",
  skillsSearch: "",
  skillsSelected: undefined,
  skillsDetail: undefined,
  skillsHistoryRun: "",
  skillsHistory: [],
  skillsHistoryBypass: [],
  skillsNotice: undefined,
  recoveryStatus: undefined,
});

export { state, setState };

export function setView(view: UIState["view"]): void {
  setState("view", view);
}

export function setError(message?: string): void {
  setState("error", message);
}
