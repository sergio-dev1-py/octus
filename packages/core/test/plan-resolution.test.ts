import { describe, expect, test } from "bun:test";
import { makeTestCore, workspaceOf, expectRejects } from "./helpers.js";

const structured = { objective: "O", steps: [{ title: "S1" }], acceptanceCriteria: ["done"] };

describe("resolución de revisiones por versión e id", () => {
  test("request_approval acepta 'v1' y auto-presenta", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "O", structured, runId: "r", createdBy: "t" });
      // Sin presentar: antes fallaba con "Only a presented revision...".
      const req = await t.core.plans.requestApproval(plan.id, "v1", session.id, "run_test");
      expect(req.revisionId).toBeTruthy();
      const rev = await t.core.plans.getRevision(req.revisionId);
      expect(rev!.lifecycle).toBe("presented");
      expect(rev!.approval).toBe("pending");
    } finally {
      await t.cleanup();
    }
  });

  test("request_approval acepta id interno y rechaza versiones inexistentes con ayuda", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "O", structured, runId: "r", createdBy: "t" });
      const v1 = (await t.core.plans.listRevisions(plan.id))[0]!;
      const byId = await t.core.plans.requestApproval(plan.id, v1.id, session.id, "run_test");
      expect(byId.revisionId).toBe(v1.id);
      await expectRejects(t.core.plans.requestApproval(plan.id, "v9", session.id, "run_test"), /disponibles: v1/);
    } finally {
      await t.cleanup();
    }
  });

  test("get acepta 'v1' y '1'", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "O", structured, runId: "r", createdBy: "t" });
      const byV = await t.core.plans.get(plan.id, "v1");
      const byN = await t.core.plans.get(plan.id, "1");
      expect(byV).toContain("O");
      expect(byN).toContain("O");
    } finally {
      await t.cleanup();
    }
  });
});
