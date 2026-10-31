/**
 * @octus/core — herramienta test_run: pruebas de Reviewer vía allowlist y copia desechable.
 */
import { z } from "zod";
import type { ToolDefinition } from "./tool-definitions.js";
import { requireTests } from "./tool-services.js";

const testRunSchema = z.object({
  entryId: z.string().min(1).describe("Allowlist entry id configured for the project"),
});

function toJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const maybe = schema as unknown as { toJSONSchema?: () => Record<string, unknown> };
  return typeof maybe.toJSONSchema === "function" ? maybe.toJSONSchema() : { type: "object" };
}

export const testRunTool: ToolDefinition = {
  manifest: {
    name: "test_run",
    description: "Run an allowlisted test command in a disposable copy (never on worker files). Requires approval.",
    inputJsonSchema: toJsonSchema(testRunSchema),
    permissionAction: "test_run",
  },
  schema: testRunSchema,
  async run(args, ctx) {
    const parsed = args as { entryId: string };
    const tests = requireTests(ctx.services);
    const result = await tests.run(ctx.projectId, parsed.entryId, ctx.directory, ctx.signal);
    return {
      text: `Test '${result.entryId}' exit=${result.exitCode} duration=${result.durationMs}ms (disposable copy, worker files untouched):\n${result.output}${result.truncated ? "\n…(truncated)" : ""}`,
    };
  },
};

export const TEST_TOOLS: ToolDefinition[] = [testRunTool];
