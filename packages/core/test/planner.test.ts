/** Etapa 3 — TaskManager/Scheduler/Planner con proveedores falsos. */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isOctusError } from "../src/errors.js";
import { canonicalizeScope } from "../src/tasks/task-scheduler.js";
import { expectRejects, makeRun, makeTestCore, workspaceOf } from "./helpers.js";

const STRUCTURED = {
  objective: "Build auth",
  steps: [{ title: "OAuth backend" }],
  acceptanceCriteria: ["login works"],
};

async function useFakeModels(t: { core: { setDefinitionModel(id: string, m: { providerId: string; modelId: string }): Promise<void> } }): Promise<void> {
  for (const id of ["explorer", "researcher", "implementer", "reviewer"]) {
    await t.core.setDefinitionModel(id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
  }
}

async function approvedSetup(t: Awaited<ReturnType<typeof makeTestCore>>, runId?: string) {
  const project = await t.core.createProject("P", workspaceOf(t));
  const session = await t.core.createSession({ projectId: project.id });
  await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
  const r = runId ?? `run_seed_${Math.random().toString(36).slice(2, 8)}`;
  await t.core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES (?, ?, 'seed', 'executing', 'build', 1, 1)", [r, session.id]);
  const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "Build auth", structured: STRUCTURED, runId: r, createdBy: "test" });
  const rev = (await t.core.plans.listRevisions(plan.id))[0]!;
  await t.core.plans.presentRevision(rev.id, "msg_seed");
  await t.core.plans.requestApproval(plan.id, rev.id, session.id, r);
  const pending = await t.core.pendingApprovals(session.id);
  await t.core.decideApproval(pending[0]!.id, "approved");
  return { project, session, plan, revision: (await t.core.plans.listRevisions(plan.id))[0]!, runId: r };
}

import type { PlannedTaskInput } from "../src/tasks/task-manager.js";

const GOOD_TASKS: PlannedTaskInput[] = [
  {
    tempId: "a",
    title: "Explore auth module files",
    description: "List and read the files involved in the current authentication flow in the repository.",
    agentRole: "explorer" as const,
    priority: 10,
    dependencies: [],
    acceptanceCriteria: ["reports README.md and the files found with paths"],
    requiredTools: ["read", "glob"],
    writeScope: [],
    validationCommands: [],
    needsReview: false,
  },
];

describe("task planning (validation + idempotency + anchoring)", () => {
  test("rechaza propuestas vagas en español con motivos accionables", async () => {
    const t = await makeTestCore();
    try {
      const s = await approvedSetup(t);
      const err = await expectRejects(
        t.core.tasks.createDag({
          runId: s.runId,
          planId: s.plan.id,
          revisionId: s.revision.id,
          requestHash: "h-vague",
          tasks: [{ ...GOOD_TASKS[0]!, tempId: "v", title: "hacer el backend", description: "hacer cosas", acceptanceCriteria: ["que funcione"], agentRole: "explorer", priority: 1, dependencies: [], requiredTools: ["read"], writeScope: [], validationCommands: [], needsReview: false }],
        }),
        /vague|verificable/,
      );
      expect(isOctusError(err, "invalid_tool_args")).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  test("rechaza tools/scopes/comandos fuera de lo permitido", async () => {
    const t = await makeTestCore();
    try {
      const s = await approvedSetup(t);
      const base = { ...GOOD_TASKS[0]!, tempId: "x", agentRole: "implementer" as const, needsReview: true };
      const errTools = await expectRejects(
        t.core.tasks.createDag({ runId: s.runId, planId: s.plan.id, revisionId: s.revision.id, requestHash: "h-tools", tasks: [{ ...base, tempId: "t1", requiredTools: ["nuke"], writeScope: ["sub"], validationCommands: [] }] }),
        /not authorized/,
      );
      expect(isOctusError(errTools, "invalid_tool_args")).toBe(true);
      const errScope = await expectRejects(
        t.core.tasks.createDag({ runId: s.runId, planId: s.plan.id, revisionId: s.revision.id, requestHash: "h-scope", tasks: [{ ...base, tempId: "t2", requiredTools: ["read"], writeScope: ["/etc"], validationCommands: [] }] }),
        /outside assigned/,
      );
      expect(isOctusError(errScope, "invalid_tool_args")).toBe(true);
      const errCmd = await expectRejects(
        t.core.tasks.createDag({ runId: s.runId, planId: s.plan.id, revisionId: s.revision.id, requestHash: "h-cmd", tasks: [{ ...base, tempId: "t3", requiredTools: ["read"], writeScope: [], validationCommands: ["rm -rf /"] }] }),
        /allowlist/,
      );
      expect(isOctusError(errCmd, "invalid_tool_args")).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  test("ciclos, auto-dependencias y tempIds duplicados se rechazan", async () => {
    const t = await makeTestCore();
    try {
      const s = await approvedSetup(t);
      const mk = (hash: string, tasks: PlannedTaskInput[]) => t.core.tasks.createDag({ runId: s.runId, planId: s.plan.id, revisionId: s.revision.id, requestHash: hash, tasks });
      const cycA = { ...GOOD_TASKS[0]!, tempId: "a", dependencies: ["b"] };
      const cycB = { ...GOOD_TASKS[0]!, tempId: "b", title: "Explore second area files", description: "Second exploration with enough description length for validation.", dependencies: ["a"], agentRole: "researcher" as const };
      await expectRejects(mk("h-cyc", [cycA, cycB]), /cycle/);
      await expectRejects(mk("h-self", [{ ...GOOD_TASKS[0]!, dependencies: ["a"] }]), /self-dependency/);
      await expectRejects(mk("h-dup", [GOOD_TASKS[0]!, GOOD_TASKS[0]!]), /duplicate temp_id/);
      await expectRejects(mk("h-miss", [{ ...GOOD_TASKS[0]!, dependencies: ["ghost"] }]), /unknown dependency/);
    } finally {
      await t.cleanup();
    }
  });

  test("reviewer que depende de target con needsReview se rechaza (deadlock)", async () => {
    const t = await makeTestCore();
    try {
      const s = await approvedSetup(t);
      const impl: PlannedTaskInput = {
        tempId: "impl",
        title: "Implement login handler with tests",
        description: "Write the login handler inside the assigned scope with full error handling and tests.",
        agentRole: "implementer",
        priority: 5,
        dependencies: [],
        acceptanceCriteria: ["handler file exists under work/ with passing tests"],
        requiredTools: ["read", "write"],
        writeScope: [],
        validationCommands: [],
        needsReview: true,
      };
      const rev: PlannedTaskInput = {
        tempId: "rev",
        title: "Review login handler implementation",
        description: "Review the implementation against the acceptance criteria with file and line evidence.",
        agentRole: "reviewer",
        priority: 1,
        dependencies: ["impl"],
        acceptanceCriteria: ["review report: handler file quoted with findings per file:line"],
        requiredTools: ["read", "git_diff"],
        writeScope: [],
        validationCommands: [],
        needsReview: false,
        reviewTargetTempId: "impl",
      };
      const err = await expectRejects(
        t.core.tasks.createDag({ runId: s.runId, planId: s.plan.id, revisionId: s.revision.id, requestHash: "h-deadlock", tasks: [impl, rev] }),
        /deadlock/,
      );
      expect(isOctusError(err, "invalid_tool_args")).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  test("idempotencia: misma clave recupera el DAG sin duplicar; rechazo exige nonce", async () => {
    const t = await makeTestCore();
    try {
      const s = await approvedSetup(t);
      const input = { runId: s.runId, planId: s.plan.id, revisionId: s.revision.id, requestHash: "h-idem", tasks: GOOD_TASKS };
      const first = await t.core.tasks.createDag(input);
      expect(first.created).toBe(true);
      const second = await t.core.tasks.createDag(input);
      expect(second.created).toBe(false);
      expect(second.taskIds).toEqual(first.taskIds);
      expect(second.planningId).toBe(first.planningId);
      expect(await t.core.tasks.listTasks({ runId: s.runId })).toHaveLength(1);
      const rejected = await t.core.tasks.recordPlanningRejected({ runId: s.runId, planId: s.plan.id, revisionId: s.revision.id, requestHash: "h-bad", reason: "vague test" });
      expect(rejected.startsWith("pln_")).toBe(true);
      await expectRejects(t.core.tasks.createDag({ ...input, requestHash: "h-bad", tasks: GOOD_TASKS }), /was rejected/);
    } finally {
      await t.cleanup();
    }
  });

  test("anclaje: revisión no aprobada y run fijado a otra revisión se rechazan", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES ('run_anchor', ?, 'x', 'executing', 'build', 1, 1)", [session.id]);
      const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "X", structured: STRUCTURED, runId: "run_anchor", createdBy: "t" });
      const rev = (await t.core.plans.listRevisions(plan.id))[0]!;
      await expectRejects(
        t.core.tasks.createDag({ runId: "run_anchor", planId: plan.id, revisionId: rev.id, requestHash: "h-noappr", tasks: GOOD_TASKS }),
        /needs-approval/,
      );
      await t.core.plans.presentRevision(rev.id, "msg_anchor");
      await t.core.plans.requestApproval(plan.id, rev.id, session.id, "run_anchor");
      const pending = await t.core.pendingApprovals(session.id);
      await t.core.decideApproval(pending[0]!.id, "approved");
      await t.core.db.exec("UPDATE runs SET plan_revision_id = 'prev_other' WHERE id = 'run_anchor'");
      await expectRejects(
        t.core.tasks.createDag({ runId: "run_anchor", planId: plan.id, revisionId: rev.id, requestHash: "h-mismatch", tasks: GOOD_TASKS }),
        /pinned/,
      );
    } finally {
      await t.cleanup();
    }
  });

  test("planner end-to-end con modelo falso: crea DAG y es idempotente", async () => {
    const proposal = {
      tasks: [
        { tempId: "p1", title: "Explore auth module files", description: "Locate and read every file involved in the current login flow.", agentRole: "explorer", priority: 5, dependencies: [], acceptanceCriteria: ["list of files under src/ with paths"], requiredTools: ["read", "glob"], writeScope: [], validationCommands: [], needsReview: false },
        { tempId: "p2", title: "Summarize login flow findings", description: "Write a structured summary of the login flow based on the exploration.", agentRole: "researcher", priority: 1, dependencies: ["p1"], acceptanceCriteria: ["summary mentions README.md"], requiredTools: ["read"], writeScope: [], validationCommands: [], needsReview: false },
      ],
    };
    const t = await makeTestCore({ metaTurns: [{ text: JSON.stringify(proposal) }] });
    try {
      await useFakeModels(t);
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const { runId, instanceId } = await makeRun(t, session.id);
      const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "Build auth", structured: STRUCTURED, runId, createdBy: "t" });
      const rev = (await t.core.plans.listRevisions(plan.id))[0]!;
      await t.core.plans.presentRevision(rev.id, "msg_p");
      await t.core.plans.requestApproval(plan.id, rev.id, session.id, runId);
      const pending = await t.core.pendingApprovals(session.id);
      await t.core.decideApproval(pending[0]!.id, "approved");
      const first = await t.core.planner.planTasks(instanceId, { runId, objective: "Build auth", planId: plan.id, revisionId: rev.id });
      expect(first.created).toBe(true);
      expect(first.taskIds).toHaveLength(2);
      const again = await t.core.planner.planTasks(instanceId, { runId, objective: "Build auth", planId: plan.id, revisionId: rev.id });
      expect(again.created).toBe(false);
      expect([...again.taskIds].sort()).toEqual([...first.taskIds].sort());
    } finally {
      await t.cleanup();
    }
  });

  test("planner exige revisión aprobada explícita sin auto-selección", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const { instanceId, runId } = await makeRun(t, session.id);
      await expectRejects(t.core.planner.planTasks(instanceId, { runId, objective: "Build auth" }), /plan_conflict|needs-approval|No approved revision/);
    } finally {
      await t.cleanup();
    }
  });
});
