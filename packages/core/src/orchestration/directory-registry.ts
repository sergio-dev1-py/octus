/**
 * @octus/core — directorios aislados registrados por el usuario (ADR-026).
 * AgentManager asigna desde aquí; nunca acepta rutas libres del modelo.
 * La validación de worktrees es solo lectura (la gestión automática es Etapa 4).
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createId } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { isUncPath, sameOrInside } from "../tools/path-scope.js";
import { now } from "../util.js";

export interface IsolatedDirectory {
  id: string;
  projectId: string;
  path: string;
  realPath: string;
  kind: "directory" | "worktree";
  repoRoot?: string;
  branch?: string;
  createdAt: number;
}

export interface RegisterDirectoryInput {
  projectId: string;
  path: string;
  kind: "directory" | "worktree";
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new OctusError("tool_failed", `git ${args[0] ?? ""} failed: ${(stderr || error.message).slice(0, 1000)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function canonicalize(input: string): string {
  if (isUncPath(input)) {
    throw new OctusError("scope_violation", "UNC paths are not allowed for isolated directories");
  }
  if (!existsSync(input)) {
    throw new OctusError("scope_violation", `Directory does not exist: ${input.slice(0, 300)}`);
  }
  if (!statSync(input).isDirectory()) {
    throw new OctusError("scope_violation", `Not a directory: ${input.slice(0, 300)}`);
  }
  return realpathSync(input);
}

export class DirectoryRegistry {
  constructor(private readonly db: PersistenceService) {}

  async list(projectId: string): Promise<IsolatedDirectory[]> {
    const rows = await this.db.query<Record<string, string | number | null>>(
      "SELECT * FROM isolated_directories WHERE project_id = ? ORDER BY created_at ASC",
      [projectId],
    );
    return rows.map(deserialize);
  }

  async get(id: string): Promise<IsolatedDirectory | undefined> {
    const row = await this.db.queryOne<Record<string, string | number | null>>("SELECT * FROM isolated_directories WHERE id = ?", [id]);
    return row ? deserialize(row) : undefined;
  }

  async register(input: RegisterDirectoryInput): Promise<IsolatedDirectory> {
    const project = await this.db.queryOne<{ id: string }>("SELECT id FROM projects WHERE id = ?", [input.projectId]);
    if (!project) throw new OctusError("not_found", `Project not found: ${input.projectId}`);
    const realPath = canonicalize(input.path);
    let repoRoot: string | undefined;
    let branch: string | undefined;
    if (input.kind === "worktree") {
      const verified = await this.verifyWorktree(realPath);
      repoRoot = verified.repoRoot;
      branch = verified.branch;
    }
    const id = createId("isd");
    const timestamp = now();
    try {
      await this.db.exec(
        "INSERT INTO isolated_directories (id, project_id, path, real_path, kind, repo_root, branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [id, input.projectId, input.path, realPath, input.kind, repoRoot ?? null, branch ?? null, timestamp],
      );
    } catch (error) {
      if (error instanceof OctusError && /UNIQUE/i.test(error.message)) {
        throw new OctusError("already_exists", "This directory is already registered for the project");
      }
      throw error;
    }
    return { id, projectId: input.projectId, path: input.path, realPath, kind: input.kind, repoRoot, branch, createdAt: timestamp };
  }

  async remove(id: string): Promise<void> {
    const active = await this.db.queryOne<{ id: string }>(
      "SELECT id FROM agent_instances WHERE assigned_directory_id = ? AND status IN ('created','running','waiting_permission','waiting_input') LIMIT 1",
      [id],
    );
    if (active) {
      throw new OctusError("invalid_state", "Directory is assigned to an active agent and cannot be removed");
    }
    await this.db.exec("DELETE FROM isolated_directories WHERE id = ?", [id]);
  }

  /** Verificación de solo lectura: existe, es worktree registrado, rama y raíz identificadas. */
  async verifyWorktree(realPath: string): Promise<{ repoRoot: string; branch: string }> {
    let anchor: string;
    try {
      anchor = (await git(["rev-parse", "--show-toplevel"], realPath)).trim();
    } catch {
      throw new OctusError("scope_violation", "Declared worktree is not inside a git repository");
    }
    const list = await git(["worktree", "list", "--porcelain"], canonicalize(anchor));
    const entries: Array<{ path: string; branch?: string }> = [];
    let current: { path: string; branch?: string } | undefined;
    for (const line of list.split("\n")) {
      if (line.startsWith("worktree ")) {
        current = { path: line.slice("worktree ".length).trim() };
        entries.push(current);
        continue;
      }
      if (line.startsWith("branch ") && current) {
        current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      }
    }
    if (entries.length === 0) {
      throw new OctusError("scope_violation", "Could not list git worktrees");
    }
    const equals = (a: string, b: string): boolean => {
      const norm = (p: string): string => {
        let out = p.replaceAll("\\", "/");
        if (process.platform === "win32") out = out.toLowerCase();
        return out.replace(/\/+$/, "");
      };
      return norm(a) === norm(b);
    };
    const index = entries.findIndex((e) => equals(e.path, realPath));
    if (index < 0) {
      throw new OctusError("scope_violation", "Path is not a registered git worktree of its repository");
    }
    if (index === 0) {
      throw new OctusError("scope_violation", "The main worktree is the workspace itself, not an isolated directory");
    }
    const entry = entries[index]!;
    return { repoRoot: canonicalize(entries[0]!.path), branch: entry.branch ?? "(detached)" };
  }

  /** true si `candidateReal` solapa (igual, contiene o contenido en) alguno de `others`. */
  static overlaps(candidateReal: string, others: string[]): boolean {
    return others.some((other) => sameOrInside(other, candidateReal) || sameOrInside(candidateReal, other));
  }
}

function deserialize(row: Record<string, string | number | null>): IsolatedDirectory {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    path: String(row.path),
    realPath: String(row.real_path),
    kind: String(row.kind) as IsolatedDirectory["kind"],
    repoRoot: row.repo_root ? String(row.repo_root) : undefined,
    branch: row.branch ? String(row.branch) : undefined,
    createdAt: Number(row.created_at),
  };
}
