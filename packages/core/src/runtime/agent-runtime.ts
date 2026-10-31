/**
 * @octus/core — AgentRuntime: un paso = una generación en streaming + herramientas.
 * El paso solo persiste al completarse: un reintento nunca duplica ni re-ejecuta (ADR-015.7).
 */
import type {
  AgentDefinition,
  AgentInstance,
  MessagePart,
  NormalizedTool,
  ProviderStreamEvent,
  Session,
  StreamEvent,
  TokenUsage,
} from "@octus/shared";
import { createId } from "@octus/shared";
import { isOctusError, OctusError } from "../errors.js";
import { backoffMs, now } from "../util.js";
import { COMPACTION_PROMPT } from "../prompts/prompts.js";
import type { ContextBuilder } from "./context-builder.js";
import { nextMessageId } from "./context-builder.js";
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import type { ModelRouter } from "../providers/model-router.js";
import type { ToolGateway } from "../tools/tool-gateway.js";
import type { ToolManifest } from "@octus/shared";

export interface AgentResult {
  status: "completed" | "failed" | "cancelled";
  finalText: string;
  steps: number;
  error?: string;
}

export interface RuntimeOptions {
  maxAttemptsPerStep?: number;
  compactionThresholdRatio?: number;
  compactionKeepTokens?: number;
  baseInstructions?: string;
  /** Proveedores de contexto de sesión (planes, entregas, proyecto). */
  sessionProviders?: {
    planState?: (sessionId: string) => Promise<string | undefined>;
    deliveries?: (sessionId: string) => Promise<string | undefined>;
    projectIdOf?: (sessionId: string) => Promise<string | undefined>;
  };
}

export interface RunInstanceOptions {
  signal: AbortSignal;
  correlationId: string;
  onStream: (event: StreamEvent) => void;
  /** false para hijos delegados: no cierran el run (lo cierra el coordinador). */
  ownsRun?: boolean;
}

interface StepAccumulator {
  text: string;
  reasoningSummary: string;
  calls: Map<string, { name: string; args: string }>;
  providerState?: unknown;
  usage: TokenUsage;
  finishReason?: string;
  error?: { code: string; message: string; retryable: boolean; retryAfterMs?: number };
}

export class AgentRuntime {
  constructor(
    private readonly db: PersistenceService,
    private readonly events: EventStore,
    private readonly bus: EventBus,
    private readonly router: ModelRouter,
    private readonly gateway: ToolGateway,
    private readonly context: ContextBuilder,
    private readonly options: RuntimeOptions = {},
  ) {}

  async runInstance(
    instanceId: string,
    opts: RunInstanceOptions,
  ): Promise<AgentResult> {
    const instance = await this.loadInstance(instanceId);
    const definition = await this.loadDefinition(instance.definitionId);
    const session = await this.loadSession(instance.sessionId);
    const tools = this.toolsFor(definition);
    const started = now();
    let steps = 0;
    const ownsRun = opts.ownsRun ?? true;

    await this.setInstanceStatus(instance, "running", opts.correlationId);
    if (ownsRun) await this.setRunStatus(instance.runId, "executing", opts.correlationId);

    try {
      while (steps < definition.maxSteps) {
        if (opts.signal.aborted) return await this.finish(instance, "cancelled", "", steps, opts.correlationId, undefined, ownsRun);
        if (now() - started > definition.timeoutMs) {
          return await this.finish(instance, "failed", "", steps, opts.correlationId, `Run exceeded its timeout (${definition.timeoutMs}ms)`, ownsRun);
        }
        const step = await this.runStep(instance, definition, session, tools, opts);
        steps++;
        if (step.fatal) {
          return await this.finish(instance, "failed", step.finalText, steps, opts.correlationId, step.fatal, ownsRun);
        }
        if (step.done) {
          return await this.finish(instance, "completed", step.finalText, steps, opts.correlationId, undefined, ownsRun);
        }
      }
      const closing = await this.closingStep(instance, definition, session, tools, opts);
      return await this.finish(instance, "completed", closing, steps + 1, opts.correlationId, undefined, ownsRun);
    } catch (error) {
      if (isOctusError(error, "aborted") || opts.signal.aborted) {
        return await this.finish(instance, "cancelled", "", steps, opts.correlationId, undefined, ownsRun);
      }
      const message = error instanceof Error ? error.message : String(error);
      return await this.finish(instance, "failed", "", steps, opts.correlationId, message, ownsRun);
    }
  }

  private async runStep(
    instance: AgentInstance,
    definition: AgentDefinition,
    session: Session,
    tools: NormalizedTool[],
    opts: RunInstanceOptions,
  ): Promise<{ done: boolean; finalText: string; fatal?: string }> {
    const isCoordinator = definition.kind === "coordinator";
    const providers = this.options.sessionProviders;
    const extras = isCoordinator
      ? {
          projectId: providers?.projectIdOf ? await providers.projectIdOf(session.id) : undefined,
          sessionId: session.id,
          runId: instance.runId,
          taskId: instance.taskId,
          instanceId: instance.id,
          planState: providers?.planState ? await providers.planState(session.id) : undefined,
          deliveries: providers?.deliveries ? await providers.deliveries(session.id) : undefined,
        }
      : {
          projectId: providers?.projectIdOf ? await providers.projectIdOf(session.id) : undefined,
          sessionId: session.id,
          runId: instance.runId,
          taskId: instance.taskId,
          instanceId: instance.id,
        };
    const instructions = await this.context.buildInstructions(definition, instance.directory, tools, extras);
    const built = isCoordinator ? await this.context.buildSessionMessages(session.id) : await this.context.buildMessages(instance.id);
    const resolution = this.router.resolve({
      instance: instance.model,
      session: session.model,
      profileDefault: definition.defaultModel,
      globalDefault: definition.defaultModel,
    });
    const estimated = this.context.estimateTokens(instructions, tools, built.messages);
    const ceiling = Math.floor(resolution.model.capabilities.maxContextTokens * (this.options.compactionThresholdRatio ?? 0.8));
    if (estimated > ceiling) {
      const compacted = await this.compact(instance, definition, session, opts);
      if (!compacted) {
        return { done: true, finalText: "", fatal: "Context exceeds the model window and compaction produced no room" };
      }
      return { done: false, finalText: "" };
    }

    const messageId = nextMessageId();
    const maxAttempts = this.options.maxAttemptsPerStep ?? 3;
    let attempt = 0;
    let acc: StepAccumulator | undefined;
    for (;;) {
      attempt++;
      acc = await this.attemptStep(instance, definition, session, resolution, instructions, tools, messageId, attempt, opts);
      if (!acc.error) break;
      if (acc.error.code === "context_overflow") {
        const compacted = await this.compact(instance, definition, session, opts, true);
        if (compacted && attempt <= maxAttempts) {
          opts.onStream({ kind: "step.retry", sessionId: session.id, runId: instance.runId, instanceId: instance.id, messageId, attempt, reason: "context_overflow→compact" });
          continue;
        }
        return { done: true, finalText: "", fatal: `Context overflow: ${acc.error.message}` };
      }
      if (!acc.error.retryable || attempt >= maxAttempts) {
        return { done: true, finalText: "", fatal: `${acc.error.code}: ${acc.error.message}` };
      }
      opts.onStream({ kind: "step.retry", sessionId: session.id, runId: instance.runId, instanceId: instance.id, messageId, attempt, reason: acc.error.code });
      const wait = acc.error.retryAfterMs ?? backoffMs(attempt);
      await sleepAbortable(Math.min(wait, 60_000), opts.signal);
    }
    const final = acc!;
    const toolIds = new Map<string, string>();
    for (const providerCallId of final.calls.keys()) toolIds.set(providerCallId, createId("tool"));
    await this.persistAssistantMessage(instance, messageId, final, toolIds, opts.correlationId, this.messageMode(definition, session));

    if (final.calls.size === 0) {
      return { done: true, finalText: final.text };
    }
    const outcome = await this.executeStepTools(instance, definition, session, final, toolIds, opts);
    if (outcome === "declined") return { done: true, finalText: final.text, fatal: "User declined a permission request" };
    if (outcome === "cancelled") throw new OctusError("aborted", "Run cancelled");
    return { done: false, finalText: "" };
  }

  private async attemptStep(
    instance: AgentInstance,
    definition: AgentDefinition,
    session: Session,
    resolution: ReturnType<ModelRouter["resolve"]>,
    instructions: string,
    tools: NormalizedTool[],
    messageId: string,
    attempt: number,
    opts: RunInstanceOptions,
  ): Promise<StepAccumulator> {
    const built =
      definition.kind === "coordinator" ? await this.context.buildSessionMessages(session.id) : await this.context.buildMessages(instance.id);
    const acc: StepAccumulator = {
      text: "",
      reasoningSummary: "",
      calls: new Map(),
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
    };
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    opts.signal.addEventListener("abort", onParentAbort, { once: true });
    let idleFired = false;
    const idleMs = definition.idleTimeoutMs;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const pokeIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleFired = true;
        controller.abort();
      }, idleMs);
    };
    const emit = (event: StreamEvent) => {
      pokeIdle();
      opts.onStream(event);
    };
    try {
      pokeIdle();
      const stream = this.router.generateStream(
        resolution,
        {
          providerId: resolution.provider.id,
          modelId: resolution.model.modelId,
          effort: resolution.effort,
          instructions,
          messages: built.messages,
          tools: tools.length > 0 ? tools : undefined,
          parallelToolCalls: false,
          conversationId: session.id,
          metadata: { sessionId: session.id, runId: instance.runId, instanceId: instance.id },
        },
        {
          sessionId: session.id,
          runId: instance.runId,
          agentInstanceId: instance.id,
          agentDefinitionId: definition.id,
          providerId: resolution.provider.id,
          modelId: resolution.model.modelId,
          correlationId: opts.correlationId,
        },
        controller.signal,
      );
      const argBuffers = new Map<string, string>();
      for await (const event of stream) {
        if (opts.signal.aborted) {
          acc.error = { code: "aborted", message: "Run cancelled", retryable: false };
          return acc;
        }
        pokeIdle();
        if (event.type === "text.delta") {
          acc.text += event.delta;
          emit({ kind: "part.delta", sessionId: session.id, runId: instance.runId, instanceId: instance.id, messageId, part: "text", delta: event.delta });
        } else if (event.type === "reasoning_summary.delta") {
          acc.reasoningSummary += event.delta;
          emit({ kind: "part.delta", sessionId: session.id, runId: instance.runId, instanceId: instance.id, messageId, part: "reasoning_summary", delta: event.delta });
        } else if (event.type === "tool_call.started") {
          // Solo UI: la llamada entra en acc.calls únicamente al completarse (condición 2/5).
          emit({ kind: "part.delta", sessionId: session.id, runId: instance.runId, instanceId: instance.id, messageId, part: "tool_arguments", key: event.providerCallId, delta: "" });
        } else if (event.type === "tool_call.delta") {
          argBuffers.set(event.providerCallId, (argBuffers.get(event.providerCallId) ?? "") + event.argumentsDelta);
          emit({ kind: "part.delta", sessionId: session.id, runId: instance.runId, instanceId: instance.id, messageId, part: "tool_arguments", key: event.providerCallId, delta: event.argumentsDelta });
        } else if (event.type === "tool_call.completed") {
          acc.calls.set(event.providerCallId, { name: event.name, args: event.argumentsJson });
          emit({ kind: "part.done", sessionId: session.id, runId: instance.runId, instanceId: instance.id, messageId, part: "tool_arguments", key: event.providerCallId });
        } else if (event.type === "provider_state") {
          acc.providerState = event.state;
        } else if (event.type === "usage" || event.type === "completed") {
          acc.usage = event.usage;
          if (event.type === "completed") acc.finishReason = event.finishReason;
        } else if (event.type === "error") {
          acc.error = { code: event.error.code, message: event.error.message, retryable: event.error.retryable, retryAfterMs: event.error.retryAfterMs };
        }
      }
      if (idleFired && acc.error?.code === "aborted") {
        acc.error = { code: "timeout", message: `No provider activity for ${idleMs}ms`, retryable: attempt < (this.options.maxAttemptsPerStep ?? 3) };
      }
      emit({ kind: "part.done", sessionId: session.id, runId: instance.runId, instanceId: instance.id, messageId, part: "text" });
      return acc;
    } catch (error) {
      if (isOctusError(error) && (error.code === "budget_exceeded" || error.code === "budgets_not_configured")) {
        acc.error = { code: error.code, message: error.message, retryable: false };
        return acc;
      }
      if (isOctusError(error, "aborted") || opts.signal.aborted) {
        acc.error = { code: "aborted", message: "Run cancelled", retryable: false };
        return acc;
      }
      acc.error = { code: "server", message: error instanceof Error ? error.message : String(error), retryable: true };
      return acc;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      opts.signal.removeEventListener("abort", onParentAbort);
    }
  }

  private async executeStepTools(
    instance: AgentInstance,
    definition: AgentDefinition,
    session: Session,
    acc: StepAccumulator,
    toolIds: Map<string, string>,
    opts: RunInstanceOptions,
  ): Promise<"continue" | "declined" | "cancelled"> {
    const parts: MessagePart[] = [];
    for (const [providerCallId, call] of acc.calls) {
      if (opts.signal.aborted) return "cancelled";
      const toolCallId = toolIds.get(providerCallId) ?? createId("tool");
      let args: unknown;
      try {
        args = JSON.parse(call.args || "{}");
      } catch {
        parts.push({ type: "tool_result", toolCallId, providerCallId, ok: false, text: "Invalid JSON arguments from model" });
        continue;
      }
      try {
        const result = await this.gateway.execute({
          toolCallId,
          idempotencyKey: `${instance.id}:${providerCallId}`,
          sessionId: instance.sessionId,
          runId: instance.runId,
          instanceId: instance.id,
          definitionId: definition.id,
          directory: instance.directory,
          name: call.name,
          args,
          signal: opts.signal,
        });
        parts.push({ type: "tool_result", toolCallId, providerCallId, ok: result.ok, text: result.text });
      } catch (error) {
        if (isOctusError(error, "aborted") || opts.signal.aborted) return "cancelled";
        if (isOctusError(error, "tool_denied")) return "declined";
        const message = error instanceof Error ? error.message : String(error);
        parts.push({ type: "tool_result", toolCallId, providerCallId, ok: false, text: `Error (${isOctusError(error) ? error.code : "tool_failed"}): ${message}` });
      }
    }
    await this.appendMessage(instance, "tool", parts, "tool", undefined, opts.correlationId, this.messageMode(definition, session));
    return "continue";
  }

  private async persistAssistantMessage(instance: AgentInstance, messageId: string, acc: StepAccumulator, toolIds: Map<string, string>, correlationId: string, mode: "plan" | "build" | undefined): Promise<void> {
    const parts: MessagePart[] = [];
    if (acc.text) parts.push({ type: "text", text: acc.text });
    if (acc.reasoningSummary) parts.push({ type: "reasoning_summary", text: acc.reasoningSummary });
    for (const [providerCallId, call] of acc.calls) {
      parts.push({ type: "tool_call", toolCallId: toolIds.get(providerCallId) ?? createId("tool"), name: call.name, argumentsJson: call.args || "{}" });
    }
    await this.appendMessageWithId(instance, messageId, "assistant", parts, "tool", acc.providerState, correlationId, mode);
  }

  /**
   * Compactación: resume lo antiguo con el proveedor (sin herramientas) y fija el corte.
   * El tramo reciente permanece íntegro ante el modelo (ADR-015.6).
   * El coordinador compacta la conversación de sesión; los subagentes, la propia.
   */
  private async compact(instance: AgentInstance, definition: AgentDefinition, session: Session, opts: RunInstanceOptions, emergency = false): Promise<boolean> {
    const isCoordinator = definition.kind === "coordinator";
    const history = isCoordinator ? await this.context.visibleSessionHistory(session.id) : await this.visibleInstanceHistory(instance.id);
    const keep = emergency ? Math.floor((this.options.compactionKeepTokens ?? 15_000) / 2) : (this.options.compactionKeepTokens ?? 15_000);
    const { recent, older } = this.context.recentWindow(history, keep);
    if (older.length === 0 || recent.length === 0) return false;
    const resolution = this.router.resolve({
      instance: instance.model,
      session: session.model,
      profileDefault: definition.defaultModel,
      globalDefault: definition.defaultModel,
    });
    const transcript = older
      .map((m) => `[${m.role}${m.mode ? `|${m.mode}` : ""}] ${m.parts.filter((p) => p.type === "text" || p.type === "reasoning_summary").map((p) => (p as { text: string }).text).join(" | ").slice(0, 4000)}`)
      .join("\n");
    let summary = "";
    try {
      const effort = resolution.model.capabilities.reasoningEfforts.includes("low") ? ("low" as const) : undefined;
      const stream = this.router.generateStream(
        { ...resolution, effort },
        {
          providerId: resolution.provider.id,
          modelId: resolution.model.modelId,
          effort,
          instructions: COMPACTION_PROMPT,
          messages: [{ role: "user", blocks: [{ type: "text", text: `Conversation to checkpoint:\n${transcript}` }] }],
          conversationId: session.id,
          metadata: { sessionId: session.id, runId: instance.runId, instanceId: instance.id },
        },
        {
          sessionId: session.id,
          runId: instance.runId,
          agentInstanceId: instance.id,
          agentDefinitionId: definition.id,
          providerId: resolution.provider.id,
          modelId: resolution.model.modelId,
          correlationId: opts.correlationId,
        },
        opts.signal,
      );
      for await (const event of stream) {
        if (event.type === "text.delta") summary += event.delta;
        if (event.type === "error") return false;
        if (event.type === "completed") break;
      }
    } catch {
      return false;
    }
    if (!summary.trim()) return false;
    if (isCoordinator) {
      const last = older[older.length - 1]! as { createdAt: number } & { rowid?: number };
      const rowid = typeof last.rowid === "number" ? last.rowid : -1;
      await this.context.saveSessionCompaction(session.id, last.createdAt, rowid, summary.trim());
    } else {
      const cutoffSeq = older[older.length - 1]!.seq;
      await this.context.saveCompaction(instance.id, cutoffSeq, summary.trim());
    }
    return true;
  }

  private async visibleInstanceHistory(instanceId: string) {
    const cutoff = await this.context.compactionCutoff(instanceId);
    const full = await this.context.fullHistory(instanceId);
    return full.filter((m) => m.seq > cutoff.seq);
  }

  private async closingStep(
    instance: AgentInstance,
    definition: AgentDefinition,
    session: Session,
    _tools: NormalizedTool[],
    opts: RunInstanceOptions,
  ): Promise<string> {
    void _tools;
    const instructions = `${await this.context.buildInstructions(definition, instance.directory, [])}\n\nMaximum steps reached for this run. Do not call tools. Reply with text only: what was accomplished, what remains, and recommended next steps.`;
    const built =
      definition.kind === "coordinator" ? await this.context.buildSessionMessages(session.id) : await this.context.buildMessages(instance.id);
    const resolution = this.router.resolve({
      instance: instance.model,
      session: session.model,
      profileDefault: definition.defaultModel,
      globalDefault: definition.defaultModel,
    });
    const messageId = nextMessageId();
    let text = "";
    try {
      const stream = this.router.generateStream(
        resolution,
        { providerId: resolution.provider.id, modelId: resolution.model.modelId, effort: resolution.effort, instructions, messages: built.messages, conversationId: session.id },
        {
          sessionId: session.id,
          runId: instance.runId,
          agentInstanceId: instance.id,
          agentDefinitionId: definition.id,
          providerId: resolution.provider.id,
          modelId: resolution.model.modelId,
          correlationId: opts.correlationId,
        },
        opts.signal,
      );
      for await (const event of stream) {
        if (event.type === "text.delta") {
          text += event.delta;
          opts.onStream({ kind: "part.delta", sessionId: session.id, runId: instance.runId, instanceId: instance.id, messageId, part: "text", delta: event.delta });
        }
        if (event.type === "completed" || event.type === "error") break;
      }
    } catch {
      // El cierre es best-effort; el run termina igualmente.
    }
    if (text.trim()) {
      await this.appendMessageWithId(instance, messageId, "assistant", [{ type: "text", text }], "tool", undefined, opts.correlationId, this.messageMode(definition, session));
    }
    return text;
  }

  private toolsFor(definition: AgentDefinition): NormalizedTool[] {
    return this.gateway.manifests().filter((m: ToolManifest) => definition.tools.includes(m.name)).map((m: ToolManifest) => ({
      name: m.name,
      description: m.description,
      parametersJsonSchema: m.inputJsonSchema,
    }));
  }

  /** Modo con el que se envía: perfil del coordinador; ausente en subagentes. */
  private messageMode(definition: AgentDefinition, session: Session): "plan" | "build" | undefined {
    return definition.kind === "coordinator" ? session.profile : undefined;
  }

  private async appendMessage(instance: AgentInstance, role: "assistant" | "tool" | "user" | "system", parts: MessagePart[], trust: "system" | "user" | "tool" | "untrusted", providerState?: unknown, correlationId?: string, mode?: "plan" | "build"): Promise<string> {
    return this.appendMessageWithId(instance, createId("msg"), role, parts, trust, providerState, correlationId ?? createId("cor"), mode);
  }

  private async appendMessageWithId(
    instance: AgentInstance,
    id: string,
    role: "assistant" | "tool" | "user" | "system",
    parts: MessagePart[],
    trust: "system" | "user" | "tool" | "untrusted",
    providerState?: unknown,
    correlationId?: string,
    mode?: "plan" | "build",
  ): Promise<string> {
    const timestamp = now();
    await this.db.exec(
      `INSERT INTO messages (id, session_id, run_id, instance_id, role, mode, parts, provider_state, trust, seq, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(seq) FROM messages WHERE instance_id = ?), -1) + 1, ?`,
      [
        id,
        instance.sessionId,
        instance.runId,
        instance.id,
        role,
        mode ?? null,
        JSON.stringify(parts),
        providerState === undefined ? null : JSON.stringify(providerState),
        trust,
        instance.id,
        timestamp,
      ],
    );
    const row = await this.db.queryOne<{ seq: number }>("SELECT seq FROM messages WHERE id = ?", [id]);
    const event = await this.events.append({
      type: "message.appended",
      aggregate: { kind: "instance", id: instance.id },
      correlationId: correlationId ?? createId("cor"),
      payload: {
        message: {
          id,
          sessionId: instance.sessionId,
          runId: instance.runId,
          instanceId: instance.id,
          role,
          mode,
          parts,
          trust,
          seq: row?.seq ?? 0,
          createdAt: timestamp,
        },
      },
    });
    this.bus.publish(event);
    return id;
  }

  private async loadInstance(id: string): Promise<AgentInstance> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM agent_instances WHERE id = ?", [id]);
    if (!row) throw new OctusError("not_found", `Agent instance not found: ${id}`);
    const rawSnapshot = JSON.parse(String(row.definition_snapshot ?? "{}")) as Partial<AgentInstance["definitionSnapshot"]>;
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      runId: String(row.run_id),
      definitionId: String(row.definition_id),
      parentInstanceId: row.parent_instance_id ? String(row.parent_instance_id) : undefined,
      status: row.status as AgentInstance["status"],
      model: JSON.parse(String(row.model)) as AgentInstance["model"],
      directory: String(row.directory),
      definitionVersion: Number(row.definition_version ?? 1),
      promptHash: String(row.prompt_hash ?? ""),
      definitionSnapshot: {
        definitionId: String(row.definition_id),
        definitionVersion: Number(row.definition_version ?? 1),
        kind: (rawSnapshot.kind ?? "coordinator") as AgentInstance["definitionSnapshot"]["kind"],
        defaultModel: rawSnapshot.defaultModel ?? (JSON.parse(String(row.model)) as AgentInstance["model"]),
        maxSteps: rawSnapshot.maxSteps ?? 60,
        timeoutMs: rawSnapshot.timeoutMs ?? 1_800_000,
        idleTimeoutMs: rawSnapshot.idleTimeoutMs ?? 300_000,
        tools: rawSnapshot.tools ?? [],
        deniedTools: rawSnapshot.deniedTools ?? [],
        permissionRules: rawSnapshot.permissionRules ?? [],
        deliveryFormat: rawSnapshot.deliveryFormat ?? "",
        canDelegateTo: rawSnapshot.canDelegateTo ?? [],
      },
      error: row.error ? String(row.error) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      completedAt: row.completed_at ? Number(row.completed_at) : undefined,
    };
  }

  private async loadDefinition(id: string): Promise<AgentDefinition> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM agent_definitions WHERE id = ?", [id]);
    if (!row) throw new OctusError("not_found", `Agent definition not found: ${id}`);
    return {
      id: String(row.id),
      kind: row.kind as AgentDefinition["kind"],
      name: String(row.name),
      description: String(row.description),
      profile: row.profile ? (String(row.profile) as AgentDefinition["profile"]) : undefined,
      defaultModel: JSON.parse(String(row.default_model)) as AgentDefinition["defaultModel"],
      maxSteps: Number(row.max_steps),
      timeoutMs: Number(row.timeout_ms),
      idleTimeoutMs: Number(row.idle_timeout_ms),
      systemPrompt: String(row.system_prompt),
      tools: JSON.parse(String(row.tools)) as string[],
      deniedTools: JSON.parse(String(row.denied_tools ?? "[]")) as string[],
      permissionRules: JSON.parse(String(row.permission_rules ?? "[]")) as AgentDefinition["permissionRules"],
      deliveryFormat: String(row.delivery_format ?? ""),
      canDelegateTo: JSON.parse(String(row.can_delegate_to ?? "[]")) as AgentDefinition["canDelegateTo"],
      promptVersion: Number(row.prompt_version),
    };
  }

  private async loadSession(id: string): Promise<Session> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM sessions WHERE id = ?", [id]);
    if (!row) throw new OctusError("not_found", `Session not found: ${id}`);
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

  private async setInstanceStatus(instance: AgentInstance, status: AgentInstance["status"], correlationId: string, error?: string): Promise<void> {
    const timestamp = now();
    await this.db.exec("UPDATE agent_instances SET status = ?, error = ?, updated_at = ?, completed_at = ? WHERE id = ?", [
      status,
      error ?? null,
      timestamp,
      status === "completed" || status === "failed" || status === "cancelled" ? timestamp : null,
      instance.id,
    ]);
    instance.status = status;
    const type = status === "running" ? "agent_instance.started" : status === "completed" ? "agent_instance.completed" : status === "failed" ? "agent_instance.failed" : status === "cancelled" ? "agent_instance.cancelled" : "agent_instance.status_changed";
    const event = await this.events.append({
      type,
      aggregate: { kind: "instance", id: instance.id },
      correlationId,
      payload: { status, error },
    });
    this.bus.publish(event);
  }

  private async setRunStatus(runId: string, status: "executing" | "done" | "failed" | "cancelled", correlationId: string, error?: string): Promise<void> {
    const timestamp = now();
    const done = status !== "executing";
    await this.db.exec("UPDATE runs SET status = ?, error = ?, updated_at = ?, completed_at = ? WHERE id = ?", [
      status,
      error ?? null,
      timestamp,
      done ? timestamp : null,
      runId,
    ]);
    const type = status === "executing" ? "run.started" : status === "done" ? "run.completed" : status === "failed" ? "run.failed" : "run.cancelled";
    const event = await this.events.append({ type, aggregate: { kind: "run", id: runId }, correlationId, payload: { status, error } });
    this.bus.publish(event);
  }

  private async finish(
    instance: AgentInstance,
    status: AgentResult["status"],
    finalText: string,
    steps: number,
    correlationId: string,
    error?: string,
    ownsRun = true,
  ): Promise<AgentResult> {
    const instanceStatus = status === "completed" ? "completed" : status === "failed" ? "failed" : "cancelled";
    await this.setInstanceStatus(instance, instanceStatus, correlationId, error);
    if (ownsRun) {
      await this.setRunStatus(instance.runId, status === "completed" ? "done" : status, correlationId, error);
      await this.db.exec("UPDATE sessions SET updated_at = ? WHERE id = ?", [now(), instance.sessionId]);
    }
    return { status, finalText, steps, error };
  }
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
