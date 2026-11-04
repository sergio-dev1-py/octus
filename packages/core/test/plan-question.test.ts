import { describe, expect, test } from "bun:test";
import { makeTestCore, workspaceOf, makeRun } from "./helpers.js";

const STRUCTURED = { objective: "O", steps: [{ title: "S1" }], acceptanceCriteria: ["done"] };

describe("plan: question libre, sin puerta de aprobación", () => {
  test("question sin plan formal se permite (la duda solo perfila el plan)", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const { runId, instanceId } = await makeRun(t, session.id, "coordinator-plan");
      // makeRun crea una instancia real de PLAN: la duda solo perfila el plan.
      const pending = t.core.gateway.execute({
        toolCallId: "tool_q1",
        idempotencyKey: "idem-q1",
        sessionId: session.id,
        runId,
        instanceId,
        definitionId: "coordinator-plan",
        directory: workspaceOf(t),
        name: "question",
        args: {
          questions: [{ question: "¿Apruebas el plan visual NOVA?", header: "Aprobación", options: [{ label: "Sí" }, { label: "No" }] }],
        },
        signal: new AbortController().signal,
      });
      await Bun.sleep(100);
      const questions = t.core.questions.pendingFor(session.id);
      expect(questions.length).toBe(1);
      t.core.questions.reply(questions[0]!.id, [{ question: "¿Apruebas el plan visual NOVA?", answers: ["Sí"] }], "cor_test");
      await pending.catch(() => undefined);
    } finally {
      await t.cleanup();
    }
  });

  test("con plan creado la guarda no bloquea la pregunta", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const { runId, instanceId } = await makeRun(t, session.id, "coordinator-plan");
      await t.core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "O", structured: STRUCTURED, runId, createdBy: "t" });
      // La pregunta se crea y queda pendiente: no debe lanzar la guarda.
      const pending = t.core.gateway.execute({
        toolCallId: "tool_q2",
        idempotencyKey: "idem-q2",
        sessionId: session.id,
        runId,
        instanceId,
        definitionId: "coordinator-plan",
        directory: workspaceOf(t),
        name: "question",
        args: {
          questions: [{ question: "¿Apruebas el plan?", header: "Aprobación", options: [{ label: "Sí" }] }],
        },
        signal: new AbortController().signal,
      });
      await Bun.sleep(100);
      const questions = t.core.questions.pendingFor(session.id);
      expect(questions.length).toBe(1);
      // No bloquear el test: se responde para cerrar la promesa.
      t.core.questions.reply(questions[0]!.id, [{ question: "¿Apruebas el plan?", answers: ["Sí"] }], "cor_test");
      await pending.catch(() => undefined);
    } finally {
      await t.cleanup();
    }
  });
});
