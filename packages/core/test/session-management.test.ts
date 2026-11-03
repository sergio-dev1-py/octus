import { describe, expect, test } from "bun:test";
import path from "node:path";
import { OctusCore } from "../src/sessions/octus-core.js";
import { MemorySecretStore } from "../src/secrets/secret-store.js";
import { makeTestCore, makeRun, expectRejects, workspaceOf } from "./helpers.js";

/**
 * Todo 11 — gestión visual de proyectos y sesiones con recuperación (C-02):
 * ciclo crear, cambiar, cerrar y recuperar con aislamiento por proyecto,
 * sobre los servicios existentes (sin SessionManager duplicado, sin
 * segunda jerarquía de persistencia). Failure: recuperación con evento
 * corrupto → sesión vacía registrada, sin pérdida silenciosa.
 */
describe("project and session management with recovery (Todo 11)", () => {
  test("ciclo crear, cambiar, cerrar y recuperar con aislamiento por proyecto", async () => {
    const t = await makeTestCore({ metaTurns: [{ text: "hola desde A1" }] });
    try {
      const projectA = await t.core.createProject("Proyecto A", workspaceOf(t));
      const projectB = await t.core.createProject("Proyecto B", workspaceOf(t));
      const sA1 = await t.core.createSession({ projectId: projectA.id, title: "A-uno" });
      const sA2 = await t.core.createSession({ projectId: projectA.id, title: "A-dos" });
      const sB1 = await t.core.createSession({ projectId: projectB.id, title: "B-uno" });

      // Aislamiento: cada proyecto solo ve sus sesiones.
      const listA = await t.core.listSessions(projectA.id);
      const listB = await t.core.listSessions(projectB.id);
      expect(listA.map((s) => s.id).sort()).toEqual([sA1.id, sA2.id].sort());
      expect(listB.map((s) => s.id)).toEqual([sB1.id]);
      expect(listA.every((s) => s.projectId === projectA.id)).toBe(true);

      // Cambiar: tráfico real en A1 queda aislado de B1.
      await t.core.setSessionModel(sA1.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      await t.core.prompt(sA1.id, "primera petición");
      await t.core.waitForIdle(sA1.id);
      const messagesA1 = await t.core.sessionMessages(sA1.id);
      expect(messagesA1.length).toBeGreaterThan(0);
      expect(await t.core.sessionMessages(sB1.id)).toEqual([]);
      const got = await t.core.getSession(sB1.id);
      expect(got.session.id).toBe(sB1.id);

      // Renombrar.
      await t.core.renameSession(sA1.id, "A-uno-renombrada");
      const renamed = (await t.core.listSessions(projectA.id)).find((s) => s.id === sA1.id);
      expect(renamed?.title).toBe("A-uno-renombrada");

      // Recuperar sesión sana: no registra incidente y conserva mensajes.
      const healthy = await t.core.recoverSession(sA1.id);
      expect(healthy.recovered).toBe(false);
      expect(healthy.skippedMessages).toEqual([]);
      expect(healthy.messages.map((m) => m.id)).toEqual(messagesA1.map((m) => m.id));
      expect(await t.core.events.listByType("error.raised")).toEqual([]);

      // Cerrar: la sesión desaparece de su proyecto y no se puede continuar.
      await t.core.deleteSession(sA2.id);
      expect((await t.core.listSessions(projectA.id)).map((s) => s.id)).toEqual([sA1.id]);
      await expectRejects(t.core.getSession(sA2.id), /Session not found/);
      await expectRejects(t.core.sessionMessages(sA2.id), /Session not found/);
      // El otro proyecto no se entera.
      expect((await t.core.listSessions(projectB.id)).map((s) => s.id)).toEqual([sB1.id]);
    } finally {
      await t.cleanup();
    }
  });

  test("cerrar liquida runs activos y el reinicio recupera a estado final (continuable por mensaje)", async () => {
    const t = await makeTestCore({ metaTurns: [{ text: "nunca llega" }] });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const { runId } = await t.core.prompt(session.id, "empieza y se interrumpe");
      await t.core.interrupt(session.id);
      await t.core.waitForIdle(session.id);
      const terminal = (await t.core.getRun(runId)).run.status;
      expect(["cancelled", "failed", "done"]).toContain(terminal);

      // Run colgado en planning + reinicio real: settleInterrupted lo cancela.
      const { runId: hung } = await makeRun(t, session.id);
      await t.core.db.exec("UPDATE runs SET status = 'planning' WHERE id = ?", [hung]);
      const dataDir = path.join(t.dir, "data");
      await t.core.close();
      const reopened = await OctusCore.create({
        dataDir,
        primarySecrets: new MemorySecretStore(),
        providers: [t.fakeMeta, t.fakeGo],
      });
      try {
        const status = (await reopened.getRun(hung)).run.status;
        expect(status).toBe("cancelled");
        // La sesión sigue navegable y continuable tras el reinicio.
        const again = await reopened.getSession(session.id);
        expect(again.session.id).toBe(session.id);
        const recovered = await reopened.recoverSession(session.id);
        expect(recovered.session.id).toBe(session.id);
      } finally {
        await reopened.close();
      }
    } finally {
      await t.cleanup();
    }
  });

  test("failure: recuperación con evento corrupto → sesión vacía registrada, sin pérdida silenciosa", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id, title: "frágil" });
      const { runId, instanceId } = await makeRun(t, session.id);

      // Fila de mensaje corrupta (parts no es JSON) + evento corrupto del agregado sesión.
      const badMessageId = "msg_corrupto_1";
      await t.core.db.exec(
        "INSERT INTO messages (id, session_id, run_id, instance_id, role, mode, parts, trust, seq, created_at) VALUES (?, ?, ?, ?, 'user', 'build', ?, 'user', 0, 1)",
        [badMessageId, session.id, runId, instanceId, "¡corrupto{"],
      );
      await t.core.db.exec(
        "INSERT INTO events (id, type, aggregate_kind, aggregate_id, seq, occurred_at, correlation_id, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["evt_corrupto_1", "session.created", "session", session.id, 99, 1, "cor_x", "idem_x", "¡corrupto{"],
      );

      const result = await t.core.recoverSession(session.id);
      // Sesión vacía: el único mensaje era ilegible y se omitió.
      expect(result.messages).toEqual([]);
      expect(result.recovered).toBe(true);
      expect(result.skippedMessages).toEqual([badMessageId]);
      expect(result.skippedEvents).toBe(1);

      // Registrada: incidente error.raised con el contexto, sin pérdida silenciosa.
      const raised = await t.core.events.listByType("error.raised");
      expect(raised).toHaveLength(1);
      expect(raised[0]!.aggregate).toEqual({ kind: "session", id: session.id });
      expect(raised[0]!.payload.reason).toBe("session-recovery");
      expect(raised[0]!.payload.sessionId).toBe(session.id);
      expect(raised[0]!.payload.skippedMessages).toEqual([badMessageId]);

      // La sesión sigue existiendo y es navegable (vacía, no borrada).
      expect((await t.core.getSession(session.id)).session.id).toBe(session.id);

      // Las filas corruptas se conservan para forense (no se borran).
      const raw = await t.core.db.queryOne<{ parts: string }>("SELECT parts FROM messages WHERE id = ?", [badMessageId]);
      expect(raw?.parts).toBe("¡corrupto{");
    } finally {
      await t.cleanup();
    }
  });

  test("borrar sesión con reviewer no falla por review_target_task_id inmutable", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const { runId } = await makeRun(t, session.id);
      const { plan } = await t.core.plans.createPlan({
        sessionId: session.id,
        projectId: project.id,
        objective: "X",
        structured: { objective: "X", steps: [{ title: "S1" }], acceptanceCriteria: ["done"] },
        runId,
        createdBy: "t",
      });
      const rev = (await t.core.plans.listRevisions(plan.id))[0]!;
      await t.core.plans.presentRevision(rev.id, "msg_seed");
      const dag = await t.core.tasks.createDag({
        runId,
        planId: plan.id,
        revisionId: rev.id,
        requestHash: "h-delete-session",
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
      expect(dag.taskIds).toHaveLength(2);
      await t.core.deleteSession(session.id);
      expect(await t.core.listSessions(project.id)).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });
});
