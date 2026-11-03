import { describe, expect, test } from "bun:test";
import { makeTestCore, makeRun, workspaceOf } from "./helpers.js";

const STRUCTURED = { objective: "X", steps: [{ title: "S1" }], acceptanceCriteria: ["done"] };

describe("revisión y replanificación del DAG", () => {
  test("request-changes reencola el implementer y crea una nueva ronda de reviewer", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const { runId } = await makeRun(t, session.id);
      const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "X", structured: STRUCTURED, runId, createdBy: "t" });
      const rev = (await t.core.plans.listRevisions(plan.id))[0]!;
      await t.core.plans.presentRevision(rev.id, "msg_seed");
      await t.core.tasks.createDag({
        runId,
        planId: plan.id,
        revisionId: rev.id,
        requestHash: "h-review-retry",
        tasks: [
          {
            tempId: "w1",
            title: "Implement feature",
            description: "Implement the feature and leave it ready for review.",
            agentRole: "implementer",
            priority: 1,
            dependencies: [],
            acceptanceCriteria: ["feature implemented"],
            requiredTools: ["read", "write"],
            writeScope: ["."],
            validationCommands: [],
            needsReview: true,
          },
          {
            tempId: "r1",
            title: "Review feature",
            description: "Review the implemented feature and report findings.",
            agentRole: "reviewer",
            priority: 1,
            dependencies: [],
            acceptanceCriteria: ["review report written"],
            requiredTools: ["read"],
            writeScope: [],
            validationCommands: [],
            needsReview: false,
            reviewTargetTempId: "w1",
          },
        ],
      });
      const before = await t.core.tasks.listTasks({ runId });
      const impl = before.find((task) => task.agentRole === "implementer")!;
      const reviewer = before.find((task) => task.agentRole === "reviewer")!;
      await t.core.db.exec("UPDATE tasks SET status = 'completed' WHERE id IN (?, ?)", [impl.id, reviewer.id]);
      await t.core.tasks.recordReview(reviewer.id, impl.id, "request-changes", { reason: "missing validation" });
      const after = await t.core.tasks.listTasks({ runId });
      expect(after.find((task) => task.id === impl.id)!.status).toBe("ready");
      const reviewers = after.filter((task) => task.agentRole === "reviewer" && task.reviewTargetTaskId === impl.id);
      expect(reviewers).toHaveLength(2);
      expect(reviewers.some((task) => task.status === "draft")).toBe(true);
    } finally {
      await t.cleanup();
    }
  });
});
