/** Etapa 5.1 — IntegrationManager con git real (fakes para los modelos). */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  for (const irow of await t.core.db.query<{ id: string }>("SELECT id FROM integrations WHERE project_id = ?", [projectId]).catch(() => []) ?? []) {
    for (const p of await t.core.previews.listPreviews(String(irow.id)).catch(() => [])) {
      await t.core.previews.stopPreview(p.id).catch(() => undefined);
      await t.core.previews.cleanupPreview(p.id).catch(() => undefined);
    }
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
        // Las tasks asentadas quedan marcadas como integradas (trazabilidad Plan→Integration).
        expect((await t.core.tasks.getTask(aId)).status).toBe("integrated");
        expect((await t.core.tasks.getTask(bId)).status).toBe("integrated");
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
      // "other" completa pero nunca se revisa: el auto-build de B no dispara y z
      // queda reviewed sin incorporar (estado exacto que debe rechazar A).
      const dagB = await approvedDag(t, b.session.id, b.project.id, runB.runId, "h-j8b", [IMPL("z"), IMPL("other"), REVIEWER_OF("rz", "z")]);
      const [zId, , rzId] = dagB.taskIds as [string, string, string];
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
describe("etapa 5.4 — validación (J10/J11)", () => {
  async function allowlistedExe(t: TestCore, projectId: string): Promise<void> {
    const exe = process.execPath;
    await t.core.tests.saveAllowlist(projectId, [
      { id: "v-pass", name: "pass", argv: [exe, "-e", "process.exit(0)"] },
      { id: "v-fail", name: "fail", argv: [exe, "-e", "process.exit(1)"] },
    ]);
  }

  const IMPLV = (tempId: string, cmds: string[]): PlannedTaskInput => ({ ...IMPL(tempId), validationCommands: cmds });

  test("J10: suite distingue passed/failed; gate bloquea con fallos", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["a", "b"], (key) => ({ name: "write", args: { path: `file-${key}.txt`, content: `content-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "V1");
      await allowlistedExe(t, project.id);
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-v1", [IMPLV("a", ["v-pass"]), IMPLV("b", ["v-fail"]), REVIEWER_OF("ra", "a"), REVIEWER_OF("rb", "b")]);
      const [aId, bId, raId, rbId] = dag.taskIds as [string, string, string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: aId, reviewer: raId }, { writer: bId, reviewer: rbId }]);
        await untilAutoBuilt(t, session.id, runId, 2);
        const integration = (await t.core.integrations.listByRun(runId))[0]!;
        const head = (await t.core.integrations.getIntegration(integration.id)).head!;
        // La suite corrió sola con el ensamblado (P1): passed + failed, nada parcial.
        const rows = await t.core.validations.listValidations(integration.id, head);
        const byEntry = new Map(rows.map((r) => [r.entryId ?? r.kind, r.status]));
        expect(byEntry.get("v-pass")).toBe("passed");
        expect(byEntry.get("v-fail")).toBe("failed");
        expect((await t.core.integrations.getIntegration(integration.id)).status).toBe("validating");
        const gate = await t.core.validations.validationGate(integration.id, head);
        expect(gate.ok).toBe(false);
        expect(gate.reasons.join(";")).toMatch(/failing/);
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("J11: comando fuera de allowlist queda blocked (nunca se ejecuta)", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["w"], (key) => ({ name: "write", args: { path: `solo-${key}.txt`, content: `solo-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "V2");
      await allowlistedExe(t, project.id);
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-v2", [IMPLV("w", ["v-pass"]), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: wId, reviewer: rId }]);
        await untilAutoBuilt(t, session.id, runId, 1);
        const integration = (await t.core.integrations.listByRun(runId))[0]!;
        const head = (await t.core.integrations.getIntegration(integration.id)).head!;
        expect((await t.core.validations.listValidations(integration.id, head)).map((r) => r.status)).toEqual(["passed"]);
        // La allowlist cambia después: re-ejecutar no ejecuta nada, marca blocked.
        await t.core.tests.saveAllowlist(project.id, []);
        const rerun = await t.core.validations.runSuiteValidation(integration.id, head, { force: true });
        expect(rerun.map((r) => r.status)).toEqual(["blocked"]);
        expect((await t.core.validations.validationGate(integration.id, head)).ok).toBe(false);
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("J11: suite vacía es skipped explícito; el gate exige review accept", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "V3");
      const { runId, instanceId: coordId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-v3", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: wId, reviewer: rId }]);
        await untilAutoBuilt(t, session.id, runId, 1);
        const integration = (await t.core.integrations.listByRun(runId))[0]!;
        const head = (await t.core.integrations.getIntegration(integration.id)).head!;
        const rows = await t.core.validations.listValidations(integration.id, head);
        expect(rows.map((r) => [r.kind, r.status])).toEqual([["suite", "skipped"]]);
        // Sin review accept el gate no pasa (skipped nunca equivale a passed).
        expect((await t.core.validations.validationGate(integration.id, head)).ok).toBe(false);
        // Reviewer sobre el worktree de integración + veredicto explícito.
        const spawned = await t.core.agents.spawn({ parentInstanceId: coordId, definitionId: "reviewer", brief: "Review the integration worktree for defects. Report findings.", mode: "background", integrationId: integration.id });
        await t.core.agents.wait(spawned.instanceId, 60000);
        await t.core.validations.recordIntegrationReview(integration.id, { instanceId: spawned.instanceId, verdict: "accept", summary: "test review" });
        const gate = await t.core.validations.validationGate(integration.id, head);
        expect(gate).toEqual({ ok: true, reasons: [] });
        // Negativo: una instancia implementer no puede registrar veredicto.
        const wAtt = (await t.core.tasks.getAttempts(wId))[0]!;
        await expectRejects(t.core.validations.recordIntegrationReview(integration.id, { instanceId: wAtt.instanceId!, verdict: "accept" }), /not a reviewer/i);
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });
});
describe("etapa 5.5 — preview (J12–J16)", () => {
  const SERVER = `require("http").createServer((q,r)=>{r.end("ok")}).listen(Number(process.env.OCTUS_PREVIEW_PORT))`;
  const DUMP = `require("fs").writeFileSync(process.env.OCTUS_PREVIEW_DATA_DIR+"/env.json", JSON.stringify(process.env)); setInterval(()=>{}, 1000000)`;

  async function previewAllowlist(t: TestCore, projectId: string): Promise<void> {
    const exe = process.execPath;
    await t.core.previews.saveAllowlist(projectId, [
      { id: "install-ok", name: "install", phase: "install", argv: [exe, "-e", "process.exit(0)"] },
      { id: "serve", name: "serve", phase: "start", argv: [exe, "-e", SERVER] },
      { id: "dump", name: "dump", phase: "start", argv: [exe, "-e", DUMP] },
      { id: "exit2", name: "exiter", phase: "start", argv: [exe, "-e", "process.exit(2)"] },
    ]);
  }

  test("J16+J13: preview sirve el SHA exacto; stop mata el árbol", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["w"], (key) => ({ name: "write", args: { path: `solo-${key}.txt`, content: `solo-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "PV");
      await previewAllowlist(t, project.id);
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-pv", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: wId, reviewer: rId }]);
        await untilAutoBuilt(t, session.id, runId, 1);
        const integration = (await t.core.integrations.listByRun(runId))[0]!;
        const head = (await t.core.integrations.getIntegration(integration.id)).head!;
        const pv = await t.core.previews.createPreview(integration.id);
        expect(pv.sha).toBe(head);
        const started = await t.core.previews.startPreview(pv.id, { startEntryId: "serve" });
        expect(started.reachable).toBe(true);
        expect(started.status).toBe("reachable");
        expect(started.url).toBe((await t.core.previews.getPreview(pv.id)).url);
        // J16: URL y SHA corresponden al registrado.
        const inspected = await t.core.previews.inspectPreview(pv.id);
        expect(inspected.shaMatchesHead).toBe(true);
        expect(inspected.reachable).toBe(true);
        const before = await t.core.previews.getPreview(pv.id);
        expect(before.pid).toBeDefined();
        // J13: stop termina el proceso (pid muerto) y marca stopped.
        const { stopped } = await t.core.previews.stopPreview(pv.id);
        expect(stopped).toBe(true);
        expect((await t.core.previews.getPreview(pv.id)).status).toBe("stopped");
        let alive = true;
        try {
          process.kill(before.pid!, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("J14: aislamiento de entorno y DB; sin .git real en el preview", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["w"], (key) => ({ name: "write", args: { path: `solo-${key}.txt`, content: `solo-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "EN");
      await previewAllowlist(t, project.id);
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-en", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: wId, reviewer: rId }]);
        await untilAutoBuilt(t, session.id, runId, 1);
        const integration = (await t.core.integrations.listByRun(runId))[0]!;
        const pv = await t.core.previews.createPreview(integration.id);
        await t.core.previews.startPreview(pv.id, { startEntryId: "dump" });
        const envPath = path.join(t.dir, "data", "previews", pv.id, "env.json");
        const deadline = Date.now() + 15000;
        for (;;) {
          if (existsSync(envPath)) break;
          if (Date.now() > deadline) throw new Error("dumped env never appeared");
          await new Promise((r) => setTimeout(r, 300));
        }
        const env = JSON.parse(readFileSync(envPath, "utf8")) as Record<string, string>;
        expect(env.OCTUS_PREVIEW_PORT).toBe(String((await t.core.previews.getPreview(pv.id)).port));
        expect(env.OCTUS_PREVIEW_HOST).toBe("127.0.0.1");
        expect(env.OCTUS_PREVIEW_URL).toBe((await t.core.previews.getPreview(pv.id)).url);
        expect(env.OCTUS_PREVIEW_SHA).toBe((await t.core.previews.getPreview(pv.id)).sha);
        expect(env.OCTUS_PREVIEW_DATA_DIR).toBe(path.join(t.dir, "data", "previews", pv.id));
        const leaked = Object.keys(env).filter((k) => /api[_-]?key|token|secret|password|credentials/i.test(k));
        expect(leaked).toEqual([]);
        expect(env.PATH).toBeDefined();
        // Sin .git real en el preview (gitdir como fichero) y fuera del repo principal.
        const dotGit = path.join((await t.core.previews.getPreview(pv.id)).canonicalPath, ".git");
        expect(existsSync(dotGit)).toBe(true);
        expect(statSync(dotGit).isFile()).toBe(true);
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("J12: preview que no arranca queda failed (sin excepción)", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["w"], (key) => ({ name: "write", args: { path: `solo-${key}.txt`, content: `solo-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "PX");
      await previewAllowlist(t, project.id);
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-px", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: wId, reviewer: rId }]);
        await untilAutoBuilt(t, session.id, runId, 1);
        const integration = (await t.core.integrations.listByRun(runId))[0]!;
        const pv = await t.core.previews.createPreview(integration.id);
        const started = await t.core.previews.startPreview(pv.id, { startEntryId: "exit2" });
        expect(started.status).toBe("failed");
        expect(started.reachable).toBe(false);
        expect((await t.core.previews.getPreview(pv.id)).status).toBe("failed");
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("preview.reconcile marca huérfanos sin matar nada; cleanup retira el espacio", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["w"], (key) => ({ name: "write", args: { path: `solo-${key}.txt`, content: `solo-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "RC");
      await previewAllowlist(t, project.id);
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-rc", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: wId, reviewer: rId }]);
        await untilAutoBuilt(t, session.id, runId, 1);
        const integration = (await t.core.integrations.listByRun(runId))[0]!;
        const pv = await t.core.previews.createPreview(integration.id);
        // Sin proceso lanzado: reconcile no toca 'starting' (lanzamiento pendiente).
        expect((await t.core.previews.reconcile()).orphaned).toBe(0);
        const started = await t.core.previews.startPreview(pv.id, { startEntryId: "serve" });
        expect(started.reachable).toBe(true);
        const livePid = (await t.core.previews.getPreview(pv.id)).pid!;
        // Proceso ajeno a este manager (simula reinicio): tracked vacío → orphaned, sin matar.
        (t.core.previews as unknown as { tracked: Map<string, unknown> }).tracked.clear();
        expect((await t.core.previews.reconcile()).orphaned).toBe(1);
        expect((await t.core.previews.getPreview(pv.id)).status).toBe("orphaned");
        // El proceso sigue vivo (reconcile no mata pids ajenos): lo termina el test.
        try {
          process.kill(livePid);
        } catch {
          // ya muerto
        }
        const deadline = Date.now() + 5000;
        for (;;) {
          let alive = true;
          try {
            process.kill(livePid, 0);
          } catch {
            alive = false;
          }
          if (!alive) break;
          if (Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        await t.core.previews.stopPreview(pv.id).catch(() => undefined);
        const { removed } = await t.core.previews.cleanupPreview(pv.id);
        expect(removed).toBe(true);
        await expectRejects(t.core.previews.getPreview(pv.id), /not found/i);
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });
});
describe("etapa 5.6 — aprobación y promoción (J17–J26)", () => {
  /** Flujo completo hasta aprobado (con waiver; sin preview). */
  async function settleAndApprove(
    t: TestCore,
    sessionId: string,
    runId: string,
    coordId: string,
    pairs: Array<{ writer: string; reviewer: string }>,
  ): Promise<{ integrationId: string; head: string }> {
    await settlePairs(t, sessionId, pairs);
    await untilAutoBuilt(t, sessionId, runId, pairs.length);
    const integration = (await t.core.integrations.listByRun(runId))[0]!;
    const head = (await t.core.integrations.getIntegration(integration.id)).head!;
    const spawned = await t.core.agents.spawn({ parentInstanceId: coordId, definitionId: "reviewer", brief: "Review the integration worktree for defects. Report findings.", mode: "background", integrationId: integration.id });
    await t.core.agents.wait(spawned.instanceId, 60000);
    await t.core.validations.recordIntegrationReview(integration.id, { instanceId: spawned.instanceId, verdict: "accept", summary: "test accept" });
    await t.core.approvals.approveIntegration(integration.id, { waiverReason: "test: library change, no server to preview" });
    return { integrationId: integration.id, head };
  }

  test("J17: aprobación pinneada al SHA exacto con actor y hash", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["w"], (key) => ({ name: "write", args: { path: `solo-${key}.txt`, content: `solo-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "AP");
      const { runId, instanceId: coordId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-ap", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        const { integrationId, head } = await settleAndApprove(t, session.id, runId, coordId, [{ writer: wId, reviewer: rId }]);
        const rows = await t.core.approvals.listApprovals(integrationId);
        expect(rows).toHaveLength(1);
        const ap = rows[0]!;
        expect(ap.candidateSha).toBe(head);
        expect(ap.decision).toBe("approved");
        expect(ap.actor).toBe("user");
        expect(ap.targetBranch).toBe("main");
        expect(ap.targetShaObserved).toHaveLength(40);
        expect(ap.validationsHash).toMatch(/^[0-9a-f]{64}$/);
        expect(ap.grantedAt).toBeGreaterThan(0);
        expect((await t.core.integrations.getIntegration(integrationId)).status).toBe("approved");
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("J18: cambio del SHA tras aprobar invalida; promover se niega", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["w"], (key) => ({ name: "write", args: { path: `solo-${key}.txt`, content: `solo-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "M8");
      const { runId, instanceId: coordId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-m8", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        const { integrationId, head } = await settleAndApprove(t, session.id, runId, coordId, [{ writer: wId, reviewer: rId }]);
        // Deriva simulada: commit directo en el worktree de integración.
        const intPath = (await t.core.integrations.getIntegration(integrationId)).canonicalPath;
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "--no-verify", "-m", "drift"], { cwd: intPath, timeout: 30_000, windowsHide: true });
        const status = await t.core.approvals.getApprovalStatus(integrationId);
        expect(status.ok).toBe(false);
        expect(status.reasons.join(";")).toMatch(/moved/i);
        await expectRejects(t.core.promotions.promoteIntegration(integrationId), /no longer valid|moved/i);
        // La integración conserva todo para auditoría (rama, commits, aprobación).
        const kept = await t.core.integrations.getIntegration(integrationId);
        expect(kept.status).toBe("approved");
        expect((await t.core.integrations.getCommits(integrationId))).toHaveLength(1);
        expect((await t.core.approvals.listApprovals(integrationId))).toHaveLength(1);
        void head;
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("J20: aprobación duplicada es idempotente; decisión distinta exige rebuild", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["w"], (key) => ({ name: "write", args: { path: `solo-${key}.txt`, content: `solo-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "D2");
      const { runId, instanceId: coordId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-d2", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        const { integrationId } = await settleAndApprove(t, session.id, runId, coordId, [{ writer: wId, reviewer: rId }]);
        const again = await t.core.approvals.approveIntegration(integrationId, { waiverReason: "test: duplicate" });
        expect(again.duplicate).toBe(true);
        expect((await t.core.approvals.listApprovals(integrationId))).toHaveLength(1);
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("J19: destino movido bloquea la promoción (stale) y el rebuild continúa", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["w"], (key) => ({ name: "write", args: { path: `solo-${key}.txt`, content: `solo-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "MV");
      const { runId, instanceId: coordId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-mv", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        const { integrationId } = await settleAndApprove(t, session.id, runId, coordId, [{ writer: wId, reviewer: rId }]);
        // El destino avanza (commit vacío en main del fixture temporal).
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "--no-verify", "-m", "upstream"], { cwd: root, timeout: 30_000, windowsHide: true });
        await expectRejects(t.core.promotions.promoteIntegration(integrationId), /target branch moved|no longer valid/i);
        expect((await t.core.integrations.getIntegration(integrationId)).status).toBe("stale");
        // Rebuild explícito: fila nueva con attempt+1 sobre la base nueva.
        const rebuilt = await t.core.promotions.rebuildIntegration(integrationId);
        expect(rebuilt.attempt).toBe(1);
        const fresh = await t.core.integrations.getIntegration(rebuilt.id);
        expect(fresh.supersedes).toBe(integrationId);
        expect(fresh.targetBaseCommit).toBe(git(root, ["rev-parse", "main"]).trim());
        expect(fresh.status).toBe("building");
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("J22: interrupción durante la promoción es recuperable sin duplicar", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["w"], (key) => ({ name: "write", args: { path: `solo-${key}.txt`, content: `solo-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "RC");
      const { runId, instanceId: coordId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-rc2", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        const { integrationId, head } = await settleAndApprove(t, session.id, runId, coordId, [{ writer: wId, reviewer: rId }]);
        const promoted = await t.core.promotions.promoteIntegration(integrationId);
        expect(promoted.reused).toBe(false);
        expect(promoted.newSha).toBe(head);
        expect(git(root, ["rev-parse", "main"]).trim()).toBe(head);
        // Simula corte tras mover la referencia: vuelve a 'started' + 'approved'.
        await t.core.db.exec("UPDATE promotions SET status = 'started', updated_at = 1 WHERE id = ?", [promoted.promotionId]);
        await t.core.db.exec("UPDATE integrations SET status = 'approved', updated_at = 1 WHERE id = ?", [integrationId]);
        const rec = await t.core.promotions.reconcile();
        expect(rec.resolved).toBe(1);
        expect((await t.core.promotions.getPromotion(promoted.promotionId)).status).toBe("completed");
        expect((await t.core.integrations.getIntegration(integrationId)).status).toBe("promoted");
        // Idempotencia: segunda pasada no duplica.
        expect((await t.core.promotions.reconcile()).resolved).toBe(0);
        expect((await t.core.promotions.listByIntegration(integrationId))).toHaveLength(1);
        // Divergencia: destino movido por terceros + started → diverged + stale.
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "--no-verify", "-m", "third-party"], { cwd: root, timeout: 30_000, windowsHide: true });
        await t.core.db.exec("UPDATE promotions SET status = 'started', updated_at = 1 WHERE id = ?", [promoted.promotionId]);
        await t.core.db.exec("UPDATE integrations SET status = 'approved', updated_at = 1 WHERE id = ?", [integrationId]);
        const rec2 = await t.core.promotions.reconcile();
        expect(rec2.diverged).toBe(1);
        expect((await t.core.integrations.getIntegration(integrationId)).status).toBe("stale");
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("J21: interrupción durante la integración resuelve ops sin duplicar", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "RI");
      const { runId } = await makeRun(t, session.id);
      const integration = await t.core.integrations.createForRun({ projectId: project.id, runId });
      await t.core.db.exec("INSERT INTO integration_ops (id, integration_id, op, status, created_at, updated_at) VALUES ('iop_fake1', ?, 'incorporate', 'started', 1, 1)", [integration.id]);
      const rec = await t.core.integrations.reconcile();
      expect(rec.resolved).toBeGreaterThanOrEqual(1);
      const op = await t.core.db.queryOne<{ status: string }>("SELECT status FROM integration_ops WHERE id = 'iop_fake1'");
      expect(op!.status).toBe("failed");
      expect((await t.core.integrations.reconcile()).resolved).toBe(0);
      await sweepAll(t, project.id, root);
    } finally {
      await t.cleanup();
    }
  });

  test("J24a: promoción fast-forward sin checkout (update-ref CAS)", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["w"], (key) => ({ name: "write", args: { path: `solo-${key}.txt`, content: `solo-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "UR");
      git(root, ["branch", "target-b"]);
      expect(git(root, ["worktree", "list", "--porcelain"]).includes("target-b")).toBe(false);
      const { runId, instanceId: coordId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-ur", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      // La integración se crea pronto con el destino explícito (el auto-build la reutiliza).
      const forced = await t.core.integrations.createForRun({ projectId: project.id, runId, targetBranch: "target-b" });
      expect(forced.targetBranch).toBe("target-b");
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: wId, reviewer: rId }]);
        await untilAutoBuilt(t, session.id, runId, 1);
        const integration = await t.core.integrations.getIntegration(forced.id);
        const head = integration.head!;
        const spawned = await t.core.agents.spawn({ parentInstanceId: coordId, definitionId: "reviewer", brief: "Review the integration worktree for defects. Report findings.", mode: "background", integrationId: integration.id });
        await t.core.agents.wait(spawned.instanceId, 60000);
        await t.core.validations.recordIntegrationReview(integration.id, { instanceId: spawned.instanceId, verdict: "accept", summary: "test" });
        await t.core.approvals.approveIntegration(integration.id, { waiverReason: "test: docs-only change" });
        const mainBefore = git(root, ["rev-parse", "main"]).trim();
        const promoted = await t.core.promotions.promoteIntegration(integration.id);
        expect(promoted.reused).toBe(false);
        // update-ref: target-b avanza al head sin checkout en ningún sitio.
        expect(git(root, ["rev-parse", "target-b"]).trim()).toBe(head);
        expect(git(root, ["worktree", "list", "--porcelain"]).includes("target-b")).toBe(false);
        // main no se tocó.
        expect(git(root, ["rev-parse", "main"]).trim()).toBe(mainBefore);
        expect((await t.core.integrations.getIntegration(integration.id)).status).toBe("promoted");
        expect((await t.core.db.queryOne<{ status: string }>("SELECT status FROM runs WHERE id = ?", [runId]))!.status).toBe("done");
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("J24b/c: destino checked-out limpio hace merge; sucio bloquea sin tocar nada (J25)", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["w"], (key) => ({ name: "write", args: { path: `solo-${key}.txt`, content: `solo-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "MC");
      const { runId, instanceId: coordId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-mc", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        const { integrationId, head } = await settleAndApprove(t, session.id, runId, coordId, [{ writer: wId, reviewer: rId }]);
        // (c) destino sucio: bloqueo explícito, cambios del usuario intactos.
        writeFileSync(path.join(root, "dirty.txt"), "user work\n");
        await expectRejects(t.core.promotions.promoteIntegration(integrationId), /pending changes/i);
        expect(existsSync(path.join(root, "dirty.txt"))).toBe(true);
        expect((await t.core.integrations.getIntegration(integrationId)).status).toBe("approved");
        expect(git(root, ["rev-parse", "main"]).trim()).not.toBe(head);
        // Limpio: merge --ff-only en el checkout existente (J24b + J25).
        await import("node:fs").then((fs) => fs.rmSync(path.join(root, "dirty.txt")));
        const promoted = await t.core.promotions.promoteIntegration(integrationId);
        expect(promoted.reused).toBe(false);
        expect(git(root, ["rev-parse", "main"]).trim()).toBe(head);
        expect(readFileSync(path.join(root, "solo-w.txt"), "utf8")).toBe("solo-w\n");
        expect((await t.core.db.queryOne<{ status: string }>("SELECT status FROM runs WHERE id = ?", [runId]))!.status).toBe("done");
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("J26: sin push automático (ni código ni remoto)", async () => {
    const { readFileSync: read } = await import("node:fs");
    const base = path.join(import.meta.dir, "..", "src", "integration");
    for (const f of ["integration-manager.ts", "conflict-manager.ts", "validation-service.ts", "preview-manager.ts", "approval-service.ts", "promotion-manager.ts"]) {
      const text = read(path.join(base, f), "utf8");
      expect(text).not.toMatch(/\bgit\s+push\b/);
      expect(text).not.toMatch(/["']push["']/);
    }
    const t = await makeTestCore();
    try {
      const { root } = await gitProject(t, "NP");
      expect(execFileSync("git", ["remote", "-v"], { cwd: root, encoding: "utf8", timeout: 30_000, windowsHide: true }).trim()).toBe("");
    } finally {
      await t.cleanup();
    }
  });
});

describe("etapa 5.7 — IPC/UI/ciclo de vida", () => {
  test("dependiente deriva de predecesor integrated (no solo reviewed)", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["a", "b"], (key) => ({ name: "write", args: { path: `solo-${key}.txt`, content: `solo-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "DI");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-di", [IMPL("a"), IMPL("b"), REVIEWER_OF("ra", "a"), REVIEWER_OF("rb", "b")]);
      const [aId, bId, raId, rbId] = dag.taskIds as [string, string, string, string];
      await t.core.db.exec("INSERT INTO task_dependencies (task_id, depends_on, kind) VALUES (?, ?, 'requires')", [bId, aId]);
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(aId)).status === "completed", 30000);
        await untilWorktreesFinished(t, [aId]);
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(raId)).status === "completed", 30000);
        await t.core.recordTaskReview(raId, aId, "accept", { note: "di-a" });
        // Incorporación temprana de A: B debe seguir desbloqueándose (integrated satisface).
        const early = await t.core.integrations.createForRun({ projectId: project.id, runId });
        await t.core.integrations.incorporateCommit(early.id, aId, 1);
        expect((await t.core.tasks.getTask(aId)).status).toBe("integrated");
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => ["assigned", "running", "completed"].includes((await t.core.tasks.getTask(bId)).status), 30000);
        await until(async () => (await t.core.tasks.getTask(bId)).status === "completed", 30000);
        await untilWorktreesFinished(t, [bId]);
        const wa = await t.core.worktrees.getByTask(aId);
        const wb = await t.core.worktrees.getByTask(bId);
        expect(wb!.baseCommit).toBe(wa!.producedCommit!);
        expect(existsSync(path.join(wb!.canonicalPath, "solo-a.txt"))).toBe(true);
        await t.core.scheduler.tick({ sessionId: session.id });
        await until(async () => (await t.core.tasks.getTask(rbId)).status === "completed", 30000);
        await t.core.recordTaskReview(rbId, bId, "accept", { note: "di-b" });
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("spawnIntegrationReview + record accept cierra el gate", async () => {
    const t = await makeTestCore({ metaTurns: writerTurns(["w"], (key) => ({ name: "write", args: { path: `solo-${key}.txt`, content: `solo-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "SR");
      const { runId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-sr", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: wId, reviewer: rId }]);
        await untilAutoBuilt(t, session.id, runId, 1);
        const integration = (await t.core.integrations.listByRun(runId))[0]!;
        const head = (await t.core.integrations.getIntegration(integration.id)).head!;
        expect((await t.core.validations.validationGate(integration.id, head)).ok).toBe(false);
        const { instanceId } = await t.core.spawnIntegrationReview(integration.id);
        expect(instanceId).toBeDefined();
        await t.core.agents.wait(instanceId!, 60000);
        await t.core.recordIntegrationReview(integration.id, { instanceId: instanceId!, verdict: "accept", summary: "test" });
        expect(await t.core.validations.validationGate(integration.id, head)).toEqual({ ok: true, reasons: [] });
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("promote con preview reachable deja el run en done", async () => {
    const exe = process.execPath;
    const t = await makeTestCore({ metaTurns: writerTurns(["w"], (key) => ({ name: "write", args: { path: `solo-${key}.txt`, content: `solo-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "PD");
      await t.core.previews.saveAllowlist(project.id, [
        { id: "serve", name: "serve", phase: "start", argv: [exe, "-e", `require("http").createServer((q,r)=>{r.end("ok")}).listen(Number(process.env.OCTUS_PREVIEW_PORT))`] },
      ]);
      const { runId, instanceId: coordId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-pd", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: wId, reviewer: rId }]);
        await untilAutoBuilt(t, session.id, runId, 1);
        const integration = (await t.core.integrations.listByRun(runId))[0]!;
        const spawned = await t.core.agents.spawn({ parentInstanceId: coordId, definitionId: "reviewer", brief: "Review the integration worktree.", mode: "background", integrationId: integration.id });
        await t.core.agents.wait(spawned.instanceId, 60000);
        await t.core.validations.recordIntegrationReview(integration.id, { instanceId: spawned.instanceId, verdict: "accept", summary: "test" });
        const pv = await t.core.previews.createPreview(integration.id);
        const started = await t.core.previews.startPreview(pv.id, { startEntryId: "serve" });
        expect(started.reachable).toBe(true);
        const { duplicate } = await t.core.approvals.approveIntegration(integration.id, { previewId: pv.id });
        expect(duplicate).toBe(false);
        const promoted = await t.core.promotions.promoteIntegration(integration.id);
        expect(promoted.reused).toBe(false);
        expect((await t.core.db.queryOne<{ status: string }>("SELECT status FROM runs WHERE id = ?", [runId]))!.status).toBe("done");
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("promote idempotente converge aunque el destino ya esté en el head", async () => {
    // Regresión live A3-meta-rundone5: el destino ya contenía el head aprobado
    // (commit previo en main) y promote devolvía reused sin cerrar nada —
    // el run quedaba en integrating para siempre. Ahora converge.
    const t = await makeTestCore({ metaTurns: writerTurns(["w"], (key) => ({ name: "write", args: { path: `solo-${key}.txt`, content: `solo-${key}\n` } })) as never });
    try {
      await useFakeModels(t.core);
      const { project, session, root } = await gitProject(t, "PC");
      const { runId, instanceId: coordId } = await makeRun(t, session.id);
      const dag = await approvedDag(t, session.id, project.id, runId, "h-pc", [IMPL("w"), REVIEWER_OF("r", "w")]);
      const [wId, rId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await settlePairs(t, session.id, [{ writer: wId, reviewer: rId }]);
        await untilAutoBuilt(t, session.id, runId, 1);
        const integration = (await t.core.integrations.listByRun(runId))[0]!;
        const head = (await t.core.integrations.getIntegration(integration.id)).head!;
        const spawned = await t.core.agents.spawn({ parentInstanceId: coordId, definitionId: "reviewer", brief: "Review the integration worktree.", mode: "background", integrationId: integration.id });
        await t.core.agents.wait(spawned.instanceId, 60000);
        await t.core.validations.recordIntegrationReview(integration.id, { instanceId: spawned.instanceId, verdict: "accept", summary: "test" });
        // Simula el caso live: el destino ya contiene el head ANTES de aprobar
        // (target observado == head, el gate pasa y promote toma la vía reused).
        execFileSync("git", ["update-ref", "refs/heads/main", head, git(root, ["rev-parse", "main"]).trim()], { cwd: root, timeout: 30_000, windowsHide: true });
        await t.core.approvals.approveIntegration(integration.id, { waiverReason: "test: converge path" });
        const promoted = await t.core.promotions.promoteIntegration(integration.id);
        expect(promoted.reused).toBe(true);
        expect((await t.core.integrations.getIntegration(integration.id)).status).toBe("promoted");
        expect((await t.core.db.queryOne<{ status: string }>("SELECT status FROM runs WHERE id = ?", [runId]))!.status).toBe("done");
        expect((await t.core.promotions.listByIntegration(integration.id)).filter((p) => p.status === "completed")).toHaveLength(1);
        // Segunda llamada: puro no-op idempotente, sin duplicar filas.
        const again = await t.core.promotions.promoteIntegration(integration.id);
        expect(again.reused).toBe(true);
        expect((await t.core.promotions.listByIntegration(integration.id))).toHaveLength(1);
        await sweepAll(t, project.id, root);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("settle: el reinicio conserva runs con integración abierta", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const { project, session } = await gitProject(t, "RS");
      const { runId } = await makeRun(t, session.id);
      const integration = await t.core.integrations.createForRun({ projectId: project.id, runId });
      expect(integration.status).toBe("building");
      await t.core.close();
      const { OctusCore } = await import("../src/sessions/octus-core.js");
      const { MemorySecretStore } = await import("../src/secrets/secret-store.js");
      const core2 = await OctusCore.create({ dataDir: path.join(t.dir, "data"), primarySecrets: new MemorySecretStore(), providers: [t.fakeMeta, t.fakeGo] });
      try {
        expect((await core2.db.queryOne<{ status: string }>("SELECT status FROM runs WHERE id = ?", [runId]))!.status).toBe("executing");
        expect((await core2.integrations.getIntegration(integration.id)).status).toBe("building");
      } finally {
        await core2.close().catch(() => undefined);
      }
    } finally {
      await t.cleanup().catch(() => undefined);
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
