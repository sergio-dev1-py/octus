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

describe("etapa 6.3 — coordinador de recuperación", () => {
  test("recoveryStatus en vacío es cero; reconcileRecovery converge sin nada pendiente", async () => {
    const t = await makeTestCore();
    try {
      expect(await t.core.recoveryStatus()).toEqual({ pendingOps: 0, startedPromotions: 0, livePreviews: 0, staleMemories: 0, pendingContradictions: 0 });
      const rec = await t.core.reconcileRecovery();
      expect(rec.previews).toEqual({ orphaned: 0 });
      expect(rec.memory).toEqual({ checked: 0, markedStale: [] });
      expect(rec.orphanedPlans).toBe(0);
    } finally {
      await t.cleanup();
    }
  });

  test("previews huérfanos se marcan al arrancar (settle incluye previews.reconcile)", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "R1");
      const now = Date.now();
      await t.core.db.exec("INSERT INTO repositories (id, project_id, root_path, worktrees_root, created_at, updated_at) VALUES ('repo_r1', ?, ?, ?, ?, ?)", [s.projectId, s.dir, `${s.dir}/wt`, now, now]);
      await t.core.db.exec(
        "INSERT INTO integrations (id, project_id, repository_id, run_id, target_branch, target_base_commit, integration_branch, canonical_path, attempt, supersedes, status, created_at, updated_at) VALUES ('int_r1', ?, 'repo_r1', ?, 'main', ?, 'harness/integration/seed', ?, 0, NULL, 'building', ?, ?)",
        [s.projectId, s.runId, "0".repeat(40), `${s.dir}/int`, now, now],
      );
      await t.core.db.exec(
        "INSERT INTO previews (id, integration_id, sha, canonical_path, argv, port, url, status, log_path, created_at, updated_at) VALUES ('prv_r1', 'int_r1', ?, ?, '[]', 54111, 'http://127.0.0.1:54111', 'running', ?, ?, ?)",
        ["1".repeat(40), `${s.dir}/pv`, `${s.dir}/pv.log`, now, now],
      );
      expect((await t.core.previews.getPreview("prv_r1")).status).toBe("running");
      await t.core.close();
      const { OctusCore } = await import("../src/sessions/octus-core.js");
      const { MemorySecretStore } = await import("../src/secrets/secret-store.js");
      const core2 = await OctusCore.create({ dataDir: path.join(t.dir, "data"), primarySecrets: new MemorySecretStore(), providers: [t.fakeMeta, t.fakeGo] });
      try {
        // El run con integración abierta sobrevive; el preview sin proceso se marca huérfano.
        expect((await core2.db.queryOne<{ status: string }>("SELECT status FROM runs WHERE id = ?", [s.runId]))!.status).toBe("executing");
        expect((await core2.previews.getPreview("prv_r1")).status).toBe("orphaned");
      } finally {
        await core2.close().catch(() => undefined);
      }
    } finally {
      await t.cleanup().catch(() => undefined);
    }
  });

  test("memory sweep al arrancar marca stale sin tocar contenido", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "R2");
      const file = path.join(s.dir, "notas.md");
      writeFileSync(file, "v1\n");
      const { createHash } = await import("node:crypto");
      const hash = createHash("sha256").update("v1\n").digest("hex");
      const entry = await t.core.memoryWriter.propose(
        { scope: "session", scopeId: s.sessionId, category: "fact", topic: "notas", content: "resumen v1", source: "doc", originRef: { path: "notas.md", contentHash: hash } },
        agentCtx(s, s.coordId),
      );
      await t.core.memoryWriter.validate(entry.id, s.coordId);
      writeFileSync(file, "v2 cambió\n");
      expect((await t.core.recoveryStatus()).staleMemories).toBe(0);
      await t.core.close();
      const { OctusCore } = await import("../src/sessions/octus-core.js");
      const { MemorySecretStore } = await import("../src/secrets/secret-store.js");
      const core2 = await OctusCore.create({ dataDir: path.join(t.dir, "data"), primarySecrets: new MemorySecretStore(), providers: [t.fakeMeta, t.fakeGo] });
      try {
        const after = await core2.memory.get(entry.id);
        expect(after.status).toBe("stale");
        expect(after.content).toBe("resumen v1");
        expect((await core2.recoveryStatus()).staleMemories).toBe(1);
      } finally {
        await core2.close().catch(() => undefined);
      }
    } finally {
      await t.cleanup().catch(() => undefined);
    }
  });
});

describe("etapa 6.2 — selección de memoria (FINAL-1/FINAL-3)", () => {
  let n = 0;
  const item = (over: Partial<import("@octus/shared").MemoryItem>): import("@octus/shared").MemoryItem => {
    n += 1;
    return {
      id: `mem_t${n}`,
      scope: "project",
      scopeId: "p1",
      category: "fact",
      topic: "t",
      content: "c",
      source: "code",
      originRef: {},
      status: "verified",
      confidence: "medium",
      version: 1,
      createdAt: n,
      updatedAt: n,
      ...over,
    };
  };

  test("ordinarias verified en todo scope entran; proposed/rejected/stale/superseded no", async () => {
    const { selectForContext } = await import("../src/memory/memory-select.js");
    const ctx = { projectId: "p1", sessionId: "s1", runId: "r1", taskId: "t1", instanceId: "i1" };
    for (const [scope, scopeId] of [["project", "p1"], ["session", "s1"], ["run", "r1"], ["task", "t1"], ["instance", "i1"]] as const) {
      const { selected } = selectForContext([item({ scope, scopeId })], ctx);
      expect(selected, scope).toHaveLength(1);
    }
    for (const status of ["proposed", "rejected", "stale", "superseded"] as const) {
      const { selected } = selectForContext([item({ status })], ctx);
      expect(selected, status).toHaveLength(0);
    }
    // approved ordinaria también entra.
    expect(selectForContext([item({ status: "approved" })], ctx).selected).toHaveLength(1);
  });

  test("decision/instruction: solo approved; verified no basta", async () => {
    const { selectForContext } = await import("../src/memory/memory-select.js");
    const ctx = { projectId: "p1" };
    expect(selectForContext([item({ category: "decision", status: "verified" })], ctx).selected).toHaveLength(0);
    expect(selectForContext([item({ category: "decision", status: "approved" })], ctx).selected).toHaveLength(1);
    expect(selectForContext([item({ category: "instruction", status: "verified" })], ctx).selected).toHaveLength(0);
    expect(selectForContext([item({ category: "instruction", status: "approved" })], ctx).selected).toHaveLength(1);
    // verified nunca se auto-convierte: el selector no cambia estados.
    const cand = item({ category: "decision", status: "verified" });
    selectForContext([cand], ctx);
    expect(cand.status).toBe("verified");
  });

  test("scopes ajenos jamás entran", async () => {
    const { selectForContext } = await import("../src/memory/memory-select.js");
    const ctx = { projectId: "p1", sessionId: "s1" };
    expect(selectForContext([item({ scope: "session", scopeId: "s9" })], ctx).selected).toHaveLength(0);
    expect(selectForContext([item({ scope: "project", scopeId: "p9" })], ctx).selected).toHaveLength(0);
    expect(selectForContext([item({ scope: "run", scopeId: "r1" })], { projectId: "p1" }).selected).toHaveLength(0);
  });

  test("checkpoints solo del run/task/instance en curso", async () => {
    const { selectForContext } = await import("../src/memory/memory-select.js");
    const ctx = { projectId: "p1", sessionId: "s1", runId: "r1", taskId: "t1", instanceId: "i1" };
    expect(selectForContext([item({ category: "checkpoint", scope: "run", scopeId: "r1" })], ctx).selected).toHaveLength(1);
    expect(selectForContext([item({ category: "checkpoint", scope: "run", scopeId: "r9" })], ctx).selected).toHaveLength(0);
    expect(selectForContext([item({ category: "checkpoint", scope: "instance", scopeId: "i1" })], ctx).selected).toHaveLength(1);
    // Checkpoint de proyecto/sesión no es punto de recuperación: fuera.
    expect(selectForContext([item({ category: "checkpoint", scope: "project", scopeId: "p1" })], ctx).selected).toHaveLength(0);
    expect(selectForContext([item({ category: "checkpoint", scope: "session", scopeId: "s1" })], ctx).selected).toHaveLength(0);
  });

  test("contradicción pendiente excluye el grupo; sin nota entra; resuelta vuelve", async () => {
    const { selectForContext } = await import("../src/memory/memory-select.js");
    const ctx = { projectId: "p1" };
    const a = item({ status: "approved", topic: "db", content: "sqlite", reviewNote: "contradiction pending vs mem_t2" });
    const b = item({ status: "approved", topic: "db", content: "postgres", reviewNote: "contradiction pending vs mem_t1" });
    const both = selectForContext([a, b], ctx);
    expect(both.selected).toHaveLength(0);
    expect(both.dropped).toBe(0);
    // Sin nota: ambas entran (no hay contradicción marcada).
    const c = item({ status: "approved", topic: "db", content: "sqlite" });
    const d = item({ status: "approved", topic: "db", content: "postgres" });
    expect(selectForContext([c, d], ctx).selected).toHaveLength(2);
    // Una sola con nota y sin hermanas: entra.
    expect(selectForContext([a], ctx).selected).toHaveLength(1);
  });

  test("topes: recientes primero, maxEntries y maxChars", async () => {
    const { selectForContext } = await import("../src/memory/memory-select.js");
    const ctx = { projectId: "p1" };
    const entries = [item({ topic: "viejo", content: "x".repeat(10), updatedAt: 1 }), item({ topic: "nuevo", content: "y".repeat(10), updatedAt: 2 })];
    const one = selectForContext(entries, ctx, { maxEntries: 1 });
    expect(one.selected.map((e) => e.topic)).toEqual(["nuevo"]);
    expect(one.dropped).toBe(1);
    const chars = selectForContext(entries, ctx, { maxChars: 15 });
    expect(chars.selected.map((e) => e.topic)).toEqual(["nuevo"]);
    expect(chars.dropped).toBe(1);
    expect(selectForContext(entries, {}).selected).toHaveLength(0);
  });

  test("buildInstructions inyecta memoria del contexto y nada ajeno", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "C1");
      const fact = await t.core.memoryWriter.propose({ scope: "project", scopeId: s.projectId, category: "fact", topic: "stack-bun", content: "bun 1.4", source: "code" }, agentCtx(s, s.coordId));
      await t.core.memoryWriter.validate(fact.id, s.coordId);
      const dec = await t.core.memoryWriter.propose({ scope: "project", scopeId: s.projectId, category: "decision", topic: "db-elegida", content: "sqlite WAL", source: "user" }, agentCtx(s, s.coordId));
      await t.core.memoryWriter.decide(dec.id, "approved");
      // Otra sesión: memoria que no debe filtrarse.
      const other = await setup(t, "C2");
      const alien = await t.core.memoryWriter.propose({ scope: "project", scopeId: other.projectId, category: "fact", topic: "ajeno-total", content: "x", source: "code" }, agentCtx(other, other.coordId));
      await t.core.memoryWriter.validate(alien.id, other.coordId);
      const def = await t.core.registry.get("explorer");
      const text = await t.core.context.buildInstructions(def!, t.dir, [], { projectId: s.projectId, sessionId: s.sessionId, runId: s.runId });
      expect(text).toContain("stack-bun");
      expect(text).toContain("db-elegida");
      expect(text).not.toContain("ajeno-total");
      expect(text).toMatch(/<memory scope="project"/);
    } finally {
      await t.cleanup();
    }
  });

  test("buildInstructions excluye grupo en contradicción y lo muestra tras resolver", async () => {
    const t = await makeTestCore();
    try {
      const s = await setup(t, "C3");
      const mk = async (content: string) => {
        const e = await t.core.memoryWriter.propose({ scope: "session", scopeId: s.sessionId, category: "fact", topic: "endpoint", content, source: "delivery" }, agentCtx(s, s.coordId));
        return t.core.memoryWriter.validate(e.id, s.coordId);
      };
      const winner = await mk("https://api-v2");
      const loser = await mk("https://api-v1");
      // Marca contradicción manualmente como haría approveEntry (fact+fact vía decide).
      await t.core.memory.setReviewNote(winner.id, "contradiction pending vs test", "governance");
      await t.core.memory.setReviewNote(loser.id, "contradiction pending vs test", "governance");
      const def = await t.core.registry.get("explorer");
      const hidden = await t.core.context.buildInstructions(def!, t.dir, [], { projectId: s.projectId, sessionId: s.sessionId });
      expect(hidden).not.toContain("api-v1");
      expect(hidden).not.toContain("api-v2");
      await t.core.memoryWriter.resolveConflict(winner.id, "v2 vigente");
      const shown = await t.core.context.buildInstructions(def!, t.dir, [], { projectId: s.projectId, sessionId: s.sessionId });
      expect(shown).toContain("api-v2");
      expect(shown).not.toContain("api-v1");
    } finally {
      await t.cleanup();
    }
  });
});
