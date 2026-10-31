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

/** Limpieza best-effort de worktrees de tasks + worktrees de integración. */
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
        const integration = await t.core.integrations.createForRun({ projectId: project.id, runId });
        const results = await t.core.integrations.incorporateRun(integration.id);
        expect(results).toHaveLength(2);
        expect(results.map((r) => r.strategy).sort()).toEqual(["fast-forward", "merge"]);
        const after = await t.core.integrations.getIntegration(integration.id);
        expect(after.head).toMatch(/^[0-9a-f]{40}$/);
        expect(readFileSync(path.join(after.canonicalPath, "file-a.txt"), "utf8")).toContain("content-a");
        expect(readFileSync(path.join(after.canonicalPath, "file-b.txt"), "utf8")).toContain("content-b");
        expect((await t.core.integrations.getCommits(integration.id)).map((c) => c.kind).sort()).toEqual(["original", "resolution"]);
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
        const integration = await t.core.integrations.createForRun({ projectId: project.id, runId });
        const results = await t.core.integrations.incorporateRun(integration.id);
        expect(results).toHaveLength(2);
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
        const integration = await t.core.integrations.createForRun({ projectId: project.id, runId });
        const results = await t.core.integrations.incorporateRun(integration.id);
        expect(results.map((r) => r.strategy)).toEqual(["fast-forward", "fast-forward"]);
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
        const integration = await t.core.integrations.createForRun({ projectId: project.id, runId });
        const first = await t.core.integrations.incorporateCommit(integration.id, wId, 1);
        expect(first.reused).toBe(false);
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
        const integration = await t.core.integrations.createForRun({ projectId: project.id, runId });
        const first = await t.core.integrations.incorporateCommit(integration.id, aId, 1);
        expect(first.strategy).toBe("fast-forward");
        await expectRejects(t.core.integrations.incorporateCommit(integration.id, bId, 1), /conflict/i);
        const conflicted = await t.core.integrations.getIntegration(integration.id);
        expect(conflicted.status).toBe("conflicted");
        const conflicts = await t.core.db.query<{ files: string; status: string }>("SELECT files, status FROM integration_conflicts WHERE scope_ref = ?", [integration.id]);
        expect(conflicts).toHaveLength(1);
        expect(JSON.parse(conflicts[0]!.files)).toEqual(["conflict.txt"]);
        expect(conflicts[0]!.status).toBe("open");
        // La rama de integración nunca queda con MERGE_HEAD.
        const porcelain = git(conflicted.canonicalPath, ["status", "--porcelain=v1"]);
        expect(porcelain.split("\n").some((l) => l.startsWith("UU"))).toBe(false);
        await expectRejects(
          Promise.resolve().then(() => git(conflicted.canonicalPath, ["rev-parse", "--verify", "MERGE_HEAD"])),
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
