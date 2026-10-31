/**
 * @octus/core — RepositoryManager: inspección Git de solo lectura (Etapa 4, ADR-043).
 * Detecta repo, rama, HEAD, estado (staged/unstaged/untracked), ramas, worktrees,
 * git-common-dir, main vs secundarios y operaciones incompletas. Cero operaciones
 * destructivas: solo comandos de lectura con argv por array.
 */
import { existsSync } from "node:fs";
import { createId, type RepositorySummary } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { PersistenceService } from "../persistence/persistence-service.js";
import { sameOrInside } from "../tools/path-scope.js";
import { now } from "../util.js";
import { resolveCommitSha, runGit } from "./git-exec.js";

export interface WorktreeEntry {
  path: string;
  branch?: string;
  locked?: string;
  prunable?: boolean;
  bare?: boolean;
  detached?: boolean;
}

export class RepositoryManager {
  constructor(private readonly db: PersistenceService) {}

  /** Snapshot completo de solo lectura. Nunca modifica el repositorio. */
  async inspectRepository(projectId: string): Promise<RepositorySummary> {
    const project = await this.db.queryOne<{ root_path: string }>("SELECT root_path FROM projects WHERE id = ?", [projectId]);
    if (!project) throw new OctusError("not_found", `Project not found: ${projectId}`);
    const rootPath = String(project.root_path);
    const recorded = await this.db.queryOne<{ id: string }>("SELECT id FROM repositories WHERE project_id = ?", [projectId]);
    const repositoryId = recorded ? String(recorded.id) : undefined;
    if (!existsSync(rootPath)) {
      return { repositoryId, rootPath, isGit: false, status: "blocked", staged: 0, unstaged: 0, untracked: 0, worktrees: [], branches: [] };
    }
    let toplevel: string;
    try {
      toplevel = (await runGit(rootPath, ["rev-parse", "--show-toplevel"])).stdout.trim();
    } catch {
      return { repositoryId, rootPath, isGit: false, status: "blocked", staged: 0, unstaged: 0, untracked: 0, worktrees: [], branches: [] };
    }
    const [branch, head, statusOut, branches, worktrees, commonDir] = await Promise.all([
      runGit(toplevel, ["rev-parse", "--abbrev-ref", "HEAD"]).then((r) => r.stdout.trim(), () => "(detached)"),
      runGit(toplevel, ["rev-parse", "HEAD"]).then((r) => r.stdout.trim(), () => ""),
      runGit(toplevel, ["status", "--porcelain=v1", "--branch", "--untracked-files=all"]).then((r) => r.stdout, () => ""),
      this.listBranches(toplevel).catch(() => [] as string[]),
      this.listWorktrees(toplevel).catch(() => [] as WorktreeEntry[]),
      runGit(toplevel, ["rev-parse", "--git-common-dir"]).then((r) => r.stdout.trim(), () => undefined as string | undefined),
    ]);
    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    for (const line of statusOut.split("\n")) {
      if (!line || line.startsWith("##")) continue;
      if (line.startsWith("??")) {
        untracked++;
        continue;
      }
      if (line[0] !== " " && line[0] !== "?") staged++;
      if (line[1] !== " " && line[1] !== "?") unstaged++;
    }
    const incomplete = await this.detectIncompleteOperation(toplevel, commonDir).catch(() => undefined);
    const status = incomplete ? "blocked" : staged + unstaged + untracked > 0 ? "dirty" : "clean";
    return {
      repositoryId,
      rootPath: toplevel,
      isGit: true,
      branch,
      head,
      status,
      staged,
      unstaged,
      untracked,
      incompleteOperation: incomplete?.kind,
      incompleteDetail: incomplete?.detail,
      worktrees,
      branches,
      gitCommonDir: commonDir,
    };
  }

  async getCurrentBranch(rootPath: string): Promise<string> {
    return (await runGit(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  }

  async getHead(rootPath: string): Promise<string> {
    return (await runGit(rootPath, ["rev-parse", "HEAD"])).stdout.trim();
  }

  /** Estado resumido: staged/unstaged/untracked. Solo lectura. */
  async getStatus(rootPath: string): Promise<{ staged: number; unstaged: number; untracked: number; porcelain: string }> {
    const out = (await runGit(rootPath, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    for (const line of out.split("\n")) {
      if (!line) continue;
      if (line.startsWith("??")) {
        untracked++;
        continue;
      }
      if (line[0] !== " " && line[0] !== "?") staged++;
      if (line[1] !== " " && line[1] !== "?") unstaged++;
    }
    return { staged, unstaged, untracked, porcelain: out.slice(0, 60000) };
  }

  /** Diff acotado contra el worktree (solo lectura). */
  async getDiff(rootPath: string, opts?: { paths?: string[]; staged?: boolean; stat?: boolean }): Promise<string> {
    const argv = ["diff", "--no-color", "--no-ext-diff"];
    if (opts?.stat) argv.push("--stat");
    if (opts?.staged) argv.push("--cached");
    if (opts?.paths?.length) argv.push("--", ...opts.paths);
    const { stdout } = await runGit(rootPath, argv);
    return stdout.slice(0, 60000);
  }

  async listBranches(rootPath: string): Promise<string[]> {
    const { stdout } = await runGit(rootPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Parseo de `git worktree list --porcelain` (misma gramática que DirectoryRegistry.verifyWorktree). */
  async listWorktrees(rootPath: string): Promise<WorktreeEntry[]> {
    const { stdout } = await runGit(rootPath, ["worktree", "list", "--porcelain"]);
    const out: WorktreeEntry[] = [];
    let current: WorktreeEntry | undefined;
    for (const raw of stdout.split("\n")) {
      const line = raw.trimEnd();
      if (line.startsWith("worktree ")) {
        current = { path: line.slice("worktree ".length).trim() };
        out.push(current);
      } else if (current && line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      } else if (current && line.startsWith("locked")) {
        current.locked = line.slice("locked".length).trim() || "locked";
      } else if (current && line === "prunable") {
        current.prunable = true;
      } else if (current && line === "bare") {
        current.bare = true;
      } else if (current && line === "detached") {
        current.detached = true;
      }
    }
    return out;
  }

  async getGitCommonDir(rootPath: string): Promise<string> {
    return (await runGit(rootPath, ["rev-parse", "--git-common-dir"])).stdout.trim();
  }

  /** true si `rev` resuelve a commit en el repo (solo lectura). */
  async commitExists(rootPath: string, rev: string): Promise<boolean> {
    try {
      await resolveCommitSha(rootPath, rev);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * validateRepository: es repo git, tiene HEAD resoluble y no hay operaciones
   * incompletas (merge/cherry-pick/rebase a medias). Sin efectos.
   */
  async validateRepository(rootPath: string): Promise<{ rootPath: string; branch: string; head: string }> {
    let toplevel: string;
    try {
      toplevel = (await runGit(rootPath, ["rev-parse", "--show-toplevel"])).stdout.trim();
    } catch {
      throw new OctusError("invalid_state", "Not a git repository");
    }
    const commonDir = await this.getGitCommonDir(toplevel).catch(() => "");
    const incomplete = await this.detectIncompleteOperation(toplevel, commonDir || undefined);
    if (incomplete) {
      throw new OctusError("invalid_state", `Repository has an incomplete ${incomplete.kind} operation (${incomplete.detail}); resolve it before provisioning worktrees`, {
        details: { kind: incomplete.kind },
      });
    }
    const branch = await this.getCurrentBranch(toplevel);
    const head = await this.getHead(toplevel).catch(() => {
      throw new OctusError("invalid_state", "Repository has no HEAD commit (empty repo); commit at least once before provisioning worktrees");
    });
    return { rootPath: toplevel, branch, head };
  }

  /** Detecta MERGE_HEAD / CHERRY_PICK_HEAD / rebase en curso bajo git-common-dir. */
  async detectIncompleteOperation(toplevel: string, commonDir?: string): Promise<{ kind: "merge" | "cherry-pick" | "rebase" | "rebase-merge" | "rebase-apply"; detail: string } | undefined> {
    const { existsSync: exists } = await import("node:fs");
    const path = await import("node:path");
    const gitDir = commonDir && !commonDir.startsWith("/") && !/^[A-Za-z]:/.test(commonDir) ? path.join(toplevel, commonDir) : commonDir || path.join(toplevel, ".git");
    const check = (name: string): boolean => {
      try {
        return exists(path.join(gitDir, name));
      } catch {
        return false;
      }
    };
    if (check("MERGE_HEAD")) return { kind: "merge", detail: "MERGE_HEAD present" };
    if (check("CHERRY_PICK_HEAD")) return { kind: "cherry-pick", detail: "CHERRY_PICK_HEAD present" };
    if (check("REBASE_HEAD")) return { kind: "rebase", detail: "REBASE_HEAD present" };
    if (check("rebase-merge")) return { kind: "rebase-merge", detail: "rebase-merge/ present" };
    if (check("rebase-apply")) return { kind: "rebase-apply", detail: "rebase-apply/ present" };
    return undefined;
  }

  /** true si `candidateReal` está dentro de `rootReal` (contención de rutas hermanas). */
  isPathInsideRepo(rootReal: string, candidateReal: string): boolean {
    return sameOrInside(rootReal, candidateReal);
  }

  /** Registra o actualiza la fila repositories del proyecto (raíz + worktrees_root). Atómico ante llamadas paralelas (UPSERT). */
  async ensureRepositoryRow(projectId: string, rootPath: string, worktreesRoot: string): Promise<string> {
    const timestamp = Date.now();
    await this.db.exec(
      "INSERT INTO repositories (id, project_id, root_path, worktrees_root, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET root_path = excluded.root_path, worktrees_root = excluded.worktrees_root, updated_at = excluded.updated_at",
      [createId("repo"), projectId, rootPath, worktreesRoot, timestamp, timestamp],
    );
    const row = await this.db.queryOne<{ id: string }>("SELECT id FROM repositories WHERE project_id = ?", [projectId]);
    if (!row) throw new OctusError("internal", `Repository row missing after upsert: ${projectId}`);
    return String(row.id);
  }
}
