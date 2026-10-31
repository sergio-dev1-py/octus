/**
 * @octus/core — PermissionManager: denegar por defecto, última regla gana (ADR-008).
 * El `deny` es inmune a guardados; shell nunca admite "siempre" (ADR-018).
 */
import type { PermissionEffect, PermissionRequest, PermissionRule, SavedPermissionRule } from "@octus/shared";
import { createId } from "@octus/shared";
import { OctusError } from "../errors.js";
import { now, wildcardMatch } from "../util.js";
import type { EventBus, EventStore } from "../events/event-store.js";
import type { PersistenceService } from "../persistence/persistence-service.js";

export interface PermissionLayers {
  /** Herramientas concedidas al perfil (techo duro: fuera de aquí, deny sin excepción). */
  definitionTools: string[];
  /** Denegaciones explícitas del perfil (ganan sobre todo lo demás). */
  deniedTools?: string[];
  /** Reglas propias de la definición (tras los defaults, antes de sesión). */
  definitionRules?: PermissionRule[];
  sessionRules?: PermissionRule[];
  instanceRules?: PermissionRule[];
}

export interface AskContext {
  sessionId: string;
  runId: string;
  instanceId: string;
  projectId: string;
  toolCallId: string;
  action: string;
  correlationId: string;
  signal?: AbortSignal;
  askTimeoutMs?: number;
}

interface PendingAsk {
  request: PermissionRequest;
  resolve: (decision: "once" | "always" | "reject", message?: string) => void;
}

/** Política por defecto de cada herramienta cuando el perfil la incluye. */
const DEFAULT_POLICY: Record<string, PermissionEffect> = {
  read: "allow",
  glob: "allow",
  grep: "allow",
  question: "allow",
  git_status: "allow",
  git_diff: "allow",
  websearch: "allow",
  webfetch: "allow",
  delegate: "allow",
  agent_status: "allow",
  agent_message: "allow",
  agent_wait: "allow",
  agent_result: "allow",
  agent_cancel: "allow",
  "plan.create": "allow",
  "plan.update": "allow",
  "plan.get": "allow",
  "plan.list": "allow",
  "plan.request_approval": "allow",
  plan_tasks: "allow",
  record_review: "allow",
  write: "ask",
  edit: "ask",
  shell: "ask",
  git_stage: "ask",
  git_commit: "ask",
  test_run: "ask",
};

export function evaluateRules(action: string, resource: string, rules: PermissionRule[]): PermissionRule | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource)) return rule;
  }
  return undefined;
}

export class PermissionManager {
  private readonly pending = new Map<string, PendingAsk>();

  constructor(
    private readonly db: PersistenceService,
    private readonly events: EventStore,
    private readonly bus: EventBus,
  ) {}

  private profileRules(tools: string[]): PermissionRule[] {
    const rules: PermissionRule[] = [];
    for (const tool of tools) {
      rules.push({ action: tool, resource: "*", effect: DEFAULT_POLICY[tool] ?? "ask" });
    }
    return rules;
  }

  async savedRules(projectId: string): Promise<SavedPermissionRule[]> {
    const rows = await this.db.query<Record<string, string | number>>(
      "SELECT * FROM permission_rules WHERE project_id = ? ORDER BY created_at ASC",
      [projectId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      action: String(row.action),
      resource: String(row.resource),
      effect: row.effect as PermissionEffect,
      createdAt: Number(row.created_at),
    }));
  }

  async revokeSaved(ruleId: string): Promise<void> {
    await this.db.exec("DELETE FROM permission_rules WHERE id = ?", [ruleId]);
  }

  /** Decide sin preguntar. Techo duro del perfil: las capas inferiores solo estrechan. */
  async preview(action: string, resource: string, layers: PermissionLayers, projectId: string): Promise<PermissionEffect> {
    const denied = layers.deniedTools ?? [];
    if (denied.some((d) => wildcardMatch(action, d))) return "deny";
    if (!layers.definitionTools.includes(action) && !layers.definitionTools.includes("*")) return "deny";
    const saved = await this.savedRules(projectId);
    const rules: PermissionRule[] = [
      ...this.profileRules(layers.definitionTools),
      ...(layers.definitionRules ?? []),
      ...(layers.sessionRules ?? []),
      ...(layers.instanceRules ?? []),
      ...saved.map((r) => ({ action: r.action, resource: r.resource, effect: r.effect }) satisfies PermissionRule),
    ];
    // Shell: los guardados nunca lo elevan.
    const filtered = action === "shell" ? rules.filter((r) => !(saved.some((s) => s.action === r.action && s.resource === r.resource) && r.effect === "allow")) : rules;
    return evaluateRules(action, resource, filtered)?.effect ?? "deny";
  }

  /**
   * Puerta completa: decide, y si toca preguntar crea la solicitud y espera respuesta
   * (con timeout y cancelación por interrupt).
   */
  async decide(
    action: string,
    resources: string[],
    layers: PermissionLayers,
    ctx: AskContext,
    detail?: string,
  ): Promise<{ decision: "allow"; via: string } | { decision: "deny"; via: string }> {
    for (const resource of resources) {
      const effect = await this.preview(action, resource, layers, ctx.projectId);
      if (effect === "deny") {
        throw new OctusError("permission_denied", `Permission denied: ${action} ${resource}`);
      }
    }
    const needsAsk = (
      await Promise.all(resources.map((r) => this.preview(action, r, layers, ctx.projectId)))
    ).some((e) => e === "ask");
    if (!needsAsk) return { decision: "allow", via: "rule" };

    const request: PermissionRequest = {
      id: createId("per"),
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      instanceId: ctx.instanceId,
      toolCallId: ctx.toolCallId,
      action,
      resources,
      detail,
      createdAt: now(),
    };

    // El pendiente se registra ANTES de publicar: una respuesta inmediata no debe perderse.
    let askedEventId: string | undefined;
    const reply = await new Promise<{ decision: "once" | "always" | "reject"; message?: string }>((resolve, reject) => {
      const timeoutMs = ctx.askTimeoutMs ?? 300_000;
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new OctusError("timeout", `Permission request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(new OctusError("aborted", "Permission request aborted by interrupt"));
      };
      const settle = (decision: "once" | "always" | "reject", message?: string) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve({ decision, message });
      };
      this.pending.set(request.id, { request, resolve: settle });
      if (ctx.signal?.aborted) {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(new OctusError("aborted", "Permission request aborted by interrupt"));
        return;
      }
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      void (async () => {
        try {
          const event = await this.events.append({
            type: "permission.asked",
            aggregate: { kind: "tool_call", id: ctx.toolCallId },
            correlationId: ctx.correlationId,
            payload: { requestId: request.id, action, resources, detail },
          });
          askedEventId = event.id;
          this.bus.publish(event);
        } catch (error) {
          clearTimeout(timer);
          this.pending.delete(request.id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });

    const replied = await this.events.append({
      type: "permission.replied",
      aggregate: { kind: "tool_call", id: ctx.toolCallId },
      correlationId: ctx.correlationId,
      causationId: askedEventId,
      payload: { requestId: request.id, decision: reply.decision },
    });
    this.bus.publish(replied);

    if (reply.decision === "reject") {
      throw new OctusError("permission_declined", reply.message?.trim() ? `Declined: ${reply.message.trim()}` : "The user declined the permission request");
    }
    if (reply.decision === "always") {
      if (action === "shell") {
        throw new OctusError("permission_denied", "Shell commands can never be always-allowed (ADR-018)");
      }
      for (const resource of resources) {
        await this.db.exec("INSERT INTO permission_rules (id, project_id, action, resource, effect, created_at) VALUES (?, ?, ?, ?, 'allow', ?)", [
          createId("pru"),
          ctx.projectId,
          action,
          resource,
          now(),
        ]);
      }
      return { decision: "allow", via: "always" };
    }
    return { decision: "allow", via: "once" };
  }

  reply(requestId: string, decision: "once" | "always" | "reject", message?: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    pending.resolve(decision, message);
    return true;
  }

  pendingFor(sessionId?: string): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request).filter((r) => !sessionId || r.sessionId === sessionId);
  }

  /** Al interrumpir: rechaza todo lo pendiente de la sesión para desbloquear el runtime. */
  cancelSession(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.request.sessionId !== sessionId) continue;
      this.pending.delete(id);
      pending.resolve("reject", "Session interrupted");
    }
  }
}
