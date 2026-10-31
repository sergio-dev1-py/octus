import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { isOctusError } from "../src/errors.js";
import { expectRejects, makeRun, makeTestCore, workspaceOf } from "./helpers.js";

async function setup() {
  const t = await makeTestCore();
  const project = await t.core.createProject("P", workspaceOf(t));
  const session = await t.core.createSession({ projectId: project.id });
  const { runId, instanceId } = await makeRun(t, session.id);
  return { t, project, session, runId, parentId: instanceId };
}

describe("agent manager (delegation)", () => {
  test("foreground spawn runs to completion and returns the delivery", async () => {
    const s = await setup();
    try {
      const result = await s.t.core.agents.spawn({
        parentInstanceId: s.parentId,
        definitionId: "explorer",
        brief: "Summarize the workspace.",
        mode: "foreground",
        model: { providerId: "fake-meta", modelId: "muse-wonder-1.0" },
      });
      expect(result.mode).toBe("foreground");
      expect(result.delivery?.status).toBe("completed");
      expect(result.delivery?.summary).toContain("hello from fake");
      const status = await s.t.core.agents.status(result.instanceId);
      expect(status.depth).toBe(1);
    } finally {
      await s.t.cleanup();
    }
  });

  test("background survives the coordinator run and its delivery stays pending", async () => {
    const t = await makeTestCore({
      metaTurns: [{ toolCalls: [{ name: "question", args: { questions: [{ question: "Q?", header: "Q", options: [{ label: "A" }] }] } }] }, { text: "child done" }],
    });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const { instanceId: parentId } = await makeRun(t, session.id);
      const spawned = await t.core.agents.spawn({ parentInstanceId: parentId, definitionId: "implementer", brief: "Ask me.", mode: "background", model: { providerId: "fake-meta", modelId: "muse-wonder-1.0" } });
      await Bun.sleep(200);
      // Hijo activo sin ningún run del coordinador en marcha.
      expect((await t.core.agents.status(spawned.instanceId)).status).toBe("running");
      expect(t.core.questions.pendingFor(session.id)).toHaveLength(1);
      // Responder completa al hijo; la entrega queda pendiente para el coordinador.
      const open = t.core.questions.pendingFor(session.id)[0]!;
      await t.core.questions.reply(open.id, [{ question: "Q?", answers: ["A"] }], "cor_test");
      const delivery = await t.core.agents.wait(spawned.instanceId, 10_000);
      expect(delivery.status).toBe("completed");
      const pending = await t.core.agents.pendingDeliveries(session.id);
      expect(pending.map((d) => d.instanceId)).toContain(spawned.instanceId);
      // El consumo es de un solo uso.
      await t.core.agents.consumePendingDeliveries(session.id);
      expect(await t.core.agents.pendingDeliveries(session.id)).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });

  test("message continues the same finished instance (no new instance)", async () => {
    const s = await setup();
    try {
      const spawned = await s.t.core.agents.spawn({ parentInstanceId: s.parentId, definitionId: "explorer", brief: "First.", mode: "foreground", model: { providerId: "fake-meta", modelId: "muse-wonder-1.0" } });
      await s.t.core.agents.message(spawned.instanceId, "Second question.");
      const delivery = await s.t.core.agents.wait(spawned.instanceId, 10_000);
      expect(delivery.status).toBe("completed");
      const { instances } = await s.t.core.getRun(s.runId);
      expect(instances.filter((i) => i.definitionId === "explorer")).toHaveLength(1);
    } finally {
      await s.t.cleanup();
    }
  });

  test("cancel cascades to descendants; siblings survive", async () => {
    const t = await makeTestCore({
      metaTurns: [{ toolCalls: [{ name: "question", args: { questions: [{ question: "Q?", header: "Q", options: [{ label: "A" }] }] } }] }],
    });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const { runId, instanceId: parentId } = await makeRun(t, session.id);
      const a = await t.core.agents.spawn({ parentInstanceId: parentId, definitionId: "implementer", brief: "A", mode: "background", model: { providerId: "fake-meta", modelId: "muse-wonder-1.0" } });
      const b = await t.core.agents.spawn({ parentInstanceId: parentId, definitionId: "implementer", brief: "B", mode: "background", model: { providerId: "fake-meta", modelId: "muse-wonder-1.0" } });
      await Bun.sleep(200);
      // Nieto simulado (fila activa colgando del hijo A).
      await t.core.db.exec(
        "INSERT INTO agent_instances (id, session_id, run_id, definition_id, parent_instance_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES ('ins_grand', ?, ?, 'explorer', ?, 'running', ?, ?, 1, '', '{}', 1, 1)",
        [session.id, runId, a.instanceId, JSON.stringify({ providerId: "fake-meta", modelId: "muse-wonder-1.0" }), workspaceOf(t)],
      );
      const cancelled = await t.core.agents.cancel(a.instanceId);
      expect(cancelled.cancelled).toContain(a.instanceId);
      expect(cancelled.cancelled).toContain("ins_grand");
      expect((await t.core.agents.status(b.instanceId)).status).toBe("running");
      await t.core.agents.cancel(b.instanceId);
    } finally {
      await t.cleanup();
    }
  });

  test("profiles without delegation rights are rejected; limits are enforced", async () => {
    const s = await setup();
    try {
      // Un explorer (hijo) no puede delegar.
      const child = await s.t.core.agents.spawn({ parentInstanceId: s.parentId, definitionId: "explorer", brief: "x", mode: "foreground", model: { providerId: "fake-meta", modelId: "muse-wonder-1.0" } });
      const err = await expectRejects(
        s.t.core.agents.spawn({ parentInstanceId: child.instanceId, definitionId: "explorer", brief: "nested", mode: "foreground", model: { providerId: "fake-meta", modelId: "muse-wonder-1.0" } }),
        /cannot delegate/,
      );
      expect(isOctusError(err, "delegation_denied")).toBe(true);
      // Límite por sesión contando al coordinador: con 1 ya activo, otro spawn falla.
      s.t.core.setAgentLimits({ maxPerSession: 1, maxPerProject: 100, maxDepth: 2 });
      // parentId (coordinator, running) + child (completed) = 1 activo.
      const err2 = await expectRejects(
        s.t.core.agents.spawn({ parentInstanceId: s.parentId, definitionId: "explorer", brief: "y", mode: "foreground", model: { providerId: "fake-meta", modelId: "muse-wonder-1.0" } }),
        /active agents/,
      );
      expect(isOctusError(err2, "concurrency_limit")).toBe(true);
    } finally {
      await s.t.cleanup();
    }
  });

  test("implementer without an assigned directory is read-only", async () => {
    const s = await setup();
    try {
      const spawned = await s.t.core.agents.spawn({ parentInstanceId: s.parentId, definitionId: "implementer", brief: "x", mode: "foreground", model: { providerId: "fake-meta", modelId: "muse-wonder-1.0" } });
      expect(spawned.delivery?.status).toBe("completed");
      const row = await s.t.core.db.queryOne<{ instance_rules: string }>("SELECT instance_rules FROM agent_instances WHERE id = ?", [spawned.instanceId]);
      expect(String(row?.instance_rules)).toContain("write");
      const err = await expectRejects(
        s.t.core.gateway.execute({
          toolCallId: "tool_impl_w",
          idempotencyKey: "idem-impl-w",
          sessionId: s.session.id,
          runId: s.runId,
          instanceId: spawned.instanceId,
          definitionId: "implementer",
          directory: workspaceOf(s.t),
          name: "write",
          args: { path: "x.txt", content: "x" },
        }),
        /denied/i,
      );
      expect(isOctusError(err, "permission_denied")).toBe(true);
    } finally {
      await s.t.cleanup();
    }
  });

  test("assigned directories are exclusive, including overlaps", async () => {
    const t = await makeTestCore({
      metaTurns: [{ toolCalls: [{ name: "question", args: { questions: [{ question: "Q?", header: "Q", options: [{ label: "A" }] }] } }] }],
    });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const { instanceId: parentId } = await makeRun(t, session.id);
      const outer = path.join(workspaceOf(t), "wt-a");
      const inner = path.join(outer, "nested");
      mkdirSync(inner, { recursive: true });
      const dirA = await t.core.registerIsolatedDirectory(project.id, outer, "directory");
      const dirB = await t.core.registerIsolatedDirectory(project.id, inner, "directory");
      const first = await t.core.agents.spawn({ parentInstanceId: parentId, definitionId: "implementer", brief: "A", mode: "background", model: { providerId: "fake-meta", modelId: "muse-wonder-1.0" }, directoryId: dirA.id });
      await Bun.sleep(200);
      expect((await t.core.agents.status(first.instanceId)).status).toBe("running");
      const err = await expectRejects(
        t.core.agents.spawn({ parentInstanceId: parentId, definitionId: "implementer", brief: "B", mode: "background", model: { providerId: "fake-meta", modelId: "muse-wonder-1.0" }, directoryId: dirB.id }),
        /overlaps/,
      );
      expect(isOctusError(err, "scope_conflict")).toBe(true);
      await t.core.agents.cancel(first.instanceId);
    } finally {
      await t.cleanup();
    }
  });

  test("model overrides are validated strictly", async () => {
    const s = await setup();
    try {
      const ok = await s.t.core.agents.spawn({
        parentInstanceId: s.parentId,
        definitionId: "explorer",
        brief: "x",
        mode: "foreground",
        model: { providerId: "fake-go", modelId: "glm-5.3-flash" },
      });
      expect(ok.delivery?.status).toBe("completed");
      const err = await expectRejects(
        s.t.core.agents.spawn({ parentInstanceId: s.parentId, definitionId: "explorer", brief: "x", mode: "foreground", model: { providerId: "nope", modelId: "x" } }),
        /not available/,
      );
      expect(isOctusError(err, "model_not_supported")).toBe(true);
    } finally {
      await s.t.cleanup();
    }
  });
});
