/**
 * @octus/core — definiciones de herramientas de la Etapa 1.
 * Cada definición declara esquema zod, manifiesto y ejecución. La puerta vive en el gateway.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { QuestionAnswer, QuestionPrompt, ToolManifest } from "@octus/shared";
import type { ToolServices } from "./tool-services.js";
import { OctusError } from "../errors.js";
import { truncate } from "../util.js";
import { resolveInScope, sameOrInside, scopeRelative } from "./path-scope.js";
import { assertShellGitAllowed } from "./shell-guard.js";
import { killTree, scrubbedEnv } from "./process-tree.js";

export interface ToolRunContext {
  directory: string;
  /** Raíces protegidas (datos internos de Octus): ninguna herramienta las toca. */
  protectedRoots: string[];
  projectId: string;
  sessionId: string;
  runId: string;
  instanceId: string;
  signal: AbortSignal;
  shellTimeoutMs: number;
  maxInlineChars: number;
  askQuestion: (questions: QuestionPrompt[]) => Promise<QuestionAnswer[]>;
  /** Servicios inyectados por el núcleo (agentes, planes). Ausentes solo en tests unitarios. */
  services?: ToolServices;
}

export interface ToolDefinition {
  manifest: ToolManifest;
  schema: z.ZodType<unknown>;
  run: (args: any, ctx: ToolRunContext) => Promise<{ text: string; fullText?: string; detail?: string }>;
}

const MAX_GLOB_RESULTS = 500;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILES = 2000;

function toJsonSchema(schema: z.ZodType<unknown>, fallback: Record<string, unknown>): Record<string, unknown> {
  // zod v4 expone JSON Schema directamente; si cambia, el fallback documenta el contrato.
  const maybe = schema as unknown as { toJSONSchema?: () => Record<string, unknown> };
  try {
    return typeof maybe.toJSONSchema === "function" ? maybe.toJSONSchema() : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

const readSchema = z.object({
  path: z.string().describe("File path, absolute or relative to the workspace"),
  offset: z.number().int().min(0).optional().describe("First line (0-based)"),
  limit: z.number().int().min(1).max(2000).optional().describe("Max lines to return"),
});

export const readTool: ToolDefinition = {
  manifest: {
    name: "read",
    description: "Read a text file inside the workspace. Returns numbered lines; use offset/limit for large files.",
    inputJsonSchema: toJsonSchema(readSchema, { type: "object" }),
    permissionAction: "read",
  },
  schema: readSchema,
  async run(args, ctx) {
    const file = resolveInScope(ctx.directory, args.path as string, { protectedRoots: ctx.protectedRoots });
    if (!existsSync(file) || !statSync(file).isFile()) throw new OctusError("tool_failed", `File not found: ${args.path}`);
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    const offset = (args.offset as number | undefined) ?? 0;
    const limit = (args.limit as number | undefined) ?? 500;
    const slice = lines.slice(offset, offset + limit);
    const numbered = slice.map((line, i) => `${offset + i + 1}: ${line}`).join("\n");
    const { text, truncated } = truncate(numbered, ctx.maxInlineChars);
    return {
      text: truncated ? `${text}\n…(truncated, ${lines.length} total lines)` : text || "(empty file)",
      fullText: truncated ? numbered : undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

const globSchema = z.object({
  pattern: z.string().describe("Glob pattern like 'src/**/*.ts'"),
  directory: z.string().optional().describe("Subdirectory inside the workspace"),
});

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  let out = "";
  const parts = normalized.split("**");
  parts.forEach((part, i) => {
    out += part
      .split("*")
      .map((seg) => seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    if (i < parts.length - 1) out += ".*";
  });
  return new RegExp(`^${out}$`);
}

function walkFiles(dir: string, collected: string[], budget: { files: number }, scopeRoot?: string): void {
  if (budget.files <= 0) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.files <= 0) return;
    if (entry === "node_modules" || entry === ".git" || entry === ".hg") continue;
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    // Los enlaces que salen del ámbito no se recorren ni se listan.
    if (scopeRoot && isOutsideScope(scopeRoot, full)) continue;
    if (stat.isDirectory()) {
      walkFiles(full, collected, budget, scopeRoot);
    } else if (stat.isFile()) {
      collected.push(full);
      budget.files--;
    }
  }
}

function isOutsideScope(scopeRoot: string, candidate: string): boolean {
  try {
    const realRoot = realpathSync(scopeRoot);
    const realCandidate = realpathSync(candidate);
    return !sameOrInside(realRoot, realCandidate);
  } catch {
    return true;
  }
}

export const globTool: ToolDefinition = {
  manifest: {
    name: "glob",
    description: "List files inside the workspace matching a glob pattern.",
    inputJsonSchema: toJsonSchema(globSchema, { type: "object" }),
    permissionAction: "glob",
  },
  schema: globSchema,
  async run(args, ctx) {
    const base = args.directory ? resolveInScope(ctx.directory, args.directory as string, { protectedRoots: ctx.protectedRoots }) : ctx.directory;
    const collected: string[] = [];
    walkFiles(base, collected, { files: MAX_GREP_FILES }, ctx.directory);
    const rx = globToRegExp(args.pattern as string);
    const matches = collected
      .map((f) => scopeRelative(ctx.directory, f))
      .filter((rel) => rx.test(rel) || rx.test(rel.split("/").pop() ?? ""))
      .slice(0, MAX_GLOB_RESULTS);
    return { text: matches.length > 0 ? matches.join("\n") : "(no matches)" };
  },
};

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

const grepSchema = z.object({
  pattern: z.string().describe("Regular expression to search for"),
  directory: z.string().optional().describe("Subdirectory inside the workspace"),
  include: z.string().optional().describe("Glob filter for file names, e.g. '*.ts'"),
});

export const grepTool: ToolDefinition = {
  manifest: {
    name: "grep",
    description: "Search file contents inside the workspace with a regular expression. Returns file:line matches.",
    inputJsonSchema: toJsonSchema(grepSchema, { type: "object" }),
    permissionAction: "grep",
  },
  schema: grepSchema,
  async run(args, ctx) {
    const base = args.directory ? resolveInScope(ctx.directory, args.directory as string, { protectedRoots: ctx.protectedRoots }) : ctx.directory;
    let rx: RegExp;
    try {
      rx = new RegExp(args.pattern as string);
    } catch {
      throw new OctusError("invalid_tool_args", `Invalid regular expression: ${args.pattern}`);
    }
    const includeRx = args.include ? globToRegExp(args.include as string) : undefined;
    const collected: string[] = [];
    walkFiles(base, collected, { files: MAX_GREP_FILES }, ctx.directory);
    const out: string[] = [];
    for (const file of collected) {
      if (out.length >= MAX_GREP_MATCHES) break;
      const rel = scopeRelative(ctx.directory, file);
      if (includeRx && !includeRx.test(rel) && !includeRx.test(path.basename(rel))) continue;
      let content: string;
      try {
        const stat = statSync(file);
        if (stat.size > 2 * 1024 * 1024) continue;
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\0")) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && out.length < MAX_GREP_MATCHES; i++) {
        if (rx.test(lines[i]!)) out.push(`${rel}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
      }
    }
    return { text: out.length > 0 ? out.join("\n") : "(no matches)" };
  },
};

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

const writeSchema = z.object({
  path: z.string().describe("File path, absolute or relative to the workspace"),
  content: z.string().describe("Full new content of the file"),
});

export const writeTool: ToolDefinition = {
  manifest: {
    name: "write",
    description: "Create or completely replace a text file inside the workspace.",
    inputJsonSchema: toJsonSchema(writeSchema, { type: "object" }),
    permissionAction: "write",
  },
  schema: writeSchema,
  async run(args, ctx) {
    const file = resolveInScope(ctx.directory, args.path as string, { protectedRoots: ctx.protectedRoots });
    const content = args.content as string;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
    return { text: `Wrote ${content.length} chars to ${scopeRelative(ctx.directory, file)}` };
  },
};

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

const editSchema = z.object({
  path: z.string().describe("File path, absolute or relative to the workspace"),
  oldString: z.string().describe("Exact text to find and replace"),
  newString: z.string().describe("Replacement text (must differ from oldString)"),
  replaceAll: z.boolean().optional().describe("Replace every occurrence (default: exactly one match required)"),
});

export const editTool: ToolDefinition = {
  manifest: {
    name: "edit",
    description: "Replace exact text in a file. oldString must occur exactly once unless replaceAll is true.",
    inputJsonSchema: toJsonSchema(editSchema, { type: "object" }),
    permissionAction: "edit",
  },
  schema: editSchema,
  async run(args, ctx) {
    const file = resolveInScope(ctx.directory, args.path as string, { protectedRoots: ctx.protectedRoots });
    if (!existsSync(file) || !statSync(file).isFile()) throw new OctusError("tool_failed", `File not found: ${args.path}`);
    const oldString = args.oldString as string;
    const newString = args.newString as string;
    if (oldString === newString) throw new OctusError("invalid_tool_args", "oldString and newString must differ");
    const content = readFileSync(file, "utf8");
    const occurrences = content.split(oldString).length - 1;
    if (occurrences === 0) throw new OctusError("tool_failed", "oldString not found in file");
    if (occurrences > 1 && !(args.replaceAll as boolean | undefined)) {
      throw new OctusError("tool_failed", `oldString occurs ${occurrences} times; add context or set replaceAll`);
    }
    const next = (args.replaceAll as boolean | undefined) ? content.split(oldString).join(newString) : content.replace(oldString, newString);
    writeFileSync(file, next, "utf8");
    const count = (args.replaceAll as boolean | undefined) ? occurrences : 1;
    return { text: `Replaced ${count} occurrence(s) in ${scopeRelative(ctx.directory, file)}` };
  },
};

// ---------------------------------------------------------------------------
// shell (ADR-018)
// ---------------------------------------------------------------------------

const shellSchema = z.object({
  command: z.string().describe("Shell command to execute"),
  timeoutMs: z.number().int().min(1000).max(600_000).optional().describe("Timeout in ms (default from config)"),
});

// Entorno depurado y muerte del árbol: ver process-tree.ts (import arriba).

export const shellTool: ToolDefinition = {
  manifest: {
    name: "shell",
    description: "Run a shell command in the workspace directory. Requires approval every time; never inherited secrets.",
    inputJsonSchema: toJsonSchema(shellSchema, { type: "object" }),
    permissionAction: "shell",
  },
  schema: shellSchema,
  async run(args, ctx) {
    const command = args.command as string;
    assertShellGitAllowed(command);
    const timeoutMs = Math.min((args.timeoutMs as number | undefined) ?? ctx.shellTimeoutMs, 600_000);
    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        cwd: ctx.directory,
        env: scrubbedEnv(),
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      let output = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        fn();
      };
      const timer = setTimeout(() => {
        if (child.pid) killTree(child.pid);
        finish(() => reject(new OctusError("timeout", `Shell command timed out after ${timeoutMs}ms: ${truncate(command, 200).text}`)));
      }, timeoutMs);
      const onAbort = () => {
        if (child.pid) killTree(child.pid);
        finish(() => reject(new OctusError("aborted", "Shell command aborted")));
      };
      if (ctx.signal.aborted) {
        onAbort();
        return;
      }
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.on("error", (error: Error) => finish(() => reject(new OctusError("tool_failed", `Shell spawn failed: ${error.message}`))));
      child.on("close", (code: number | null) => {
        finish(() => {
          const { text, truncated } = truncate(output, ctx.maxInlineChars);
          const suffix = code !== 0 ? `\n(exit code ${code ?? "unknown"})` : "";
          if (code === 0) {
            resolve({ text: (text || "(no output)") + suffix, fullText: truncated ? output : undefined });
          } else {
            reject(new OctusError("tool_failed", `Shell exited with code ${code}: ${(text || "(no output)").slice(0, 2000)}`));
          }
        });
      });
    });
  },
};

// ---------------------------------------------------------------------------
// question
// ---------------------------------------------------------------------------

const questionSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        header: z.string(),
        options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
        multiple: z.boolean().optional(),
      }),
    )
    .min(1),
});

export const questionTool: ToolDefinition = {
  manifest: {
    name: "question",
    description: "Ask the user structured questions during execution and wait for answers.",
    inputJsonSchema: toJsonSchema(questionSchema, { type: "object" }),
    permissionAction: "question",
  },
  schema: questionSchema,
  async run(args, ctx) {
    const answers = await ctx.askQuestion((args as { questions: QuestionPrompt[] }).questions);
    const parts = answers.map((a) => `"${a.question}"="${a.answers.join(", ") || "Unanswered"}"`);
    return { text: `User answers: ${parts.join("; ")}` };
  },
};

export const STAGE1_TOOLS: ToolDefinition[] = [readTool, globTool, grepTool, writeTool, editTool, shellTool, questionTool];
