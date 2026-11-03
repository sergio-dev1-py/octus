import { describe, expect, test } from "bun:test";
import { makeTestCore, workspaceOf, makeRun, expectRejects } from "./helpers.js";

const STRUCTURED = { objective: "Build auth", steps: [{ title: "S1" }], acceptanceCriteria: ["done"] };
const PROPOSAL = {
  tasks: [
    {
      tempId: "p1",
      title: "Explore auth module files",
      description: "Locate and read every file involved in the current login flow.",
      agentRole: "explorer",
      priority: 5,
      dependencies: [],
      acceptanceCriteria: ["list of files under src/ with paths"],
      requiredTools: ["read", "glob"],
      writeScope: [],
      validationCommands: [],
      needsReview: false,
    },
  ],
};

describe("plan_tasks sin argumentos (run anclado)", () => {
  test("resuelve runId/objective/plan/revisión del ancla", async () => {
    const t = await makeTestCore({ metaTurns: [{ text: JSON.stringify(PROPOSAL) }] });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const { runId, instanceId } = await makeRun(t, session.id);
      const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "Build auth", structured: STRUCTURED, runId, createdBy: "t" });
      const rev = (await t.core.plans.listRevisions(plan.id))[0]!;
      await t.core.plans.requestApproval(plan.id, rev.id, session.id, runId);
      const pending = await t.core.pendingApprovals(session.id);
      await t.core.decideApproval(pending[0]!.id, "approved");
      // El run queda anclado como en producción.
      await t.core.db.exec("UPDATE runs SET plan_revision_id = ? WHERE id = ?", [rev.id, runId]);
      // Firma sin objective/planId/revisionId: todo se resuelve del ancla.
      const out = await t.core.planner.planTasks(instanceId, { runId });
      expect(out.created).toBe(true);
      expect(out.taskIds.length).toBeGreaterThan(0);
    } finally {
      await t.cleanup();
    }
  });

  test("acepta revisionId 'vN' y reintenta si el planner corta el JSON", async () => {
    const t = await makeTestCore({ metaTurns: [{ text: "{\"tasks\":[" }, { text: JSON.stringify(PROPOSAL) }] });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const { runId, instanceId } = await makeRun(t, session.id);
      const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "Build auth", structured: STRUCTURED, runId, createdBy: "t" });
      const rev = (await t.core.plans.listRevisions(plan.id))[0]!;
      await t.core.plans.presentRevision(rev.id, "msg_p");
      const out = await t.core.planner.planTasks(instanceId, { runId, objective: "Build auth", planId: plan.id, revisionId: "v1" });
      expect(out.created).toBe(true);
      expect(out.taskIds).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });

  test("normaliza prioridad textual, nulls y criterios naturales del modelo", async () => {
    const proposal = {
      tasks: [
        {
          tempId: "e1",
          title: "Inspect FAQ implementation",
          description: "Read the FAQ page and the Base layout to list exact files and gaps.",
          agentRole: "explorer",
          priority: "high",
          dependencies: null,
          acceptanceCriteria: ["Schema FAQPage presente en el HTML final"],
          requiredTools: ["read", "shell"],
          writeScope: null,
          validationCommands: ["npm run build"],
          needsReview: "false",
        },
      ],
    };
    const t = await makeTestCore({ metaTurns: [{ text: JSON.stringify(proposal) }] });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const { runId, instanceId } = await makeRun(t, session.id);
      const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "Build auth", structured: STRUCTURED, runId, createdBy: "t" });
      const rev = (await t.core.plans.listRevisions(plan.id))[0]!;
      await t.core.plans.presentRevision(rev.id, "msg_p");
      const out = await t.core.planner.planTasks(instanceId, { runId, objective: "Build auth", planId: plan.id, revisionId: "v1" });
      expect(out.created).toBe(true);
      const tasks = await t.core.tasks.listTasks({ runId });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.priority).toBe(8);
      // El planner no puede colar tools ni comandos fuera de lo permitido.
      expect(tasks[0]!.requiredTools).toEqual(["read"]);
      expect(tasks[0]!.validationCommands).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });

  test("un run no crea un segundo DAG aunque cambie el brief", async () => {
    const t = await makeTestCore({ metaTurns: [{ text: JSON.stringify(PROPOSAL) }] });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const { runId, instanceId } = await makeRun(t, session.id);
      const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "Build auth", structured: STRUCTURED, runId, createdBy: "t" });
      const rev = (await t.core.plans.listRevisions(plan.id))[0]!;
      await t.core.plans.presentRevision(rev.id, "msg_p");
      const first = await t.core.planner.planTasks(instanceId, { runId, objective: "Build auth", planId: plan.id, revisionId: rev.id, brief: "first" });
      expect(first.created).toBe(true);
      const second = await t.core.planner.planTasks(instanceId, { runId, objective: "Build auth", planId: plan.id, revisionId: rev.id, brief: "second", nonce: "again" });
      expect(second.created).toBe(false);
      expect([...second.taskIds].sort()).toEqual([...first.taskIds].sort());
      expect(await t.core.tasks.listTasks({ runId })).toHaveLength(first.taskIds.length);
    } finally {
      await t.cleanup();
    }
  });

  test("una revisión nueva o replan cancela el DAG viejo y crea otro", async () => {
    const first = { tasks: [{ ...PROPOSAL.tasks[0]!, tempId: "a1", title: "Inspect first revision" }] };
    const second = { tasks: [{ ...PROPOSAL.tasks[0]!, tempId: "b1", title: "Inspect second revision" }] };
    const t = await makeTestCore({ metaTurns: [{ text: JSON.stringify(first) }, { text: JSON.stringify(second) }] });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const { runId, instanceId } = await makeRun(t, session.id);
      const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "Build auth", structured: STRUCTURED, runId, createdBy: "t" });
      const rev1 = (await t.core.plans.listRevisions(plan.id))[0]!;
      await t.core.plans.presentRevision(rev1.id, "msg_v1");
      const v1 = await t.core.planner.planTasks(instanceId, { runId, objective: "Build auth", planId: plan.id, revisionId: rev1.id });
      expect(v1.created).toBe(true);
      const rev2 = await t.core.plans.updatePlan(plan.id, STRUCTURED, runId, "t");
      const v2 = await t.core.planner.planTasks(instanceId, { runId, objective: "Build auth", planId: plan.id, revisionId: rev2.id });
      expect(v2.created).toBe(true);
      const tasks = await t.core.tasks.listTasks({ runId });
      expect(tasks).toHaveLength(2);
      expect(tasks.find((task) => task.id === v1.taskIds[0]!)!.status).toBe("cancelled");
      expect(tasks.find((task) => task.id === v2.taskIds[0]!)!.status).not.toBe("cancelled");
    } finally {
      await t.cleanup();
    }
  });

  test("sin ancla devuelve error accionable (no auto-selecciona)", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const { runId, instanceId } = await makeRun(t, session.id);
      await expectRejects(t.core.planner.planTasks(instanceId, { runId }), /No plan revision|plan_conflict/);
    } finally {
      await t.cleanup();
    }
  });
});
