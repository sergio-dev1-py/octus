/** Etapa 3 — Scheduler + TaskManager con proveedores falsos (H1–H8, límites, equidad, recuperación). */
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { isOctusError } from "../src/errors.js";
import { expectRejects, makeRun, makeTestCore, workspaceOf, type TestCore } from "./helpers.js";
import type { PlannedTaskInput } from "../src/tasks/task-manager.js";

async function useFakeModels(core: TestCore["core"]): Promise<void> {
  for (const id of ["explorer", "researcher", "implementer", "reviewer"]) {
    await core.setDefinitionModel(id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
  }
}

async function approvedRun(t: TestCore) {
  const project = await t.core.createProject("P", workspaceOf(t));
  const session = await t.core.createSession({ projectId: project.id });
  await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
  const { runId } = await makeRun(t, session.id);
  const structured = { objective: "Build auth", steps: [{ title: "OAuth backend" }], acceptanceCriteria: ["login works"] };
  const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "Build auth", structured, runId, createdBy: "t" });
  const rev = (await t.core.plans.listRevisions(plan.id))[0]!;
  await t.core.plans.presentRevision(rev.id, "msg_seed");
  await t.core.plans.requestApproval(plan.id, rev.id, session.id, runId);
  const pending = await t.core.pendingApprovals(session.id);
  await t.core.decideApproval(pending[0]!.id, "approved");
  return { project, session, plan, revision: rev, runId };
}

const EXPLORER_TASK = (tempId: string, extra: Partial<PlannedTaskInput> = {}): PlannedTaskInput => ({ ...baseExplorerTask(tempId), ...extra });

function baseExplorerTask(tempId: string) {
  return {
    tempId,
    title: `Explore area ${tempId} files`,
    description: `Locate and read every file involved in area ${tempId} of the repository under test.`,
    agentRole: "explorer" as const,
    priority: 1,
    dependencies: [] as string[],
    acceptanceCriteria: [`lists files under src/${tempId}/ with paths`],
    requiredTools: ["read", "glob"],
    writeScope: [] as string[],
    validationCommands: [] as string[],
    needsReview: false,
  };
}

const IMPL_TASK = (tempId: string, scope: string): PlannedTaskInput => ({
  tempId,
  title: `Implement area ${tempId} code`,
  description: `Write the implementation for area ${tempId} inside the assigned isolated directory.`,
  agentRole: "implementer" as const,
  priority: 1,
  dependencies: [] as string[],
  acceptanceCriteria: [`file ${scope}/${tempId}.txt exists with content version 1`],
  requiredTools: ["read", "write"],
  writeScope: [scope],
  validationCommands: [] as string[],
  needsReview: true,
});

async function until(fn: () => Promise<boolean> | boolean, ms = 15000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function activeTaskInstances(t: TestCore, sessionId: string): Promise<number> {
  const rows = await t.core.db.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM agent_instances WHERE session_id = ? AND status IN ('created','running','waiting_permission','waiting_input')",
    [sessionId],
  );
  return rows[0]?.n ?? 0;
}

const STEPS = {
  objective: "Build auth",
  steps: [{ title: "OAuth backend" }],
  acceptanceCriteria: ["login works"],
};

describe("scheduler (dag, fairness, limits, retries, recovery)", () => {
  test("H3+H4: dos lectoras en paralelo y dependiente que espera", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const s = await approvedRun(t);
      const dag = await t.core.tasks.createDag({
        runId: s.runId,
        planId: s.plan.id,
        revisionId: s.revision.id,
        requestHash: "h-parallel",
        tasks: [EXPLORER_TASK("a", { priority: 10 }), EXPLORER_TASK("b", { priority: 9 }), { ...EXPLORER_TASK("c"), dependencies: ["a", "b"] }],
      });
      expect(dag.created).toBe(true);
      await t.core.scheduler.tick({ sessionId: s.session.id });
      await until(async () => (await t.core.tasks.getTask(dag.taskIds[0]!)).status !== "ready");
      const a = await t.core.tasks.getTask(dag.taskIds[0]!);
      const b = await t.core.tasks.getTask(dag.taskIds[1]!);
      const c = await t.core.tasks.getTask(dag.taskIds[2]!);
      expect(["assigned", "running", "completed"]).toContain(a.status);
      expect(["assigned", "running", "completed"]).toContain(b.status);
      // Puerta determinista (Etapa 4: el scheduler despierta dependientes en el
      // mismo tick en que observa las compleciones): c solo puede haber avanzado
      // si a y b ya están completadas.
      if (c.status !== "draft") {
        expect(a.status).toBe("completed");
        expect(b.status).toBe("completed");
      }
      // Completa a y b (instancias reales en background).
      for (const id of [dag.taskIds[0]!, dag.taskIds[1]!]) {
        const attempts = await t.core.tasks.getAttempts(id);
        if (attempts[0]?.instanceId) await t.core.agents.wait(attempts[0].instanceId, 10000).catch(() => undefined);
      }
      await t.core.scheduler.tick({ sessionId: s.session.id });
      await until(async () => {
        const t3 = await t.core.tasks.getTask(dag.taskIds[2]!);
        return t3.status !== "draft" && t3.status !== "blocked";
      });
      const c2 = await t.core.tasks.getTask(dag.taskIds[2]!);
      expect(["assigned", "running", "completed"]).toContain(c2.status);
      const attempts = await t.core.tasks.getAttempts(dag.taskIds[2]!);
      if (attempts[0]?.instanceId) await t.core.agents.wait(attempts[0].instanceId, 10000).catch(() => undefined);
      await t.core.scheduler.tick({ sessionId: s.session.id });
      await until(async () => (await t.core.tasks.getTask(dag.taskIds[2]!)).status === "completed");
      const run = (await t.core.getRun(s.runId)).run;
      expect(run.status).toBe("done");
      // Sin duplicados: un intento por tarea.
      for (const id of dag.taskIds) {
        expect((await t.core.tasks.getAttempts(id)).length).toBe(1);
      }
    } finally {
      await t.cleanup();
    }
  });

  test("H5: conflicto de scopes solapados serializa escritores", async () => {
    const t = await makeTestCore({
      metaTurns: [
        { toolCalls: [{ name: "question", args: { questions: [{ question: "Q?", header: "Q", options: [{ label: "A" }] }] } }] },
        { text: "done-a" },
        { toolCalls: [{ name: "question", args: { questions: [{ question: "Q?", header: "Q", options: [{ label: "A" }] }] } }] },
        { text: "done-b" },
      ],
    });
    try {
      await useFakeModels(t.core);
      const s = await approvedRun(t);
      const work = path.join(workspaceOf(t), "work");
      mkdirSync(work, { recursive: true });
      const dir = await t.core.registerIsolatedDirectory(s.project.id, work, "directory");
      void dir;
      const impl = (tempId: string, scope: string) => ({
        tempId,
        title: `Implement area ${tempId} code`,
        description: `Write the implementation for area ${tempId} inside the assigned isolated directory.`,
        agentRole: "implementer" as const,
        priority: 1,
        dependencies: [] as string[],
        acceptanceCriteria: [`file work/${tempId}.txt exists with content version 1`],
        requiredTools: ["read", "write"],
        writeScope: [scope],
        validationCommands: [] as string[],
        needsReview: true,
      });
      const rev = (tempId: string, target: string) => ({
        tempId,
        title: `Review area ${tempId} implementation`,
        description: `Review the implementation of area ${tempId} against its acceptance criteria.`,
        agentRole: "reviewer" as const,
        priority: 0,
        dependencies: [] as string[],
        acceptanceCriteria: [`review report ${tempId} contains at least 1 finding with file and line`],
        requiredTools: ["read", "git_diff"],
        writeScope: [] as string[],
        validationCommands: [] as string[],
        needsReview: false,
        reviewTargetTempId: target,
      });
      const dag = await t.core.tasks.createDag({ runId: s.runId, planId: s.plan.id, revisionId: s.revision.id, requestHash: "h-conflict", tasks: [impl("w1", "work"), impl("w2", "work"), rev("r1", "w1"), rev("r2", "w2")] });
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await t.core.scheduler.tick({ sessionId: s.session.id });
        await until(async () => {
          const statuses = await Promise.all(dag.taskIds.map(async (id) => (await t.core.tasks.getTask(id)).status));
          return statuses.some((x) => x === "assigned" || x === "running") && statuses.some((x) => x === "blocked");
        });
        const w1 = await t.core.tasks.getTask(dag.taskIds[0]!);
        const w2 = await t.core.tasks.getTask(dag.taskIds[1]!);
        const blocked = w1.status === "blocked" ? w1 : w2;
        expect(blocked.blockedReason).toBe("no-capacity");
        // Al cancelar la activa, la bloqueada avanza.
        const active = w1.status === "blocked" ? w2 : w1;
        const attempts = await t.core.tasks.getAttempts(active.id);
        if (attempts[0]?.instanceId) await t.core.agents.cancel(attempts[0].instanceId);
        await t.core.scheduler.tick({ sessionId: s.session.id });
        await until(async () => (await t.core.tasks.getTask(blocked.id)).status !== "blocked");
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("H6+H8: fallo, backoff, reintento sin duplicar y límite de intentos", async () => {
    const t = await makeTestCore({ metaTurns: [{ text: "first try ok" }, { text: "retry ok" }] });
    try {
      await useFakeModels(t.core);
      const s = await approvedRun(t);
      await t.core.config.update({ scheduler: { maxAttemptsPerTask: 3, backoffBaseMs: 50 } });
      const dag = await t.core.tasks.createDag({ runId: s.runId, planId: s.plan.id, revisionId: s.revision.id, requestHash: "h-retry", tasks: [EXPLORER_TASK("a")] });
      const taskId = dag.taskIds[0]!;
      await t.core.scheduler.tick({ sessionId: s.session.id });
      await until(async () => (await t.core.tasks.getTask(taskId)).status !== "ready");
      // Falla el intento 1 de forma explícita.
      await t.core.tasks.completeAttempt(taskId, "failed", { errorCode: "probe", errorMessage: "boom" });
      expect((await t.core.tasks.getTask(taskId)).status).toBe("failed");
      // Reintento inmediato: backoff lo rechaza sin duplicar.
      const brisk = await expectRejects(t.core.tasks.retryTask(taskId), /backoff/i);
      expect(isOctusError(brisk, "invalid_state")).toBe(true);
      await t.core.db.exec("UPDATE task_attempts SET completed_at = 1 WHERE task_id = ?", [taskId]);
      const before = (await t.core.agentInstances(s.session.id)).length;
      const retried = await t.core.tasks.retryTask(taskId);
      expect(retried.attempt).toBe(2);
      expect((await t.core.tasks.getAttempts(taskId)).length).toBe(2);
      expect((await t.core.agentInstances(s.session.id)).length).toBe(before + 1);
      const attempts = await t.core.tasks.getAttempts(taskId);
      expect(attempts[1]!.instanceId).not.toBe(attempts[0]!.instanceId);
      await t.core.scheduler.tick({ sessionId: s.session.id });
      await until(async () => (await t.core.tasks.getTask(taskId)).status === "completed");
      // Segundo reintento sobre tarea completed: prohibido.
      await expectRejects(t.core.tasks.retryTask(taskId), /Only failed or interrupted/);
    } finally {
      await t.cleanup();
    }
  });

  test("cancelación en cascada preserva completed/reviewed e independientes", async () => {
    const t = await makeTestCore();
    try {
      const s = await approvedRun(t);
      const dag = await t.core.tasks.createDag({
        runId: s.runId,
        planId: s.plan.id,
        revisionId: s.revision.id,
        requestHash: "h-cancel",
        tasks: [
          EXPLORER_TASK("root"),
          { ...EXPLORER_TASK("done"), dependencies: ["root"] },
          { ...EXPLORER_TASK("child"), dependencies: ["root"] },
          EXPLORER_TASK("indep"),
        ],
      });
      const [root, done, child, indep] = dag.taskIds as [string, string, string, string];
      await t.core.db.exec("UPDATE tasks SET status = 'completed', updated_at = 1 WHERE id = ?", [done]);
      await t.core.db.exec("UPDATE tasks SET status = 'ready', updated_at = 1 WHERE id = ?", [root]);
      const { cancelled } = await t.core.tasks.cancelTask(root);
      expect(cancelled).toContain(root);
      expect(cancelled).toContain(child);
      expect(cancelled).not.toContain(done);
      expect(cancelled).not.toContain(indep);
      expect((await t.core.tasks.getTask(done)).status).toBe("completed");
      expect((await t.core.tasks.getTask(child)).status).toBe("cancelled");
      expect((await t.core.tasks.getTask(indep)).status).toBe("draft");
    } finally {
      await t.cleanup();
    }
  });

  test("reviewer: needsReview gate, veredicto accept y request-changes", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const s = await approvedRun(t);
      const work = path.join(workspaceOf(t), "work-review");
      mkdirSync(work, { recursive: true });
      await t.core.registerIsolatedDirectory(s.project.id, work, "directory");
      const impl = {
        tempId: "impl",
        title: "Implement login handler code",
        description: "Write the login handler inside the assigned scope with full error handling.",
        agentRole: "implementer" as const,
        priority: 5,
        dependencies: [] as string[],
        acceptanceCriteria: ["handler file exists under work-review/ with tests"],
        requiredTools: ["read", "write"],
        writeScope: ["work-review"],
        validationCommands: [] as string[],
        needsReview: true,
      };
      const revw = {
        tempId: "rev",
        title: "Review login handler implementation",
        description: "Review the implementation against the acceptance criteria and report findings.",
        agentRole: "reviewer" as const,
        priority: 1,
        dependencies: [] as string[],
        acceptanceCriteria: ["review report contains at least 2 findings with file and line"],
        requiredTools: ["read", "git_diff"],
        writeScope: [] as string[],
        validationCommands: [] as string[],
        needsReview: false,
        reviewTargetTempId: "impl",
      };
      const dag = await t.core.tasks.createDag({ runId: s.runId, planId: s.plan.id, revisionId: s.revision.id, requestHash: "h-review", tasks: [impl, revw] });
      const [implId, revId] = dag.taskIds as [string, string];
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        await t.core.scheduler.tick({ sessionId: s.session.id });
        // Reviewer queda draft hasta que el target complete.
        await until(async () => (await t.core.tasks.getTask(implId)).status !== "ready");
        expect((await t.core.tasks.getTask(revId)).status).toBe("draft");
        const implAttempts = await t.core.tasks.getAttempts(implId);
        if (implAttempts[0]?.instanceId) await t.core.agents.wait(implAttempts[0].instanceId, 10000).catch(() => undefined);
        await t.core.scheduler.tick({ sessionId: s.session.id });
        await until(async () => (await t.core.tasks.getTask(implId)).status === "completed");
        await t.core.scheduler.tick({ sessionId: s.session.id });
        await until(async () => (await t.core.tasks.getTask(revId)).status !== "draft");
        const revAttempts = await t.core.tasks.getAttempts(revId);
        if (revAttempts[0]?.instanceId) await t.core.agents.wait(revAttempts[0].instanceId, 10000).catch(() => undefined);
        await t.core.scheduler.tick({ sessionId: s.session.id });
        await until(async () => (await t.core.tasks.getTask(revId)).status === "completed");
        // Veredicto arbitrario sin vínculo: imposible (target erróneo).
        await expectRejects(t.core.tasks.recordReview(revId, implId === revId ? implId : "tsk_missing", "accept"), /not found|link/i);
        await t.core.tasks.recordReview(revId, implId, "accept", { summary: "looks good" });
        expect((await t.core.tasks.getTask(implId)).status).toBe("reviewed");
        // Veredicto duplicado: rechazado (el target ya no está completed tras el accept).
        await expectRejects(t.core.tasks.recordReview(revId, implId, "accept"), /completed|already exists/i);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("request-changes deja failed elegible para retry", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const s = await approvedRun(t);
      const impl = {
        tempId: "impl",
        title: "Implement login handler code",
        description: "Write the login handler inside the assigned scope with full error handling.",
        agentRole: "implementer" as const,
        priority: 1,
        dependencies: [] as string[],
        acceptanceCriteria: ["handler file exists under work/ with tests"],
        requiredTools: ["read"],
        writeScope: [] as string[],
        validationCommands: [] as string[],
        needsReview: true,
      };
      const revw = {
        tempId: "rev",
        title: "Review login handler implementation",
        description: "Review the implementation against the acceptance criteria and report findings.",
        agentRole: "reviewer" as const,
        priority: 1,
        dependencies: [] as string[],
        acceptanceCriteria: ["review report contains at least 2 findings with file and line"],
        requiredTools: ["read"],
        writeScope: [] as string[],
        validationCommands: [] as string[],
        needsReview: false,
        reviewTargetTempId: "impl",
      };
      const dag = await t.core.tasks.createDag({ runId: s.runId, planId: s.plan.id, revisionId: s.revision.id, requestHash: "h-changes", tasks: [impl, revw] });
      const [implId, revId] = dag.taskIds as [string, string];
      await t.core.db.exec("UPDATE tasks SET status = 'completed' WHERE id = ?", [implId]);
      await t.core.db.exec("UPDATE tasks SET status = 'completed' WHERE id = ? AND agent_role = 'reviewer'", [revId]);
      await t.core.tasks.recordReview(revId, implId, "request-changes", { reason: "missing tests" });
      expect((await t.core.tasks.getTask(implId)).status).toBe("failed");
      expect((await t.core.tasks.getTask(implId)).error).toContain("changes-requested");
      await t.core.config.update({ scheduler: { maxAttemptsPerTask: 3, backoffBaseMs: 0 } });
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      try {
        const retried = await t.core.tasks.retryTask(implId);
        expect(retried.attempt).toBe(1);
        // Espera a que la instancia alcance estado terminal antes de limpiar (evita EBUSY en Windows).
        await t.core.agents.cancel(retried.instanceId).catch(() => undefined);
        await t.core.agents.wait(retried.instanceId, 10000).catch(() => undefined);
      } finally {
        stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("límites: sesión/proyecto/rol bloquean con no-capacity; equidad round-robin", async () => {
    const t = await makeTestCore();
    try {
      await useFakeModels(t.core);
      const s = await approvedRun(t);
      const dag = await t.core.tasks.createDag({
        runId: s.runId,
        planId: s.plan.id,
        revisionId: s.revision.id,
        requestHash: "h-limits",
        tasks: [EXPLORER_TASK("a"), EXPLORER_TASK("b")],
      });
      t.core.setAgentLimits({ maxPerSession: 1 });
      await t.core.scheduler.tick({ sessionId: s.session.id });
      const statuses = await Promise.all(dag.taskIds.map(async (id) => (await t.core.tasks.getTask(id)).status));
      // Coordinador (makeRun: running) + límite 1 → todo bloqueado por capacidad.
      expect(statuses.every((x) => x === "blocked")).toBe(true);
      expect((await t.core.tasks.getTask(dag.taskIds[0]!)).blockedReason).toBe("no-capacity");
      t.core.setAgentLimits({ maxPerSession: 4, maxPerProject: 6, maxDepth: 2, maxImplementers: 2, maxReaders: 1, maxReviewers: 1 });
      await t.core.scheduler.tick({ sessionId: s.session.id });
      // Con maxReaders=1 los dos exploradores se serializan: el segundo no
      // empieza hasta que el primero termina (cualquiera de los dos puede ir
      // primero; el invariante es la no-superposición, no el orden).
      // (Etapa 4: el tick despierta dependientes en cuanto observa la compleción.)
      await until(
        async () => (await t.core.tasks.getTask(dag.taskIds[0]!)).status === "completed" && (await t.core.tasks.getTask(dag.taskIds[1]!)).status === "completed",
        30000,
      );
      const attA = (await t.core.tasks.getAttempts(dag.taskIds[0]!))[0]!;
      const attB = (await t.core.tasks.getAttempts(dag.taskIds[1]!))[0]!;
      expect(attA.completedAt).toBeDefined();
      expect(attB.completedAt).toBeDefined();
      // Intervalos disjuntos: uno terminó antes de que el otro empezara.
      const disjoint = attB.startedAt! >= attA.completedAt! || attA.startedAt! >= attB.completedAt!;
      expect(disjoint).toBe(true);
      // Sin duplicados: un intento por tarea.
      for (const id of dag.taskIds) {
        expect((await t.core.tasks.getAttempts(id)).length).toBe(1);
      }
    } finally {
      await t.cleanup();
    }
  });

  test("fairness: rotación entre runs y cursor persistido", async () => {
    const questionTurn = {
      toolCalls: [{ name: "question", args: { questions: [{ question: "Q?", header: "Q", options: [{ label: "A" }] }] } }],
    };
    const t = await makeTestCore({
      metaTurns: ((callIndex: number, input: { messages?: Array<{ blocks?: unknown[] }> }) => {
        // Primera llamada (solo brief): bloquea con pregunta; continuaciones: terminan.
        const blocks = (input?.messages ?? []).flatMap((m) => m.blocks ?? []);
        return blocks.length <= 1 ? questionTurn : { text: `done-${callIndex}` };
      }) as never,
    });
    try {
      await useFakeModels(t.core);
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const work = path.join(workspaceOf(t), "work");
      mkdirSync(work, { recursive: true });
      for (const sub of ["f1", "f2", "f3"]) mkdirSync(path.join(work, sub), { recursive: true });
      await t.core.registerIsolatedDirectory(project.id, work, "directory");
      const mkDag = async (suffix: string) => {
        const { runId } = await makeRun(t, session.id);
        const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: `O${suffix}`, structured: STEPS, runId, createdBy: "t" });
        const rev = (await t.core.plans.listRevisions(plan.id))[0]!;
        await t.core.plans.presentRevision(rev.id, `msg_${suffix}`);
        await t.core.plans.requestApproval(plan.id, rev.id, session.id, runId);
        const pending = await t.core.pendingApprovals(session.id);
        await t.core.decideApproval(pending[pending.length - 1]!.id, "approved");
        const dag = await t.core.tasks.createDag({ runId, planId: plan.id, revisionId: rev.id, requestHash: `h-fair-${suffix}`, tasks: [IMPL_TASK(`t${suffix}`, `work/f${suffix}`)] });
        return { runId, taskId: dag.taskIds[0]! };
      };
      const r1 = await mkDag("1");
      const r2 = await mkDag("2");
      const r3 = await mkDag("3");
      t.core.setAgentLimits({ maxPerSession: 10, maxPerProject: 10, maxDepth: 2, maxImplementers: 1, maxReaders: 2, maxReviewers: 1 });
      // Con implementers bloqueados en pregunta, solo cabe uno activo: rotación r1→r2→r3.
      const stop = (await import("./helpers.js")).autoAllow(t.core, "once");
      const drain = async (taskId: string): Promise<void> => {
        const deadline = Date.now() + 12000;
        for (;;) {
          const inst = (await t.core.tasks.getAttempts(taskId))[0]?.instanceId;
          for (const q of t.core.questions.pendingFor(session.id)) {
            if (!inst || q.instanceId === inst) {
              await t.core.questions.reply(q.id, [{ question: q.questions[0]!.question, answers: [q.questions[0]!.options[0]!.label] }], "cor_fair");
            }
          }
          const st = (await t.core.tasks.getTask(taskId)).status;
          if (st === "completed" || st === "failed" || st === "cancelled") return;
          if (Date.now() > deadline) throw new Error(`drain timed out for ${taskId} (status ${st})`);
          await new Promise((r) => setTimeout(r, 200));
        }
      };
      const first = await t.core.scheduler.tick({ sessionId: session.id });
      expect(first).toHaveLength(1);
      expect(first[0]!.runId).toBe(r1.runId);
      expect(await t.core.tasks.fairnessCursor(session.id)).toBe(r1.runId);
      await drain(r1.taskId);
      await t.core.scheduler.tick({ sessionId: session.id });
      await until(async () => ["assigned", "running", "completed"].includes((await t.core.tasks.getTask(r2.taskId)).status));
      expect(await t.core.tasks.fairnessCursor(session.id)).toBe(r2.runId);
      await drain(r2.taskId);
      await t.core.scheduler.tick({ sessionId: session.id });
      await until(async () => ["assigned", "running", "completed"].includes((await t.core.tasks.getTask(r3.taskId)).status));
      expect(await t.core.tasks.fairnessCursor(session.id)).toBe(r3.runId);
      await drain(r3.taskId);
      await t.core.scheduler.tick({ sessionId: session.id });
      await until(async () => (await t.core.tasks.getTask(r3.taskId)).status === "completed");
      stop();
    } finally {
      await t.cleanup().catch(() => undefined);
    }
  });

  test("triggers persistentes: cross-run, re-anclaje, kind inválido, review_target", async () => {
    const t = await makeTestCore();
    try {
      const s = await approvedRun(t);
      const dag = await t.core.tasks.createDag({ runId: s.runId, planId: s.plan.id, revisionId: s.revision.id, requestHash: "h-trig", tasks: [EXPLORER_TASK("a"), EXPLORER_TASK("b")] });
      const [a, b] = dag.taskIds as [string, string];
      // kind inválido en INSERT y UPDATE.
      await expectRejects(t.core.db.exec("INSERT INTO task_dependencies (task_id, depends_on, kind) VALUES (?, ?, 'optional')", [b, a]), /requires/);
      await t.core.db.exec("INSERT INTO task_dependencies (task_id, depends_on, kind) VALUES (?, ?, 'requires')", [b, a]);
      await expectRejects(t.core.db.exec("UPDATE task_dependencies SET kind = 'optional' WHERE task_id = ? AND depends_on = ?", [b, a]), /requires/);
      // Dependencia cross-run rechazada (segunda run con su propio planning).
      const { runId: run2 } = await makeRun(t, s.session.id);
      const dag2 = await t.core.tasks.createDag({ runId: run2, planId: s.plan.id, revisionId: s.revision.id, requestHash: "h-trig-2", tasks: [EXPLORER_TASK("o")] });
      const o = dag2.taskIds[0]!;
      await expectRejects(t.core.db.exec("INSERT INTO task_dependencies (task_id, depends_on, kind) VALUES (?, ?, 'requires')", [o, a]), /same run/);
      // Re-anclaje de tasks y plannings prohibido.
      await expectRejects(t.core.db.exec("UPDATE tasks SET run_id = ? WHERE id = ?", [run2, a]), /immutable/);
      await expectRejects(t.core.db.exec("UPDATE tasks SET planning_id = 'pln_other' WHERE id = ?", [a]), /immutable/);
      const pln = await t.core.db.queryOne<{ id: string }>("SELECT id FROM plannings LIMIT 1");
      await expectRejects(t.core.db.exec("UPDATE plannings SET request_hash = 'x' WHERE id = ?", [pln!.id]), /immutable/);
      // review_target solo en reviewer e inmutable.
      await expectRejects(t.core.db.exec("UPDATE tasks SET review_target_task_id = ? WHERE id = ?", [b, a]), /immutable|review/);
      const plnOfA = await t.core.db.queryOne<{ planning_id: string }>("SELECT planning_id FROM tasks WHERE id = ?", [a]);
      await expectRejects(t.core.db.exec("INSERT INTO tasks (id, run_id, planning_id, plan_id, revision_id, title, description, agent_role, priority, acceptance_criteria, required_tools, write_scope, validation_commands, review_target_task_id, needs_review, status, attempt, created_at, updated_at) VALUES ('tsk_bad', ?, ?, ?, ?, 't', 'Review the thing thoroughly now', 'explorer', 1, '[]', '[]', '[]', '[]', ?, 0, 'draft', 0, 1, 1)", [s.runId, plnOfA!.planning_id, s.plan.id, s.revision.id, b]), /only for reviewer/);
      // reviewed directo sin veredicto: prohibido (INSERT y UPDATE).
      await expectRejects(t.core.db.exec("UPDATE tasks SET status = 'reviewed' WHERE id = ?", [a]), /verdict|reviewed_by/);
      await expectRejects(
        t.core.db.exec("INSERT INTO tasks (id, run_id, planning_id, plan_id, revision_id, title, description, agent_role, priority, acceptance_criteria, required_tools, write_scope, validation_commands, review_target_task_id, needs_review, status, attempt, created_at, updated_at, reviewed_by_task_id) VALUES ('tsk_bad2', ?, ?, ?, ?, 't', 'Review the thing thoroughly now', 'explorer', 1, '[]', '[]', '[]', '[]', NULL, 0, 'reviewed', 0, 1, 1, 'tsk_x')", [s.runId, plnOfA!.planning_id, s.plan.id, s.revision.id]),
        /verdict|reviewed_by|format/i,
      );
      // Índice único de intento activo.
      await t.core.db.exec("INSERT INTO task_attempts (task_id, attempt, status, created_at) VALUES (?, 1, 'pending', 1)", [a]);
      await expectRejects(t.core.db.exec("INSERT INTO task_attempts (task_id, attempt, status, created_at) VALUES (?, 2, 'running', 1)", [a]), /UNIQUE|unique/i);
    } finally {
      await t.cleanup();
    }
  });

  test("reconcile post-reinicio interrumpe lo activo y libera reservas huérfanas", async () => {
    const t = await makeTestCore({
      metaTurns: [
        { toolCalls: [{ name: "question", args: { questions: [{ question: "Q?", header: "Q", options: [{ label: "A" }] }] } }] },
        { text: "recovered and done" },
      ],
    });
    try {
      await useFakeModels(t.core);
      const s = await approvedRun(t);
      const dag = await t.core.tasks.createDag({ runId: s.runId, planId: s.plan.id, revisionId: s.revision.id, requestHash: "h-reconcile", tasks: [EXPLORER_TASK("a")] });
      const taskId = dag.taskIds[0]!;
      await t.core.tasks.setStatus(taskId, "ready");
      // Simula caída con trabajo a medias: todo en 'running' + reserva huérfana.
      const insId = `ins_crash_${Math.random().toString(36).slice(2, 8)}`;
      await t.core.db.exec(
        "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, task_id, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES (?, ?, ?, 'explorer', 'running', ?, ?, ?, 1, '', '{}', 1, 1)",
        [insId, s.session.id, s.runId, JSON.stringify({ providerId: "fake-meta", modelId: "muse-wonder-1.0" }), workspaceOf(t), taskId],
      );
      await t.core.db.exec("INSERT INTO task_attempts (task_id, attempt, instance_id, status, started_at, created_at) VALUES (?, 1, ?, 'running', 1, 1)", [taskId, insId]);
      await t.core.db.exec("UPDATE tasks SET status = 'running', updated_at = 1 WHERE id = ?", [taskId]);
      await t.core.db.exec("INSERT INTO scheduler_reservations (id, kind, resource_key, session_id, project_id, task_id, attempt, acquired_at) VALUES ('rsv_orphan', 'slot-role', 'explorer', ?, ?, ?, 1, 1)", [s.session.id, s.project.id, taskId]);
      const out = await t.core.tasks.reconcile();
      expect(out.interrupted).toBeGreaterThan(0);
      expect((await t.core.tasks.getTask(taskId)).status).toBe("interrupted");
      expect((await t.core.db.queryOne<{ status: string }>("SELECT status FROM task_attempts WHERE task_id = ? AND attempt = 1", [taskId]))?.status).toBe("interrupted");
      expect(await t.core.db.query("SELECT * FROM scheduler_reservations WHERE id = 'rsv_orphan'")).toHaveLength(0);
      // Recuperar la misma instancia continúa sin duplicar (settle marca la instancia interrupted).
      await t.core.db.exec("UPDATE agent_instances SET status = 'interrupted' WHERE id = ?", [insId]);
      const resumed = await t.core.tasks.recoverInstance(insId);
      expect(resumed).toEqual({ taskId, attempt: 1 });
      expect((await t.core.tasks.getTask(taskId)).status).toBe("running");
      expect((await t.core.db.queryOne<{ status: string }>("SELECT status FROM agent_instances WHERE id = ?", [insId]))?.status).toBe("running");
      expect((await t.core.tasks.getAttempts(taskId)).length).toBe(1);
      // Con intento pendiente manual (aunque la task figure como failed) no hay duplicados.
      // Primero se completa el intento reanudado respondiendo su pregunta.
      for (const q of t.core.questions.pendingFor(s.session.id)) {
        await t.core.questions.reply(q.id, [{ question: q.questions[0]!.question, answers: [q.questions[0]!.options[0]!.label] }], "cor_reconcile");
      }
      const resumed2 = await t.core.agents.wait(insId, 10000).catch(() => undefined);
      expect(resumed2?.status).toBe("completed");
      await until(async () => (await t.core.tasks.getTask(taskId)).status === "completed");
      await t.core.db.exec("UPDATE tasks SET status = 'failed', updated_at = 1 WHERE id = ?", [taskId]);
      await t.core.db.exec("UPDATE task_attempts SET completed_at = 1 WHERE task_id = ?", [taskId]);
      await t.core.db.exec("INSERT INTO task_attempts (task_id, attempt, status, created_at) VALUES (?, 99, 'pending', 1)", [taskId]);
      await expectRejects(t.core.tasks.retryTask(taskId), /active attempt/);
      await t.core.db.exec("DELETE FROM task_attempts WHERE task_id = ? AND attempt = 99", [taskId]);
      await t.core.agents.cancel(insId);
    } finally {
      await t.cleanup();
    }
  });

  test("H7: steering, asNewRequest y ambigüedad con varios runs", async () => {
    const t = await makeTestCore({
      metaTurns: [
        { toolCalls: [{ name: "question", args: { questions: [{ question: "Q?", header: "Q", options: [{ label: "A" }] }] } }] },
        { text: "answer one" },
        { text: "answer two" },
      ],
    });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const first = await t.core.prompt(session.id, "first request");
      await Bun.sleep(500);
      // Steering al run activo.
      const steered = await t.core.prompt(session.id, "follow-up");
      expect(steered.runId).toBe(first.runId);
      // Segunda solicitud explícita crea otro run (encolado tras el primero).
      const second = await t.core.prompt(session.id, "second request", undefined, { asNewRequest: true });
      expect(second.runId).not.toBe(first.runId);
      // Con dos runs activos, steering ambiguo exige runId.
      await expectRejects(t.core.prompt(session.id, "ambiguous"), /Ambiguous/);
      const explicit = await t.core.prompt(session.id, "to second", undefined, { runId: second.runId });
      expect(explicit.runId).toBe(second.runId);
      // Responde la pregunta del primero y deja que ambos terminen.
      for (const q of t.core.questions.pendingFor(session.id)) {
        await t.core.questions.reply(q.id, [{ question: "Q?", answers: ["A"] }], "cor_h7");
      }
      await t.core.waitForIdle(session.id);
      const { runs } = await t.core.getSession(session.id);
      expect(runs.filter((r) => r.id === first.runId)[0]!.status).toBe("done");
      expect(runs.filter((r) => r.id === second.runId)[0]!.status).toBe("done");
      const messages = await t.core.sessionMessages(session.id);
      expect(messages.map((m) => `${m.role}@${m.runId === first.runId ? "r1" : "r2"}`).join(",")).toContain("r1");
    } finally {
      await t.cleanup();
    }
  });
});
