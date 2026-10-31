/**
 * @octus/core — herramientas de memoria (Etapa 6, P1).
 * `memory_propose`: todos los perfiles, solo crea `proposed` (la gobernanza
 * decide el resto). `memory_validate`: solo coordinador, solo ordinarias
 * (decision/instruction exigen usuario). Sin capability de aprobar, editar
 * ni borrar para ningún perfil.
 */
import { z } from "zod";
import type { ToolDefinition } from "../tools/tool-definitions.js";
import { requireMemory } from "../tools/tool-services.js";

const originRefSchema = z.object({
  path: z.string().min(1).max(500).optional().describe("Project-relative file this memory derives from"),
  section: z.string().min(1).max(200).optional().describe("Section or symbol within the origin"),
  commit: z.string().min(1).max(100).optional().describe("Commit SHA the origin was observed at"),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/i, "must be a sha256 hex digest").optional().describe("SHA-256 of the origin content (change detection)"),
});

const proposeSchema = z.object({
  scope: z.enum(["project", "session", "run", "task", "instance"]).describe("Memory scope (must belong to the calling agent lineage)"),
  scopeId: z.string().min(1).describe("Id of the scope (project/session/run/task/instance)"),
  category: z.string().min(1).max(40).describe("fact, decision, instruction, checkpoint, ..."),
  topic: z.string().min(1).max(200).describe("Short topic key"),
  content: z.string().min(1).max(20000).describe("Memory content (no secrets, no private reasoning)"),
  source: z.string().min(1).max(64).describe("code, test, doc, delivery, user, ..."),
  originRef: originRefSchema.optional().describe("Provenance for revalidation"),
  confidence: z.enum(["low", "medium", "high"]).optional().describe("Confidence level (default medium)"),
});

const validateSchema = z.object({
  id: z.string().min(1).describe("Memory entry id to validate (coordinator only, ordinary categories)"),
});

function toJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const maybe = schema as unknown as { toJSONSchema?: () => Record<string, unknown> };
  return typeof maybe.toJSONSchema === "function" ? maybe.toJSONSchema() : { type: "object" };
}

export const memoryProposeTool: ToolDefinition = {
  manifest: {
    name: "memory_propose",
    description: "Propose a memory entry (always provisional; governance decides promotion). Never include secrets or credentials.",
    inputJsonSchema: toJsonSchema(proposeSchema),
    permissionAction: "memory_propose",
  },
  schema: proposeSchema,
  async run(args, ctx) {
    const parsed = args as {
      scope: "project" | "session" | "run" | "task" | "instance";
      scopeId: string;
      category: string;
      topic: string;
      content: string;
      source: string;
      originRef?: { path?: string; section?: string; commit?: string; contentHash?: string };
      confidence?: "low" | "medium" | "high";
    };
    const memory = requireMemory(ctx.services);
    const entry = await memory.propose(
      { scope: parsed.scope, scopeId: parsed.scopeId, category: parsed.category, topic: parsed.topic, content: parsed.content, source: parsed.source, originRef: parsed.originRef, confidence: parsed.confidence },
      { projectId: ctx.projectId, sessionId: ctx.sessionId, runId: ctx.runId, instanceId: ctx.instanceId },
    );
    return { text: `Memory proposed (${entry.status}): ${entry.id} [${entry.scope}:${entry.category}:${entry.topic}]` };
  },
};

export const memoryValidateTool: ToolDefinition = {
  manifest: {
    name: "memory_validate",
    description: "Validate a proposed ordinary memory (coordinator only; decision/instruction require the user).",
    inputJsonSchema: toJsonSchema(validateSchema),
    permissionAction: "memory_validate",
  },
  schema: validateSchema,
  async run(args, ctx) {
    const parsed = args as { id: string };
    const memory = requireMemory(ctx.services);
    const entry = await memory.validate(parsed.id, ctx.instanceId);
    return { text: `Memory validated (${entry.status}): ${entry.id}` };
  },
};

export const MEMORY_TOOLS: ToolDefinition[] = [memoryProposeTool, memoryValidateTool];
