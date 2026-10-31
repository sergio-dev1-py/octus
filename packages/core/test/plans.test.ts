import { describe, expect, test } from "bun:test";
import { makeTestCore, workspaceOf } from "./helpers.js";

const STRUCTURED = {
  objective: "Add Google auth",
  steps: [{ title: "OAuth backend", verification: "login works" }],
  acceptanceCriteria: ["Google login works"],
};

const STRUCTURED_V2 = {
  objective: "Add Google auth",
  steps: [{ title: "OAuth backend" }, { title: "GitHub provider" }],
  acceptanceCriteria: ["Google login works", "GitHub login works"],
};

async function setup() {
  const t = await makeTestCore();
  const project = await t.core.createProject("P", workspaceOf(t));
  const session = await t.core.createSession({ projectId: project.id });
  return { t, project, session };
}

describe("plan manager (scenarios A-F)", () => {
  test("A: create plan + first revision, unpresented and pending", async () => {
    const s = await setup();
    try {
      const { plan, revision } = await s.t.core.plans.createPlan({
        sessionId: s.session.id,
        projectId: s.project.id,
        objective: "Add Google auth",
        structured: STRUCTURED,
        runId: "run_a",
        createdBy: "ins_plan",
      });
      expect(plan.currentRevisionId).toBeUndefined();
      expect(revision.version).toBe(1);
      expect(revision.lifecycle).toBe("unpresented");
      expect(revision.approval).toBe("pending");
      expect(revision.contentMarkdown).toContain("OAuth backend");
      const list = await s.t.core.plans.listPlans(s.session.id);
      expect(list).toHaveLength(1);
    } finally {
      await s.t.cleanup();
    }
  });

  test("B: update creates an immutable new revision, history preserved", async () => {
    const s = await setup();
    try {
      const { plan } = await s.t.core.plans.createPlan({ sessionId: s.session.id, projectId: s.project.id, objective: "Add Google auth", structured: STRUCTURED, runId: "run_a", createdBy: "i" });
      const v2 = await s.t.core.plans.updatePlan(plan.id, STRUCTURED_V2, "run_b", "i");
      expect(v2.version).toBe(2);
      const revisions = await s.t.core.plans.listRevisions(plan.id);
      expect(revisions).toHaveLength(2);
      expect(revisions[0]!.structuredContent.steps).toHaveLength(1);
      expect(revisions[1]!.structuredContent.steps).toHaveLength(2);
    } finally {
      await s.t.cleanup();
    }
  });

  test("D: only presented revisions are approvable; approval pins (plan, revision)", async () => {
    const s = await setup();
    try {
      const { plan, revision } = await s.t.core.plans.createPlan({ sessionId: s.session.id, projectId: s.project.id, objective: "X", structured: STRUCTURED, runId: "r", createdBy: "i" });
      const { expectRejects } = await import("./helpers.js");
      await expectRejects(s.t.core.plans.approveRevision(plan.id, revision.id), /presented/);
      await s.t.core.plans.presentRevision(revision.id, "msg_presenter");
      await s.t.core.plans.approveRevision(plan.id, revision.id);
      const updated = await s.t.core.plans.getPlan(plan.id);
      expect(updated.approvedRevisionId).toBe(revision.id);
      expect(updated.currentRevisionId).toBe(revision.id);
      // Una revisión posterior nace pendiente y no hereda la aprobación.
      const v2 = await s.t.core.plans.updatePlan(plan.id, STRUCTURED_V2, "r2", "i");
      expect(v2.approval).toBe("pending");
      const after = await s.t.core.plans.getPlan(plan.id);
      expect(after.approvedRevisionId).toBe(revision.id);
    } finally {
      await s.t.cleanup();
    }
  });

  test("approval requests are idempotent per revision; decide pins the revision", async () => {
    const s = await setup();
    try {
      const { plan, revision } = await s.t.core.plans.createPlan({ sessionId: s.session.id, projectId: s.project.id, objective: "X", structured: STRUCTURED, runId: "r", createdBy: "i" });
      await s.t.core.plans.presentRevision(revision.id, "msg_1");
      const first = await s.t.core.plans.requestApproval(plan.id, revision.id, s.session.id, "r");
      const second = await s.t.core.plans.requestApproval(plan.id, revision.id, s.session.id, "r");
      expect(second.id).toBe(first.id);
      const decided = await s.t.core.plans.decideApproval(first.id, "approved");
      expect(decided.status).toBe("decided");
      expect((await s.t.core.plans.getPlan(plan.id)).approvedRevisionId).toBe(revision.id);
      expect(await s.t.core.plans.pendingApprovals(s.session.id)).toHaveLength(0);
    } finally {
      await s.t.cleanup();
    }
  });

  test("E: independent objectives create separate plans in the same session", async () => {
    const s = await setup();
    try {
      const auth = await s.t.core.plans.createPlan({ sessionId: s.session.id, projectId: s.project.id, objective: "Auth", structured: STRUCTURED, runId: "r", createdBy: "i" });
      const payments = await s.t.core.plans.createPlan({ sessionId: s.session.id, projectId: s.project.id, objective: "Payments", structured: { ...STRUCTURED, objective: "Payments" }, runId: "r", createdBy: "i" });
      expect(auth.plan.id).not.toBe(payments.plan.id);
      expect(await s.t.core.plans.listPlans(s.session.id)).toHaveLength(2);
      expect((await s.t.core.plans.listRevisions(auth.plan.id))).toHaveLength(1);
    } finally {
      await s.t.cleanup();
    }
  });

  test("F: interrupted runs orphan unpresented revisions; presented ones survive", async () => {
    const s = await setup();
    try {
      const { plan, revision } = await s.t.core.plans.createPlan({ sessionId: s.session.id, projectId: s.project.id, objective: "X", structured: STRUCTURED, runId: "run_dead", createdBy: "i" });
      await s.t.core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES ('run_dead', ?, 'x', 'executing', 'plan', 1, 1)", [s.session.id]);
      await s.t.core.db.exec("UPDATE runs SET status = 'cancelled' WHERE id = 'run_dead'");
      const orphaned = await s.t.core.plans.orphanSweep();
      expect(orphaned).toBe(1);
      const reloaded = await s.t.core.plans.getRevision(revision.id);
      expect(reloaded?.lifecycle).toBe("orphaned");
      const { expectRejects } = await import("./helpers.js");
      await expectRejects(s.t.core.plans.approveRevision(plan.id, revision.id), /presented/);
    } finally {
      await s.t.cleanup();
    }
  });

  test("archive and export keep the internal revision as source of truth", async () => {
    const s = await setup();
    try {
      const { plan, revision } = await s.t.core.plans.createPlan({ sessionId: s.session.id, projectId: s.project.id, objective: "X", structured: STRUCTURED, runId: "r", createdBy: "i" });
      await s.t.core.plans.presentRevision(revision.id, "msg_1");
      await s.t.core.plans.approveRevision(plan.id, revision.id);
      const exported = await s.t.core.plans.exportRevision(plan.id, revision.id);
      expect(exported.markdown).toContain("OAuth backend");
      expect(exported.suggestedName).toMatch(/\.md$/);
      await s.t.core.plans.archivePlan(plan.id);
      expect((await s.t.core.plans.getPlan(plan.id)).status).toBe("archived");
      expect((await s.t.core.plans.getPlan(plan.id)).approvedRevisionId).toBe(revision.id);
    } finally {
      await s.t.cleanup();
    }
  });

  test("settle links revisions to the presenting assistant message (or orphans without one)", async () => {
    const s = await setup();
    try {
      const { plan, revision } = await s.t.core.plans.createPlan({ sessionId: s.session.id, projectId: s.project.id, objective: "X", structured: STRUCTURED, runId: "run_link", createdBy: "i" });
      await s.t.core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES ('run_link', ?, 'x', 'executing', 'plan', 1, 1)", [s.session.id]);
      const def = (await s.t.core.registry.get("coordinator-plan"))!;
      const { snapshotOf, promptHashOf } = await import("../src/agents/definition-loader.js");
      await s.t.core.db.exec(
        "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES ('ins_x', ?, 'run_link', ?, 'running', ?, ?, ?, ?, ?, 1, 1)",
        [s.session.id, def.id, JSON.stringify(def.defaultModel), "C:\\tmp", def.promptVersion, promptHashOf(def), JSON.stringify(snapshotOf(def))],
      );
      await s.t.core.db.exec(
        "INSERT INTO messages (id, session_id, run_id, instance_id, role, parts, trust, seq, created_at) VALUES ('msg_present', ?, 'run_link', 'ins_x', 'assistant', ?, 'tool', 0, ?)",
        [s.session.id, JSON.stringify([{ type: "text", text: "here is the plan" }]), revision.createdAt],
      );
      const settled = await s.t.core.plans.settleRunRevisions("run_link");
      expect(settled).toEqual({ presented: 1, orphaned: 0 });
      const linked = (await s.t.core.plans.getRevision(revision.id))!;
      expect(linked.lifecycle).toBe("presented");
      expect(linked.sourceMessageId).toBe("msg_present");
      expect((await s.t.core.plans.getPlan(plan.id)).currentRevisionId).toBe(revision.id);
      // Sin mensaje posterior: huérfana, jamás aprobable.
      const v2 = await s.t.core.plans.updatePlan(plan.id, STRUCTURED_V2, "run_empty", "i");
      await s.t.core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES ('run_empty', ?, 'x', 'executing', 'plan', 1, 1)", [s.session.id]);
      const settled2 = await s.t.core.plans.settleRunRevisions("run_empty");
      expect(settled2).toEqual({ presented: 0, orphaned: 1 });
      expect((await s.t.core.plans.getRevision(v2.id))?.lifecycle).toBe("orphaned");
    } finally {
      await s.t.cleanup();
    }
  });
});
