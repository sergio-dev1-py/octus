/**
 * @octus/core — definiciones declarativas en YAML con validación Zod estricta.
 * Parser seguro (`yaml` sin ejecución de código); sin fallback silencioso (ADR-007).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { AgentDefinition, AgentKind, CoordinatorProfile } from "@octus/shared";
import { OctusError } from "../errors.js";

const modelSelectionSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  effort: z.string().min(1).optional(),
});

const permissionRuleSchema = z.object({
  action: z.string().min(1),
  resource: z.string().min(1),
  effect: z.enum(["allow", "deny", "ask"]),
});

const definitionSchema = z
  .object({
    id: z.string().min(1).regex(/^[a-z0-9-]+$/),
    kind: z.enum(["coordinator", "explorer", "researcher", "implementer", "reviewer", "utility"]),
    name: z.string().min(1),
    description: z.string().min(1),
    profile: z.enum(["plan", "build"]).optional(),
    defaultModel: modelSelectionSchema,
    maxSteps: z.number().int().min(1).max(500),
    timeoutMs: z.number().int().min(10_000),
    idleTimeoutMs: z.number().int().min(10_000),
    systemPrompt: z.string().min(1),
    tools: z.array(z.string().min(1)),
    deniedTools: z.array(z.string().min(1)).default([]),
    permissionRules: z.array(permissionRuleSchema).default([]),
    deliveryFormat: z.string().min(1),
    canDelegateTo: z.array(z.enum(["coordinator", "explorer", "researcher", "implementer", "reviewer", "utility"])).default([]),
    promptVersion: z.number().int().min(1),
  })
  .strict()
  .superRefine((def, ctx) => {
    if (def.kind === "coordinator" && !def.profile) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "coordinator definitions require a profile" });
    }
    if (def.kind !== "coordinator" && def.profile) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "only coordinator definitions may declare a profile" });
    }
    const overlap = def.tools.filter((t) => def.deniedTools.includes(t));
    if (overlap.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `tools also listed as denied: ${overlap.join(", ")}` });
    }
    if (def.canDelegateTo.includes("coordinator")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "delegation to coordinator is forbidden" });
    }
  });

export type ValidatedDefinition = z.infer<typeof definitionSchema>;

export function parseDefinitionFile(filePath: string): ValidatedDefinition {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new OctusError("invalid_definition", `Invalid YAML in ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = definitionSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new OctusError("invalid_definition", `Invalid agent definition in ${path.basename(filePath)}: ${details}`);
  }
  return parsed.data;
}

/** Nombres de herramientas desconocidas se rechazan (nada silencioso). */
export function assertKnownTools(def: ValidatedDefinition, knownTools: string[]): void {
  const unknown = [...def.tools, ...def.deniedTools].filter((t) => !knownTools.includes(t));
  if (unknown.length > 0) {
    throw new OctusError("invalid_definition", `Definition '${def.id}' references unknown tools: ${[...new Set(unknown)].join(", ")}`);
  }
}

export function promptHashOf(def: Pick<ValidatedDefinition, "systemPrompt" | "deliveryFormat">): string {
  return createHash("sha256").update(`${def.systemPrompt}\n---\n${def.deliveryFormat}`, "utf8").digest("hex");
}

/** Foto inmutable de la definición vigente al crear una instancia (ADR-028). */
export function snapshotOf(def: AgentDefinition): import("@octus/shared").AgentDefinitionSnapshot {
  return {
    definitionId: def.id,
    definitionVersion: def.promptVersion,
    kind: def.kind,
    defaultModel: { ...def.defaultModel },
    maxSteps: def.maxSteps,
    timeoutMs: def.timeoutMs,
    idleTimeoutMs: def.idleTimeoutMs,
    tools: [...def.tools],
    deniedTools: [...def.deniedTools],
    permissionRules: def.permissionRules.map((r) => ({ ...r })),
    deliveryFormat: def.deliveryFormat,
    canDelegateTo: [...def.canDelegateTo],
  };
}

export function toAgentDefinition(def: ValidatedDefinition): AgentDefinition {
  return {
    id: def.id,
    kind: def.kind as AgentKind,
    name: def.name,
    description: def.description,
    profile: def.profile as CoordinatorProfile | undefined,
    defaultModel: def.defaultModel,
    maxSteps: def.maxSteps,
    timeoutMs: def.timeoutMs,
    idleTimeoutMs: def.idleTimeoutMs,
    systemPrompt: def.systemPrompt,
    tools: [...def.tools],
    deniedTools: [...def.deniedTools],
    permissionRules: def.permissionRules.map((r) => ({ ...r })),
    deliveryFormat: def.deliveryFormat,
    canDelegateTo: [...def.canDelegateTo] as AgentKind[],
    promptVersion: def.promptVersion,
  };
}

export function loadDefinitionsDirectory(dir: string): ValidatedDefinition[] {
  if (!existsSync(dir)) {
    throw new OctusError("invalid_definition", `Agent definitions directory not found: ${dir}`);
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  if (files.length === 0) {
    throw new OctusError("invalid_definition", `No agent definitions in ${dir}`);
  }
  const seen = new Set<string>();
  const out: ValidatedDefinition[] = [];
  for (const file of files) {
    const def = parseDefinitionFile(path.join(dir, file));
    if (seen.has(def.id)) {
      throw new OctusError("invalid_definition", `Duplicate agent definition id: ${def.id}`);
    }
    seen.add(def.id);
    out.push(def);
  }
  return out;
}
