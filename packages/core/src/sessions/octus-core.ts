/**
 * @octus/core — OctusCore: fachada de aplicación (proyectos, sesiones, runs, proveedores).
 * El escritorio (y los tests) hablan con el core solo a través de esta clase.
 */
import type {
  AgentInstance,
  Budget,
  BudgetUsage,
  Message,
  ModelProvider,
  ModelSelection,
  PersistedEvent,
  PermissionRule,
  Project,
  ProviderDescriptor,
  QuestionAnswer,
  QuestionPrompt,
  QuestionRequest,
  Run,
  Session,
  StreamEvent,
  Task,
  TaskAttempt,
  TaskDependency,
  Planning,
  TaskStatus,
  ToolCallRecord,
  UsageRecord,
} from "@octus/shared";
import { createId } from "@octus/shared";
import path from "node:path";
import { AgentRegistry } from "../agents/agent-registry.js";
import { promptHashOf, snapshotOf } from "../agents/definition-loader.js";
import { ConfigStore } from "../config/config-store.js";
import { evaluateBudgets, listBudgets, markBudgetsConfigured, saveBudgets, spendInWindow, usageByBudget } from "../costs/budgets.js";
import { usageForRun, usageForSession } from "../costs/usage.js";
import { OctusError, isOctusError } from "../errors.js";
import { EventBus, EventStore } from "../events/event-store.js";
import { AgentManager, DEFAULT_AGENT_LIMITS, type AgentLimits } from "../orchestration/agent-manager.js";
import { AGENT_TOOLS } from "../orchestration/agent-tools.js";
import { DirectoryRegistry, type IsolatedDirectory } from "../orchestration/directory-registry.js";
import { PersistenceService } from "../persistence/persistence-service.js";
import { PermissionManager, type PermissionLayers } from "../permissions/permission-manager.js";
import { PlanManager } from "../plans/plan-manager.js";
import { PLAN_TOOLS } from "../plans/plan-tools.js";
import { TaskManager } from "../tasks/task-manager.js";
import { TaskPlanner } from "../tasks/task-planner.js";
import { TaskScheduler } from "../tasks/task-scheduler.js";
import { RepositoryManager } from "../repositories/repository-manager.js";
import { WorktreeManager } from "../worktrees/worktree-manager.js";
import { IntegrationManager } from "../integration/integration-manager.js";
import { TASK_TOOLS } from "../tasks/task-tools.js";
import { GoAdapter } from "../providers/go-adapter.js";
import { MetaAdapter } from "../providers/meta-adapter.js";
import { ModelRouter } from "../providers/model-router.js";
import { QuestionService } from "../questions/question-service.js";
import { AgentRuntime, type RuntimeOptions } from "../runtime/agent-runtime.js";
import { ContextBuilder, deserializeMessage } from "../runtime/context-builder.js";
import { CompositeSecretStore, EnvSecretStore, secretRefForProvider, type SecretStore } from "../secrets/secret-store.js";
import { ToolGateway } from "../tools/tool-gateway.js";
import { STAGE1_TOOLS } from "../tools/tool-definitions.js";
import { GIT_TOOLS } from "../tools/git-tools.js";
import { TEST_TOOLS } from "../tools/test-tools.js";
import { TestRunner, type TestEntry } from "../tools/test-runner.js";
import type { ToolServices } from "../tools/tool-services.js";
import { WEB_TOOLS } from "../tools/web-tools.js";
import { now } from "../util.js";

export interface OctusCoreOptions {
  dataDir: string;
  /** Primario (SO). Si se omite, memoria + entorno (tests). */
  primarySecrets?: SecretStore;
  workerUrl?: URL | string;
  /** Directorio de definiciones YAML (prod empaquetado). Por defecto, junto al módulo. */
  definitionsDir?: string;
  /** Proveedores exactos a registrar (tests con fakes). Por defecto: Meta + Go reales. */
  providers?: ModelProvider[];
  allowContributorModels?: boolean;
  runtimeOptions?: RuntimeOptions;
  onStream?: (event: StreamEvent) => void;
  onEvent?: (event: PersistedEvent) => void;
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
  finished: Promise<void>;
}

export class OctusCore {
  readonly config: ConfigStore;
  readonly secrets: SecretStore;
  readonly db: PersistenceService;
  readonly events: EventStore;
  readonly bus: EventBus;
  readonly permissions: PermissionManager;
  readonly questions: QuestionService;
  readonly router: ModelRouter;
  readonly gateway: ToolGateway;
  readonly runtime: AgentRuntime;
  readonly registry: AgentRegistry;
  readonly context: ContextBuilder;
  readonly plans: PlanManager;
  readonly agents: AgentManager;
  readonly directories: DirectoryRegistry;
  readonly tests: TestRunner;
  readonly tasks: TaskManager;
  readonly planner: TaskPlanner;
  readonly scheduler: TaskScheduler;
  readonly repositories: RepositoryManager;
  readonly worktrees: WorktreeManager;
  readonly integrations: IntegrationManager;

  private readonly activeRuns = new Map<string, Map<string, ActiveRun>>();
  /** Serializa la generación del coordinador por sesión (un turno cada vez). */
  private readonly coordinatorTurn = new Map<string, Promise<unknown>>();
  private readonly coordinatorSeq = new Map<string, number>();
  private readonly streamHandlers = new Map<string, (event: StreamEvent) => void>();
  private readonly meta: MetaAdapter | undefined;
  private readonly go: GoAdapter | undefined;
  private closed = false;

  private constructor(
    options: OctusCoreOptions,
    db: PersistenceService,
    config: ConfigStore,
    secrets: SecretStore,
  ) {
    this.config = config;
    this.secrets = secrets;
    this.db = db;
    this.events = new EventStore(db);
    this.bus = new EventBus();
    this.permissions = new PermissionManager(db, this.events, this.bus);
    this.questions = new QuestionService(this.events, this.bus);
    this.router = new ModelRouter(db, this.events, this.bus);
    this.context = new ContextBuilder(db);
    this.registry = new AgentRegistry(db, options.definitionsDir ? { definitionsDir: options.definitionsDir } : {});
    const cfg = config.get();
    const toolServices: ToolServices = {};
    this.gateway = new ToolGateway(
      db,
      this.events,
      this.bus,
      this.permissions,
      {
        askQuestion: (questions: QuestionPrompt[], qctx) =>
          this.questions.ask(questions, {
            sessionId: qctx.sessionId,
            runId: qctx.runId,
            instanceId: qctx.instanceId,
            toolCallId: qctx.toolCallId,
            correlationId: qctx.correlationId,
            signal: qctx.signal,
          }),
        toolServices,
      },
      {
        shellTimeoutMs: cfg.shellTimeoutMs,
        maxInlineChars: cfg.maxOutputChars,
        protectedRoots: [options.dataDir],
        projectIdForSession: async (sessionId: string) => (await this.requireSession(sessionId)).projectId,
        layersFor: async (definitionId: string, _sessionId: string, instanceId: string): Promise<PermissionLayers> => {
          // Foto de la instancia (ADR-028); legacy sin snapshot: definición viva.
          const row = await db
            .queryOne<{ definition_snapshot: string; instance_rules: string }>("SELECT definition_snapshot, instance_rules FROM agent_instances WHERE id = ?", [instanceId])
            .catch(() => undefined);
          let instanceRules: PermissionRule[] = [];
          try {
            const parsed: unknown = JSON.parse(String(row?.instance_rules ?? "[]"));
            if (Array.isArray(parsed)) instanceRules = parsed as PermissionRule[];
          } catch {
            instanceRules = [];
          }
          const snapshot = row ? (JSON.parse(String(row.definition_snapshot ?? "{}")) as Partial<import("@octus/shared").AgentDefinitionSnapshot>) : undefined;
          if (snapshot && Array.isArray(snapshot.tools)) {
            return { definitionTools: snapshot.tools, deniedTools: snapshot.deniedTools ?? [], definitionRules: snapshot.permissionRules ?? [], instanceRules };
          }
          const def = await this.registry.get(definitionId);
          return { definitionTools: def?.tools ?? [], deniedTools: def?.deniedTools ?? [], definitionRules: def?.permissionRules ?? [], instanceRules };
        },
      },
      STAGE1_TOOLS.concat(WEB_TOOLS, GIT_TOOLS, TEST_TOOLS, PLAN_TOOLS, AGENT_TOOLS, TASK_TOOLS),
    );
    this.plans = new PlanManager(db, this.events, this.bus);
    this.directories = new DirectoryRegistry(db);
    this.repositories = new RepositoryManager(db);
    this.worktrees = new WorktreeManager(db, this.events, this.bus, this.repositories, options.dataDir);
    this.integrations = new IntegrationManager(db, this.events, this.bus, this.repositories, this.worktrees, options.dataDir);
    this.tests = new TestRunner(db);
    this.runtime = new AgentRuntime(db, this.events, this.bus, this.router, this.gateway, this.context, {
      ...(options.runtimeOptions ?? {}),
      sessionProviders: {
        planState: async (sessionId: string) => this.sessionPlanState(sessionId),
        deliveries: async (sessionId: string) => this.sessionDeliveries(sessionId),
        projectIdOf: async (sessionId: string) => (await this.requireSession(sessionId)).projectId,
      },
    });
    this.agents = new AgentManager(
      db,
      this.events,
      this.bus,
      this.runtime,
      this.registry,
      this.router,
      this.directories,
      () => this.config.get().agentLimits ?? DEFAULT_AGENT_LIMITS,
      (event) => this.streamHandlers.get(event.sessionId)?.(event),
      () => this.worktrees,
    );
    toolServices.agents = this.agents;
    toolServices.plans = this.plans;
    toolServices.tests = this.tests;
    this.tasks = new TaskManager(
      db,
      this.events,
      this.bus,
      this.registry,
      this.directories,
      this.tests,
      () => this.agents,
      () => {
        const l = this.config.get().agentLimits;
        return { maxImplementers: l.maxImplementers, maxReaders: l.maxReaders, maxReviewers: l.maxReviewers };
      },
      () => this.config.get().scheduler,
      () => this.worktrees,
    );
    this.planner = new TaskPlanner(db, this.router, this.registry, this.directories, this.tests, this.plans, this.tasks);
    this.scheduler = new TaskScheduler(
      db,
      this.events,
      this.bus,
      this.registry,
      this.directories,
      () => this.agents,
      () => this.tasks,
      () => {
        const l = this.config.get().agentLimits;
        return { maxImplementers: l.maxImplementers, maxReaders: l.maxReaders, maxReviewers: l.maxReviewers };
      },
      () => this.config.get().scheduler,
      () => this.config.get().agentLimits,
      () => this.worktrees,
    );
    toolServices.tasks = {
      plan: async (input) => {
        const out = await this.planner.planTasks(input.coordinatorInstanceId, input);
        if (out.created) {
          const row = await this.db.queryOne<{ session_id: string }>("SELECT session_id FROM runs WHERE id = ?", [input.runId]).catch(() => undefined);
          if (row) await this.scheduler.tick({ sessionId: row.session_id }).catch(() => undefined);
        }
        return out;
      },
      review: async (input) => {
        await this.tasks.recordReview(input.reviewerTaskId, input.targetTaskId, input.verdict, input.detail);
        await this.tickSessionForTask(input.targetTaskId);
      },
    };
    this.bus.subscribe((event: PersistedEvent) => {
      // Solo eventos externos al Scheduler despiertan ticks (sus propias mutaciones
      // re-evalúan explícitamente para evitar tormentas y carreras).
      if (event.type === "run.created") {
        const sessionId = (event.payload as Record<string, unknown>).sessionId;
        if (typeof sessionId === "string") void this.scheduler.tick({ sessionId }).catch(() => undefined);
        return;
      }
      if (event.type === "agent_instance.completed" || event.type === "agent_instance.failed" || event.type === "agent_instance.cancelled") {
        void this.tickSessionForInstance(String(event.aggregate.id)).catch(() => undefined);
      }
    });

    if (options.providers) {
      for (const provider of options.providers) this.router.register(provider);
      this.meta = undefined;
      this.go = undefined;
    } else {
      const meta = new MetaAdapter({ getApiKey: () => secrets.get(secretRefForProvider("meta")) });
      const go = new GoAdapter({
        getApiKey: () => secrets.get(secretRefForProvider("opencode-go")),
        getSessionHeader: (input) => input.conversationId ?? "",
        allowContributor: options.allowContributorModels ?? false,
      });
      this.router.register(meta);
      this.router.register(go);
      this.meta = meta;
      this.go = go;
    }

    if (options.onEvent) this.bus.subscribe(options.onEvent);
  }

  static async create(options: OctusCoreOptions): Promise<OctusCore> {
    const config = new ConfigStore(options.dataDir);
    const secrets = new CompositeSecretStore(
      options.primarySecrets ?? (await import("../secrets/secret-store.js").then((m) => new m.MemorySecretStore())),
      new EnvSecretStore(),
    );
    const db = await PersistenceService.open({ dbPath: `${options.dataDir}/octus.db`, workerUrl: options.workerUrl });
    const core = new OctusCore(options, db, config, secrets);
    await core.registry.ensureSeeded(core.gateway.manifests().map((m) => m.name));
    await core.settleInterrupted();
    return core;
  }

  // ------------------------------------------------------------------ proyectos
  async listProjects(): Promise<Project[]> {
    const rows = await this.db.query<Record<string, string | number>>("SELECT * FROM projects ORDER BY updated_at DESC");
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      rootPath: String(row.root_path),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  async createProject(name: string, rootPath: string): Promise<Project> {
    const timestamp = now();
    const project: Project = { id: createId("prj"), name, rootPath, createdAt: timestamp, updatedAt: timestamp };
    await this.db.exec("INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
      project.id,
      project.name,
      project.rootPath,
      project.createdAt,
      project.updatedAt,
    ]);
    return project;
  }

  // ------------------------------------------------------------------ sesiones
  async listSessions(projectId?: string): Promise<Session[]> {
    const rows = projectId
      ? await this.db.query<Record<string, string | number | null>>("SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC", [projectId])
      : await this.db.query<Record<string, string | number | null>>("SELECT * FROM sessions ORDER BY updated_at DESC");
    return rows.map(deserializeSession);
  }

  async createSession(input: { projectId: string; directory?: string; title?: string }): Promise<Session> {
    const project = (await this.listProjects()).find((p) => p.id === input.projectId);
    if (!project) throw new OctusError("not_found", `Project not found: ${input.projectId}`);
    const timestamp = now();
    const session: Session = {
      id: createId("ses"),
      projectId: project.id,
      title: input.title?.trim() || "New session",
      directory: input.directory ?? project.rootPath,
      profile: "build",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.db.exec("INSERT INTO sessions (id, project_id, title, directory, profile, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      session.id,
      session.projectId,
      session.title,
      session.directory,
      session.profile,
      null,
      session.createdAt,
      session.updatedAt,
    ]);
    const event = await this.events.append({
      type: "session.created",
      aggregate: { kind: "session", id: session.id },
      correlationId: createId("cor"),
      payload: { projectId: project.id },
    });
    this.bus.publish(event);
    return session;
  }

  async getSession(sessionId: string): Promise<{ session: Session; runs: Run[] }> {
    const session = await this.requireSession(sessionId);
    const rows = await this.db.query<Record<string, string | number | null>>(
      "SELECT * FROM runs WHERE session_id = ? ORDER BY created_at ASC",
      [sessionId],
    );
    return { session, runs: rows.map(deserializeRun) };
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.interrupt(sessionId);
    await this.db.exec("DELETE FROM sessions WHERE id = ?", [sessionId]);
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.requireSession(sessionId);
    await this.db.exec("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", [title.trim() || "Untitled", now(), sessionId]);
  }

  async setSessionProfile(sessionId: string, profile: "plan" | "build"): Promise<void> {
    const session = await this.requireSession(sessionId);
    if ((this.activeRuns.get(sessionId)?.size ?? 0) > 0) throw new OctusError("invalid_state", "Cannot switch profile while a run is active");
    await this.db.exec("UPDATE sessions SET profile = ?, updated_at = ? WHERE id = ?", [profile, now(), session.id]);
  }

  async setSessionModel(sessionId: string, model: ModelSelection): Promise<void> {
    await this.requireSession(sessionId);
    // Validación estricta inmediata (nada silencioso, ADR-015.10/13).
    this.router.resolve({ session: model, globalDefault: model });
    await this.db.exec("UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?", [JSON.stringify(model), now(), sessionId]);
  }

  async sessionMessages(sessionId: string, runId?: string): Promise<Message[]> {
    await this.requireSession(sessionId);
    const rows = runId
      ? await this.db.query<Record<string, string | number | null>>(
        "SELECT m.* FROM messages m JOIN runs r ON r.id = m.run_id WHERE m.session_id = ? AND m.run_id = ? ORDER BY r.created_at ASC, m.seq ASC",
        [sessionId, runId],
      )
      : await this.db.query<Record<string, string | number | null>>(
        "SELECT m.* FROM messages m JOIN runs r ON r.id = m.run_id WHERE m.session_id = ? ORDER BY r.created_at ASC, m.seq ASC",
        [sessionId],
      );
    return rows.map(deserializeMessage);
  }

  // ------------------------------------------------------------------ prompt / runs
  async prompt(
    sessionId: string,
    text: string,
    onStream?: (event: StreamEvent) => void,
    opts?: { asNewRequest?: boolean; runId?: string },
  ): Promise<{ runId: string }> {
    const session = await this.requireSession(sessionId);
    const active = this.activeRuns.get(sessionId);
    // Steering explícito a un run concreto.
    if (opts?.runId) {
      if (!active?.has(opts.runId)) {
        const ids = active ? [...active.keys()].join(", ") : "(none)";
        throw new OctusError("invalid_state", `Run ${opts.runId} is not active in this session (active: ${ids})`);
      }
      await this.appendUserMessage(session, opts.runId, text);
      return { runId: opts.runId };
    }
    if (active && active.size > 0 && !opts?.asNewRequest) {
      if (active.size > 1) {
        throw new OctusError("invalid_state", `Ambiguous steering: runs ${[...active.keys()].join(", ")} are active; retry with runId or asNewRequest`);
      }
      // Steering: el mensaje persiste y el runtime lo recoge en la frontera del paso.
      const only = [...active.keys()][0]!;
      await this.appendUserMessage(session, only, text);
      return { runId: only };
    }
    // Nueva solicitud independiente: nuevo run_id en la misma sesión y cronología.
    // Aprobación por texto: solo con una solicitud pendiente inequívoca (ADR-022).
    await this.maybeApproveFromText(session, text);
    const timestamp = now();
    const runId = createId("run");
    const correlationId = createId("cor");
    await this.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES (?, ?, ?, 'planning', ?, ?, ?)", [
      runId,
      sessionId,
      text,
      session.profile,
      timestamp,
      timestamp,
    ]);
    const definition = await this.registry.forProfile(session.profile);
    const instanceId = createId("ins");
    const snapshot = snapshotOf(definition);
    await this.db.exec(
      "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?)",
      [instanceId, sessionId, runId, definition.id, JSON.stringify(session.model ?? definition.defaultModel), session.directory, definition.promptVersion, promptHashOf(definition), JSON.stringify(snapshot), timestamp, timestamp],
    );
    const runEvent = await this.events.append({
      type: "run.created",
      aggregate: { kind: "run", id: runId },
      correlationId,
      payload: { sessionId },
    });
    this.bus.publish(runEvent);
    const instanceEvent = await this.events.append({
      type: "agent_instance.created",
      aggregate: { kind: "instance", id: instanceId },
      correlationId,
      payload: { runId, definitionId: definition.id },
    });
    this.bus.publish(instanceEvent);
    await this.appendUserMessage(session, runId, text, instanceId);
    if (session.title === "New session" && text.trim()) {
      await this.renameSession(sessionId, text.trim().slice(0, 60));
    }

    const controller = new AbortController();
    const streamHandler = onStream ?? (() => undefined);
    this.streamHandlers.set(sessionId, streamHandler);
    // La generación del coordinador se serializa por sesión; los runs coexisten.
    const previous = this.coordinatorTurn.get(sessionId) ?? Promise.resolve();
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const seq = (this.coordinatorSeq.get(sessionId) ?? 0) + 1;
    this.coordinatorSeq.set(sessionId, seq);
    this.coordinatorTurn.set(
      sessionId,
      previous.then(() => turn).catch(() => undefined),
    );
    const finished = (async (): Promise<void> => {
      await previous.catch(() => undefined);
      try {
        await this.runtime.runInstance(instanceId, { signal: controller.signal, correlationId, onStream: streamHandler, ownsRun: true });
      } catch {
        // El resultado final lo fija finish(); aquí solo se libera el turno.
      } finally {
        if (this.activeRuns.get(sessionId)?.get(runId)) this.activeRuns.get(sessionId)!.delete(runId);
        await this.plans.settleRunRevisions(runId).catch(() => undefined);
        releaseTurn();
        if (this.coordinatorSeq.get(sessionId) === seq) {
          this.coordinatorSeq.delete(sessionId);
          this.coordinatorTurn.delete(sessionId);
        }
      }
    })();
    if (!this.activeRuns.has(sessionId)) this.activeRuns.set(sessionId, new Map());
    this.activeRuns.get(sessionId)!.set(runId, { runId, controller, finished });
    return { runId };
  }

  /**
   * Un "sí" solo aprueba ante una única solicitud pendiente inequívoca,
   * resuelta desde el estado estructurado (nunca por decisión del modelo).
   */
  private async maybeApproveFromText(session: Session, text: string): Promise<void> {
    const pending = await this.plans.pendingApprovals(session.id);
    if (pending.length !== 1) return;
    if (!isAffirmative(text)) return;
    await this.plans.decideApproval(pending[0]!.id, "approved");
  }

  private async appendUserMessage(session: Session, runId: string, text: string, instanceId?: string): Promise<void> {
    let target = instanceId;
    if (!target) {
      const row = await this.db.queryOne<{ id: string }>(
        `SELECT i.id AS id FROM agent_instances i
         JOIN agent_definitions d ON d.id = i.definition_id
         WHERE i.run_id = ? AND d.kind = 'coordinator'
         ORDER BY i.created_at DESC LIMIT 1`,
        [runId],
      );
      if (!row) throw new OctusError("not_found", `No coordinator instance for run ${runId}`);
      target = row.id;
    }
    const messageId = createId("msg");
    const timestamp = now();
    await this.db.exec(
      `INSERT INTO messages (id, session_id, run_id, instance_id, role, mode, parts, trust, seq, created_at)
       SELECT ?, ?, ?, ?, 'user', ?, ?, 'user', COALESCE((SELECT MAX(seq) FROM messages WHERE instance_id = ?), -1) + 1, ?`,
      [messageId, session.id, runId, target, session.profile, JSON.stringify([{ type: "text", text }]), target, timestamp],
    );
    const row = await this.db.queryOne<{ seq: number }>("SELECT seq FROM messages WHERE id = ?", [messageId]);
    const correlationId = createId("cor");
    const received = await this.events.append({
      type: "user_message.received",
      aggregate: { kind: "run", id: runId },
      correlationId,
      payload: { sessionId: session.id },
    });
    this.bus.publish(received);
    const appended = await this.events.append({
      type: "message.appended",
      aggregate: { kind: "instance", id: target },
      correlationId,
      causationId: received.id,
      payload: {
        message: {
          id: messageId,
          sessionId: session.id,
          runId,
          instanceId: target,
          role: "user",
          mode: session.profile,
          parts: [{ type: "text", text }],
          trust: "user",
          seq: row?.seq ?? 0,
          createdAt: timestamp,
        },
      },
    });
    this.bus.publish(appended);
  }

  async interrupt(sessionId: string): Promise<void> {
    const active = this.activeRuns.get(sessionId);
    this.permissions.cancelSession(sessionId);
    this.questions.cancelSession(sessionId);
    // El interrupt del usuario cancela tasks no terminales de la sesión (sin éxitos).
    await this.cancelSessionTasks(sessionId).catch(() => undefined);
    await this.agents.cancelSession(sessionId);
    if (active) {
      for (const run of active.values()) run.controller.abort();
      await Promise.all([...active.values()].map((run) => run.finished));
    }
  }

  private async sessionPlanState(sessionId: string): Promise<string | undefined> {
    const plans = await this.plans.listPlans(sessionId);
    const lines: string[] = [];
    for (const plan of plans) {
      if (plan.status !== "active") continue;
      const revisions = await this.plans.listRevisions(plan.id);
      const current = revisions.find((r) => r.id === plan.currentRevisionId);
      const approved = revisions.find((r) => r.id === plan.approvedRevisionId);
      lines.push(
        `- ${plan.id} "${plan.objective}": current v${current?.version ?? "?"}(${current?.approval ?? "?"}) approved=${approved ? `v${approved.version} (${approved.id})` : "none"}`,
      );
    }
    const pending = await this.plans.pendingApprovals(sessionId);
    for (const request of pending) {
      lines.push(`- PENDING APPROVAL ${request.id}: plan ${request.planId} revision ${request.revisionId} (only the user can decide)`);
    }
    return lines.length > 0 ? lines.join("\n") : undefined;
  }

  private async sessionDeliveries(sessionId: string): Promise<string | undefined> {
    const deliveries = await this.agents.consumePendingDeliveries(sessionId);
    if (deliveries.length === 0) return undefined;
    return deliveries
      .map((d) => `[delivery ${d.definitionId} ${d.instanceId} ${d.status}]\n${d.summary.slice(0, 20000)}${d.error ? `\nError: ${d.error}` : ""}`)
      .join("\n\n");
  }

  // ------------------------------------------------------------------ planes (solo app/usuario)
  async listPlans(sessionId: string) {
    await this.requireSession(sessionId);
    return this.plans.listPlans(sessionId);
  }

  async getPlan(planId: string) {
    const plan = await this.plans.getPlan(planId);
    const revisions = await this.plans.listRevisions(planId);
    return { plan, revisions };
  }

  async approvePlanRevision(planId: string, revisionId: string): Promise<void> {
    await this.plans.approveRevision(planId, revisionId);
  }

  async rejectPlanRevision(planId: string, revisionId: string): Promise<void> {
    await this.plans.rejectRevision(planId, revisionId);
  }

  async archivePlan(planId: string): Promise<void> {
    await this.plans.archivePlan(planId);
  }

  async exportPlanRevision(planId: string, revisionId: string, targetPath: string): Promise<{ path: string }> {
    if (!path.isAbsolute(targetPath)) throw new OctusError("invalid_tool_args", "Export path must be absolute");
    const { markdown } = await this.plans.exportRevision(planId, revisionId);
    const { writeFileSync, existsSync, mkdirSync } = await import("node:fs");
    mkdirSync(path.dirname(targetPath), { recursive: true });
    if (existsSync(targetPath)) {
      throw new OctusError("already_exists", `Export target already exists (choose another path): ${targetPath}`);
    }
    writeFileSync(targetPath, markdown, "utf8");
    return { path: targetPath };
  }

  async pendingApprovals(sessionId: string) {
    await this.requireSession(sessionId);
    return this.plans.pendingApprovals(sessionId);
  }

  async decideApproval(requestId: string, decision: "approved" | "rejected") {
    return this.plans.decideApproval(requestId, decision);
  }

  /** Crea un run de Build fijado a una revisión aprobada seleccionada por el usuario. */
  async implementPlanRevision(sessionId: string, planId: string, revisionId: string): Promise<{ runId: string }> {
    const session = await this.requireSession(sessionId);
    const plan = await this.plans.getPlan(planId);
    if (plan.sessionId !== sessionId) throw new OctusError("invalid_state", "Plan does not belong to this session");
    if (plan.approvedRevisionId !== revisionId) {
      throw new OctusError("invalid_state", "Only the user-approved revision can be implemented");
    }
    const revision = await this.plans.getRevision(revisionId);
    if (!revision || revision.approval !== "approved") {
      throw new OctusError("invalid_state", "Selected revision is not approved");
    }
    const current = await this.requireSession(sessionId);
    if (current.profile !== "build") {
      // Cambio de perfil solo si no hay otros runs activos (el run ya fija mode='build').
      try {
        await this.setSessionProfile(sessionId, "build");
      } catch (error) {
        if (!isOctusError(error, "invalid_state")) throw error;
      }
    }
    const text = `Implement the approved revision v${revision.version} of plan "${plan.objective}" (plan ${planId}, revision ${revisionId}). Use plan.get to read it exactly; do not substitute another version.`;
    const timestamp = now();
    const runId = createId("run");
    const correlationId = createId("cor");
    await this.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, plan_revision_id, created_at, updated_at) VALUES (?, ?, ?, 'planning', 'build', ?, ?, ?)", [
      runId,
      sessionId,
      text,
      revisionId,
      timestamp,
      timestamp,
    ]);
    const definition = await this.registry.forProfile("build");
    const instanceId = createId("ins");
    const snapshot = snapshotOf(definition);
    await this.db.exec(
      "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?)",
      [instanceId, sessionId, runId, definition.id, JSON.stringify(current.model ?? definition.defaultModel), current.directory, definition.promptVersion, promptHashOf(definition), JSON.stringify(snapshot), timestamp, timestamp],
    );
    const runEvent = await this.events.append({ type: "run.created", aggregate: { kind: "run", id: runId }, correlationId, payload: { sessionId, planRevisionId: revisionId } });
    this.bus.publish(runEvent);
    const instanceEvent = await this.events.append({ type: "agent_instance.created", aggregate: { kind: "instance", id: instanceId }, correlationId, payload: { runId, definitionId: definition.id } });
    this.bus.publish(instanceEvent);
    await this.appendUserMessage(await this.requireSession(sessionId), runId, text, instanceId);
    const controller = new AbortController();
    const streamHandler = this.streamHandlers.get(sessionId) ?? (() => undefined);
    // Se encadena al turno del coordinador como un prompt más (multi-run coexistente).
    const previous = this.coordinatorTurn.get(sessionId) ?? Promise.resolve();
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const seq = (this.coordinatorSeq.get(sessionId) ?? 0) + 1;
    this.coordinatorSeq.set(sessionId, seq);
    this.coordinatorTurn.set(sessionId, previous.then(() => turn).catch(() => undefined));
    const finished = (async (): Promise<void> => {
      await previous.catch(() => undefined);
      try {
        await this.runtime.runInstance(instanceId, { signal: controller.signal, correlationId, onStream: streamHandler, ownsRun: true });
      } catch {
        // El resultado final lo fija finish().
      } finally {
        if (this.activeRuns.get(sessionId)?.get(runId)) this.activeRuns.get(sessionId)!.delete(runId);
        await this.plans.settleRunRevisions(runId).catch(() => undefined);
        releaseTurn();
        if (this.coordinatorSeq.get(sessionId) === seq) {
          this.coordinatorSeq.delete(sessionId);
          this.coordinatorTurn.delete(sessionId);
        }
      }
    })();
    if (!this.activeRuns.has(sessionId)) this.activeRuns.set(sessionId, new Map());
    this.activeRuns.get(sessionId)!.set(runId, { runId, controller, finished });
    return { runId };
  }

  // ------------------------------------------------------------------ agentes y proyecto
  async agentDefinitions() {
    return this.registry.list();
  }

  async agentInstances(sessionId: string): Promise<AgentInstance[]> {
    await this.requireSession(sessionId);
    const rows = await this.db.query<Record<string, string | number | null>>(
      "SELECT * FROM agent_instances WHERE session_id = ? ORDER BY created_at ASC",
      [sessionId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      sessionId: String(r.session_id),
      runId: String(r.run_id),
      taskId: r.task_id ? String(r.task_id) : undefined,
      worktreeId: r.worktree_id ? String(r.worktree_id) : undefined,
      definitionId: String(r.definition_id),
      parentInstanceId: r.parent_instance_id ? String(r.parent_instance_id) : undefined,
      status: r.status as AgentInstance["status"],
      model: JSON.parse(String(r.model)) as AgentInstance["model"],
      directory: String(r.directory),
      definitionVersion: Number(r.definition_version ?? 1),
      promptHash: String(r.prompt_hash ?? ""),
      definitionSnapshot: JSON.parse(String(r.definition_snapshot ?? "{}")) as AgentInstance["definitionSnapshot"],
      error: r.error ? String(r.error) : undefined,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      completedAt: r.completed_at ? Number(r.completed_at) : undefined,
    }));
  }

  // ------------------------------------------------------------------ tasks (Etapa 3)
  async listTasks(filter: { sessionId?: string; runId?: string }): Promise<Task[]> {
    return this.tasks.listTasks(filter);
  }

  async getTask(taskId: string) {
    const task = await this.tasks.getTask(taskId);
    const dependencies = await this.tasks.getDependencies(taskId);
    const attempts = await this.tasks.getAttempts(taskId);
    return { task, dependencies, attempts };
  }

  async cancelTask(taskId: string) {
    const out = await this.tasks.cancelTask(taskId);
    await this.tickSessionForTask(taskId);
    return out;
  }

  async retryTask(taskId: string, opts?: { directoryId?: string }) {
    const out = await this.tasks.retryTask(taskId, opts);
    await this.tickSessionForTask(taskId);
    return out;
  }

  async recordTaskReview(reviewerTaskId: string, targetTaskId: string, verdict: "accept" | "request-changes", detail?: Record<string, unknown>) {
    await this.tasks.recordReview(reviewerTaskId, targetTaskId, verdict, detail);
    await this.tickSessionForTask(targetTaskId);
  }

  async getTaskDelivery(taskId: string) {
    return this.tasks.getDelivery(taskId);
  }

  async schedulerStatus(sessionId: string) {
    await this.requireSession(sessionId);
    const lastRunId = await this.tasks.fairnessCursor(sessionId);
    const active = await this.db.queryOne<{ tasks: number; reservations: number }>(
      `SELECT (SELECT COUNT(*) FROM tasks t JOIN runs r ON r.id = t.run_id WHERE r.session_id = ? AND t.status IN ('assigned','running')) AS tasks,
              (SELECT COUNT(*) FROM scheduler_reservations WHERE session_id = ?) AS reservations`,
      [sessionId, sessionId],
    );
    return { lastRunId, active: { tasks: active?.tasks ?? 0, reservations: active?.reservations ?? 0 } };
  }

  // ------------------------------------------------------------------ worktrees y repos (Etapa 4)
  async listProjectWorktrees(projectId: string) {
    return this.worktrees.listProjectWorktrees(projectId);
  }

  async getWorktree(worktreeId: string) {
    const worktree = await this.worktrees.getWorktree(worktreeId);
    const operations = await this.worktrees.listOperations(worktreeId);
    return { worktree, operations };
  }

  async cleanupWorktree(worktreeId: string, opts?: { deleteBranch?: boolean }) {
    return this.worktrees.cleanupWorktree(worktreeId, opts);
  }

  async inspectRepository(projectId: string) {
    return this.repositories.inspectRepository(projectId);
  }

  async setWorktreesRoot(projectId: string, path: string) {
    return this.worktrees.setWorktreesRoot(projectId, path);
  }

  private async cancelSessionTasks(sessionId: string): Promise<void> {
    const tasks = await this.tasks.listTasks({ sessionId });
    for (const task of tasks) {
      if (!["completed", "reviewed", "cancelled"].includes(task.status)) {
        await this.tasks.cancelTask(task.id).catch(() => undefined);
      }
    }
  }

  private async tickSessionForTask(taskId: string): Promise<void> {
    const row = await this.db.queryOne<{ session_id: string }>(
      "SELECT r.session_id AS session_id FROM tasks t JOIN runs r ON r.id = t.run_id WHERE t.id = ?",
      [taskId],
    ).catch(() => undefined);
    if (row) await this.scheduler.tick({ sessionId: row.session_id }).catch(() => undefined);
  }

  private async tickSessionForInstance(instanceId: string): Promise<void> {
    const row = await this.db.queryOne<{ session_id: string }>("SELECT session_id FROM agent_instances WHERE id = ?", [instanceId]).catch(() => undefined);
    if (row) await this.scheduler.tick({ sessionId: row.session_id }).catch(() => undefined);
  }

  async cancelAgent(instanceId: string) {
    return this.agents.cancel(instanceId);
  }

  async setDefinitionModel(definitionId: string, model: ModelSelection): Promise<void> {
    const definition = await this.registry.get(definitionId);
    if (!definition) throw new OctusError("not_found", `Agent definition not found: ${definitionId}`);
    this.router.resolve({ instance: model, globalDefault: model });
    await this.db.exec("UPDATE agent_definitions SET default_model = ? WHERE id = ?", [JSON.stringify(model), definitionId]);
  }

  async isolatedDirectories(projectId: string): Promise<IsolatedDirectory[]> {
    return this.directories.list(projectId);
  }

  async registerIsolatedDirectory(projectId: string, dirPath: string, kind: "directory" | "worktree"): Promise<IsolatedDirectory> {
    return this.directories.register({ projectId, path: dirPath, kind });
  }

  async removeIsolatedDirectory(id: string): Promise<void> {
    return this.directories.remove(id);
  }

  async testAllowlist(projectId: string): Promise<TestEntry[]> {
    return this.tests.listAllowlist(projectId);
  }

  async saveTestAllowlist(projectId: string, entries: TestEntry[]): Promise<TestEntry[]> {
    return this.tests.saveAllowlist(projectId, entries);
  }

  async trustedInstructions(projectId: string): Promise<string[]> {
    const row = await this.db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", [`trusted_instructions.${projectId}`]);
    if (!row) return [];
    try {
      const parsed: unknown = JSON.parse(row.value);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }

  async saveTrustedInstructions(projectId: string, names: string[]): Promise<string[]> {
    for (const name of names) {
      if (typeof name !== "string" || !name || name.includes("..") || path.isAbsolute(name) || name.length > 200) {
        throw new OctusError("invalid_tool_args", `Invalid trusted file name: ${String(name).slice(0, 100)}`);
      }
    }
    const clean = [...new Set(names)].slice(0, 20);
    await this.db.exec("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [
      `trusted_instructions.${projectId}`,
      JSON.stringify(clean),
      now(),
    ]);
    return clean;
  }

  agentLimits(): AgentLimits {
    return this.config.get().agentLimits ?? DEFAULT_AGENT_LIMITS;
  }

  setAgentLimits(limits: Partial<AgentLimits>): AgentLimits {
    const merged = { ...DEFAULT_AGENT_LIMITS, ...limits };
    for (const [key, value] of Object.entries(merged)) {
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new OctusError("invalid_tool_args", `Invalid agent limit ${key}: ${String(value)}`);
      }
    }
    this.config.update({ agentLimits: merged });
    return merged;
  }

  setSchedulerConfig(config: Partial<{ maxAttemptsPerTask: number; backoffBaseMs: number }>): { maxAttemptsPerTask: number; backoffBaseMs: number } {
    const current = this.config.get().scheduler;
    const merged = { ...current, ...config };
    if (!Number.isInteger(merged.maxAttemptsPerTask) || merged.maxAttemptsPerTask < 1 || merged.maxAttemptsPerTask > 20) {
      throw new OctusError("invalid_tool_args", `Invalid maxAttemptsPerTask: ${String(merged.maxAttemptsPerTask)}`);
    }
    if (!Number.isInteger(merged.backoffBaseMs) || merged.backoffBaseMs < 0 || merged.backoffBaseMs > 60000) {
      throw new OctusError("invalid_tool_args", `Invalid backoffBaseMs: ${String(merged.backoffBaseMs)}`);
    }
    this.config.update({ scheduler: merged });
    return merged;
  }

  schedulerConfig(): { maxAttemptsPerTask: number; backoffBaseMs: number } {
    return this.config.get().scheduler;
  }

  async waitForIdle(sessionId: string): Promise<void> {
    const active = this.activeRuns.get(sessionId);
    if (active) await Promise.all([...active.values()].map((run) => run.finished));
  }

  async getRun(runId: string): Promise<{ run: Run; instances: AgentInstance[]; toolCalls: ToolCallRecord[] }> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM runs WHERE id = ?", [runId]);
    if (!row) throw new OctusError("not_found", `Run not found: ${runId}`);
    const instances = await this.db.query<Record<string, string | number | null>>("SELECT * FROM agent_instances WHERE run_id = ?", [runId]);
    const tools = await this.db.query<Record<string, string | number | null>>(
      "SELECT * FROM tool_invocations WHERE run_id = ? ORDER BY started_at ASC",
      [runId],
    );
    return {
      run: deserializeRun(row),
      instances: instances.map((r) => ({
        id: String(r.id),
        sessionId: String(r.session_id),
        runId: String(r.run_id),
        taskId: r.task_id ? String(r.task_id) : undefined,
        worktreeId: r.worktree_id ? String(r.worktree_id) : undefined,
        definitionId: String(r.definition_id),
        parentInstanceId: r.parent_instance_id ? String(r.parent_instance_id) : undefined,
        status: r.status as AgentInstance["status"],
        model: JSON.parse(String(r.model)) as AgentInstance["model"],
        directory: String(r.directory),
        definitionVersion: Number(r.definition_version ?? 1),
        promptHash: String(r.prompt_hash ?? ""),
        definitionSnapshot: JSON.parse(String(r.definition_snapshot ?? "{}")) as AgentInstance["definitionSnapshot"],
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
      })),
      toolCalls: tools.map((r) => ({
        id: String(r.id),
        sessionId: String(r.session_id),
        runId: String(r.run_id),
        instanceId: String(r.instance_id),
        name: String(r.name),
        argumentsJson: String(r.arguments_json),
        status: r.status as ToolCallRecord["status"],
        providerCallId: r.provider_call_id ? String(r.provider_call_id) : undefined,
        idempotencyKey: String(r.idempotency_key),
        permission: JSON.parse(String(r.permission)) as ToolCallRecord["permission"],
        resultText: r.result_text ? String(r.result_text) : undefined,
        artifactId: r.artifact_id ? String(r.artifact_id) : undefined,
        error: r.error ? String(r.error) : undefined,
        startedAt: r.started_at ? Number(r.started_at) : undefined,
        completedAt: r.completed_at ? Number(r.completed_at) : undefined,
      })),
    };
  }

  // ------------------------------------------------------- proveedores y costes
  async listProviders(): Promise<ProviderDescriptor[]> {
    const out: ProviderDescriptor[] = [];
    for (const provider of this.router.list()) {
      const ref = secretRefForProvider(provider.id);
      const configured = ref ? (await this.secrets.get(ref)) !== undefined : false;
      out.push({ id: provider.id, displayName: provider.displayName, configured, models: provider.models() });
    }
    return out;
  }

  async setProviderKey(providerId: string, apiKey: string): Promise<void> {
    if (!this.router.get(providerId)) throw new OctusError("not_found", `Unknown provider '${providerId}'`);
    if (!apiKey.trim()) throw new OctusError("invalid_tool_args", "API key must not be empty");
    await this.secrets.set(secretRefForProvider(providerId), apiKey.trim());
  }

  async removeProviderKey(providerId: string): Promise<void> {
    if (!this.router.get(providerId)) throw new OctusError("not_found", `Unknown provider '${providerId}'`);
    await this.secrets.delete(secretRefForProvider(providerId));
  }

  async testProvider(providerId: string): Promise<{ ok: boolean; error?: string; models?: number }> {
    if (providerId === "meta" && this.meta) return this.meta.test();
    if (providerId === "opencode-go" && this.go) return this.go.test();
    return { ok: false, error: `Provider '${providerId}' has no connectivity probe` };
  }

  async refreshGoCatalog(): Promise<{ ok: boolean; count?: number; error?: string }> {
    if (!this.go) return { ok: false, error: "Go adapter is not registered" };
    return this.go.refreshCatalog();
  }

  async budgetsStatus(): Promise<{ configured: boolean; budgets: Budget[]; usage: BudgetUsage[] }> {
    const configured = (await this.db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = 'budgets.configured'"))?.value === "1";
    const budgets = await listBudgets(this.db);
    const usage = await usageByBudget(this.db, { providerId: "", modelId: "", agentDefinitionId: "", sessionId: "", runId: "" }).catch(() => [] as BudgetUsage[]);
    return { configured, budgets, usage };
  }

  async configureBudgets(budgets: Array<Omit<Budget, "id" | "createdAt" | "updatedAt">>): Promise<Budget[]> {
    const saved = await saveBudgets(this.db, budgets);
    const event = await this.events.append({
      type: "budgets.configured",
      aggregate: { kind: "budget", id: "global" },
      correlationId: createId("cor"),
      payload: { count: saved.length },
    });
    this.bus.publish(event);
    return saved;
  }

  async runUsage(runId: string): Promise<UsageRecord[]> {
    return usageForRun(this.db, runId);
  }

  async sessionUsage(sessionId: string): Promise<UsageRecord[]> {
    return usageForSession(this.db, sessionId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [sessionId] of this.activeRuns) {
      await this.interrupt(sessionId);
    }
    await this.db.checkpoint().catch(() => undefined);
    await this.db.close();
  }

  // ------------------------------------------------------------------ internas
  private async requireSession(sessionId: string): Promise<Session> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM sessions WHERE id = ?", [sessionId]);
    if (!row) throw new OctusError("not_found", `Session not found: ${sessionId}`);
    return deserializeSession(row);
  }

  /** Liquidación tras cierre/caída: nada queda en `running` para siempre. */
  private async settleInterrupted(): Promise<void> {
    const timestamp = now();
    const runs = await this.db.query<{ id: string }>(
      "SELECT id FROM runs WHERE status IN ('planning', 'executing', 'integrating', 'awaiting_approval', 'promoting')",
    );
    await this.db.exec(
      "UPDATE runs SET status = 'cancelled', error = 'Interrupted by shutdown or previous crash', updated_at = ?, completed_at = ? WHERE status IN ('planning', 'executing', 'integrating', 'awaiting_approval', 'promoting')",
      [timestamp, timestamp],
    );
    await this.db.exec(
      "UPDATE agent_instances SET status = 'interrupted', error = 'Interrupted by shutdown or restart (explicit resume required)', updated_at = ?, completed_at = ? WHERE task_id IS NOT NULL AND status IN ('created','running','waiting_permission','waiting_input')",
      [timestamp, timestamp],
    );
    await this.db.exec(
      "UPDATE agent_instances SET status = 'cancelled', error = 'Interrupted by shutdown or restart (continuable via message)', updated_at = ?, completed_at = ? WHERE task_id IS NULL AND status IN ('created','running','waiting_permission','waiting_input')",
      [timestamp, timestamp],
    );
    await this.db.exec(
      "UPDATE tool_invocations SET status = 'cancelled', error = 'Interrupted by shutdown or previous crash', completed_at = ? WHERE status IN ('pending', 'running')",
      [timestamp],
    );
    for (const run of runs) {
      const event = await this.events.append({
        type: "run.cancelled",
        aggregate: { kind: "run", id: run.id },
        correlationId: createId("cor"),
        payload: { reason: "settle-on-startup" },
      });
      this.bus.publish(event);
    }
    await this.tasks.reconcile().catch(() => undefined);
    await this.worktrees.reconcile().catch(() => undefined);
    await this.plans.orphanSweep().catch(() => 0);
  }
}

function deserializeSession(row: Record<string, string | number | null>): Session {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    directory: String(row.directory),
    profile: String(row.profile) as Session["profile"],
    model: row.model ? (JSON.parse(String(row.model)) as Session["model"]) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function deserializeRun(row: Record<string, string | number | null>): Run {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    prompt: String(row.prompt),
    status: row.status as Run["status"],
    mode: (row.mode ? String(row.mode) : "build") as Run["mode"],
    planRevisionId: row.plan_revision_id ? String(row.plan_revision_id) : undefined,
    error: row.error ? String(row.error) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at ? Number(row.completed_at) : undefined,
  };
}

export { markBudgetsConfigured, evaluateBudgets, spendInWindow };

const AFFIRMATIVE_START = /^(sí|si|vale|de acuerdo|ok(ay)?|dale|adelante|aprobado|apruebo|approved|approve|yes|yeah|sure|go ahead)(?![\p{L}])/iu;

/** Afirmación breve sin interrogación; la validez la decide el estado (solicitud única). */
function isAffirmative(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 300 || trimmed.includes("?") || trimmed.includes("¿")) return false;
  return AFFIRMATIVE_START.test(trimmed);
}
