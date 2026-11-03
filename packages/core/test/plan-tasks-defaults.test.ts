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
