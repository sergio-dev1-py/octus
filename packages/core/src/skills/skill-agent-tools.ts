/**
 * @octus/core — herramienta de agente para instalar skills a petición del usuario.
 * Semántica idéntica a la UI (mismo instalador + misma activación por proyecto):
 * - folder/zip local (el agente lo obtiene antes: curl a /tmp, carpeta del repo, etc.).
 * - Nunca ejecuta nada de la skill: solo valida, copia y registra.
 * - `enable: true` la deja habilitada en el proyecto para este y futuros runs.
 */
import { z } from "zod";
import type { ToolDefinition, ToolRunContext } from "../tools/tool-definitions.js";
import { requireSkills } from "../tools/tool-services.js";

function toJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const maybe = schema as unknown as { toJSONSchema?: () => Record<string, unknown> };
  return typeof maybe.toJSONSchema === "function" ? maybe.toJSONSchema() : { type: "object" };
}

const skillInstallSchema = z.object({
  kind: z.enum(["folder", "zip"]).describe("Origen local ya obtenido por el agente (carpeta o zip)."),
  path: z.string().min(1).describe("Ruta absoluta o relativa al workspace del origen."),
  scope: z.enum(["global", "project", "managed"]).default("project").describe("Ámbito de instalación."),
  enable: z.boolean().default(true).describe("Habilitarla en el proyecto tras instalar."),
});

export const skillInstallTool: ToolDefinition = {
  manifest: {
    name: "skill_install",
    description: "Instala una skill a petición explícita del usuario (carpeta o zip local ya obtenido; nunca descarga nada por sí misma). Úsala solo cuando el usuario pida una skill por nombre o te pida buscar e instalar una.",
    inputJsonSchema: toJsonSchema(skillInstallSchema),
    permissionAction: "skill_install",
  },
  schema: skillInstallSchema,
  async run(args, ctx) {
    const skills = requireSkills(ctx.services);
    const input = args as { kind: "folder" | "zip"; path: string; scope?: "global" | "project" | "managed"; enable?: boolean };
    const installed = await skills.install(
      { kind: input.kind, path: input.path, scope: input.scope ?? "project" },
      { projectId: ctx.projectId, enable: input.enable ?? true },
    );
    return {
      text: `Skill instalada: ${installed.name}@${installed.version} (${installed.scope})${installed.enabled ? ", habilitada en este proyecto" : ""}. Menciónala con @${installed.name} para usarla.`,
    };
  },
};

export const SKILL_AGENT_TOOLS: ToolDefinition[] = [skillInstallTool];
