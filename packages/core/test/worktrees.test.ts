/** Etapa 4 — RepositoryManager + WorktreeManager con git real (fakes para los modelos). */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isOctusError } from "../src/errors.js";
import { expectRejects, makeRun, makeTestCore, workspaceOf, type TestCore } from "./helpers.js";
import { OctusCore } from "../src/sessions/octus-core.js";
import { MemorySecretStore } from "../src/secrets/secret-store.js";
import { FakeProvider, fakeGoModels, fakeMetaModels } from "../src/testing/fake-providers.js";
import type { PlannedTaskInput } from "../src/tasks/task-manager.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
}

function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@octus.local"]);
  git(root, ["config", "user.name", "Octus Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(root, "README.md"), "# fixture\n");
  writeFileSync(path.join(root, "app.txt"), "line-one\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture init"]);
}

/** Borrado robusto en Windows (objetos git de solo lectura). */
function nukeDir(dir: string): void {
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n);
      try {
        chmodSync(p, 0o666);
      } catch {
        // best effort
      }
      try {
        if (statSync(p).isDirectory()) walk(p);
      } catch {
        // best effort
      }
    }
  };
  try {
    walk(dir);
  } catch {
    // best effort
  }
  rmSync(dir, { recursive: true, force: true });
}

function headOf(root: string): string {
  return git(root, ["rev-parse", "HEAD"]).trim();
}

async function useFakeModels(core: TestCore["core"]): Promise<void> {
  for (const id of ["explorer", "researcher", "implementer", "reviewer"]) {
    await core.setDefinitionModel(id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
  }
}

const STEPS = {
  objective: "Build auth",
  steps: [{ title: "OAuth backend" }],
  acceptanceCriteria: ["login works"],
};

async function gitProject(t: TestCore, name = "P"): Promise<{ project: { id: string }; session: { id: string; directory: string }; root: string }> {
  const root = path.join(t.dir, `repo-${name}-${Math.random().toString(36).slice(2, 6)}`);
  initRepo(root);
  const project = await t.core.createProject(name, root);
  const session = await t.core.createSession({ projectId: project.id, directory: root, title: `S-${name}` });
  await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
  return { project, session: session as unknown as { id: string; directory: string }, root };
}

async function approvedDag(t: TestCore, sessionId: string, projectId: string, runId: string, hash: string, tasks: PlannedTaskInput[]) {
  const { plan } = await t.core.plans.createPlan({ sessionId, projectId, objective: "Build auth", structured: STEPS, runId, createdBy: "t" });
  const rev = (await t.core.plans.listRevisions(plan.id))[0]!;
  await t.core.plans.presentRevision(rev.id, `msg_${hash}`);
  await t.core.plans.requestApproval(plan.id, rev.id, sessionId, runId);
  const pending = await t.core.pendingApprovals(sessionId);
  await t.core.decideApproval(pending[pending.length - 1]!.id, "approved");
  const revNow = (await t.core.plans.listRevisions(plan.id))[0]!;
  return t.core.tasks.createDag({ runId, planId: plan.id, revisionId: revNow.id, requestHash: hash, tasks });
}

const IMPL = (tempId: string, deps: string[] = []): PlannedTaskInput => ({
  tempId,
  title: `Implement area ${tempId} code`,
  description: `Write the implementation for area ${tempId} inside the assigned isolated directory. It must be long enough to pass validation rules.`,
  agentRole: "implementer",
  priority: 1,
  dependencies: deps,
  acceptanceCriteria: [`file impl/${tempId}.txt exists with content version 1`],
  requiredTools: ["read", "write"],
  writeScope: ["."],
  validationCommands: [],
  needsReview: true,
});

const READER = (tempId: string): PlannedTaskInput => ({
  tempId,
  title: `Explore area ${tempId} files`,
  description: `Locate and read every file involved in area ${tempId} of the repository under test. It must be long enough to pass validation rules.`,
  agentRole: "explorer",
  priority: 1,
  dependencies: [],
  acceptanceCriteria: [`lists files under src/${tempId}/ with real paths version 1`],
  requiredTools: ["read", "glob"],
  writeScope: [],
  validationCommands: [],
  needsReview: false,
});

const REVIEWER_OF = (tempId: string, target: string): PlannedTaskInput => ({
  tempId,
  title: `Review area ${tempId} implementation`,
  description: `Review the implementation of area ${target} against its acceptance criteria and report findings with file and line.`,
  agentRole: "reviewer",
  priority: 1,
  dependencies: [],
  acceptanceCriteria: [`review report ${tempId} contains at least 1 finding with file and line version 1`],
  requiredTools: ["read", "git_diff"],
  writeScope: [],
  validationCommands: [],
  needsReview: false,
  reviewTargetTempId: target,
});

async function until(fn: () => Promise<boolean> | boolean, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Espera a que los worktrees de las tasks alcancen un estado (el commit+finished corre tras completar la task). */
async function untilWorktrees(t: TestCore, taskIds: string[], statuses: string[], ms = 30000): Promise<void> {
  await until(async () => {
    for (const id of taskIds) {
      const wt = await t.core.worktrees.getByTask(id);
      if (!wt || !statuses.includes(wt.status)) return false;
    }
    return true;
  }, ms);
}

/** Limpia los worktrees del proyecto (best-effort) antes del rm del tmp. */
async function sweepWorktrees(t: TestCore, projectId: string): Promise<void> {
  const list = await t.core.worktrees.listProjectWorktrees(projectId).catch(() => []);
  for (const w of list) {
    await t.core.worktrees.cleanupWorktree(w.id).catch(() => undefined);
  }
}

describe("etapa 4 — repository manager (solo lectura)", () => {
  test("1-2: detecta repo, rama, HEAD y estado limpio/sucio (staged/unstaged/untracked)", async () => {
    const t = await makeTestCore();
    try {
      const { project, root } = await gitProject(t);
      const clean = await t.core.repositories.inspectRepository(project.id);
      expect(clean.isGit).toBe(true);
      expect(clean.branch).toBe("main");
      expect(clean.head).toBe(headOf(root));
      expect(clean.status).toBe("clean");
      expect(clean.staged + clean.unstaged + clean.untracked).toBe(0);
      expect(clean.worktrees.length).toBeGreaterThanOrEqual(1);
      expect(clean.branches).toContain("main");
      writeFileSync(path.join(root, "app.txt"), "line-one\nline-two\n");
      git(root, ["add", "app.txt"]);
      writeFileSync(path.join(root, "new-untracked.txt"), "x\n");
      const dirty = await t.core.repositories.inspectRepository(project.id);
      expect(dirty.status).toBe("dirty");
      expect(dirty.staged).toBe(1);
      expect(dirty.untracked).toBe(1);
      const st = await t.core.repositories.getStatus(root);
      expect(st.staged).toBe(1);
      expect(st.untracked).toBe(1);
      // Limpieza sin tocar nada del usuario desde el producto: solo el test restaura.
      git(root, ["checkout", "--", "."]);
      rmSync(path.join(root, "new-untracked.txt"));
    } finally {
      await t.cleanup();
    }
  });

  test("2b: validateRepository rechaza MERGE_HEAD y repo sin HEAD", async () => {
    const t = await makeTestCore();
    try {
      const { root } = await gitProject(t);
      writeFileSync(path.join(root, ".git", "MERGE_HEAD"), "0".repeat(40));
      const err = await expectRejects(t.core.repositories.validateRepository(root), /merge/i);
      expect(isOctusError(err, "invalid_state")).toBe(true);
      rmSync(path.join(root, ".git", "MERGE_HEAD"));
      const ok = await t.core.repositories.validateRepository(root);
      expect(ok.branch).toBe("main");
      expect(ok.head).toHaveLength(40);
      await expectRejects(t.core.repositories.validateRepository(path.join(t.dir, "workspace")), /not a git repository/i);
    } finally {
      await t.cleanup();
    }
  });

  test("3: lista ramas y worktrees reales", async () => {
    const t = await makeTestCore();
    try {
      const { root } = await gitProject(t);
      const wt = `${root}-wt-list`;
      try {
        git(root, ["worktree", "add", "-b", "feature-list", wt]);
        const branches = await t.core.repositories.listBranches(root);
        expect(branches).toContain("main");
        expect(branches).toContain("feature-list");
        const listed = await t.core.repositories.listWorktrees(root);
        expect(listed.some((w) => w.path.endsWith("-wt-list"))).toBe(true);
        expect(listed[0]!.path).toBeDefined();
      } finally {
        git(root, ["worktree", "remove", "--force", wt]);
        nukeDir(wt);
      }
    } finally {
      await t.cleanup();
    }
  });
});

describe("etapa 4 — worktree manager: creación e idempotencia", () => {
  test("4: ensureForTask crea rama harness/*, worktree validado y journal", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const { project, session } = await gitProject(t);
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-wt1", [READER("r"), IMPL("w")]);
      const implId = dag.taskIds[1]!;
      const out = await t.core.worktrees.ensureForTask({ projectId: project.id, runId, taskId: implId, attempt: 1 });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.reused).toBe(false);
      expect(out.branch).toBe(`harness/run-${runId}/task-${implId}`);
      expect(out.baseCommit).toHaveLength(40);
      expect(existsSync(out.path)).toBe(true);
      const wt = await t.core.worktrees.getWorktree(out.worktreeId);
      expect(wt.status).toBe("assigned");
      expect(wt.baseSource).toBe("head");
      const ops = await t.core.worktrees.listOperations(out.worktreeId);
      expect(ops.some((o) => o.op === "provision" && o.status === "done")).toBe(true);
      const listed = await t.core.repositories.listWorktrees(session.directory);
      const norm = (p: string): string => {
        let out = p.replaceAll("\\", "/");
        if (process.platform === "win32") out = out.toLowerCase();
        return out.replace(/\/+$/, "");
      };
      expect(listed.some((w) => norm(w.path) === norm(wt.canonicalPath))).toBe(true);
      await t.core.worktrees.cleanupWorktree(out.worktreeId);
    } finally {
      await t.cleanup();
    }
  });

  test("5: idempotencia — re-solicitar devuelve el mismo sin duplicar ramas", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t);
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-wt2", [READER("r"), IMPL("w")]);
      const implId = dag.taskIds[1]!;
      const before = (await t.core.repositories.listBranches(root)).length;
      const [a, b] = await Promise.all([
        t.core.worktrees.ensureForTask({ projectId: project.id, runId, taskId: implId, attempt: 1 }),
        t.core.worktrees.ensureForTask({ projectId: project.id, runId, taskId: implId, attempt: 1 }),
      ]);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.worktreeId).toBe(b.worktreeId);
      const after = (await t.core.repositories.listBranches(root)).length;
      expect(after).toBe(before + 1);
      await t.core.worktrees.cleanupWorktree(a.worktreeId);
    } finally {
      await t.cleanup();
    }
  });

  test("6: colisión con rama ajena preexistente → sufijo -r2", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t);
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-wt3", [READER("r"), IMPL("w")]);
      const implId = dag.taskIds[1]!;
      git(root, ["branch", `harness/run-${runId}/task-${implId}`]);
      const out = await t.core.worktrees.ensureForTask({ projectId: project.id, runId, taskId: implId, attempt: 1 });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.branch).toBe(`harness/run-${runId}/task-${implId}-r2`);
      await t.core.worktrees.cleanupWorktree(out.worktreeId);
      git(root, ["branch", "-D", `harness/run-${runId}/task-${implId}`]);
    } finally {
      await t.cleanup();
    }
  });

  test("7: proyecto no-git → no-repository y camino legacy intacto", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-wt4", [IMPL("w")]);
      const out = await t.core.worktrees.ensureForTask({ projectId: project.id, runId, taskId: dag.taskIds[0]!, attempt: 1 });
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.blockedReason).toBe("no-repository");
      await t.core.registerIsolatedDirectory(project.id, workspaceOf(t), "directory");
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        const assigned = await t.core.scheduler.tick({ sessionId: session.id });
        expect(assigned.length).toBe(1);
        const inst = (await t.core.agentInstances(session.id)).find((i) => i.id === assigned[0]!.instanceId)!;
        expect(inst.definitionId).toBe("implementer");
        expect(inst.worktreeId).toBeUndefined();
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("8-9: setWorktreesRoot valida (absoluta, fuera del repo, no UNC, sin activos)", async () => {
    const t = await makeTestCore();
    try {
      const { project, root } = await gitProject(t, "R");
      await expectRejects(t.core.setWorktreesRoot(project.id, path.join(root, "wt-inside")), /outside the repository/i);
      await expectRejects(t.core.setWorktreesRoot(project.id, "relative/path"), /absolute/i);
      await expectRejects(t.core.setWorktreesRoot(project.id, "\\\\srv\\share\\x"), /UNC/i);
      const custom = path.join(t.dir, "custom-wt");
      const set = await t.core.setWorktreesRoot(project.id, custom);
      expect(set.length).toBeGreaterThan(0);
      expect(existsSync(custom)).toBe(true);
    } finally {
      await t.cleanup();
    }
  });
});

describe("etapa 4 — scheduler + agentmanager con worktrees", () => {
  test("11+21: dos implementers en paralelo en worktrees distintos; scopes sin solape", async () => {    const seen = new Map<string, number>();
    const t = await makeTestCore({
      metaTurns: ((_: number, input: { messages?: Array<{ blocks?: unknown[] }> }) => {
        const text = JSON.stringify(input?.messages ?? []);
        const m = /area ([ab]) code/.exec(text);
        const key = m ? m[1]! : "other";
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        if (m && n === 1) return { toolCalls: [{ name: "write", args: { path: `mark-${key}.txt`, content: key.toUpperCase() } }] };
        return { text: `done-${key}` };
      }) as never,
    });
    try {
      await useFakeModels(t.core);
      const { project, session } = await gitProject(t, "P");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-par", [IMPL("a"), IMPL("b")]);
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => {
          const rows = await t.core.db.query<{ status: string }>("SELECT status FROM tasks");
          return rows.length === 2 && rows.every((r) => r.status === "completed");
        }, 30000);
        await untilWorktrees(t, dag.taskIds, ["finished"]);
        const paths = new Set<string>();
        for (const id of dag.taskIds) {
          const wt = await t.core.worktrees.getByTask(id);
          expect(wt).toBeDefined();
          paths.add(wt!.canonicalPath);
          expect(wt!.status).toBe("finished");
          expect(wt!.producedCommit).toMatch(/^[0-9a-f]{40}$/);
        }
        expect(paths.size).toBe(2);
        const all = [...paths].flatMap((p) => {
          try {
            return readdirOf(p);
          } catch {
            return [] as string[];
          }
        });
        expect(all).toContain("mark-a.txt");
        expect(all).toContain("mark-b.txt");
        await sweepWorktrees(t, project.id);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("13+15: dependencia writer→writer deriva de produced_commit y hereda el fichero", async () => {
    const t = await makeTestCore({
      metaTurns: [
        { toolCalls: [{ name: "write", args: { path: "base.txt", content: "from-a" } }] },
        { text: "a-done" },
        { text: "rev-done" },
        { text: "b-done" },
      ],
    });
    try {
      await useFakeModels(t.core);
      const { project, session } = await gitProject(t, "C");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-chain", [IMPL("a"), REVIEWER_OF("r", "a"), IMPL("b")]);
      const [aId, rId, bId] = dag.taskIds as [string, string, string];
      await t.core.db.exec("INSERT INTO task_dependencies (task_id, depends_on, kind) VALUES (?, ?, 'requires')", [bId, aId]);
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await t.core.scheduler.tick({ sessionId: session.id });
        // A completa, luego el reviewer verifica y acepta.
        await until(async () => (await t.core.tasks.getTask(aId)).status === "completed", 30000);
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(rId)).status !== "draft", 30000);
        const rAtt = await t.core.tasks.getAttempts(rId);
        if (rAtt[0]?.instanceId) await t.core.agents.wait(rAtt[0].instanceId, 30000).catch(() => undefined);
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(rId)).status === "completed", 30000);
        await t.core.recordTaskReview(rId, aId, "accept", { note: "live-chain" });
        // B se desbloquea con el produced_commit de A y hereda el fichero.
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(bId)).status === "completed", 30000);
        const wa = await t.core.worktrees.getByTask(aId);
        const wb = await t.core.worktrees.getByTask(bId);
        expect(wa?.producedCommit).toMatch(/^[0-9a-f]{40}$/);
        expect(wb?.baseCommit).toBe(wa?.producedCommit);
        expect(wb?.baseSource).toBe(`task:${aId}`);
        expect(existsSync(path.join(wb!.canonicalPath, "base.txt"))).toBe(true);
        expect(readFileSync(path.join(wb!.canonicalPath, "base.txt"), "utf8")).toContain("from-a");
        await sweepWorktrees(t, project.id);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("14: multi-predecesor writer → deps-unavailable explícito", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const { project, session } = await gitProject(t, "M");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-multi", [IMPL("a"), IMPL("b"), IMPL("c")]);
      const [aId, bId, cId] = dag.taskIds as [string, string, string];
      await t.core.db.exec("INSERT INTO task_dependencies (task_id, depends_on, kind) VALUES (?, ?, 'requires')", [cId, aId]);
      await t.core.db.exec("INSERT INTO task_dependencies (task_id, depends_on, kind) VALUES (?, ?, 'requires')", [cId, bId]);
      await t.core.scheduler.tick({ sessionId: session.id });
      await until(async () => {
        const c = await t.core.tasks.getTask(cId);
        return c.status === "blocked" && c.blockedReason === "deps-unavailable";
      });
      const c = await t.core.tasks.getTask(cId);
      expect(String(JSON.stringify(c.blockedDetails))).toMatch(/merge|Etapa 5/i);
      await sweepWorktrees(t, project.id);
    } finally {
      await t.cleanup();
    }
  });

  test("12: retry reutiliza el worktree y conserva parciales", async () => {
    const t = await makeTestCore({
      metaTurns: [
        { toolCalls: [{ name: "write", args: { path: "partial.txt", content: "v1" } }] },
        { text: "first-done" },
        { toolCalls: [{ name: "write", args: { path: "partial.txt", content: "v2" } }] },
        { text: "second-done" },
      ],
    });
    try {
      await useFakeModels(t.core);
      const { project, session } = await gitProject(t, "R");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-retry", [IMPL("w")]);
      const taskId = dag.taskIds[0]!;
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(taskId)).status === "completed", 30000);
        await untilWorktrees(t, [taskId], ["finished"]);
        const before = await t.core.worktrees.getByTask(taskId);
        expect(before?.status).toBe("finished");
        const firstPath = before!.canonicalPath;
        expect(existsSync(path.join(firstPath, "partial.txt"))).toBe(true);
        await t.core.db.exec("UPDATE tasks SET status = 'failed', updated_at = 1 WHERE id = ?", [taskId]);
        await t.core.db.exec("UPDATE task_attempts SET completed_at = 1 WHERE task_id = ?", [taskId]);
        const { attempt, instanceId } = await t.core.tasks.retryTask(taskId);
        expect(attempt).toBe(2);
        const after = await t.core.worktrees.getByTask(taskId);
        expect(after!.id).toBe(before!.id);
        expect(after!.canonicalPath).toBe(firstPath);
        expect(after!.attempt).toBe(2);
        expect(existsSync(path.join(firstPath, "partial.txt"))).toBe(true);
        await t.core.agents.wait(instanceId, 30000).catch(() => undefined);
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(taskId)).status === "completed", 30000);
        expect(readFileSync(path.join(firstPath, "partial.txt"), "utf8")).toContain("v2");
        await sweepWorktrees(t, project.id);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("19: reviewer usa el worktree del target (P2)", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const { project, session } = await gitProject(t, "V");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-rev", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      await t.core.db.exec("UPDATE tasks SET status = 'completed', updated_at = 1 WHERE id = ?", [wId]);
      const ensured = await t.core.worktrees.ensureForTask({ projectId: project.id, runId, taskId: wId, attempt: 1 });
      expect(ensured.ok).toBe(true);
      await t.core.scheduler.tick({ sessionId: session.id });
      await until(async () => {
        const s = (await t.core.tasks.getTask(rId)).status;
        return s === "assigned" || s === "running" || s === "completed";
      });
      const attempts = await t.core.tasks.getAttempts(rId);
      expect(attempts.length).toBeGreaterThan(0);
      const inst = (await t.core.agentInstances(session.id)).find((i) => i.id === attempts[0]!.instanceId)!;
      if (!ensured.ok) throw new Error("no worktree");
      expect(inst.worktreeId).toBe(ensured.worktreeId);
      expect(inst.directory).toBe(ensured.path);
      await t.core.agents.wait(inst.id, 30000).catch(() => undefined);
      await sweepWorktrees(t, project.id);
    } finally {
      await t.cleanup();
    }
  });
});

describe("etapa 4 — seguridad de aislamiento", () => {
  test("8+10+11: UNC, worktrees_root y .git denegados; worktree fuera del repo", async () => {
    const t = await makeTestCore();
    try {
      const { project, root } = await gitProject(t, "S");
      await expectRejects(t.core.setWorktreesRoot(project.id, "\\\\srv\\share\\x"), /UNC/i);
      await expectRejects(t.core.setWorktreesRoot(project.id, path.join(root, "inside")), /outside the repository/i);
      const { resolveInScope } = await import("../src/tools/path-scope.js");
      const wt = path.join(t.dir, "wt-probe");
      mkdirSync(wt, { recursive: true });
      await expectRejects(Promise.resolve().then(() => resolveInScope(wt, ".git/config")), /\.git|forbidden/i);
      await expectRejects(Promise.resolve().then(() => resolveInScope(wt, "../escape.txt")), /escapes/i);
    } finally {
      await t.cleanup();
    }
  });

  test("12: escritura al workspace principal denegada por el gateway", async () => {
    const evil = { abs: "" };
    const t = await makeTestCore({
      metaTurns: (_: number, input: { messages?: Array<{ blocks?: unknown[] }> }) => {
        void _;
        void input;
        return { toolCalls: [{ name: "write", args: { path: evil.abs, content: "x" } }] };
      },
    });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "W");
      evil.abs = path.join(root, "abs-evil.txt");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-sec", [IMPL("w")]);
      const taskId = dag.taskIds[0]!;
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => ["completed", "failed"].includes((await t.core.tasks.getTask(taskId)).status), 30000);
        const rows = await t.core.db.query<{ status: string; error: string | null }>("SELECT status, error FROM tool_invocations WHERE run_id = ?", [runId]);
        expect(rows.some((r) => r.status === "denied" || /scope_violation|escapes/i.test(r.error ?? ""))).toBe(true);
        expect(existsSync(path.join(root, "abs-evil.txt"))).toBe(false);
        await sweepWorktrees(t, project.id);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });
});

describe("etapa 4 — ciclo de vida, limpieza y reconciliación", () => {
  test("16+18: cleanup exige árbol limpio y sin agentes; con todo en orden elimina", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "L");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-cl", [IMPL("w")]);
      const taskId = dag.taskIds[0]!;
      const out = await t.core.worktrees.ensureForTask({ projectId: project.id, runId, taskId, attempt: 1 });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      writeFileSync(path.join(out.path, "dirty.txt"), "x\n");
      await expectRejects(t.core.worktrees.cleanupWorktree(out.worktreeId), /pending changes/i);
      rmSync(path.join(out.path, "dirty.txt"));
      const done = await t.core.worktrees.cleanupWorktree(out.worktreeId);
      expect(done.removed).toBe(true);
      expect(done.branchDeleted).toBe(false);
      expect(existsSync(out.path)).toBe(false);
      const branches = await t.core.repositories.listBranches(root);
      expect(branches).toContain(out.branch);
      void project;
    } finally {
      await t.cleanup();
    }
  });

  test("16b: cleanup bloqueado con agente activo", async () => {
    const t = await makeTestCore({
      metaTurns: [
        { toolCalls: [{ name: "question", args: { questions: [{ question: "Q?", header: "Q", options: [{ label: "A" }] }] } }] },
        { text: "done" },
      ],
    });
    try {
      await useFakeModels(t.core);
      const { project, session } = await gitProject(t, "A");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-cl2", [IMPL("w")]);
      const taskId = dag.taskIds[0]!;
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => {
          const wt = await t.core.worktrees.getByTask(taskId);
          return !!wt && wt.status === "running";
        });
        const wt = (await t.core.worktrees.getByTask(taskId))!;
        await expectRejects(t.core.worktrees.cleanupWorktree(wt.id), /active agent/i);
        const deadline = Date.now() + 30000;
        for (;;) {
          for (const q of t.core.questions.pendingFor(session.id)) {
            await t.core.questions.reply(q.id, [{ question: q.questions[0]!.question, answers: [q.questions[0]!.options[0]!.label] }], "cor_live");
          }
          if ((await t.core.tasks.getTask(taskId)).status === "completed") break;
          if (Date.now() > deadline) throw new Error("Timed out waiting for completion");
          await new Promise((r) => setTimeout(r, 300));
        }
        await untilWorktrees(t, [taskId], ["finished"]);
      } finally {
        stop();
      }
      const wt2 = (await t.core.worktrees.getByTask(taskId))!;
      const done = await t.core.worktrees.cleanupWorktree(wt2.id);
      expect(done.removed).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  test("15+19+20: reconcile resuelve provisioning interrumpido y huérfanos", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "O");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-orph", [IMPL("w")]);
      const taskId = dag.taskIds[0]!;
      const repoId = await t.core.repositories.ensureRepositoryRow(project.id, root, await t.core.worktrees.effectiveWorktreesRoot(project.id));
      await t.core.db.exec(
        "INSERT INTO worktrees (id, project_id, repository_id, run_id, task_id, branch_name, base_commit, canonical_path, status, created_at, updated_at) VALUES ('wt_stuck', ?, ?, ?, ?, 'harness/run-x/task-y', ?, ?, 'provisioning', 1, 1)",
        [project.id, repoId, runId, taskId, headOf(root), path.join(t.dir, "nope", taskId)],
      );
      await t.core.db.exec("INSERT INTO worktree_ops (id, worktree_id, task_id, op, status, created_at, updated_at) VALUES ('wop_stuck', 'wt_stuck', ?, 'provision', 'started', 1, 1)", [taskId]);
      const ghost = path.join(await t.core.worktrees.effectiveWorktreesRoot(project.id), "ghost-task");
      git(root, ["worktree", "add", "-b", "harness/ghost-task", ghost, "HEAD"]);
      const out = await t.core.worktrees.reconcile();
      expect(out.orphaned).toBeGreaterThanOrEqual(2);
      const stuck = await t.core.worktrees.getWorktree("wt_stuck");
      expect(stuck.status).toBe("orphaned");
      const adopted = await t.core.db.queryOne<{ id: string }>("SELECT id FROM worktrees WHERE canonical_path = ? AND status = 'orphaned'", [ghost]);
      expect(adopted).toBeDefined();
      git(root, ["worktree", "remove", "--force", ghost]);
      await t.core.db.exec("DELETE FROM worktrees WHERE canonical_path = ?", [ghost]);
      void session;
    } finally {
      await t.cleanup();
    }
  });

  test("19b: restart marca assigned→suspended sin auto-run", async () => {
    const dir = path.join(tmpdir(), `octus-test-restart-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    const root = path.join(dir, "repo");
    initRepo(root);
    const fakeMeta = new FakeProvider("fake-meta", "Fake Meta", fakeMetaModels(), { turns: [{ text: "hello" }] as never, billable: false });
    const fakeGo = new FakeProvider("fake-go", "Fake Go", fakeGoModels(), { turns: [{ text: "hi" }] as never, billable: false });
    const dataDir = path.join(dir, "data");
    const core1 = await OctusCore.create({ dataDir, primarySecrets: new MemorySecretStore(), providers: [fakeMeta, fakeGo] });
    try {
      for (const id of ["explorer", "researcher", "implementer", "reviewer"]) {
        await core1.setDefinitionModel(id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      }
      const project = await core1.createProject("R", root);
      const session = await core1.createSession({ projectId: project.id, directory: root, title: "S" });
      await core1.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const runId = `run_${Math.random().toString(36).slice(2, 8)}`;
      const coordId = `ins_${Math.random().toString(36).slice(2, 8)}`;
      const def = (await core1.registry.get("coordinator-build"))!;
      const { promptHashOf, snapshotOf } = await import("../src/agents/definition-loader.js");
      await core1.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES (?, ?, 'test', 'executing', 'build', 1, 1)", [runId, session.id]);
      await core1.db.exec(
        "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES (?, ?, ?, 'coordinator-build', 'running', ?, ?, ?, ?, ?, 1, 1)",
        [coordId, session.id, runId, JSON.stringify({ providerId: "fake-meta", modelId: "muse-wonder-1.0" }), root, def.promptVersion, promptHashOf(def), JSON.stringify(snapshotOf(def))],
      );
      const { plan } = await core1.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "Build auth", structured: STEPS, runId, createdBy: "t" });
      const rev = (await core1.plans.listRevisions(plan.id))[0]!;
      await core1.plans.presentRevision(rev.id, "msg_r");
      await core1.plans.requestApproval(plan.id, rev.id, session.id, runId);
      await core1.decideApproval((await core1.pendingApprovals(session.id))[0]!.id, "approved");
      const revNow = (await core1.plans.listRevisions(plan.id))[0]!;
      const dag = await core1.tasks.createDag({ runId, planId: plan.id, revisionId: revNow.id, requestHash: "h-restart", tasks: [IMPL("w")] });
      const ensured = await core1.worktrees.ensureForTask({ projectId: project.id, runId, taskId: dag.taskIds[0]!, attempt: 1 });
      expect(ensured.ok).toBe(true);
      await core1.close();
      // Reinicio: settle marca interrupted/suspended; sin auto-run.
      const core2 = await OctusCore.create({ dataDir, primarySecrets: new MemorySecretStore(), providers: [fakeMeta, fakeGo] });
      try {
        const task = await core2.tasks.getTask(dag.taskIds[0]!);
        expect(task.status).toBe("draft");
        const wt = await core2.worktrees.getByTask(dag.taskIds[0]!);
        expect(wt!.status).toBe("suspended");
        const attempts = await core2.tasks.getAttempts(dag.taskIds[0]!);
        expect(attempts.filter((a) => a.status === "running" || a.status === "pending")).toHaveLength(0);
      } finally {
        await core2.close();
      }
    } finally {
      nukeDir(dir);
    }
  });
});

describe("etapa 4 — git_diff base y trigger inmutable", () => {
  test("git_diff acepta base SHA y rechaza base inválida", async () => {
    const t = await makeTestCore();
    try {
      const { root } = await gitProject(t, "G");
      const { gitDiffTool } = await import("../src/tools/git-tools.js");
      const sha = headOf(root);
      const ctx = (extra: Record<string, unknown>) => ({
        directory: root,
        protectedRoots: [] as string[],
        projectId: "p",
        sessionId: "s",
        runId: "r",
        instanceId: "i",
        signal: new AbortController().signal,
        shellTimeoutMs: 1000,
        maxInlineChars: 1000,
        services: {},
        askQuestion: async () => [] as never[],
        ...extra,
      });
      const out = await gitDiffTool.run({ base: sha, stat: true }, ctx({}));
      expect(out.text).toBeDefined();
      await expectRejects(gitDiffTool.run({ base: "not-a-sha!", stat: true }, ctx({})), /base/i);
    } finally {
      await t.cleanup();
    }
  });

  test("worktrees.task_id/canonical/branch/base son inmutables", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const { project, session } = await gitProject(t, "I");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-imm", [READER("r"), IMPL("w")]);
      const implId = dag.taskIds[1]!;
      const out = await t.core.worktrees.ensureForTask({ projectId: project.id, runId, taskId: implId, attempt: 1 });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      await expectRejects(t.core.db.exec("UPDATE worktrees SET task_id = 'other' WHERE id = ?", [out.worktreeId]), /immutable/i);
      await expectRejects(t.core.db.exec("UPDATE worktrees SET branch_name = 'other' WHERE id = ?", [out.worktreeId]), /immutable/i);
      await expectRejects(t.core.db.exec("UPDATE worktrees SET canonical_path = '/other' WHERE id = ?", [out.worktreeId]), /immutable/i);
      await expectRejects(t.core.db.exec("UPDATE worktrees SET base_commit = 'other' WHERE id = ?", [out.worktreeId]), /immutable/i);
      await t.core.worktrees.cleanupWorktree(out.worktreeId);
    } finally {
      await t.cleanup();
    }
  });
});

function readdirOf(dir: string): string[] {
  return readdirSync(dir);
}
