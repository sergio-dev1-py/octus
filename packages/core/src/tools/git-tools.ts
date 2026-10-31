/**
 * @octus/core — herramientas Git controladas (Etapa 2, ADR-026).
 * Lectura para explorer/reviewer/implementer; stage/commit solo para Implementer
 * dentro de su ámbito. Sin shell: execFile con argumentos por array.
 */
import { execFile } from "node:child_process";
import { z } from "zod";
import { OctusError } from "../errors.js";
import { resolveInScope } from "./path-scope.js";
import type { ToolDefinition, ToolRunContext } from "./tool-definitions.js";

const GIT_TIMEOUT_MS = 60_000;
const MAX_DIFF_CHARS = 60_000;

function toJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const maybe = schema as unknown as { toJSONSchema?: () => Record<string, unknown> };
  return typeof maybe.toJSONSchema === "function" ? maybe.toJSONSchema() : { type: "object" };
}

function runGit(cwd: string, args: string[], signal: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new OctusError("tool_failed", `git ${args[0] ?? ""} failed: ${(stderr || error.message).slice(0, 2000)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    if (signal.aborted) {
      child.kill();
      reject(new OctusError("aborted", "git command aborted"));
      return;
    }
    signal.addEventListener("abort", () => child.kill(), { once: true });
  });
}

const gitStatusSchema = z.object({});

export const gitStatusTool: ToolDefinition = {
  manifest: {
    name: "git_status",
    description: "Read-only git status (porcelain) of the instance directory.",
    inputJsonSchema: toJsonSchema(gitStatusSchema),
    permissionAction: "git_status",
  },
  schema: gitStatusSchema,
  async run(_args, ctx) {
    const { stdout } = await runGit(ctx.directory, ["status", "--porcelain=v1", "--branch"], ctx.signal);
    return { text: stdout.trim() ? stdout.slice(0, MAX_DIFF_CHARS) : "(clean)" };
  },
};

const gitDiffSchema = z.object({
  paths: z.array(z.string()).optional().describe("Paths inside the scope to diff"),
  staged: z.boolean().optional().describe("Diff staged changes instead of worktree"),
  stat: z.boolean().optional().describe("Only show stat summary"),
});

export const gitDiffTool: ToolDefinition = {
  manifest: {
    name: "git_diff",
    description: "Read-only git diff of the instance directory.",
    inputJsonSchema: toJsonSchema(gitDiffSchema),
    permissionAction: "git_diff",
  },
  schema: gitDiffSchema,
  async run(args, ctx) {
    const parsed = args as { paths?: string[]; staged?: boolean; stat?: boolean };
    const scoped = (parsed.paths ?? []).map((p) => resolveInScope(ctx.directory, p, { protectedRoots: ctx.protectedRoots }));
    const argv = ["diff", "--no-color", "--no-ext-diff"];
    if (parsed.stat) argv.push("--stat");
    if (parsed.staged) argv.push("--cached");
    if (scoped.length > 0) argv.push("--", ...scoped);
    const { stdout } = await runGit(ctx.directory, argv, ctx.signal);
    const text = stdout.slice(0, MAX_DIFF_CHARS);
    return { text: text.trim() ? text : "(no differences)", fullText: stdout.length > MAX_DIFF_CHARS ? stdout : undefined };
  },
};

const gitStageSchema = z.object({
  paths: z.array(z.string()).min(1).describe("Paths inside the assigned directory to stage"),
});

export const gitStageTool: ToolDefinition = {
  manifest: {
    name: "git_stage",
    description: "Stage paths (git add) strictly inside the assigned directory. Requires approval.",
    inputJsonSchema: toJsonSchema(gitStageSchema),
    permissionAction: "git_stage",
  },
  schema: gitStageSchema,
  async run(args, ctx) {
    const parsed = args as { paths: string[] };
    const scoped = parsed.paths.map((p) => resolveInScope(ctx.directory, p, { protectedRoots: ctx.protectedRoots }));
    await runGit(ctx.directory, ["add", "--", ...scoped], ctx.signal);
    return { text: `Staged ${scoped.length} path(s)` };
  },
};

const gitCommitSchema = z.object({
  message: z.string().min(1).max(500).describe("Commit message"),
});

export const gitCommitTool: ToolDefinition = {
  manifest: {
    name: "git_commit",
    description: "Create a commit with staged changes (--no-verify to avoid hanging hooks). Requires approval.",
    inputJsonSchema: toJsonSchema(gitCommitSchema),
    permissionAction: "git_commit",
  },
  schema: gitCommitSchema,
  async run(args, ctx) {
    const parsed = args as { message: string };
    const { stdout } = await runGit(ctx.directory, ["commit", "--no-verify", "-m", parsed.message], ctx.signal);
    return { text: stdout.slice(0, 2000) || "Committed" };
  },
};

export const GIT_TOOLS: ToolDefinition[] = [gitStatusTool, gitDiffTool, gitStageTool, gitCommitTool];

export type { ToolRunContext };
