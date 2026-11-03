import { describe, expect, test } from "bun:test";
import type { PermissionRule } from "@octus/shared";
import { makeTestCore, workspaceOf, makeRun } from "./helpers.js";

const STRUCTURED = { objective: "Build auth", steps: [{ title: "S1" }], acceptanceCriteria: ["done"] };

describe("auto-aprobación al pasar a build", () => {
  test("un plan presentado y pendiente se aprueba al enviar el prompt en build", async () => {
    const t = await makeTestCore({ metaTurns: [{ text: "ok" }] });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const { runId } = await makeRun(t, session.id);
      const { plan } = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "Build auth", structured: STRUCTURED, runId, createdBy: "t" });
      const rev = (await t.core.plans.listRevisions(plan.id))[0]!;
      await t.core.plans.requestApproval(plan.id, rev.id, session.id, runId);
      expect(await t.core.pendingApprovals(session.id)).toHaveLength(1);
      // El usuario cambia a build y escribe "procede": se aprueba solo.
      const { runId: newRun } = await t.core.prompt(session.id, "procede");
      await t.core.waitForIdle(session.id);
      const { run } = await t.core.getRun(newRun);
      expect(run.planRevisionId).toBe(rev.id);
      const approved = await t.core.plans.getRevision(rev.id);
      expect(approved!.approval).toBe("approved");
      expect(await t.core.pendingApprovals(session.id)).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });

  test("con dos revisiones pendientes no se auto-aprueba", async () => {
    const t = await makeTestCore({ metaTurns: [{ text: "ok" }] });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const { runId } = await makeRun(t, session.id);
      const a = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "A", structured: STRUCTURED, runId, createdBy: "t" });
      const b = await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "B", structured: STRUCTURED, runId, createdBy: "t" });
      const ra = (await t.core.plans.listRevisions(a.plan.id))[0]!;
      const rb = (await t.core.plans.listRevisions(b.plan.id))[0]!;
      await t.core.plans.requestApproval(a.plan.id, ra.id, session.id, runId);
      await t.core.plans.requestApproval(b.plan.id, rb.id, session.id, runId);
      await t.core.prompt(session.id, "procede");
      await t.core.waitForIdle(session.id);
      expect(await t.core.pendingApprovals(session.id)).toHaveLength(2);
    } finally {
      await t.cleanup();
    }
  });
});

describe("herencia de permisos padre → subagente", () => {
  test("el subagente recibe las reglas del coordinador y conserva su techo de tools", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const { instanceId: parentId } = await makeRun(t, session.id);
      const spawned = await t.core.agents.spawn({
        parentInstanceId: parentId,
        definitionId: "explorer",
        brief: "look",
        mode: "foreground",
        model: { providerId: "fake-meta", modelId: "muse-wonder-1.0" },
      });
      const layersOf = (t.core as unknown as {
        gateway: { options: { layersFor(id: string, s: string, i: string): Promise<{ definitionTools: string[]; definitionRules?: PermissionRule[] }> } };
      });
      // Acceso al hook del gateway a través de su tabla de opciones no es público;
      // se valida el efecto con preview sobre las capas propias del hijo.
      const inherited = await (t.core as unknown as { inheritedRules(id: string): Promise<PermissionRule[]> }).inheritedRules(spawned.instanceId);
      expect(inherited.some((r) => r.action === "write" && r.effect === "allow")).toBe(true);
      expect(inherited.some((r) => r.action === "shell" && r.effect === "allow")).toBe(true);
      // El techo del explorer sigue sin shell/write: heredar no amplía tools.
      const explorer = await t.core.registry.get("explorer");
      expect(explorer!.tools).not.toContain("write");
      expect(explorer!.tools).not.toContain("shell");
      void layersOf;
      void project;
    } finally {
      await t.cleanup();
    }
  });
});
