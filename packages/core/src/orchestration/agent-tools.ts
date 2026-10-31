/**
 * @octus/core — herramientas de delegación (Etapa 2, sin DAG).
 * `delegate` crea una instancia hija en foreground o background; `agent_*` la supervisan.
 */
import { z } from "zod";
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
  instanceId: z.string().min(1).describe("Target subagent instance id"),
});

export const agentStatusTool: ToolDefinition = {
  manifest: { name: "agent_status", description: "Inspect a subagent state (status, depth, directory).", inputJsonSchema: toJsonSchema(instanceSchema), permissionAction: "agent_status" },
  schema: instanceSchema,
  async run(args, ctx) {
    const parsed = args as { instanceId: string };
    const status = await requireAgents(ctx.services).status(parsed.instanceId);
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
    await requireAgents(ctx.services).message(parsed.instanceId, parsed.text);
    return { text: `Message delivered to ${parsed.instanceId}` };
  },
};

const waitSchema = z.object({
  instanceId: z.string().min(1),
  timeoutMs: z.number().int().min(1000).max(600_000).optional().describe("Max wait (default 120000)"),
});

export const agentWaitTool: ToolDefinition = {
  manifest: { name: "agent_wait", description: "Wait for a background subagent and return its structured delivery.", inputJsonSchema: toJsonSchema(waitSchema), permissionAction: "agent_wait" },
  schema: waitSchema,
  async run(args, ctx) {
    const parsed = args as { instanceId: string; timeoutMs?: number };
    const delivery = await requireAgents(ctx.services).wait(parsed.instanceId, parsed.timeoutMs ?? 120_000);
    return { text: `Delivery from ${delivery.definitionId} (${delivery.status}):\n${delivery.summary}${delivery.error ? `\nError: ${delivery.error}` : ""}` };
  },
};

export const agentResultTool: ToolDefinition = {
  manifest: { name: "agent_result", description: "Read a finished subagent delivery (fails while it is still running).", inputJsonSchema: toJsonSchema(instanceSchema), permissionAction: "agent_result" },
  schema: instanceSchema,
  async run(args, ctx) {
    const parsed = args as { instanceId: string };
    const delivery = await requireAgents(ctx.services).result(parsed.instanceId);
    return { text: `Delivery from ${delivery.definitionId} (${delivery.status}):\n${delivery.summary}${delivery.error ? `\nError: ${delivery.error}` : ""}` };
  },
};

export const agentCancelTool: ToolDefinition = {
  manifest: { name: "agent_cancel", description: "Cancel a subagent and its descendants.", inputJsonSchema: toJsonSchema(instanceSchema), permissionAction: "agent_cancel" },
  schema: instanceSchema,
  async run(args, ctx) {
    const parsed = args as { instanceId: string };
    const result = await requireAgents(ctx.services).cancel(parsed.instanceId);
    return { text: `Cancelled ${result.cancelled.length} instance(s)` };
  },
};

export const AGENT_TOOLS: ToolDefinition[] = [delegateTool, agentStatusTool, agentMessageTool, agentWaitTool, agentResultTool, agentCancelTool];
