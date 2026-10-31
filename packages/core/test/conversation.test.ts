import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { makeTestCore, workspaceOf } from "./helpers.js";

describe("continuous plan/build conversation (scenario C)", () => {
  test("same session_id, mode stamped per message, shared context across runs", async () => {
    const t = await makeTestCore({ metaTurns: [{ text: "answer one" }, { text: "answer two" }] });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const first = await t.core.prompt(session.id, "first request");
      await t.core.waitForIdle(session.id);
      await t.core.setSessionProfile(session.id, "plan");
      const second = await t.core.prompt(session.id, "second request");
      await t.core.waitForIdle(session.id);
      expect(second.runId).not.toBe(first.runId);
      const messages = await t.core.sessionMessages(session.id);
      expect(messages.map((m) => `${m.role}:${m.mode ?? "-"}`)).toEqual([
        "user:build",
        "assistant:build",
        "user:plan",
        "assistant:plan",
      ]);
      // El segundo run vio la conversación completa (contexto continuo).
      expect(t.fakeMeta.seen).toHaveLength(2);
      const secondInput = JSON.stringify(t.fakeMeta.seen[1]!.messages);
      expect(secondInput).toContain("first request");
      expect(secondInput).toContain("answer one");
      expect(secondInput).toContain("second request");
    } finally {
      await t.cleanup();
    }
  });

  test("text approval resolves from structured state only with a single pending request", async () => {
    const t = await makeTestCore({ metaTurns: [{ text: "ack" }] });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const structured = { objective: "X", steps: [{ title: "S1" }], acceptanceCriteria: ["done"] };
      const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "X", structured, runId: "run_seed", createdBy: "test" });
      const revision = (await t.core.plans.listRevisions(plan.id))[0]!;
      await t.core.plans.presentRevision(revision.id, "msg_seed");
      await t.core.plans.requestApproval(plan.id, revision.id, session.id, "run_seed");
      // "sí" con una única solicitud pendiente: aprueba y además crea el run normalmente.
      const { runId } = await t.core.prompt(session.id, "sí, adelante");
      await t.core.waitForIdle(session.id);
      expect((await t.core.plans.getPlan(plan.id)).approvedRevisionId).toBe(revision.id);
      expect((await t.core.getRun(runId)).run.status).toBe("done");
    } finally {
      await t.cleanup();
    }
  });

  test("ambiguous affirmation with several pending requests approves nothing", async () => {
    const t = await makeTestCore({ metaTurns: [{ text: "which one?" }] });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const structured = { objective: "X", steps: [{ title: "S1" }], acceptanceCriteria: ["done"] };
      for (const objective of ["A", "B"]) {
        const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective, structured: { ...structured, objective }, runId: "r", createdBy: "t" });
        const revision = (await t.core.plans.listRevisions(plan.id))[0]!;
        await t.core.plans.presentRevision(revision.id, "msg_seed");
        await t.core.plans.requestApproval(plan.id, revision.id, session.id, "r");
      }
      await t.core.prompt(session.id, "sí");
      await t.core.waitForIdle(session.id);
      expect(await t.core.plans.pendingApprovals(session.id)).toHaveLength(2);
    } finally {
      await t.cleanup();
    }
  });

  test("implement uses exactly the approved revision and switches to build", async () => {
    const t = await makeTestCore({ metaTurns: [{ text: "implementing" }] });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      await t.core.setSessionProfile(session.id, "plan");
      const structured = { objective: "X", steps: [{ title: "S1" }], acceptanceCriteria: ["done"] };
      const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "X", structured, runId: "r", createdBy: "t" });
      const v1 = (await t.core.plans.listRevisions(plan.id))[0]!;
      await t.core.plans.presentRevision(v1.id, "msg_seed");
      await t.core.plans.approveRevision(plan.id, v1.id);
      const { runId } = await t.core.implementPlanRevision(session.id, plan.id, v1.id);
      await t.core.waitForIdle(session.id);
      const { run } = await t.core.getRun(runId);
      expect(run.planRevisionId).toBe(v1.id);
      expect(run.mode).toBe("build");
      expect((await t.core.getSession(session.id)).session.profile).toBe("build");
      expect(run.status).toBe("done");
    } finally {
      await t.cleanup();
    }
  });

  test("only explicitly approved project files become trusted instructions", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      writeFileSync(path.join(workspaceOf(t), "AGENTS.md"), "SNEAKY-INSTRUCTION");
      writeFileSync(path.join(workspaceOf(t), "notes.md"), "APPROVED-INSTRUCTION");
      const def = await t.core.registry.forProfile("build");
      const before = await t.core.context.buildInstructions(def, workspaceOf(t), [], { projectId: project.id });
      expect(before).not.toContain("SNEAKY-INSTRUCTION");
      await t.core.saveTrustedInstructions(project.id, ["notes.md"]);
      const after = await t.core.context.buildInstructions(def, workspaceOf(t), [], { projectId: project.id });
      expect(after).toContain("APPROVED-INSTRUCTION");
      expect(after).not.toContain("SNEAKY-INSTRUCTION");
    } finally {
      await t.cleanup();
    }
  });

  test("approved plan state survives session compaction (injected from SQLite, not the summary)", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const structured = { objective: "Keep me", steps: [{ title: "S1" }], acceptanceCriteria: ["done"] };
      const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "Keep me", structured, runId: "r", createdBy: "t" });
      const revision = (await t.core.plans.listRevisions(plan.id))[0]!;
      await t.core.plans.presentRevision(revision.id, "msg_seed");
      await t.core.plans.approveRevision(plan.id, revision.id);
      // Simula un checkpoint de compactación: el estado de planes sigue viniendo de SQLite.
      await t.core.context.saveSessionCompaction(session.id, Date.now(), 999999, "summary without plan details");
      const def = await t.core.registry.forProfile("build");
      const state = await (t.core as unknown as { sessionPlanState(sessionId: string): Promise<string | undefined> }).sessionPlanState(session.id);
      expect(state).toContain(plan.id);
      expect(state).toContain(revision.id);
      expect(state).toContain("approved");
      void def;
    } finally {
      await t.cleanup();
    }
  });

  test("interrupted agents are continuable after reopen (recovery)", async () => {
    const t = await makeTestCore({ metaTurns: [{ text: "resumed and done" }] });
    const dir = t.dir;
    const dataDir = `${dir}/data`;
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const { makeRun } = await import("./helpers.js");
      const { instanceId: parentId } = await makeRun(t, session.id);
      const spawned = await t.core.agents.spawn({ parentInstanceId: parentId, definitionId: "explorer", brief: "x", mode: "foreground", model: { providerId: "fake-meta", modelId: "muse-wonder-1.0" } });
      await t.core.db.exec("UPDATE agent_instances SET status = 'running' WHERE id = ?", [spawned.instanceId]);
      await t.core.close();
      const { OctusCore } = await import("../src/sessions/octus-core.js");
      const { MemorySecretStore } = await import("../src/secrets/secret-store.js");
      const { FakeProvider, fakeMetaModels } = await import("../src/testing/fake-providers.js");
      const fake = new FakeProvider("fake-meta", "Fake", fakeMetaModels(), { turns: [{ text: "resumed and done" }], billable: false });
      const core2 = await OctusCore.create({ dataDir, primarySecrets: new MemorySecretStore(), providers: [fake] });
      try {
        const status = await core2.agents.status(spawned.instanceId);
        expect(status.status).toBe("cancelled");
        // Continuable con un mensaje nuevo, en la misma instancia.
        await core2.agents.message(spawned.instanceId, "continue please");
        const delivery = await core2.agents.wait(spawned.instanceId, 10_000);
        expect(delivery.status).toBe("completed");
        expect(delivery.summary).toContain("resumed and done");
      } finally {
        await core2.close();
      }
    } finally {
      await t.cleanup().catch(() => undefined);
    }
  });
});
