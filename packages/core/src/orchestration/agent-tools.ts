/**
 * @octus/core — herramientas de delegación (Etapa 2, sin DAG).
 * `delegate` crea una instancia hija en foreground o background; `agent_*` la supervisan.
 */
import { z } from "zod";
import { OctusError } from "../errors.js";
import type { ToolDefinition } from "../tools/tool-definitions.js";
import { requireAgents } from "../tools/tool-services.js";

function toJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const maybe = schema as unknown as { toJSONSchema?: () => Record<string, unknown> };
  return typeof maybe.toJSONSchema === "function" ? maybe.toJSONSchema() : { type: "object" };
}

const delegateSchema = z.object({
  definitionId: z.string().min(1).describe("Subagent profile id (explorer, researcher, implementer, reviewer)"),
  brief: z.string().min(1).max(20000).describe("Self-contained task brief: goal, context, scope, acceptance criteria"),
  mode: z.enum(["foreground", "background"]).optional().describe("Wait for completion (foreground) or continue working (background). Default foreground."),
  directoryId: z.string().min(1).optional().describe("Registered isolated directory id (required for implementer writes)"),
  model: z.object({ providerId: z.string().min(1), modelId: z.string().min(1), effort: z.string().min(1).optional() }).optional().describe("Model override"),
});

export const delegateTool: ToolDefinition = {
  manifest: {
    name: "delegate",
    description: "Spawn a specialized subagent for one task. Foreground waits; background returns an instanceId to supervise with agent_*.",
    inputJsonSchema: toJsonSchema(delegateSchema),
    permissionAction: "delegate",
  },
  schema: delegateSchema,
  async run(args, ctx) {
    const parsed = args as { definitionId: string; brief: string; mode?: "foreground" | "background"; directoryId?: string; model?: { providerId: string; modelId: string; effort?: string } };
    const agents = requireAgents(ctx.services);
    // Implementers/reviewers necesitan una task y el workspace que asigna el
    // scheduler. Sin eso sus escrituras se deniegan: se canalizan por plan_tasks.
    if (["implementer", "reviewer"].includes(parsed.definitionId)) {
      const parent = await agents.status(ctx.instanceId);
      if (parent.definitionId === "coordinator-build") {
        throw new OctusError(
          "invalid_tool_args",
          "Implementer/reviewer work must run through plan_tasks: it creates the task and assigns its workspace/worktree. Manual delegation has no task assignment and writes are denied.",
        );
      }
    }
    const result = await agents.spawn({
      definitionId: parsed.definitionId,
      brief: parsed.brief,
      mode: parsed.mode ?? "foreground",
      directoryId: parsed.directoryId,
      model: parsed.model,
      parentInstanceId: ctx.instanceId,
    });
    if (result.delivery) {
      const delivery = result.delivery;
      return { text: `Subagent ${result.definitionId} finished (${delivery.status}):\n${delivery.summary}${delivery.error ? `\nError: ${delivery.error}` : ""}` };
    }
    return { text: `Subagent started in background: instanceId=${result.instanceId} (${result.definitionId}). Use agent_status/agent_wait/agent_result to supervise it. Do not duplicate its work.` };
  },
};

const instanceSchema = z.object({
  instanceId: z.string().min(1).optional().describe("Target subagent instance id. Omit it in agent_status to list this coordinator's workers."),
});

const targetSchema = z.object({
  instanceId: z.string().min(1).describe("Target subagent instance id"),
});

export const agentStatusTool: ToolDefinition = {
  manifest: { name: "agent_status", description: "Inspect a subagent state, or list this coordinator's worker subagents when instanceId is omitted.", inputJsonSchema: toJsonSchema(instanceSchema), permissionAction: "agent_status" },
  schema: instanceSchema,
  async run(args, ctx) {
    const parsed = args as { instanceId?: string };
    const agents = requireAgents(ctx.services);
    if (!parsed.instanceId) {
      const children = await agents.children(ctx.instanceId);
      if (children.length === 0) return { text: "No worker subagents yet. The scheduler may still be provisioning them; call agent_status again shortly." };
      return {
        text: children
          .map((child) => `- ${child.instanceId} (${child.definitionId}) ${child.status}${child.taskId ? ` task=${child.taskId}` : ""}${child.reviewTargetTaskId ? ` review-target=${child.reviewTargetTaskId}` : ""}${child.error ? ` error=${child.error}` : ""}`)
          .join("\n"),
      };
    }
    await agents.assertOwnedBy(parsed.instanceId, ctx.runId);
    const status = await agents.status(parsed.instanceId);
    return { text: `Agent ${status.instanceId} (${status.definitionId}): ${status.status}, depth ${status.depth}, dir ${status.directory}${status.error ? `, error: ${status.error}` : ""}` };
  },
};

const messageSchema = z.object({
  instanceId: z.string().min(1),
  text: z.string().min(1).max(20000).describe("Follow-up for the subagent; resumes it if it had finished"),
});

export const agentMessageTool: ToolDefinition = {
  manifest: { name: "agent_message", description: "Send a follow-up message to a subagent (resumes it if finished).", inputJsonSchema: toJsonSchema(messageSchema), permissionAction: "agent_message" },
  schema: messageSchema,
  async run(args, ctx) {
    const parsed = args as { instanceId: string; text: string };
    const agents = requireAgents(ctx.services);
    await agents.assertOwnedBy(parsed.instanceId, ctx.runId);
    await agents.message(parsed.instanceId, parsed.text);
    return { text: `Message delivered to ${parsed.instanceId}` };
  },
};

const waitSchema = z.object({
  instanceId: z.string().min(1).optional().describe("Single subagent to wait for"),
  all: z.boolean().optional().describe("Wait for every worker of this coordinator, including new waves"),
  timeoutMs: z.number().int().min(1000).max(600_000).optional().describe("Max wait (default 120s, or 300s for all)"),
});

export const agentWaitTool: ToolDefinition = {
  manifest: { name: "agent_wait", description: "Wait for a background subagent (or all of this coordinator's workers) and return their structured deliveries.", inputJsonSchema: toJsonSchema(waitSchema), permissionAction: "agent_wait" },
  schema: waitSchema,
  async run(args, ctx) {
    const parsed = args as { instanceId?: string; all?: boolean; timeoutMs?: number };
    const agents = requireAgents(ctx.services);
    const clip = (text: string): string => (text.length > 8000 ? `${text.slice(0, 8000)}\n…[delivery truncated]` : text);
    const format = (delivery: { definitionId: string; status: string; summary: string; error?: string }) =>
      `Delivery from ${delivery.definitionId} (${delivery.status}):\n${clip(delivery.summary)}${delivery.error ? `\nError: ${delivery.error}` : ""}`;
    if (parsed.all || !parsed.instanceId) {
      const deliveries = await agents.waitForChildren(ctx.instanceId, parsed.timeoutMs ?? 300_000);
      if (deliveries.length === 0) return { text: "No new worker deliveries. If tasks remain, record pending reviewer verdicts with record_review and call agent_wait {all:true} again." };
      return { text: deliveries.map(format).join("\n\n") };
    }
    await agents.assertOwnedBy(parsed.instanceId, ctx.runId);
    const delivery = await agents.wait(parsed.instanceId, parsed.timeoutMs ?? 120_000);
    return { text: format(delivery) };
  },
};

export const agentResultTool: ToolDefinition = {
  manifest: { name: "agent_result", description: "Read a finished subagent delivery (fails while it is still running).", inputJsonSchema: toJsonSchema(targetSchema), permissionAction: "agent_result" },
  schema: targetSchema,
  async run(args, ctx) {
    const parsed = args as { instanceId: string };
    const agents = requireAgents(ctx.services);
    await agents.assertOwnedBy(parsed.instanceId, ctx.runId);
    const delivery = await agents.result(parsed.instanceId);
    const summary = delivery.summary.length > 8000 ? `${delivery.summary.slice(0, 8000)}\n…[delivery truncated]` : delivery.summary;
    return { text: `Delivery from ${delivery.definitionId} (${delivery.status}):\n${summary}${delivery.error ? `\nError: ${delivery.error}` : ""}` };
  },
};

export const agentCancelTool: ToolDefinition = {
  manifest: { name: "agent_cancel", description: "Cancel a subagent and its descendants.", inputJsonSchema: toJsonSchema(targetSchema), permissionAction: "agent_cancel" },
  schema: targetSchema,
  async run(args, ctx) {
    const parsed = args as { instanceId: string };
    const agents = requireAgents(ctx.services);
    await agents.assertOwnedBy(parsed.instanceId, ctx.runId);
    const result = await agents.cancel(parsed.instanceId);
    return { text: `Cancelled ${result.cancelled.length} instance(s)` };
  },
};

export const AGENT_TOOLS: ToolDefinition[] = [delegateTool, agentStatusTool, agentMessageTool, agentWaitTool, agentResultTool, agentCancelTool];
