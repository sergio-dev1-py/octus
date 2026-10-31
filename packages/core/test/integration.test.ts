/** Etapa 5.1 — IntegrationManager con git real (fakes para los modelos). */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectRejects, makeRun, makeTestCore, workspaceOf, type TestCore } from "./helpers.js";
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
  // Fixtures herméticos: LF siempre (en Windows el autocrlf global rompería
  // los edits exactos de los tests y los diffs esperados).
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "core.eol", "lf"]);
  writeFileSync(path.join(root, "README.md"), "# fixture\n");
  writeFileSync(path.join(root, "app.txt"), "line-one\n");
  const shared = Array.from({ length: 20 }, (_, i) => `line-${String(i + 1).padStart(2, "0")}`).join("\n") + "\n";
  writeFileSync(path.join(root, "shared.txt"), shared);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture init"]);
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

const IMPL = (tempId: string): PlannedTaskInput => ({
  tempId,
  title: `Implement area ${tempId} code`,
  description: `Write the implementation for area ${tempId} inside the assigned isolated directory. It must be long enough to pass validation rules.`,
  agentRole: "implementer",
  priority: 1,
  dependencies: [],
  acceptanceCriteria: [`file impl/${tempId}.txt exists with content version 1`],
  requiredTools: ["read", "write"],
  writeScope: ["."],
  validationCommands: [],
  needsReview: true,
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

async function until(fn: () => Promise<boolean> | boolean, ms = 30000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function untilWorktreesFinished(t: TestCore, taskIds: string[], ms = 30000): Promise<void> {
  await until(async () => {
    for (const id of taskIds) {
      const wt = await t.core.worktrees.getByTask(id);
      if (!wt || wt.status !== "finished") return false;
    }
    return true;
  }, ms);
}

/** Conduce writers→reviewers→verdicts para pares (writer, reviewer). */
async function settlePairs(t: TestCore, sessionId: string, pairs: Array<{ writer: string; reviewer: string }>): Promise<void> {
  await t.core.scheduler.tick({ sessionId });
  for (const p of pairs) {
    await until(async () => (await t.core.tasks.getTask(p.writer)).status === "completed", 30000);
  }
  await untilWorktreesFinished(t, pairs.map((p) => p.writer));
  await t.core.scheduler.tick({ sessionId });
  for (const p of pairs) {
    await until(async () => (await t.core.tasks.getTask(p.reviewer)).status === "completed", 30000);
  }
  for (const p of pairs) {
    await t.core.recordTaskReview(p.reviewer, p.writer, "accept", { note: "test-accept" });
  }
}

/** Espera al auto-build P1 (con ticks: la sesión quieta no despierta sola). */
async function untilAutoBuilt(t: TestCore, sessionId: string, runId: string, n: number, ms = 30000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const list = await t.core.integrations.listByRun(runId);
    if (list[0] && (await t.core.integrations.getCommits(list[0].id)).length === n) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for auto-build");
    await t.core.scheduler.tick({ sessionId }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Limpieza best-effort de worktrees de tasks + worktrees de integración + resolución. */
async function sweepAll(t: TestCore, projectId: string, repoRoot: string): Promise<void> {
  for (const w of await t.core.worktrees.listProjectWorktrees(projectId).catch(() => [])) {
    await t.core.worktrees.cleanupWorktree(w.id).catch(() => undefined);
  }
  const rows = await t.core.db.query<{ canonical_path: string }>("SELECT canonical_path FROM integrations WHERE project_id = ?", [projectId]).catch(() => []);
  for (const r of rows ?? []) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", String(r.canonical_path)], { cwd: repoRoot, timeout: 30_000, windowsHide: true });
    } catch {
      // best effort
    }
  }
  for (const c of await t.core.conflicts.listConflicts().catch(() => [])) {
    await t.core.conflicts.cleanupResolutionWorkspace(c.id).catch(() => undefined);
  }
}

function writerTurns(keys: string[], write: (key: string) => { name: string; args: Record<string, string> }): (callIndex: number, input: never) => { toolCalls?: Array<{ name: string; args: unknown }>; text?: string } {
  const seen = new Map<string, number>();
  const pattern = new RegExp(`area ([${keys.join("")}]) code`);
  return (_: number, input: never) => {
    const text = JSON.stringify((input as unknown as { messages?: unknown[] })?.messages ?? []);
    const m = pattern.exec(text);
    if (m) {
      const key = m[1]!;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n === 1) {
        const call = write(key);
        return { toolCalls: [{ name: call.name, args: call.args }] };
      }
      return { text: `done-${key}` };
    }
    return { text: "review-done" };
  };
}

describe("etapa 5.1 — creación idempotente del espacio de integración", () => {
  test("createForRun crea rama intermedia + worktree; segunda llamada reutiliza", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t);
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-int0", [IMPL("w")]);
      void dag;
      const first = await t.core.integrations.createForRun({ projectId: project.id, runId });
      expect(first.integrationBranch).toBe(`harness/integration/run-${runId}`);
      expect(first.targetBranch).toBe("main");
      expect(first.targetBaseCommit).toHaveLength(40);
      expect(first.status).toBe("building");
      expect(existsSync(first.canonicalPath)).toBe(true);
      const second = await t.core.integrations.createForRun({ projectId: project.id, runId });
      expect(second.id).toBe(first.id);
      const ops = await t.core.integrations.listOperations(first.id);
      expect(ops.some((o) => o.op === "create" && o.status === "done")).toBe(true);
      await sweepAll(t, project.id, root);
    } finally {
      await t.cleanup();
    }
  });
});

describe("etapa 5.1 — incorporación (J1–J3)", () => {
  test("J1: dos commits independientes compatibles (FF + merge), ambos ficheros presentes", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["a", "b"], (key) => ({ name: "write", args: { path: `file-${key}.txt`, content: `content-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "J1");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-j1", [IMPL("a"), IMPL("b"), REVIEWER_OF("ra", "a"), REVIEWER_OF("rb", "b")]);
      const [aId, bId, raId, rbId] = dag.taskIds as [string, string, string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: aId, reviewer: raId }, { writer: bId, reviewer: rbId }]);
        // P1: el auto-build ya incorporó (createForRun + incorporateRun corren en el tick).
        await untilAutoBuilt(t, session.id, runId, 2);
        const integration = (await t.core.integrations.listByRun(runId))[0]!;
        const commits = await t.core.integrations.getCommits(integration.id);
        expect(commits.map((c) => c.kind).sort()).toEqual(["original", "resolution"]);
        const after = await t.core.integrations.getIntegration(integration.id);
        expect(after.head).toMatch(/^[0-9a-f]{40}$/);
        expect(readFileSync(path.join(after.canonicalPath, "file-a.txt"), "utf8")).toContain("content-a");
        expect(readFileSync(path.join(after.canonicalPath, "file-b.txt"), "utf8")).toContain("content-b");
        expect((await t.core.db.queryOne<{ status: string }>("SELECT status FROM runs WHERE id = ?", [runId]))!.status).toBe("integrating");
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("J2: dos commits sobre el mismo archivo sin solape (merge limpio)", async () => {
    const t = await makeTestCore({
      metaTurns: writerTurns(["a", "b"], (key) => ({
        name: "edit",
        args: key === "a" ? { path: "shared.txt", oldString: "line-02\n", newString: "line-02-A\n" } : { path: "shared.txt", oldString: "line-19\n", newString: "line-19-B\n" },
      })) as never,
    });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "J2");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-j2", [IMPL("a"), IMPL("b"), REVIEWER_OF("ra", "a"), REVIEWER_OF("rb", "b")]);
      const [aId, bId, raId, rbId] = dag.taskIds as [string, string, string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: aId, reviewer: raId }, { writer: bId, reviewer: rbId }]);
        await untilAutoBuilt(t, session.id, runId, 2);
        const integration = (await t.core.integrations.listByRun(runId))[0]!;
        const merged = readFileSync(path.join((await t.core.integrations.getIntegration(integration.id)).canonicalPath, "shared.txt"), "utf8");
        expect(merged).toContain("line-02-A");
        expect(merged).toContain("line-19-B");
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("J3: cadena de commits dependientes (FF + FF)", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["a", "b"], (key) => ({ name: "write", args: { path: `chain-${key}.txt`, content: `chain-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "J3");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-j3", [IMPL("a"), IMPL("b"), REVIEWER_OF("ra", "a"), REVIEWER_OF("rb", "b")]);
      const [aId, bId, raId, rbId] = dag.taskIds as [string, string, string, string];
      await t.core.db.exec("INSERT INTO task_dependencies (task_id, depends_on, kind) VALUES (?, ?, 'requires')", [bId, aId]);
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        // A → RA → accept → B se desbloquea sobre el produced de A.
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(aId)).status === "completed", 30000);
        await untilWorktreesFinished(t, [aId]);
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(raId)).status === "completed", 30000);
        await t.core.recordTaskReview(raId, aId, "accept", { note: "chain-a" });
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(bId)).status === "completed", 30000);
        await untilWorktreesFinished(t, [bId]);
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(rbId)).status === "completed", 30000);
        await t.core.recordTaskReview(rbId, bId, "accept", { note: "chain-b" });
        await untilAutoBuilt(t, session.id, runId, 2);
        const integration = (await t.core.integrations.listByRun(runId))[0]!;
        expect((await t.core.integrations.getCommits(integration.id)).map((c) => c.kind)).toEqual(["original", "original"]);
        const after = await t.core.integrations.getIntegration(integration.id);
        expect(existsSync(path.join(after.canonicalPath, "chain-a.txt"))).toBe(true);
        expect(existsSync(path.join(after.canonicalPath, "chain-b.txt"))).toBe(true);
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });
});

describe("etapa 5.1 — rechazos (J7–J9)", () => {
  test("J7: origen no registrado (task desconocida, task sin revisión)", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "J7");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-j7", [IMPL("w")]);
      const integration = await t.core.integrations.createForRun({ projectId: project.id, runId });
      await expectRejects(t.core.integrations.incorporateCommit(integration.id, "tsk_missing", 1), /not found/i);
      await expectRejects(t.core.integrations.incorporateCommit(integration.id, dag.taskIds[0]!, 1), /requires review|not completed|no recorded produced/i);
      await sweepAll(t, project.id, root);
    } finally {
      await t.cleanup();
    }
  });

  test("J8: commit de otro proyecto/repositorio", async () => {
    const mkTurns = () =>
      writerTurns(["z"], (key) => ({ name: "write", args: { path: `file-${key}.txt`, content: `content-${key}\n` } })) as never;
    const t = await makeTestCore({ metaTurns: mkTurns() });
    try {
      await useFakeModels(t.core);
      const a = await gitProject(t, "JA");
      const b = await gitProject(t, "JB");
      const runA = await makeRun(t, a.session.id);
      const runB = await makeRun(t, b.session.id);
      const dagB = await approvedDag(t, b.session.id, b.project.id, runB.runId, "h-j8b", [IMPL("z"), REVIEWER_OF("rz", "z")]);
      const [zId, rzId] = dagB.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, b.session.id, [{ writer: zId, reviewer: rzId }]);
        const integrationA = await t.core.integrations.createForRun({ projectId: a.project.id, runId: runA.runId });
        await expectRejects(t.core.integrations.incorporateCommit(integrationA.id, zId, 1), /another project or repository/i);
        await sweepAll(t, a.project.id, a.root);
        await sweepAll(t, b.project.id, b.root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("J9: intento ya integrado es idempotente (sin duplicar filas)", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["w"], (key) => ({ name: "write", args: { path: `solo-${key}.txt`, content: `solo-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "J9");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-j9", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: wId, reviewer: rId }]);
        // P1: el auto-build ya incorporó; las llamadas explícitas son idempotentes.
        await untilAutoBuilt(t, session.id, runId, 1);
        const integration = (await t.core.integrations.listByRun(runId))[0]!;
        const first = await t.core.integrations.incorporateCommit(integration.id, wId, 1);
        expect(first.reused).toBe(true);
        const second = await t.core.integrations.incorporateCommit(integration.id, wId, 1);
        expect(second.reused).toBe(true);
        expect(second.integratedSha).toBe(first.integratedSha);
        expect((await t.core.integrations.getCommits(integration.id))).toHaveLength(1);
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });
});

describe("etapa 5.2 — workbase multi-predecesor (J4)", () => {
  test("J4: task con dos predecesores escritores usa workbase y se incorpora tras ambos", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["a", "b", "c"], (key) => ({ name: "write", args: { path: `file-${key}.txt`, content: `content-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      t.core.setAgentLimits({ maxPerSession: 4, maxPerProject: 6, maxDepth: 2, maxImplementers: 1, maxReaders: 2, maxReviewers: 1 });
      const { project, session, root } = await gitProject(t, "WB");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-wb", [IMPL("a"), IMPL("b"), IMPL("c"), REVIEWER_OF("ra", "a"), REVIEWER_OF("rb", "b"), REVIEWER_OF("rc", "c")]);
      const [aId, bId, cId, raId, rbId, rcId] = dag.taskIds as [string, string, string, string, string, string];
      await t.core.db.exec("INSERT INTO task_dependencies (task_id, depends_on, kind) VALUES (?, ?, 'requires')", [cId, aId]);
      await t.core.db.exec("INSERT INTO task_dependencies (task_id, depends_on, kind) VALUES (?, ?, 'requires')", [cId, bId]);
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        // A completa y se revisa con B aún pendiente: C queda bloqueada (re-evaluable).
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(aId)).status === "completed", 30000);
        await untilWorktreesFinished(t, [aId]);
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(raId)).status === "completed", 30000);
        await t.core.recordTaskReview(raId, aId, "accept", { note: "wb-a" });
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => {
          const c = await t.core.tasks.getTask(cId);
          return c.status === "blocked" && c.blockedReason === "deps-unavailable";
        }, 30000);
        // B completa y se revisa: C se desbloquea sobre la workbase A+B.
        t.core.setAgentLimits({ maxPerSession: 4, maxPerProject: 6, maxDepth: 2, maxImplementers: 2, maxReaders: 2, maxReviewers: 1 });
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(bId)).status === "completed", 30000);
        await untilWorktreesFinished(t, [bId]);
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(rbId)).status === "completed", 30000);
        await t.core.recordTaskReview(rbId, bId, "accept", { note: "wb-b" });
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(cId)).status === "completed", 30000);
        await untilWorktreesFinished(t, [cId]);
        // La workbase existe y el worktree de C deriva de ella con ambos ficheros.
        const wb = await t.core.integrations.getWorkBase(cId);
        expect(wb).toBeDefined();
        expect(wb!.status).toBe("ready");
        expect(wb!.tipSha).toMatch(/^[0-9a-f]{40}$/);
        const cWt = await t.core.worktrees.getByTask(cId);
        expect(cWt!.baseSource.startsWith("workbase:")).toBe(true);
        expect(cWt!.baseCommit).toBe(wb!.tipSha);
        expect(readFileSync(path.join(cWt!.canonicalPath, "file-a.txt"), "utf8")).toContain("content-a");
        expect(readFileSync(path.join(cWt!.canonicalPath, "file-b.txt"), "utf8")).toContain("content-b");
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(rcId)).status === "completed", 30000);
        await t.core.recordTaskReview(rcId, cId, "accept", { note: "wb-c" });
        await untilAutoBuilt(t, session.id, runId, 3);
        const integration = (await t.core.integrations.listByRun(runId))[0]!;
        const commits = await t.core.integrations.getCommits(integration.id);
        expect(commits.map((c) => c.kind).sort()).toEqual(["original", "resolution", "resolution"]);
        const byTask = new Map(commits.map((c) => [c.taskId, c]));
        expect(byTask.get(cId)!.kind).toBe("resolution");
        const after = await t.core.integrations.getIntegration(integration.id);
        for (const f of ["file-a.txt", "file-b.txt", "file-c.txt"]) {
          expect(existsSync(path.join(after.canonicalPath, f))).toBe(true);
        }
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("ensureWorkBase bloquea mientras los predecesores no están revisados", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "WU");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-wu", [IMPL("a"), IMPL("b"), IMPL("c")]);
      const [aId, bId, cId] = dag.taskIds as [string, string, string];
      const blocked = await t.core.integrations.ensureWorkBaseForTask({ projectId: project.id, runId, taskId: cId, predecessorIds: [aId, bId] });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.blockedReason).toBe("deps-unavailable");
      await sweepAll(t, project.id, root);
    } finally {
      await t.cleanup();
    }
  });
});

describe("etapa 5.2 — auto-build del run (P1)", () => {
  test("run con escritores revisados se integra solo y pasa a integrating", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["w"], (key) => ({ name: "write", args: { path: `auto-${key}.txt`, content: `auto-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "AB");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-ab", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: wId, reviewer: rId }]);
        // El veredicto (vía settlePairs) ya disparó ticks: la integración existe sin crearla a mano.
        await untilAutoBuilt(t, session.id, runId, 1);
        const integration = (await t.core.integrations.listByRun(runId))[0]!;
        const run = await t.core.db.queryOne<{ status: string }>("SELECT status FROM runs WHERE id = ?", [runId]);
        expect(run!.status).toBe("integrating");
        expect(existsSync(path.join(integration.canonicalPath, "auto-w.txt"))).toBe(true);
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("run sin escritores git conserva done directo (legacy intacto)", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const { project, session } = await gitProject(t, "LG");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-lg", [REVIEWER_OF("r", "w"), IMPL("w")]);
      void dag;
      // Sin writers ejecutados no hay worktrees: el run puede cerrarse en done.
      await t.core.db.exec("UPDATE runs SET status = 'done', updated_at = 1, completed_at = 1 WHERE id = ?", [runId]);
      const run = await t.core.db.queryOne<{ status: string }>("SELECT status FROM runs WHERE id = ?", [runId]);
      expect(run!.status).toBe("done");
      expect(await t.core.integrations.listByRun(runId)).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });
});
describe("etapa 5.3 — resolución asistida (J5/J6)", () => {
  /** Turnos: writers (write), reviewers (texto), resolver (write merged). */
  function resolverTurns(keys: string[]): (callIndex: number, input: never) => { toolCalls?: Array<{ name: string; args: unknown }>; text?: string } {
    const seen = new Map<string, number>();
    return (_: number, input: never) => {
      const text = JSON.stringify((input as unknown as { messages?: unknown[] })?.messages ?? []);
      if (text.includes("Conflict resolution in an isolated workspace")) {
        const n = (seen.get("__resolver") ?? 0) + 1;
        seen.set("__resolver", n);
        if (n === 1) return { toolCalls: [{ name: "write", args: { path: "conflict.txt", content: "merged-a-b\n" } }] };
        return { text: "resolution done" };
      }
      const m = new RegExp(`area ([${keys.join("")}]) code`).exec(text);
      if (m) {
        const key = m[1]!;
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        if (n === 1) return { toolCalls: [{ name: "write", args: { path: "conflict.txt", content: `version-${key}\n` } }] };
        return { text: `done-${key}` };
      }
      return { text: "review-done" };
    };
  }

  async function untilConflicted(t: TestCore, sessionId: string, runId: string, ms = 30000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const list = await t.core.integrations.listByRun(runId);
      if (list[0]) {
        const full = await t.core.integrations.getIntegration(list[0].id);
        if (full.status === "conflicted") return full;
      }
      if (Date.now() > deadline) throw new Error("Timed out waiting for conflicted integration");
      await t.core.scheduler.tick({ sessionId }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  test("J5+J6: el agente resuelve sin tocar la rama de integración; la incorporación la hace el harness", async () => {
    const t = await makeTestCore({ metaTurns: resolverTurns(["a", "b"]) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "RS");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-rs", [IMPL("a"), IMPL("b"), REVIEWER_OF("ra", "a"), REVIEWER_OF("rb", "b")]);
      const [aId, bId, raId, rbId] = dag.taskIds as [string, string, string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: aId, reviewer: raId }, { writer: bId, reviewer: rbId }]);
        const conflicted = await untilConflicted(t, session.id, runId);
        const headBefore = conflicted.head!;
        const conflicts = await t.core.conflicts.listConflicts({ scopeRef: conflicted.id, status: "open" });
        expect(conflicts).toHaveLength(1);
        const conflict = conflicts[0]!;
        // Solicitud: workspace de resolución + instancia (la rama de integración no se toca).
        const req = await t.core.conflicts.requestResolution(conflict.id);
        expect(req.instanceId).toBeDefined();
        expect(req.reused).toBe(false);
        expect(req.branchName).toBe(`harness/resolution/${conflict.id}`);
        expect(req.branchName).not.toBe(conflicted.integrationBranch);
        expect(req.workspacePath).not.toBe(conflicted.canonicalPath);
        await t.core.agents.wait(req.instanceId!, 60000);
        await t.core.scheduler.tick({ sessionId: session.id }).catch(() => undefined);
        // Finalización: el harness commitea; la integración sigue en el SHA previo.
        const { resolutionSha } = await t.core.conflicts.finalizeResolution(conflict.id, req.instanceId!);
        expect(resolutionSha).toMatch(/^[0-9a-f]{40}$/);
        expect((await t.core.integrations.getIntegration(conflicted.id)).head).toBe(headBefore);
        const afterFinalize = await t.core.conflicts.getConflict(conflict.id);
        expect(afterFinalize.status).toBe("resolved");
        // Incorporación: FF verificado por padres, fila kind resolution.
        const inc = await t.core.conflicts.incorporateResolution(conflicted.id, conflict.id);
        expect(inc.reused).toBe(false);
        expect(inc.integratedSha).toBe(resolutionSha);
        const after = await t.core.integrations.getIntegration(conflicted.id);
        expect(after.head).toBe(resolutionSha);
        expect(readFileSync(path.join(after.canonicalPath, "conflict.txt"), "utf8")).toBe("merged-a-b\n");
        const commits = await t.core.integrations.getCommits(conflicted.id);
        expect(commits.filter((c) => c.kind === "resolution")).toHaveLength(1);
        // Idempotencia: segunda incorporación reutiliza.
        const again = await t.core.conflicts.incorporateResolution(conflicted.id, conflict.id);
        expect(again.reused).toBe(true);
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("reutilización: mismos padres ya resueltos no spawnean otro agente", async () => {
    const t = await makeTestCore({ metaTurns: resolverTurns(["a", "b"]) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "RU");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-ru", [IMPL("a"), IMPL("b"), REVIEWER_OF("ra", "a"), REVIEWER_OF("rb", "b")]);
      const [aId, bId, raId, rbId] = dag.taskIds as [string, string, string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: aId, reviewer: raId }, { writer: bId, reviewer: rbId }]);
        const conflicted = await untilConflicted(t, session.id, runId);
        const conflict = (await t.core.conflicts.listConflicts({ scopeRef: conflicted.id, status: "open" }))[0]!;
        const req = await t.core.conflicts.requestResolution(conflict.id);
        await t.core.agents.wait(req.instanceId!, 60000);
        const { resolutionSha } = await t.core.conflicts.finalizeResolution(conflict.id, req.instanceId!);
        // Rebobinar la integración al estado previo (fixture temporal) y abrir
        // un segundo conflicto con la misma pareja (ours, theirs).
        execFileSync("git", ["reset", "--hard", conflict.oursSha], { cwd: conflicted.canonicalPath, timeout: 30_000, windowsHide: true });
        await t.core.db.exec(
          "INSERT INTO integration_conflicts (id, scope, scope_ref, files, ours_sha, theirs_sha, base_sha, task_id, attempt, status, created_at, updated_at) VALUES ('cf_reuse1', 'integration', ?, ?, ?, ?, ?, ?, 2, 'open', 1, 1)",
          [conflicted.id, JSON.stringify(["conflict.txt"]), conflict.oursSha, conflict.theirsSha, conflict.baseSha ?? null, conflict.taskId ?? null],
        );
        const before = (await t.core.agentInstances(session.id)).length;
        const req2 = await t.core.conflicts.requestResolution("cf_reuse1");
        expect(req2.reused).toBe(true);
        expect(req2.resolutionSha).toBe(resolutionSha);
        expect(req2.instanceId).toBeUndefined();
        expect((await t.core.agentInstances(session.id)).length).toBe(before);
        expect((await t.core.conflicts.getConflict("cf_reuse1")).status).toBe("resolved");
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("finalize rechaza si el agente commiteó por su cuenta (sin MERGE_HEAD)", async () => {
    const seen = new Map<string, number>();
    const t = await makeTestCore({
      metaTurns: ((_: number, input: never) => {
        const text = JSON.stringify((input as unknown as { messages?: unknown[] })?.messages ?? []);
        if (text.includes("Conflict resolution in an isolated workspace")) {
          const n = (seen.get("r") ?? 0) + 1;
          seen.set("r", n);
          if (n === 1) return { toolCalls: [{ name: "write", args: { path: "conflict.txt", content: "rogue\n" } }] };
          if (n === 2) return { toolCalls: [{ name: "git_stage", args: { paths: ["conflict.txt"] } }] };
          if (n === 3) return { toolCalls: [{ name: "git_commit", args: { message: "rogue commit" } }] };
          return { text: "rogue done" };
        }
        const m = /area ([ab]) code/.exec(text);
        if (m) {
          const key = m[1]!;
          const n = (seen.get(key) ?? 0) + 1;
          seen.set(key, n);
          if (n === 1) return { toolCalls: [{ name: "write", args: { path: "conflict.txt", content: `version-${key}\n` } }] };
          return { text: `done-${key}` };
        }
        return { text: "review-done" };
      }) as never,
    });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "RG");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-rg", [IMPL("a"), IMPL("b"), REVIEWER_OF("ra", "a"), REVIEWER_OF("rb", "b")]);
      const [aId, bId, raId, rbId] = dag.taskIds as [string, string, string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: aId, reviewer: raId }, { writer: bId, reviewer: rbId }]);
        const conflicted = await untilConflicted(t, session.id, runId);
        const conflict = (await t.core.conflicts.listConflicts({ scopeRef: conflicted.id, status: "open" }))[0]!;
        const req = await t.core.conflicts.requestResolution(conflict.id);
        await t.core.agents.wait(req.instanceId!, 60000);
        await expectRejects(t.core.conflicts.finalizeResolution(conflict.id, req.instanceId!), /merge state|MERGE_HEAD/i);
        expect((await t.core.conflicts.getConflict(conflict.id)).status).toBe("resolving");
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("finalize rechaza escritura fuera del scope del conflicto", async () => {
    const seen = new Map<string, number>();
    const t = await makeTestCore({
      metaTurns: ((_: number, input: never) => {
        const text = JSON.stringify((input as unknown as { messages?: unknown[] })?.messages ?? []);
        if (text.includes("Conflict resolution in an isolated workspace")) {
          const n = (seen.get("r") ?? 0) + 1;
          seen.set("r", n);
          if (n === 1) return { toolCalls: [{ name: "write", args: { path: "conflict.txt", content: "merged\n" } }] };
          if (n === 2) return { toolCalls: [{ name: "write", args: { path: "evil.txt", content: "x\n" } }] };
          return { text: "wide done" };
        }
        const m = /area ([ab]) code/.exec(text);
        if (m) {
          const key = m[1]!;
          const n = (seen.get(key) ?? 0) + 1;
          seen.set(key, n);
          if (n === 1) return { toolCalls: [{ name: "write", args: { path: "conflict.txt", content: `version-${key}\n` } }] };
          return { text: `done-${key}` };
        }
        return { text: "review-done" };
      }) as never,
    });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "SC");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-sc", [IMPL("a"), IMPL("b"), REVIEWER_OF("ra", "a"), REVIEWER_OF("rb", "b")]);
      const [aId, bId, raId, rbId] = dag.taskIds as [string, string, string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: aId, reviewer: raId }, { writer: bId, reviewer: rbId }]);
        const conflicted = await untilConflicted(t, session.id, runId);
        const conflict = (await t.core.conflicts.listConflicts({ scopeRef: conflicted.id, status: "open" }))[0]!;
        const req = await t.core.conflicts.requestResolution(conflict.id);
        await t.core.agents.wait(req.instanceId!, 60000);
        await expectRejects(t.core.conflicts.finalizeResolution(conflict.id, req.instanceId!), /outside the conflict scope/i);
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });
});
describe("etapa 5.1 — conflicto detectado (anticipa §C)", () => {
  test("merge con conflicto: abort + fila abierta + rama preservada", async () => {
    const t = await makeTestCore({
      metaTurns: writerTurns(["a", "b"], (key) => ({ name: "write", args: { path: "conflict.txt", content: `version-${key}\n` } })) as never,
    });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "CF");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-cf", [IMPL("a"), IMPL("b"), REVIEWER_OF("ra", "a"), REVIEWER_OF("rb", "b")]);
      const [aId, bId, raId, rbId] = dag.taskIds as [string, string, string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: aId, reviewer: raId }, { writer: bId, reviewer: rbId }]);
        // P1: el auto-build incorpora A y abre el conflicto con B (una sola fila).
        const deadline = Date.now() + 30000;
        let conflicted = await t.core.integrations.listByRun(runId).then((l) => l[0]).then((i) => (i ? t.core.integrations.getIntegration(i.id) : undefined));
        for (;;) {
          if (conflicted && conflicted.status === "conflicted") break;
          if (Date.now() > deadline) throw new Error("Timed out waiting for conflicted integration");
          await t.core.scheduler.tick({ sessionId: session.id }).catch(() => undefined);
          await new Promise((r) => setTimeout(r, 500));
          conflicted = await t.core.integrations.listByRun(runId).then((l) => l[0]).then((i) => (i ? t.core.integrations.getIntegration(i.id) : undefined));
        }
        expect(conflicted!.status).toBe("conflicted");
        const conflicts = await t.core.db.query<{ files: string; status: string }>("SELECT files, status FROM integration_conflicts WHERE scope_ref = ?", [conflicted!.id]);
        expect(conflicts).toHaveLength(1);
        expect(JSON.parse(conflicts[0]!.files)).toEqual(["conflict.txt"]);
        expect(conflicts[0]!.status).toBe("open");
        // Uno quedó incorporado (FF); el otro abrió el conflicto (orden no determinista).
        const incorporated = (await t.core.integrations.getCommits(conflicted!.id)).map((c) => c.taskId);
        expect(incorporated).toHaveLength(1);
        expect([aId, bId]).toContain(incorporated[0]!);
        // La rama de integración nunca queda con MERGE_HEAD.
        const porcelain = git(conflicted!.canonicalPath, ["status", "--porcelain=v1"]);
        expect(porcelain.split("\n").some((l) => l.startsWith("UU"))).toBe(false);
        await expectRejects(
          Promise.resolve().then(() => git(conflicted!.canonicalPath, ["rev-parse", "--verify", "MERGE_HEAD"])),
          /fatal|needed a single revision/i,
        );
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });
});
