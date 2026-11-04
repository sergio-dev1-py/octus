/**
 * @octus/core — ToolGateway: único camino de ejecución de herramientas (ADR-008).
 * Definición → validación → permisos → ejecución → registro. Idempotente por clave.
 */
import type { QuestionPrompt, ToolExecuteRequest, ToolExecuteResult } from "@octus/shared";
import { createId } from "@octus/shared";
import { isOctusError, OctusError } from "../errors.js";
import { now, truncate } from "../util.js";
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import type { PermissionLayers, PermissionManager } from "../permissions/permission-manager.js";
import type { ToolServices } from "./tool-services.js";
import type { ToolDefinition, ToolRunContext } from "./tool-definitions.js";

export interface GatewayServices {
  askQuestion: (questions: QuestionPrompt[], ctx: { sessionId: string; runId: string; instanceId: string; toolCallId: string; correlationId: string; signal?: AbortSignal }) => Promise<
    Array<{ question: string; answers: string[] }>
  >;
  /** Servicios de agentes/planes; lo fija el núcleo tras crear los managers. */
  toolServices?: ToolServices;
}

export interface GatewayOptions {
  shellTimeoutMs: number;
  maxInlineChars: number;
  /** Raíces internas protegidas (datos de Octus). */
  protectedRoots?: string[];
  projectIdForSession: (sessionId: string) => Promise<string>;
  layersFor: (definitionId: string, sessionId: string, instanceId: string) => Promise<PermissionLayers>;
  /**
   * Todo 23: dice si una skill PIDE una herramienta (`allowed-tools`,
   * descriptivo). Nunca autoriza: si las capas niegan y la skill lo pedía,
   * la llamada se niega y se audita como intento de evasión.
   */
  skillAllowsTool?: (skillName: string, action: string) => boolean;
  /** Todo 23: registra el intento de evasión (SkillRuntime.noteBypass). */
  noteSkillBypass?: (runId: string, skillName: string, action: string) => Promise<void>;
}

export class ToolGateway {
  private readonly definitions = new Map<string, ToolDefinition>();

  constructor(
    private readonly db: PersistenceService,
    private readonly events: EventStore,
    private readonly bus: EventBus,
    private readonly permissions: PermissionManager,
    private readonly services: GatewayServices,
    private readonly options: GatewayOptions,
    definitions: ToolDefinition[],
  ) {
    for (const def of definitions) this.definitions.set(def.manifest.name, def);
  }

  manifests() {
    return [...this.definitions.values()].map((d) => d.manifest);
  }

  /** Registro dinámico (p. ej. herramientas MCP aisladas por servidor, Todo 27).
   *  El nombre ya registrado se rechaza como conflicto: jamás se sobrescribe
   *  en silencio una herramienta en uso. */
  registerDefinition(definition: ToolDefinition): void {
    if (this.definitions.has(definition.manifest.name)) {
      throw new OctusError("already_exists", `Tool already registered: '${definition.manifest.name}'`);
    }
    this.definitions.set(definition.manifest.name, definition);
  }

  /** Retira una herramienta dinámica por nombre. Devuelve si existía. */
  unregisterTool(name: string): boolean {
    return this.definitions.delete(name);
  }

  /** Retira todas las herramientas dinámicas que cumplan el predicado. Devuelve las retiradas. */
  unregisterWhere(predicate: (name: string) => boolean): string[] {
    const removed: string[] = [];
    for (const name of [...this.definitions.keys()]) {
      if (predicate(name)) {
        this.definitions.delete(name);
        removed.push(name);
      }
    }
    return removed;
  }

  async execute(request: ToolExecuteRequest): Promise<ToolExecuteResult> {
    const started = now();
    const definition = this.definitions.get(request.name);
    if (!definition) throw new OctusError("tool_not_found", `Unknown tool '${request.name}'`);

    // Idempotencia: un efecto ya aplicado nunca se re-ejecuta (ADR-015.7).
    const existing = await this.db.queryOne<Record<string, string | number | null>>(
      "SELECT * FROM tool_invocations WHERE idempotency_key = ?",
      [request.idempotencyKey],
    );
    if (existing && ["completed", "failed", "denied"].includes(String(existing.status))) {
      return {
        ok: String(existing.status) === "completed",
        text: String(existing.result_text ?? existing.error ?? ""),
        error: String(existing.status) === "completed" ? undefined : String(existing.error ?? "tool failed"),
      };
    }

    const parsed = definition.schema.safeParse(request.args);
    if (!parsed.success) {
      throw new OctusError("invalid_tool_args", `Invalid arguments for '${request.name}': ${parsed.error.issues.map((i) => i.message).slice(0, 3).join("; ")}`);
    }

    // Build anclado a un plan: con workers activos o tareas listas, la
    // implementación va por plan_tasks para no pisar worktrees. Cuando el DAG
    // está bloqueado o inactivo, el coordinador puede leer/editar/ejecutar
    // directamente para desbloquear el run sin pedir permiso al usuario.
    if (request.definitionId === "coordinator-build" && ["write", "edit", "shell", "git_stage", "git_commit"].includes(request.name)) {
      const run = await this.db.queryOne<{ plan_revision_id: string | null }>("SELECT plan_revision_id FROM runs WHERE id = ?", [request.runId]).catch(() => undefined);
      if (run?.plan_revision_id) {
        const activeWorkers = await this.db.queryOne<{ n: number }>(
          "SELECT COUNT(*) AS n FROM agent_instances WHERE run_id = ? AND parent_instance_id IS NOT NULL AND status IN ('created','running','waiting_permission','waiting_input')",
          [request.runId],
        );
        const openWork = await this.db.queryOne<{ n: number }>(
          "SELECT COUNT(*) AS n FROM tasks WHERE run_id = ? AND status IN ('pending','ready','assigned','running')",
          [request.runId],
        );
        if ((activeWorkers?.n ?? 0) > 0 || (openWork?.n ?? 0) > 0) {
          throw new OctusError(
            "permission_denied",
            "Workers are active for this plan. Wait for their deliveries or replan; direct write/edit/shell by the coordinator is allowed only when the DAG is idle or blocked.",
          );
        }
      }
    }

    const layers = await this.options.layersFor(request.definitionId, request.sessionId, request.instanceId);
    const projectId = await this.options.projectIdForSession(request.sessionId);
    const correlationId = createId("cor");

    await this.db.exec(
      `INSERT INTO tool_invocations (id, session_id, run_id, instance_id, name, arguments_json, status, provider_call_id, idempotency_key, permission, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)`,
      [request.toolCallId, request.sessionId, request.runId, request.instanceId, request.name, JSON.stringify(parsed.data), request.idempotencyKey, JSON.stringify({ decision: "ask" }), started],
    );
    await this.publishToolEvent("tool_call.requested", request, correlationId, { name: request.name, ...skillPayload(request.skillName) });

    const resources = scopeResources(request.name, request.directory, parsed.data);
    try {
      const verdict = await this.permissions.decide(
        definition.manifest.permissionAction,
        resources,
        layers,
        {
          sessionId: request.sessionId,
          runId: request.runId,
          instanceId: request.instanceId,
          projectId,
          toolCallId: request.toolCallId,
          action: definition.manifest.permissionAction,
          correlationId,
          signal: request.signal,
        },
        permissionDetail(request.name, parsed.data) ?? definition.permissionDetail?.(parsed.data),
      );
      await this.db.exec("UPDATE tool_invocations SET status = 'running', permission = ? WHERE id = ?", [
        JSON.stringify({ decision: "allow", rule: verdict.via }),
        request.toolCallId,
      ]);
      await this.publishToolEvent("tool_call.started", request, correlationId, { via: verdict.via, ...skillPayload(request.skillName) });
    } catch (error) {
      if (isOctusError(error, "permission_declined") || isOctusError(error, "aborted") || isOctusError(error, "timeout")) {
        await this.db.exec("UPDATE tool_invocations SET status = 'denied', error = ?, completed_at = ? WHERE id = ?", [
          error.message,
          now(),
          request.toolCallId,
        ]);
        await this.publishToolEvent("tool_call.failed", request, correlationId, { error: error.code, ...skillPayload(request.skillName) });
        throw new OctusError("tool_denied", error.message, { details: { code: error.code } });
      }
      if (isOctusError(error, "permission_denied")) {
        // Todo 23: una skill nunca autoriza herramienta prohibida. Si la skill
        // la pedía (`allowed-tools`) y las capas niegan, se niega y se audita.
        const bypass =
          request.skillName !== undefined &&
          (this.options.skillAllowsTool?.(request.skillName, definition.manifest.permissionAction) ?? false);
        if (bypass) {
          await this.options.noteSkillBypass?.(request.runId, request.skillName!, definition.manifest.permissionAction);
        }
        await this.db.exec("UPDATE tool_invocations SET status = 'denied', error = ?, completed_at = ? WHERE id = ?", [
          bypass ? `[skill-bypass-denied skill=${request.skillName}] ${error.message}` : error.message,
          now(),
          request.toolCallId,
        ]);
        await this.publishToolEvent("tool_call.failed", request, correlationId, {
          error: "permission_denied",
          ...skillPayload(request.skillName),
          ...(bypass ? { skillBypassAttempt: true } : {}),
        });
        throw error;
      }
      throw error;
    }

    const runCtx: ToolRunContext = {
      directory: request.directory,
      protectedRoots: this.options.protectedRoots ?? [],
      projectId,
      sessionId: request.sessionId,
      runId: request.runId,
      instanceId: request.instanceId,
      signal: request.signal ?? new AbortController().signal,
      shellTimeoutMs: this.options.shellTimeoutMs,
      maxInlineChars: this.options.maxInlineChars,
      services: this.services.toolServices,
      askQuestion: (questions) =>
        this.services.askQuestion(questions, {
          sessionId: request.sessionId,
          runId: request.runId,
          instanceId: request.instanceId,
          toolCallId: request.toolCallId,
          correlationId,
          signal: request.signal,
        }),
    };

    try {
      const outcome = await definition.run(parsed.data, runCtx);
      let artifactId: string | undefined;
      if (outcome.fullText) {
        artifactId = createId("art");
        await this.db.exec(
          "INSERT INTO artifacts (id, session_id, run_id, instance_id, tool_call_id, kind, mime, text, byte_size, created_at) VALUES (?, ?, ?, ?, ?, 'tool_output', 'text/plain', ?, ?, ?)",
          [artifactId, request.sessionId, request.runId, request.instanceId, request.toolCallId, outcome.fullText, outcome.fullText.length, now()],
        );
      }
      await this.db.exec("UPDATE tool_invocations SET status = 'completed', result_text = ?, artifact_id = ?, completed_at = ? WHERE id = ?", [
        outcome.text,
        artifactId ?? null,
        now(),
        request.toolCallId,
      ]);
      await this.publishToolEvent("tool_call.completed", request, correlationId, { artifactId, ...skillPayload(request.skillName) });
      return { ok: true, text: outcome.text, fullText: outcome.fullText, diff: outcome.diff };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = isOctusError(error) ? error.code : "tool_failed";
      if (code === "aborted") {
        await this.db.exec("UPDATE tool_invocations SET status = 'cancelled', error = ?, completed_at = ? WHERE id = ?", [
          message,
          now(),
          request.toolCallId,
        ]);
        await this.publishToolEvent("tool_call.failed", request, correlationId, { error: code });
        throw error instanceof OctusError ? error : new OctusError("aborted", message);
      }
      if (code === "scope_violation" || code === "tool_denied") {
        await this.db.exec("UPDATE tool_invocations SET status = 'denied', error = ?, completed_at = ? WHERE id = ?", [
          message,
          now(),
          request.toolCallId,
        ]);
        await this.publishToolEvent("tool_call.failed", request, correlationId, { error: code });
        throw error instanceof OctusError ? error : new OctusError("tool_denied", message);
      }
      await this.db.exec("UPDATE tool_invocations SET status = 'failed', error = ?, completed_at = ? WHERE id = ?", [
        message.slice(0, 8000),
        now(),
        request.toolCallId,
      ]);
      await this.publishToolEvent("tool_call.failed", request, correlationId, { error: code });
      if (error instanceof OctusError) throw error;
      throw new OctusError("tool_failed", message);
    }
  }

  private async publishToolEvent(
    type: "tool_call.requested" | "tool_call.started" | "tool_call.completed" | "tool_call.failed",
    request: ToolExecuteRequest,
    correlationId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const event = await this.events.append({
      type,
      aggregate: { kind: "tool_call", id: request.toolCallId },
      correlationId,
      payload: { name: request.name, sessionId: request.sessionId, runId: request.runId, instanceId: request.instanceId, ...payload },
    });
    this.bus.publish(event);
  }
}

/** Todo 23: procedencia de skill en eventos (auditoría, nunca autorización). */
function skillPayload(skillName: string | undefined): Record<string, unknown> {
  return skillName === undefined ? {} : { skill: skillName };
}

function scopeResources(tool: string, directory: string, args: unknown): string[] {
  const record = (args ?? {}) as Record<string, unknown>;
  if (tool === "shell") return [truncate(String(record.command ?? ""), 500).text || "*"];
  if (typeof record.path === "string" && record.path) return [record.path];
  if (typeof record.pattern === "string" && record.pattern) return [record.pattern];
  if (typeof record.directory === "string" && record.directory) return [record.directory];
  void directory;
  return ["*"];
}

function permissionDetail(tool: string, args: unknown): string | undefined {
  const record = (args ?? {}) as Record<string, unknown>;
  if (tool === "shell") return `Command: ${String(record.command ?? "")}`.slice(0, 2000);
  if (tool === "write" && typeof record.path === "string") {
    const content = String(record.content ?? "");
    return `Write ${content.length} chars to ${record.path}\nPreview:\n${content.slice(0, 1500)}`;
  }
  if (tool === "edit" && typeof record.path === "string") {
    return `Edit ${record.path}: replace ${String(record.oldString ?? "").length} chars with ${String(record.newString ?? "").length} chars`;
  }
  return undefined;
}
