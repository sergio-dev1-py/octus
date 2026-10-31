/** Etapa 6.5 — E2E de memoria y recuperación (fakes + git real donde aplica).
 * Reutiliza Etapas 1–5 sin duplicarlas: aquí solo el comportamiento de
 * memoria a través de sesiones, runs coexistentes, checkpoints,
 * aislamiento, topes y gobernanza sin escritura autorizada.
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expectRejects, makeRun, makeTestCore, type TestCore } from "./helpers.js";
import { mkdirSync } from "node:fs";

async function setup(t: TestCore, name = "E"): Promise<{ projectId: string; sessionId: string; runId: string; coordId: string; dir: string }> {
  const dir = path.join(t.dir, `ws-${name}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  const project = await t.core.createProject(`P-${name}`, dir);
  const session = await t.core.createSession({ projectId: project.id, directory: dir, title: `S-${name}` });
  const { runId, instanceId: coordId } = await makeRun(t, session.id);
  return { projectId: project.id, sessionId: session.id as string, runId, coordId, dir };
}

function agentCtx(s: { projectId: string; sessionId: string; runId: string }, instanceId: string) {
  return { projectId: s.projectId, sessionId: s.sessionId, runId: s.runId, instanceId };
}

async function workerInstance(t: TestCore, sessionId: string, runId: string, dir: string, definitionId = "implementer"): Promise<string> {
  const id = `ins_w_${Math.random().toString(36).slice(2, 8)}`;
  await t.core.db.exec(
    "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?, 1, 'h', '{}', 1, 1)",
    [id, sessionId, runId, definitionId, JSON.stringify({ providerId: "fake-meta", modelId: "muse-wonder-1.0" }), dir],
  );
  return id;
}

describe("etapa 6.5 — persistencia y continuidad entre sesiones (O2)", () => {
  test("la memoria de proyecto validada sobrevive a sesiones nuevas del mismo proyecto", async () => {
    const t = await makeTestCore();
    try {
      const a = await setup(t, "EA");
      const fact = await t.core.memoryWriter.propose({ scope: "project", scopeId: a.projectId, category: "fact", topic: "stack-e2e", content: "bun 1.4", source: "code" }, agentCtx(a, a.coordId));
      await t.core.memoryWriter.validate(fact.id, a.coordId);
      // Sesión nueva, mismo proyecto: el contexto la recupera.
      const sessionB = await t.core.createSession({ projectId: a.projectId, directory: a.dir, title: "S-B" });
      const { runId: runB, instanceId: coordB } = await makeRun(t, sessionB.id);
      const def = await t.core.registry.get("coordinator-build");
      const text = await t.core.context.buildInstructions(def!, a.dir, [], { projectId: a.projectId, sessionId: sessionB.id as string, runId: runB, instanceId: coordB });
      expect(text).toContain("stack-e2e");
      // …pero no en otro proyecto.
      const other = await setup(t, "EO");
      const def2 = await t.core.registry.get("coordinator-build");
      const foreign = await t.core.context.buildInstructions(def2!, other.dir, [], { projectId: other.projectId, sessionId: other.sessionId, runId: other.runId, instanceId: other.coordId });
      expect(foreign).not.toContain("stack-e2e");
    } finally {
      await t.cleanup();
    }
  });

  test("checkpoint de instancia: recuperable por su instancia, invisible para otras", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "EC");
      const w1 = await workerInstance(t, s.sessionId, s.runId, s.dir);
      const w2 = await workerInstance(t, s.sessionId, s.runId, s.dir);
      const cp = await t.core.memoryWriter.propose({ scope: "instance", scopeId: w1, category: "checkpoint", topic: "progreso", content: "archivos a medias: x", source: "delivery" }, agentCtx(s, w1));
      await t.core.memoryWriter.validate(cp.id, s.coordId);
      const def = await t.core.registry.get("implementer");
      const own = await t.core.context.buildInstructions(def!, s.dir, [], { projectId: s.projectId, sessionId: s.sessionId, runId: s.runId, instanceId: w1 });
      expect(own).toContain("archivos a medias");
      const alien = await t.core.context.buildInstructions(def!, s.dir, [], { projectId: s.projectId, sessionId: s.sessionId, runId: s.runId, instanceId: w2 });
      expect(alien).not.toContain("archivos a medias");
    } finally {
      await t.cleanup();
    }
  });
});

describe("etapa 6.5 — runs coexistentes y aislamiento (O5 + §J)", () => {
  test("dos runs misma sesión: memoria de run no cruza; proyecto compartido sí", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "ER");
      const { runId: runB } = await makeRun(t, s.sessionId);
      const mRun = await t.core.memoryWriter.propose({ scope: "run", scopeId: s.runId, category: "fact", topic: "nota-run-a", content: "solo run A", source: "delivery" }, agentCtx(s, s.coordId));
      await t.core.memoryWriter.validate(mRun.id, s.coordId);
      const shared = await t.core.memoryWriter.propose({ scope: "project", scopeId: s.projectId, category: "fact", topic: "comun-e2e", content: "stack común", source: "code" }, agentCtx(s, s.coordId));
      await t.core.memoryWriter.validate(shared.id, s.coordId);
      const def = await t.core.registry.get("coordinator-build");
      const ctxB = await t.core.context.buildInstructions(def!, s.dir, [], { projectId: s.projectId, sessionId: s.sessionId, runId: runB });
      expect(ctxB).toContain("comun-e2e");
      expect(ctxB).not.toContain("solo run A");
      const ctxA = await t.core.context.buildInstructions(def!, s.dir, [], { projectId: s.projectId, sessionId: s.sessionId, runId: s.runId });
      expect(ctxA).toContain("solo run A");
    } finally {
      await t.cleanup();
    }
  });

  test("tasks heredan la cadena del run; tasks de otro run no ven nada ajeno", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "ET");
      const w = await workerInstance(t, s.sessionId, s.runId, s.dir);
      const { plan } = await t.core.plans.createPlan({ sessionId: s.sessionId, projectId: s.projectId, objective: "O", structured: { objective: "O", steps: [{ title: "S1" }], acceptanceCriteria: ["done"] }, runId: s.runId, createdBy: "test" });
      const rev = (await t.core.plans.listRevisions(plan.id))[0]!;
      await t.core.plans.presentRevision(rev.id, "msg");
      await t.core.plans.requestApproval(plan.id, rev.id, s.sessionId, s.runId);
      const pending = await t.core.pendingApprovals(s.sessionId);
      await t.core.decideApproval(pending[pending.length - 1]!.id, "approved");
      const dag = await t.core.tasks.createDag({
        runId: s.runId,
        planId: plan.id,
        revisionId: (await t.core.plans.listRevisions(plan.id))[0]!.id,
        requestHash: "h-meme2e",
        tasks: [{ tempId: "e", title: "Explore area files", description: "Locate and read every file involved in the area. It must be long enough to pass validation rules.", agentRole: "explorer", priority: 1, dependencies: [], acceptanceCriteria: ["lists files version 1"], requiredTools: ["read"], writeScope: [], validationCommands: [], needsReview: false }],
      });
      const taskId = dag.taskIds[0]!;
      const tm = await t.core.memoryWriter.propose({ scope: "task", scopeId: taskId, category: "fact", topic: "hallazgo-e2e", content: "hay README", source: "delivery" }, agentCtx(s, w));
      await t.core.memoryWriter.validate(tm.id, s.coordId);
      const def = await t.core.registry.get("explorer");
      const shown = await t.core.context.buildInstructions(def!, s.dir, [], { projectId: s.projectId, sessionId: s.sessionId, runId: s.runId, taskId, instanceId: w });
      expect(shown).toContain("hallazgo-e2e");
      // Otra task (mismo run, distinto topic) no arrastra la ajena por scope.
      const other = await t.core.memoryWriter.propose({ scope: "task", scopeId: taskId, category: "fact", topic: "otro-tema", content: "zzz", source: "delivery" }, agentCtx(s, w));
      await t.core.memoryWriter.validate(other.id, s.coordId);
      const scoped = await t.core.context.buildInstructions(def!, s.dir, [], { projectId: s.projectId, sessionId: s.sessionId, runId: s.runId, taskId, instanceId: w });
      expect(scoped).toContain("hallazgo-e2e");
    } finally {
      await t.cleanup();
    }
  });
});

describe("etapa 6.5 — topes, secretos y gobernanza sin escritura autorizada", () => {
  test("topes del builder: 20 entradas + nota de omitidas", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "EL");
      for (let i = 0; i < 25; i++) {
        const e = await t.core.memoryWriter.propose({ scope: "project", scopeId: s.projectId, category: "fact", topic: `relleno-${i}`, content: `contenido ${i}`, source: "code" }, agentCtx(s, s.coordId));
        await t.core.memoryWriter.validate(e.id, s.coordId);
      }
      const def = await t.core.registry.get("coordinator-build");
      const text = await t.core.context.buildInstructions(def!, s.dir, [], { projectId: s.projectId, sessionId: s.sessionId, runId: s.runId, instanceId: s.coordId });
      const hits = (text.match(/<memory scope="project"/g) ?? []).length;
      expect(hits).toBe(20);
      expect(text).toContain("omitidas");
    } finally {
      await t.cleanup();
    }
  });

  test("sin escritura autorizada: worker no valida ni aprueba; solo propone", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "EW");
      const w = await workerInstance(t, s.sessionId, s.runId, s.dir);
      const e = await t.core.memoryWriter.propose({ scope: "run", scopeId: s.runId, category: "decision", topic: "d-w", content: "x", source: "delivery" }, agentCtx(s, w));
      expect(e.status).toBe("proposed");
      await expectRejects(t.core.memoryWriter.validate(e.id, w), /only the coordinator/i);
      await expectRejects(t.core.memoryWriter.supersede(e.id, { content: "y" }), /only verified, approved or stale/i);
      // El coordinador tampoco puede validar decisiones: solo el usuario.
      await expectRejects(t.core.memoryWriter.validate(e.id, s.coordId), /requires explicit user approval/i);
      const approved = await t.core.memoryWriter.decide(e.id, "approved");
      expect(approved.status).toBe("approved");
    } finally {
      await t.cleanup();
    }
  });

  test("secreto propuesto por tool se rechaza antes de persistir (permiso + servicio)", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "ES");
      const { memoryProposeTool } = await import("../src/memory/memory-tools.js");
      const w = await workerInstance(t, s.sessionId, s.runId, s.dir);
      await expectRejects(
        memoryProposeTool.run(
          { scope: "project", scopeId: s.projectId, category: "fact", topic: "deploy", content: "token: ghp_secreto123", source: "code" },
          { directory: t.dir, protectedRoots: [], projectId: s.projectId, sessionId: s.sessionId, runId: s.runId, instanceId: w, signal: new AbortController().signal, shellTimeoutMs: 1000, maxInlineChars: 1000, askQuestion: async () => [], services: { memory: { propose: (i: never, a: never) => t.core.memoryWriter.propose(i, a).then((e) => ({ id: e.id, status: e.status, scope: e.scope, category: e.category, topic: e.topic })), validate: (id: string, c: string) => t.core.memoryWriter.validate(id, c).then((e) => ({ id: e.id, status: e.status })) } } },
        ),
        /secret|credential/i,
      );
      expect(await t.core.memory.list({ scope: "project", scopeId: s.projectId })).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });
});
