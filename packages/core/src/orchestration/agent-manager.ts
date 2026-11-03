/**
 * @octus/core — AgentManager: ciclo de vida de subagentes (Etapa 2, ADR-025).
 * Delegación foreground/background sin DAG: límites, exclusividad de directorios,
 * cancelación en cascada y entregas pendientes para el coordinador.
 */
import type { AgentKind, ModelSelection, StreamEvent } from "@octus/shared";
import { realpathSync } from "node:fs";
import { createId } from "@octus/shared";
import type { AgentRegistry } from "../agents/agent-registry.js";
import { promptHashOf, snapshotOf } from "../agents/definition-loader.js";
import { OctusError } from "../errors.js";
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import type { ModelRouter } from "../providers/model-router.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { SkillSpawnGate } from "../skills/skill-runtime.js";
import { sameOrInside } from "../tools/path-scope.js";
import type { AgentDelivery, AgentStatusView, AgentToolService, SpawnMode, SpawnRequest, SpawnResult } from "../tools/tool-services.js";
import type { WorktreePort } from "../worktrees/worktree-port.js";
import type { IntegrationPort } from "../integration/integration-port.js";
import type { ResolutionPort } from "../integration/resolution-port.js";
import { now } from "../util.js";
import { DirectoryRegistry } from "./directory-registry.js";

export interface AgentLimits {
  maxPerSession: number;
  maxPerProject: number;
  maxDepth: number;
  /** Etapa 3: límites por rol (sin integrador; ADR-030). */
  maxImplementers: number;
  maxReaders: number;
  maxReviewers: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = { maxPerSession: 4, maxPerProject: 6, maxDepth: 2, maxImplementers: 2, maxReaders: 2, maxReviewers: 1 };

const ACTIVE = "('created','running','waiting_permission','waiting_input')";

interface Tracked {
  controller: AbortController;
  finished: Promise<unknown>;
}

export class AgentManager implements AgentToolService {
  private readonly tracked = new Map<string, Tracked>();

  constructor(
    private readonly db: PersistenceService,
    private readonly events: EventStore,
    private readonly bus: EventBus,
    private readonly runtime: AgentRuntime,
    private readonly registry: AgentRegistry,
    private readonly router: ModelRouter,
    private readonly directories: DirectoryRegistry,
    private readonly getLimits: () => AgentLimits,
    private readonly onStream: (event: StreamEvent) => void,
    private readonly worktrees?: () => WorktreePort | undefined,
    private readonly resolutions?: () => ResolutionPort | undefined,
    private readonly integrations?: () => IntegrationPort | undefined,
    /** Todo 23: puerta de skills para `spawn` (ausente = spawn con skills se niega). */
    private readonly skillGate?: SkillSpawnGate,
  ) {}

  // ------------------------------------------------------------------ spawn
  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    const parent = await this.requireInstance(request.parentInstanceId);
    const parentSnapshot = this.parseSnapshot(parent.snapshotJson, parent.definitionId);
    const definition = await this.registry.get(request.definitionId);
    if (!definition) throw new OctusError("not_found", `Agent definition not found: ${request.definitionId}`);
    if (!parentSnapshot.canDelegateTo.includes(definition.kind)) {
      throw new OctusError("delegation_denied", `Profile '${parent.definitionId}' cannot delegate to '${definition.kind}'`);
    }
    // Todo 23: workers solo con autorizadas. Sin puerta configurada, el spawn
    // con skills se niega (deny-by-default); con puerta, cada skill debe estar
    // habilitada en el proyecto del padre.
    if (request.skillNames !== undefined && request.skillNames.length > 0) {
      if (!this.skillGate) {
        throw new OctusError("invalid_state", "Spawn con skills sin puerta de autorización: se niega");
      }
      for (const name of request.skillNames) {
        if (!(await this.skillGate.isAllowed(parent.projectId, name))) {
          throw new OctusError("scope_violation", `Skill '${name}' no habilitada en este proyecto`, { details: { area: "skills" } });
        }
      }
    }
    const depth = (await this.depthOf(parent.id)) + 1;
    const limits = this.getLimits();
    if (depth > limits.maxDepth) {
      throw new OctusError("concurrency_limit", `Delegation depth ${depth} exceeds the maximum of ${limits.maxDepth}`);
    }
    await this.checkConcurrency(parent.sessionId, parent.projectId);
    const model = this.resolveModel(request.model, definition.defaultModel);
    const assignment = await this.resolveDirectory(parent, definition.kind, request.directoryId, request.worktreeId, request.taskId, request.reviewTargetTaskId, request.resolutionWorkspaceId, request.integrationId);
    const instanceId = createId("ins");
    const timestamp = now();
    const snapshot = snapshotOf(definition);
    await this.db.exec(
      "INSERT INTO agent_instances (id, session_id, run_id, definition_id, parent_instance_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, assigned_directory_id, instance_rules, task_id, worktree_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        instanceId,
        parent.sessionId,
        parent.runId,
        definition.id,
        parent.id,
        JSON.stringify(model),
        assignment.directory,
        definition.promptVersion,
        promptHashOf(definition),
        JSON.stringify(snapshot),
        assignment.directoryId,
        JSON.stringify(assignment.instanceRules),
        request.taskId ?? null,
        request.worktreeId ?? null,
        timestamp,
        timestamp,
      ],
    );
    const correlationId = createId("cor");
    const event = await this.events.append({
      type: "agent_instance.created",
      aggregate: { kind: "instance", id: instanceId },
      correlationId,
      payload: { runId: parent.runId, definitionId: definition.id, parentInstanceId: parent.id, mode: request.mode, directoryId: assignment.directoryId },
    });
    this.bus.publish(event);
    await this.appendBrief(instanceId, parent.sessionId, parent.runId, request.brief);
    if (request.mode === "foreground") {
      await this.runChild(instanceId, correlationId);
      const delivery = await this.result(instanceId);
      return { instanceId, definitionId: definition.id, mode: request.mode, delivery };
    }
    void this.runChild(instanceId, correlationId).catch(() => undefined);
    return { instanceId, definitionId: definition.id, mode: request.mode };
  }

  private async runChild(instanceId: string, correlationId: string): Promise<void> {
    const controller = new AbortController();
    const finished = this.runtime
      .runInstance(instanceId, { signal: controller.signal, correlationId, onStream: this.onStream, ownsRun: false })
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.tracked.get(instanceId)?.controller === controller) this.tracked.delete(instanceId);
      });
    this.tracked.set(instanceId, { controller, finished });
    await finished;
  }

  // ------------------------------------------------------------- supervisión
  async status(instanceId: string): Promise<AgentStatusView> {
    const row = await this.db.queryOne<Record<string, string | number | null>>(
      "SELECT i.*, t.review_target_task_id AS review_target_task_id FROM agent_instances i LEFT JOIN tasks t ON t.id = i.task_id WHERE i.id = ?",
      [instanceId],
    );
    if (!row) throw new OctusError("not_found", `Agent instance not found: ${instanceId}`);
    return {
      instanceId,
      definitionId: String(row.definition_id),
      status: String(row.status),
      depth: await this.depthOf(instanceId),
      directory: String(row.directory),
      error: row.error ? String(row.error) : undefined,
      taskId: row.task_id ? String(row.task_id) : undefined,
      reviewTargetTaskId: row.review_target_task_id ? String(row.review_target_task_id) : undefined,
    };
  }

  /** Subagentes directos del coordinador, para supervisarlos sin conocer sus ids. */
  async children(parentInstanceId: string): Promise<AgentStatusView[]> {
    const rows = await this.db.query<Record<string, string | number | null>>(
      "SELECT i.*, t.review_target_task_id AS review_target_task_id FROM agent_instances i LEFT JOIN tasks t ON t.id = i.task_id WHERE i.parent_instance_id = ? ORDER BY i.created_at ASC",
      [parentInstanceId],
    );
    const out: AgentStatusView[] = [];
    for (const row of rows) {
      out.push({
        instanceId: String(row.id),
        definitionId: String(row.definition_id),
        status: String(row.status),
        depth: await this.depthOf(String(row.id)),
        directory: String(row.directory),
        error: row.error ? String(row.error) : undefined,
        taskId: row.task_id ? String(row.task_id) : undefined,
        reviewTargetTaskId: row.review_target_task_id ? String(row.review_target_task_id) : undefined,
      });
    }
    return out;
  }

  /**
   * Espera a la oleada actual de workers del coordinador (no a todo el DAG:
   * los reviewer gates exigen que el coordinador registre veredictos entre
   * oleadas). Devuelve las entregas disponibles. No cancela nada.
   */
  async waitForChildren(parentInstanceId: string, timeoutMs: number): Promise<AgentDelivery[]> {
    const coord = await this.db.queryOne<{ run_id: string }>("SELECT run_id FROM agent_instances WHERE id = ?", [parentInstanceId]);
    if (!coord) throw new OctusError("not_found", `Agent instance not found: ${parentInstanceId}`);
    const deadline = now() + timeoutMs;
    const started = now();
    const activeStatuses = ["created", "running", "waiting_permission", "waiting_input"];
    let seen = false;
    let idleSince = 0;
    let emptySince = 0;
    const deliver = async (rows: Array<{ id: string; status: string }>): Promise<AgentDelivery[]> => {
      const fresh: Array<{ id: string; status: string }> = [];
      for (const row of rows) {
        if (activeStatuses.includes(row.status)) continue;
        const already = await this.db.queryOne<{ key: string }>("SELECT key FROM kv WHERE key = ?", [`delivery.wait.${row.id}`]).catch(() => undefined);
        if (!already) fresh.push(row);
      }
      const deliveries: AgentDelivery[] = [];
      for (const row of fresh) {
        const delivery = await this.result(row.id).catch(() => undefined);
        if (!delivery) continue;
        deliveries.push(delivery);
        await this.db.exec("INSERT INTO kv (key, value, updated_at) VALUES (?, '1', ?) ON CONFLICT(key) DO NOTHING", [`delivery.wait.${row.id}`, now()]).catch(() => undefined);
      }
      return deliveries;
    };
    for (;;) {
      const rows = await this.db.query<{ id: string; status: string }>(
        "SELECT id, status FROM agent_instances WHERE parent_instance_id = ? ORDER BY created_at ASC",
        [parentInstanceId],
      );
      const active = rows.filter((row) => activeStatuses.includes(row.status));
      if (rows.length > 0) seen = true;
      if (active.length > 0) {
        idleSince = 0;
        emptySince = 0;
      } else if (seen) {
        // Gracia corta para que el scheduler asigne la siguiente oleada.
        if (idleSince === 0) idleSince = now();
        if (now() - idleSince >= 5000) return deliver(rows);
      } else {
        const actionable = await this.db.queryOne<{ n: number }>(
          "SELECT COUNT(*) AS n FROM tasks WHERE run_id = ? AND status IN ('ready','assigned','running')",
          [coord.run_id],
        );
        if (Number(actionable?.n ?? 0) === 0) {
          if (emptySince === 0) emptySince = now();
          if (now() - emptySince >= 3000) return [];
        } else {
          emptySince = 0;
        }
      }
      if (now() >= deadline) {
        throw new OctusError("timeout", `Timed out waiting for ${active.length} subagent(s) (${Math.round((now() - started) / 1000)}s)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** Evita que un coordinador nuevo reviva instancias de runs anteriores. */
  async assertOwnedBy(instanceId: string, runId: string): Promise<void> {
    const row = await this.db.queryOne<{ run_id: string }>("SELECT run_id FROM agent_instances WHERE id = ?", [instanceId]);
    if (!row) throw new OctusError("not_found", `Agent instance not found: ${instanceId}`);
    if (String(row.run_id) !== runId) {
      throw new OctusError(
        "invalid_state",
        `Agent ${instanceId} belongs to run ${row.run_id}, not this run. Previous runs are not continuable from a new coordinator; create the work with plan_tasks.`,
      );
    }
  }

  async message(instanceId: string, text: string): Promise<void> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM agent_instances WHERE id = ?", [instanceId]);
    if (!row) throw new OctusError("not_found", `Agent instance not found: ${instanceId}`);
    await this.db.exec(
      `INSERT INTO messages (id, session_id, run_id, instance_id, role, parts, trust, seq, created_at)
       SELECT ?, ?, ?, ?, 'user', ?, 'user', COALESCE((SELECT MAX(seq) FROM messages WHERE instance_id = ?), -1) + 1, ?`,
      [createId("msg"), String(row.session_id), String(row.run_id), instanceId, JSON.stringify([{ type: "text", text }]), instanceId, now()],
    );
    const status = String(row.status);
    if (status === "completed" || status === "failed" || status === "cancelled") {
      // Continuar la MISMA instancia (sin crear otra): vuelve a running.
      await this.db.exec("UPDATE agent_instances SET status = 'running', error = NULL, updated_at = ? WHERE id = ?", [now(), instanceId]);
      void this.runChild(instanceId, createId("cor")).catch(() => undefined);
    }
  }

  async wait(instanceId: string, timeoutMs: number): Promise<AgentDelivery> {
    const deadline = now() + timeoutMs;
    for (;;) {
      const row = await this.db.queryOne<{ status: string }>("SELECT status FROM agent_instances WHERE id = ?", [instanceId]);
      if (!row) throw new OctusError("not_found", `Agent instance not found: ${instanceId}`);
      if (["completed", "failed", "cancelled"].includes(row.status)) return this.result(instanceId);
      if (now() >= deadline) throw new OctusError("timeout", `Timed out waiting for agent ${instanceId}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async result(instanceId: string): Promise<AgentDelivery> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM agent_instances WHERE id = ?", [instanceId]);
    if (!row) throw new OctusError("not_found", `Agent instance not found: ${instanceId}`);
    const status = String(row.status);
    if (!["completed", "failed", "cancelled"].includes(status)) {
      throw new OctusError("invalid_state", `Agent ${instanceId} is still ${status}; use agent_wait`);
    }
    const last = await this.db.queryOne<{ parts: string }>(
      "SELECT parts FROM messages WHERE instance_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1",
      [instanceId],
    );
    let summary = "";
    if (last) {
      try {
        const parts = JSON.parse(String(last.parts)) as Array<{ type: string; text?: string }>;
        summary = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
      } catch {
        summary = "";
      }
    }
    return {
      instanceId,
      definitionId: String(row.definition_id),
      status: status as AgentDelivery["status"],
      summary,
      error: row.error ? String(row.error) : undefined,
    };
  }

  /** Recuperar una instancia interrumpida (post-reinicio): misma instancia, sin intento nuevo. */
  async resumeInstance(instanceId: string): Promise<void> {
    const row = await this.db.queryOne<{ status: string }>("SELECT status FROM agent_instances WHERE id = ?", [instanceId]);
    if (!row) throw new OctusError("not_found", `Agent instance not found: ${instanceId}`);
    if (row.status !== "interrupted") {
      throw new OctusError("invalid_state", `Only interrupted instances can be resumed (is ${row.status}; use message to continue finished ones)`);
    }
    await this.db.exec("UPDATE agent_instances SET status = 'running', error = NULL, updated_at = ? WHERE id = ?", [now(), instanceId]);
    void this.runChild(instanceId, createId("cor")).catch(() => undefined);
  }

  async cancel(instanceId: string): Promise<{ cancelled: string[] }> {
    const cancelled: string[] = [];
    const visit = async (id: string): Promise<void> => {
      const children = await this.db.query<{ id: string }>("SELECT id FROM agent_instances WHERE parent_instance_id = ?", [id]);
      for (const child of children) await visit(child.id);
      const tracked = this.tracked.get(id);
      if (tracked) {
        tracked.controller.abort();
        await tracked.finished.catch(() => undefined);
      } else {
        await this.db.exec("UPDATE agent_instances SET status = 'cancelled', error = 'Cancelled', updated_at = ? WHERE id = ? AND status NOT IN ('completed','failed','cancelled')", [now(), id]);
      }
      cancelled.push(id);
    };
    const row = await this.db.queryOne<{ id: string }>("SELECT id FROM agent_instances WHERE id = ?", [instanceId]);
    if (!row) throw new OctusError("not_found", `Agent instance not found: ${instanceId}`);
    await visit(instanceId);
    return { cancelled };
  }

  /**
   * Cierra el turno del coordinador de PLAN: espera a todos sus subagentes del
   * run para que el resultado llegue antes de entregar el plan. Si alguno
   * excede el tope, se cancela (nunca quedan corriendo tras el plan).
   */
  async settleRunChildren(runId: string, timeoutMs = 180_000): Promise<{ waited: number; cancelled: number }> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT i.id AS id FROM agent_instances i
       WHERE i.run_id = ? AND i.parent_instance_id IS NOT NULL
         AND i.status IN ('created','running','waiting_permission','waiting_input')`,
      [runId],
    );
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return { waited: 0, cancelled: 0 };
    const waits = ids.map((id) => this.tracked.get(id)?.finished).filter((p): p is Promise<unknown> => Boolean(p));
    if (waits.length === 0) return { waited: ids.length, cancelled: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const outcome = await Promise.race([Promise.all(waits).then(() => "done" as const), timeout]);
    if (timer) clearTimeout(timer);
    if (outcome === "done") return { waited: ids.length, cancelled: 0 };
    let cancelled = 0;
    for (const id of ids) {
      const still = await this.db
        .queryOne<{ status: string }>("SELECT status FROM agent_instances WHERE id = ?", [id])
        .catch(() => undefined);
      if (still && ["created", "running", "waiting_permission", "waiting_input"].includes(String(still.status))) {
        await this.cancel(id).catch(() => undefined);
        cancelled++;
      }
    }
    return { waited: ids.length - cancelled, cancelled };
  }

  /** Cancela todo lo activo de una sesión (interrupt del usuario). */
  async cancelSession(sessionId: string): Promise<void> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM agent_instances WHERE session_id = ? AND status IN ${ACTIVE}`,
    );
    for (const row of rows) {
      const tracked = this.tracked.get(row.id);
      if (tracked) {
        tracked.controller.abort();
        await tracked.finished.catch(() => undefined);
      } else {
        await this.db.exec("UPDATE agent_instances SET status = 'cancelled', error = 'Session interrupted', updated_at = ? WHERE id = ?", [now(), row.id]);
      }
    }
  }

  /** Entregas terminales aún no consumidas por el coordinador (background superviviente). */
  async pendingDeliveries(sessionId: string): Promise<AgentDelivery[]> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT i.id AS id FROM agent_instances i
       JOIN agent_definitions d ON d.id = i.definition_id
       WHERE i.session_id = ? AND i.parent_instance_id IS NOT NULL
       AND i.status IN ('completed','failed','cancelled')
       AND d.kind <> 'coordinator'
       AND NOT EXISTS (SELECT 1 FROM kv WHERE key = 'delivery.seen.' || i.id)`,
      [sessionId],
    );
    const out: AgentDelivery[] = [];
    for (const row of rows) out.push(await this.result(row.id));
    return out;
  }

  async consumePendingDeliveries(sessionId: string): Promise<AgentDelivery[]> {
    const deliveries = await this.pendingDeliveries(sessionId);
    for (const delivery of deliveries) {
      await this.db.exec("INSERT INTO kv (key, value, updated_at) VALUES (?, '1', ?) ON CONFLICT(key) DO NOTHING", [
        `delivery.seen.${delivery.instanceId}`,
        now(),
      ]);
    }
    return deliveries;
  }

  async activeInstances(sessionId: string): Promise<AgentStatusView[]> {
    const rows = await this.db.query<Record<string, string | number | null>>(
      `SELECT * FROM agent_instances WHERE session_id = ? AND status IN ${ACTIVE} ORDER BY created_at ASC`,
      [sessionId],
    );
    const out: AgentStatusView[] = [];
    for (const row of rows) {
      out.push({
        instanceId: String(row.id),
        definitionId: String(row.definition_id),
        status: String(row.status),
        depth: await this.depthOf(String(row.id)),
        directory: String(row.directory),
        error: row.error ? String(row.error) : undefined,
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ internas
  private async requireInstance(instanceId: string): Promise<{ id: string; sessionId: string; runId: string; definitionId: string; snapshotJson: string; projectId: string }> {
    const row = await this.db.queryOne<Record<string, string | number | null>>(
      "SELECT i.*, s.project_id AS project_id FROM agent_instances i JOIN sessions s ON s.id = i.session_id WHERE i.id = ?",
      [instanceId],
    );
    if (!row) throw new OctusError("not_found", `Agent instance not found: ${instanceId}`);
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      runId: String(row.run_id),
      definitionId: String(row.definition_id),
      snapshotJson: String(row.definition_snapshot ?? "{}"),
      projectId: String(row.project_id),
    };
  }

  private parseSnapshot(json: string, definitionId: string): { canDelegateTo: AgentKind[] } {
    try {
      const parsed = JSON.parse(json) as { canDelegateTo?: AgentKind[] };
      if (Array.isArray(parsed.canDelegateTo)) return { canDelegateTo: parsed.canDelegateTo };
    } catch {
      // legacy sin snapshot: sin delegación
    }
    void definitionId;
    return { canDelegateTo: [] };
  }

  private async depthOf(instanceId: string): Promise<number> {
    let depth = 0;
    let current: string | undefined = instanceId;
    const seen = new Set<string>();
    for (;;) {
      if (!current || seen.has(current)) break;
      seen.add(current);
      const row: { parent_instance_id: string | null } | null = await this.db.queryOne<{ parent_instance_id: string | null }>(
        "SELECT parent_instance_id FROM agent_instances WHERE id = ?",
        [current],
      );
      if (!row?.parent_instance_id) break;
      depth++;
      current = row.parent_instance_id;
      if (depth > 10) break;
    }
    return depth;
  }

  private async checkConcurrency(sessionId: string, projectId: string): Promise<void> {
    const limits = this.getLimits();
    const sessionCount = await this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agent_instances WHERE session_id = ? AND status IN ${ACTIVE}`,
      [sessionId],
    );
    if ((sessionCount?.n ?? 0) >= limits.maxPerSession) {
      throw new OctusError("concurrency_limit", `Session already has ${limits.maxPerSession} active agents`);
    }
    const projectCount = await this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agent_instances i JOIN sessions s ON s.id = i.session_id WHERE s.project_id = ? AND i.status IN ${ACTIVE}`,
      [projectId],
    );
    if ((projectCount?.n ?? 0) >= limits.maxPerProject) {
      throw new OctusError("concurrency_limit", `Project already has ${limits.maxPerProject} active agents`);
    }
  }

  private resolveModel(override: ModelSelection | undefined, fallback: ModelSelection): ModelSelection {
    const selected = override ?? fallback;
    const provider = this.router.get(selected.providerId);
    const model = provider?.models().find((m) => m.modelId === selected.modelId);
    if (!provider || !model) {
      throw new OctusError("model_not_supported", `Model '${selected.providerId}/${selected.modelId}' is not available`);
    }
    if (selected.effort && !model.capabilities.reasoningEfforts.includes(selected.effort as never)) {
      throw new OctusError("effort_not_supported", `Effort '${selected.effort}' is not supported by ${selected.modelId}`);
    }
    return { providerId: selected.providerId, modelId: selected.modelId, effort: selected.effort };
  }

  private async resolveDirectory(
    parent: { sessionId: string; projectId: string },
    childKind: AgentKind,
    directoryId: string | undefined,
    worktreeId?: string,
    taskId?: string,
    reviewTargetTaskId?: string,
    resolutionWorkspaceId?: string,
    integrationId?: string,
  ): Promise<{ directory: string; directoryId: string | null; instanceRules: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> }> {
    // Worktree de integración para revisión (Etapa 5): manager-asignado, nunca ruta libre.
    if (integrationId) {
      const port = this.integrations?.();
      if (!port) throw new OctusError("invalid_state", "Integration workspace requested but no IntegrationManager is wired");
      const ws = await port.getIntegrationWorkspace(integrationId);
      if (!ws) throw new OctusError("not_found", `Integration workspace not found: ${integrationId}`);
      if (ws.projectId !== parent.projectId) {
        throw new OctusError("scope_violation", "Integration workspace belongs to another project");
      }
      if (childKind !== "reviewer") {
        throw new OctusError("scope_violation", "Only a reviewer may read the integration workspace");
      }
      if (!["building", "validating"].includes(ws.status)) {
        throw new OctusError("invalid_state", `Integration workspace is ${ws.status}, not usable for spawn`);
      }
      return { directory: ws.path, directoryId: null, instanceRules: [] };
    }
    // Workspace de resolución de un conflicto (Etapa 5): manager-asignado, nunca ruta libre.
    if (resolutionWorkspaceId) {
      const port = this.resolutions?.();
      if (!port) throw new OctusError("invalid_state", "Resolution workspace requested but no ConflictManager is wired");
      const ws = await port.getResolutionWorkspace(resolutionWorkspaceId);
      if (!ws) throw new OctusError("not_found", `Resolution workspace not found: ${resolutionWorkspaceId}`);
      if (ws.projectId !== parent.projectId) {
        throw new OctusError("scope_violation", "Resolution workspace belongs to another project");
      }
      if (childKind !== "implementer") {
        throw new OctusError("scope_violation", "Only an implementer may resolve conflicts");
      }
      if (!["open", "resolving"].includes(ws.status)) {
        throw new OctusError("invalid_state", `Resolution workspace is ${ws.status}, not usable for spawn`);
      }
      return { directory: ws.path, directoryId: null, instanceRules: [] };
    }
    // Worktree asignado por el WorktreeManager (Etapa 4): gana sobre directoryId.
    if (worktreeId) {
      const port = this.worktrees?.();
      if (!port) throw new OctusError("invalid_state", "Worktree assignment requested but no WorktreeManager is wired");
      const assigned = await port.getAssignment(worktreeId);
      if (!assigned) throw new OctusError("not_found", `Assigned worktree not found: ${worktreeId}`);
      if (assigned.projectId !== parent.projectId) {
        throw new OctusError("scope_violation", "Assigned worktree belongs to another project");
      }
      const owns = taskId !== undefined && assigned.taskId === taskId;
      const reviews = childKind === "reviewer" && reviewTargetTaskId !== undefined && assigned.taskId === reviewTargetTaskId;
      if (!owns && !reviews) {
        throw new OctusError("scope_violation", "Assigned worktree belongs to another task");
      }
      // Implementer: solo el espacio asignado activo. Reviewer: lee el worktree
      // del target en cualquier estado intacto (finished es lo normal al revisar).
      const usable = owns
        ? ["assigned", "running", "suspended"]
        : ["available", "assigned", "running", "suspended", "finished", "retained"];
      if (!usable.includes(assigned.status)) {
        throw new OctusError("invalid_state", `Assigned worktree is ${assigned.status}, not usable for spawn`);
      }
      return { directory: assigned.path, directoryId: null, instanceRules: [] };
    }
    const session = await this.db.queryOne<{ directory: string }>("SELECT directory FROM sessions WHERE id = ?", [parent.sessionId]);
    const sessionDir = session ? String(session.directory) : "";
    if (!directoryId) {
      // Implementer del scheduler en proyecto no-git: el workspace legacy es el
      // directorio de la sesión. Las reservas de scope evitan solapes entre
      // writers. La delegación manual (sin taskId) sigue siendo solo lectura.
      if (childKind === "implementer" && !taskId) {
        const deny = ["write", "edit", "shell", "git_stage", "git_commit"].map((action) => ({ action, resource: "*", effect: "deny" as const }));
        return { directory: sessionDir, directoryId: null, instanceRules: deny };
      }
      return { directory: sessionDir, directoryId: null, instanceRules: [] };
    }
    const registered = await this.directories.get(directoryId);
    if (!registered || registered.projectId !== parent.projectId) {
      throw new OctusError("scope_violation", "Assigned directory is not registered for this project");
    }
    // Exclusividad real entre escritores activos (solape en cualquier dirección).
    const writers = await this.db.query<{ directory: string }>(
      `SELECT i.directory AS directory FROM agent_instances i
       JOIN agent_definitions d ON d.id = i.definition_id
       WHERE i.session_id = ? AND i.status IN ${ACTIVE} AND d.kind = 'implementer' AND i.assigned_directory_id IS NOT NULL`,
      [parent.sessionId],
    );
    const candidate = realpathSync(registered.realPath);
    for (const writer of writers) {
      let other: string;
      try {
        other = realpathSync(String(writer.directory));
      } catch {
        continue;
      }
      if (sameOrInside(other, candidate) || sameOrInside(candidate, other)) {
        throw new OctusError("scope_conflict", "Assigned directory overlaps an active implementer scope");
      }
    }
    return { directory: registered.realPath, directoryId: registered.id, instanceRules: [] };
  }

  private async appendBrief(instanceId: string, sessionId: string, runId: string, brief: string): Promise<void> {
    await this.db.exec(
      `INSERT INTO messages (id, session_id, run_id, instance_id, role, parts, trust, seq, created_at)
       SELECT ?, ?, ?, ?, 'user', ?, 'user', COALESCE((SELECT MAX(seq) FROM messages WHERE instance_id = ?), -1) + 1, ?`,
      [createId("msg"), sessionId, runId, instanceId, JSON.stringify([{ type: "text", text: brief }]), instanceId, now()],
    );
  }
}

export type { SpawnMode, SpawnRequest, SpawnResult };
