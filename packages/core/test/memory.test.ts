/** Etapa 6.1 — MemoryService + MemoryWriter + gobernanza + tools (fakes, sin modelos). */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectRejects, makeRun, makeTestCore, type TestCore } from "./helpers.js";
import { memoryProposeTool, memoryValidateTool } from "../src/memory/memory-tools.js";
import type { ToolRunContext } from "../src/tools/tool-definitions.js";

async function setup(t: TestCore, name = "M"): Promise<{ projectId: string; sessionId: string; runId: string; coordId: string; dir: string }> {
  const dir = path.join(t.dir, `ws-${name}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  const project = await t.core.createProject(`P-${name}`, dir);
  const session = await t.core.createSession({ projectId: project.id, directory: dir, title: `S-${name}` });
  const { runId, instanceId: coordId } = await makeRun(t, session.id);
  return { projectId: project.id, sessionId: session.id as string, runId, coordId, dir };
}

async function workerInstance(t: TestCore, sessionId: string, runId: string, dir: string): Promise<string> {
  const id = `ins_w_${Math.random().toString(36).slice(2, 8)}`;
  await t.core.db.exec(
    "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES (?, ?, ?, 'implementer', 'running', ?, ?, 1, 'h', '{}', 1, 1)",
    [id, sessionId, runId, JSON.stringify({ providerId: "fake-meta", modelId: "muse-wonder-1.0" }), dir],
  );
  return id;
}

function agentCtx(s: { projectId: string; sessionId: string; runId: string }, instanceId: string) {
  return { projectId: s.projectId, sessionId: s.sessionId, runId: s.runId, instanceId };
}

/** La pregunta se registra tras awaits internos: esperar a que aparezca. */
async function untilQuestion(t: TestCore, sessionId: string, toolCallId: string) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const req = t.core.questions.pendingFor(sessionId).find((q) => q.toolCallId === toolCallId);
    if (req) return req;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for question ${toolCallId}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function toolCtx(s: { projectId: string; sessionId: string; runId: string }, instanceId: string, t: TestCore): ToolRunContext {
  return {
    directory: t.dir,
    protectedRoots: [],
    projectId: s.projectId,
    sessionId: s.sessionId,
    runId: s.runId,
    instanceId,
    signal: new AbortController().signal,
    shellTimeoutMs: 30_000,
    maxInlineChars: 50_000,
    askQuestion: async () => [],
    services: {
      memory: {
        propose: async (input, agent) => {
          const entry = await t.core.memoryWriter.propose(input as never, agent);
          return { id: entry.id, status: entry.status, scope: entry.scope, category: entry.category, topic: entry.topic };
        },
        validate: async (id, coordinatorInstanceId) => {
          const entry = await t.core.memoryWriter.validate(id, coordinatorInstanceId);
          return { id: entry.id, status: entry.status };
        },
      },
    },
  };
}

describe("etapa 6.1 — propose y lectura", () => {
  test("propose crea proposed + emite memory.recorded; get/list funcionan", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "P1");
      const entry = await t.core.memoryWriter.propose(
        { scope: "project", scopeId: s.projectId, category: "fact", topic: "stack", content: "Node 20 + bun", source: "code" },
        agentCtx(s, s.coordId),
      );
      expect(entry.status).toBe("proposed");
      expect(entry.version).toBe(1);
      expect((await t.core.memory.get(entry.id)).topic).toBe("stack");
      expect((await t.core.memory.list({ scope: "project", scopeId: s.projectId }))).toHaveLength(1);
      expect((await t.core.memory.list({ scope: "project", scopeId: s.projectId, status: "approved" }))).toHaveLength(0);
      const events = await t.core.db.query<{ type: string }>("SELECT type FROM events WHERE aggregate_id = ? ORDER BY seq ASC", [entry.id]);
      expect(events.map((e) => e.type)).toContain("memory.recorded");
    } finally {
      await t.cleanup();
    }
  });

  test("propose rechaza scope inexistente (sin filas huérfanas)", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "P2");
      await expectRejects(t.core.memory.get("mem_missing"), /not_found|not found/i);
      await expectRejects(t.core.memory.setStatus("mem_missing", "verified"), /not_found|not found/i);
      // Scope ajeno: la procedencia falla antes que la existencia.
      await expectRejects(
        t.core.memoryWriter.propose({ scope: "session", scopeId: "ses_missing", category: "fact", topic: "t", content: "c", source: "code" }, agentCtx(s, s.coordId)),
        /does not match the agent session/i,
      );
    } finally {
      await t.cleanup();
    }
  });

  test("P1: subagente no puede validar lo propio ni lo ajeno (solo coordinador)", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "P3");
      const worker = await workerInstance(t, s.sessionId, s.runId, s.dir);
      const entry = await t.core.memoryWriter.propose(
        { scope: "run", scopeId: s.runId, category: "fact", topic: "nota", content: "halo", source: "delivery" },
        agentCtx(s, worker),
      );
      expect(entry.status).toBe("proposed");
      await expectRejects(t.core.memoryWriter.validate(entry.id, worker), /only the coordinator/i);
    } finally {
      await t.cleanup();
    }
  });

  test("coordinador valida ordinaria → verified; decision/instruction exigen usuario", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "P4");
      const fact = await t.core.memoryWriter.propose({ scope: "project", scopeId: s.projectId, category: "fact", topic: "stack", content: "bun", source: "code" }, agentCtx(s, s.coordId));
      const verified = await t.core.memoryWriter.validate(fact.id, s.coordId);
      expect(verified.status).toBe("verified");
      const decision = await t.core.memoryWriter.propose({ scope: "project", scopeId: s.projectId, category: "decision", topic: "db", content: "usar sqlite", source: "user" }, agentCtx(s, s.coordId));
      await expectRejects(t.core.memoryWriter.validate(decision.id, s.coordId), /requires explicit user approval/i);
      expect((await t.core.memory.get(decision.id)).status).toBe("proposed");
    } finally {
      await t.cleanup();
    }
  });

  test("deny-list: secretos aparentes se rechazan y jamás se persisten", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "P5");
      await expectRejects(
        t.core.memoryWriter.propose({ scope: "project", scopeId: s.projectId, category: "fact", topic: "deploy", content: "api_key = AKIA-SECRET-XYZ", source: "code" }, agentCtx(s, s.coordId)),
        /secret/i,
      );
      expect(await t.core.memory.list({ scope: "project", scopeId: s.projectId })).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });

  test("procedencia: scopes ajenos al linaje se rechazan", async () => {
    const t = await makeTestCore();
    try {
      const a = await setup(t, "PA");
      const b = await setup(t, "PB");
      // Sesión de otro proyecto.
      await expectRejects(
        t.core.memoryWriter.propose({ scope: "session", scopeId: b.sessionId, category: "fact", topic: "t", content: "c", source: "code" }, agentCtx(a, a.coordId)),
        /does not match the agent session|outside/i,
      );
      // Tasks reales en cada run (DAG mínimo de exploradora).
      const mkTask = async (s: { projectId: string; sessionId: string; runId: string }, hash: string) => {
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
          requestHash: hash,
          tasks: [{ tempId: "e", title: "Explore area files", description: "Locate and read every file involved in the area. It must be long enough to pass validation rules.", agentRole: "explorer", priority: 1, dependencies: [], acceptanceCriteria: ["lists files version 1"], requiredTools: ["read"], writeScope: [], validationCommands: [], needsReview: false }],
        });
        return dag.taskIds[0]!;
      };
      const taskA = await mkTask(a, "h-mema");
      const taskB = await mkTask(b, "h-memb");
      const okTask = await t.core.memoryWriter.propose({ scope: "task", scopeId: taskA, category: "fact", topic: "hallazgo", content: "hay un README", source: "delivery" }, agentCtx(a, a.coordId));
      expect(okTask.status).toBe("proposed");
      await expectRejects(
        t.core.memoryWriter.propose({ scope: "task", scopeId: taskB, category: "fact", topic: "t", content: "c", source: "delivery" }, agentCtx(a, a.coordId)),
        /outside the agent run/i,
      );
      // Instancia ajena.
      await expectRejects(
        t.core.memoryWriter.propose({ scope: "instance", scopeId: b.coordId, category: "checkpoint", topic: "t", content: "c", source: "delivery" }, agentCtx(a, a.coordId)),
        /does not match/i,
      );
    } finally {
      await t.cleanup();
    }
  });
});

describe("etapa 6.1 — gobernanza (P2)", () => {
  test("requestApproval con approve → approved; contradiction marca review_note en hermanas", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "G1");
      const first = await t.core.memoryWriter.propose({ scope: "project", scopeId: s.projectId, category: "decision", topic: "db", content: "usar sqlite", source: "user" }, agentCtx(s, s.coordId));
      const pending = t.core.memoryWriter.requestApproval(first.id, { sessionId: s.sessionId, runId: s.runId, instanceId: s.coordId });
      const req = await untilQuestion(t, s.sessionId, `mem-${first.id}`);
      expect(req).toBeDefined();
      await t.core.questions.reply(req.id, [{ question: req.questions[0]!.question, answers: ["approve"] }], "cor_test");
      const { approved, entry } = await pending;
      expect(approved).toBe(true);
      expect(entry.status).toBe("approved");
      // Segunda decisión contradictoria sobre mismo scope+topic.
      const second = await t.core.memoryWriter.propose({ scope: "project", scopeId: s.projectId, category: "decision", topic: "db", content: "usar postgres", source: "user" }, agentCtx(s, s.coordId));
      const pending2 = t.core.memoryWriter.requestApproval(second.id, { sessionId: s.sessionId, runId: s.runId, instanceId: s.coordId });
      const req2 = await untilQuestion(t, s.sessionId, `mem-${second.id}`);
      await t.core.questions.reply(req2.id, [{ question: req2.questions[0]!.question, answers: ["approve"] }], "cor_test");
      const done2 = await pending2;
      expect(done2.entry.status).toBe("approved");
      expect(done2.entry.reviewNote).toMatch(/contradiction pending/i);
      expect((await t.core.memory.get(first.id)).reviewNote).toMatch(/contradiction pending/i);
    } finally {
      await t.cleanup();
    }
  });

  test("requestApproval con reject → rejected; timeout → sigue proposed con nota", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "G2");
      const one = await t.core.memoryWriter.propose({ scope: "session", scopeId: s.sessionId, category: "instruction", topic: "estilo", content: "tabs", source: "user" }, agentCtx(s, s.coordId));
      const p1 = t.core.memoryWriter.requestApproval(one.id, { sessionId: s.sessionId, runId: s.runId, instanceId: s.coordId });
      const req = await untilQuestion(t, s.sessionId, `mem-${one.id}`);
      await t.core.questions.reply(req.id, [{ question: req.questions[0]!.question, answers: ["reject"] }], "cor_test");
      const r1 = await p1;
      expect(r1.approved).toBe(false);
      expect(r1.entry.status).toBe("rejected");
      const two = await t.core.memoryWriter.propose({ scope: "session", scopeId: s.sessionId, category: "instruction", topic: "estilo2", content: "tabs", source: "user" }, agentCtx(s, s.coordId));
      const r2 = await t.core.memoryWriter.requestApproval(two.id, { sessionId: s.sessionId, runId: s.runId, instanceId: s.coordId, timeoutMs: 80 });
      expect(r2.approved).toBe(false);
      expect(r2.reason).toBe("timeout");
      const kept = await t.core.memory.get(two.id);
      expect(kept.status).toBe("proposed");
      expect(kept.reviewNote).toMatch(/timed out/i);
    } finally {
      await t.cleanup();
    }
  });

  test("decide directo del usuario: verified/approved/rejected; verified denegado en decision", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "G3");
      const fact = await t.core.memoryWriter.propose({ scope: "run", scopeId: s.runId, category: "fact", topic: "f", content: "c", source: "code" }, agentCtx(s, s.coordId));
      expect((await t.core.memoryWriter.decide(fact.id, "verified")).status).toBe("verified");
      const dec = await t.core.memoryWriter.propose({ scope: "run", scopeId: s.runId, category: "decision", topic: "d", content: "c", source: "user" }, agentCtx(s, s.coordId));
      await expectRejects(t.core.memoryWriter.decide(dec.id, "verified"), /requires approved/i);
      expect((await t.core.memoryWriter.decide(dec.id, "approved")).status).toBe("approved");
    } finally {
      await t.cleanup();
    }
  });

  test("trigger: retrocesos bloqueados; setStatus emite memory.status_changed", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "G4");
      const fact = await t.core.memoryWriter.propose({ scope: "project", scopeId: s.projectId, category: "fact", topic: "f", content: "c", source: "code" }, agentCtx(s, s.coordId));
      await t.core.memoryWriter.validate(fact.id, s.coordId);
      // Retrocesos ilegales: verified→proposed y approved→verified.
      await expectRejects(t.core.memory.setStatus(fact.id, "proposed"), /illegal status transition/i);
      const approved = await t.core.memoryWriter.decide(fact.id, "approved");
      expect(approved.status).toBe("approved");
      await expectRejects(t.core.memory.setStatus(fact.id, "verified"), /illegal status transition/i);
      const events = await t.core.db.query<{ type: string }>("SELECT type FROM events WHERE aggregate_id = ?", [fact.id]);
      expect(events.map((e) => e.type)).toContain("memory.status_changed");
    } finally {
      await t.cleanup();
    }
  });

  test("resolveConflict: ganadora limpia, perdedoras a stale sin borrar", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "G5");
      const mk = async (content: string) => {
        const e = await t.core.memoryWriter.propose({ scope: "project", scopeId: s.projectId, category: "decision", topic: "db", content, source: "user" }, agentCtx(s, s.coordId));
        return t.core.memoryWriter.decide(e.id, "approved");
      };
      const winner = await mk("sqlite");
      const loser = await mk("postgres");
      expect((await t.core.memory.get(loser.id)).reviewNote).toMatch(/contradiction/i);
      const resolved = await t.core.memoryWriter.resolveConflict(winner.id, "se mantiene sqlite por decisión de producto");
      expect(resolved.reviewNote).toBeUndefined();
      const loserAfter = await t.core.memory.get(loser.id);
      expect(loserAfter.status).toBe("stale");
      expect(loserAfter.content).toBe("postgres");
    } finally {
      await t.cleanup();
    }
  });
});

describe("etapa 6.1 — versiones y revalidación", () => {
  test("supersede: nueva versión proposed + anterior superseded; cadena intacta", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "V1");
      const v1 = await t.core.memoryWriter.propose({ scope: "project", scopeId: s.projectId, category: "fact", topic: "stack", content: "Node 20", source: "code" }, agentCtx(s, s.coordId));
      const verified = await t.core.memoryWriter.validate(v1.id, s.coordId);
      const v2 = await t.core.memoryWriter.supersede(verified.id, { content: "Node 22" }, "coordinator");
      expect(v2.version).toBe(2);
      expect(v2.status).toBe("proposed");
      expect(v2.supersedes).toBe(v1.id);
      expect((await t.core.memory.get(v1.id)).status).toBe("superseded");
      // Superseder una proposed se niega (sin cadena que versionar).
      const draft = await t.core.memoryWriter.propose({ scope: "project", scopeId: s.projectId, category: "fact", topic: "x", content: "y", source: "code" }, agentCtx(s, s.coordId));
      await expectRejects(t.core.memoryWriter.supersede(draft.id, { content: "z" }), /only verified, approved or stale/i);
    } finally {
      await t.cleanup();
    }
  });

  test("revalidate con hash: sin cambios conserva; cambio marca stale sin tocar contenido", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "V2");
      const file = path.join(s.dir, "stack.md");
      writeFileSync(file, "stack: bun\n");
      const hash = createHash("sha256").update("stack: bun\n").digest("hex");
      const entry = await t.core.memoryWriter.propose(
        { scope: "project", scopeId: s.projectId, category: "fact", topic: "stack", content: "stack bun", source: "doc", originRef: { path: "stack.md", contentHash: hash } },
        agentCtx(s, s.coordId),
      );
      await t.core.memoryWriter.validate(entry.id, s.coordId);
      const same = await t.core.memoryWriter.revalidate(entry.id);
      expect(same.changed).toBe(false);
      expect((await t.core.memory.get(entry.id)).status).toBe("verified");
      writeFileSync(file, "stack: deno\n");
      const changed = await t.core.memoryWriter.revalidate(entry.id);
      expect(changed.changed).toBe(true);
      const stale = await t.core.memory.get(entry.id);
      expect(stale.status).toBe("stale");
      expect(stale.content).toBe("stack bun");
      expect(stale.reviewNote).toMatch(/origin content changed/i);
      // Coincide de nuevo → vuelve a verified.
      writeFileSync(file, "stack: bun\n");
      const back = await t.core.memoryWriter.revalidate(entry.id);
      expect(back.changed).toBe(false);
      expect((await t.core.memory.get(entry.id)).status).toBe("verified");
    } finally {
      await t.cleanup();
    }
  });

  test("revalidate: fichero ausente y commit inalcanzable marcan stale; sin origen no aplica", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "V3");
      const missing = await t.core.memoryWriter.propose(
        { scope: "session", scopeId: s.sessionId, category: "fact", topic: "doc", content: "c", source: "doc", originRef: { path: "gone.md", contentHash: createHash("sha256").update("x").digest("hex") } },
        agentCtx(s, s.coordId),
      );
      await t.core.memoryWriter.validate(missing.id, s.coordId);
      const r1 = await t.core.memoryWriter.revalidate(missing.id);
      expect(r1.changed).toBe(true);
      expect((await t.core.memory.get(missing.id)).status).toBe("stale");
      const noOrigin = await t.core.memoryWriter.propose({ scope: "session", scopeId: s.sessionId, category: "fact", topic: "n", content: "c", source: "user" }, agentCtx(s, s.coordId));
      await t.core.memoryWriter.validate(noOrigin.id, s.coordId);
      const r2 = await t.core.memoryWriter.revalidate(noOrigin.id);
      expect(r2.applied).toBe(false);
      expect((await t.core.memory.get(noOrigin.id)).status).toBe("verified");
    } finally {
      await t.cleanup();
    }
  });

  test("revalidate con commit: alcanzable conserva; inexistente marca stale", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "V4");
      execFileSync("git", ["init", "-b", "main"], { cwd: s.dir, timeout: 30_000 });
      execFileSync("git", ["config", "user.email", "t@octus.local"], { cwd: s.dir, timeout: 30_000 });
      execFileSync("git", ["config", "user.name", "Octus Test"], { cwd: s.dir, timeout: 30_000 });
      execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: s.dir, timeout: 30_000 });
      writeFileSync(path.join(s.dir, "a.txt"), "a\n");
      execFileSync("git", ["add", "."], { cwd: s.dir, timeout: 30_000 });
      execFileSync("git", ["commit", "-m", "init"], { cwd: s.dir, timeout: 30_000 });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: s.dir, encoding: "utf8", timeout: 30_000 }).trim();
      const ok = await t.core.memoryWriter.propose(
        { scope: "project", scopeId: s.projectId, category: "fact", topic: "repo", content: "repo git", source: "code", originRef: { commit: sha } },
        agentCtx(s, s.coordId),
      );
      await t.core.memoryWriter.validate(ok.id, s.coordId);
      expect((await t.core.memoryWriter.revalidate(ok.id)).changed).toBe(false);
      const bad = await t.core.memoryWriter.propose(
        { scope: "project", scopeId: s.projectId, category: "fact", topic: "repo2", content: "x", source: "code", originRef: { commit: "0".repeat(40) } },
        agentCtx(s, s.coordId),
      );
      await t.core.memoryWriter.validate(bad.id, s.coordId);
      const r = await t.core.memoryWriter.revalidate(bad.id);
      expect(r.changed).toBe(true);
      expect((await t.core.memory.get(bad.id)).status).toBe("stale");
    } finally {
      await t.cleanup();
    }
  });
});

describe("etapa 6.1 — tools y definiciones", () => {
  test("memory_propose crea provisional; memory_validate solo coordinador y solo ordinarias", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "T1");
      const worker = await workerInstance(t, s.sessionId, s.runId, s.dir);
      const out = await memoryProposeTool.run(
        { scope: "project", scopeId: s.projectId, category: "fact", topic: "stack", content: "bun", source: "code" },
        toolCtx(s, worker, t),
      );
      expect(out.text).toMatch(/provisional|proposed/i);
      const listed = await t.core.memory.list({ scope: "project", scopeId: s.projectId });
      expect(listed).toHaveLength(1);
      expect(listed[0]!.status).toBe("proposed");
      // Worker no puede validar (kind check a nivel servicio, no solo YAML).
      await expectRejects(memoryValidateTool.run({ id: listed[0]!.id }, toolCtx(s, worker, t)), /only the coordinator/i);
      // Coordinador sí; decision vía tool se niega.
      const validated = await memoryValidateTool.run({ id: listed[0]!.id }, toolCtx(s, s.coordId, t));
      expect(validated.text).toMatch(/verified/i);
      const dec = await memoryProposeTool.run(
        { scope: "project", scopeId: s.projectId, category: "decision", topic: "db", content: "sqlite", source: "user" },
        toolCtx(s, s.coordId, t),
      );
      expect(dec.text).toMatch(/proposed/i);
      const decEntry = (await t.core.memory.list({ scope: "project", scopeId: s.projectId, category: "decision" }))[0]!;
      await expectRejects(memoryValidateTool.run({ id: decEntry.id }, toolCtx(s, s.coordId, t)), /requires explicit user approval/i);
    } finally {
      await t.cleanup();
    }
  });

  test("tool rechaza scope ajeno (procedencia a nivel servicio)", async () => {
    const t = await makeTestCore();
    try {
      const a = await setup(t, "TA");
      const b = await setup(t, "TB");
      const worker = await workerInstance(t, a.sessionId, a.runId, a.dir);
      await expectRejects(
        memoryProposeTool.run({ scope: "session", scopeId: b.sessionId, category: "fact", topic: "t", content: "c", source: "code" }, toolCtx(a, worker, t)),
        /scope_violation|outside|match/i,
      );
    } finally {
      await t.cleanup();
    }
  });

  test("definiciones: memory_propose en los 6 perfiles; memory_validate solo coordinadores", async () => {
    const t = await makeTestCore();
    try {
      for (const id of ["coordinator-build", "coordinator-plan", "explorer", "researcher", "implementer", "reviewer"]) {
        const def = await t.core.registry.get(id);
        expect(def, `missing ${id}`).toBeDefined();
        expect(def!.tools).toContain("memory_propose");
      }
      expect((await t.core.registry.get("coordinator-build"))!.tools).toContain("memory_validate");
      expect((await t.core.registry.get("coordinator-plan"))!.tools).toContain("memory_validate");
      for (const id of ["explorer", "researcher", "implementer", "reviewer"]) {
        expect((await t.core.registry.get(id))!.tools).not.toContain("memory_validate");
      }
    } finally {
      await t.cleanup();
    }
  });
});
