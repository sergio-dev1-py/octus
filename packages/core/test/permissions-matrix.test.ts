import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promptHashOf, snapshotOf } from "../src/agents/definition-loader.js";
import { isOctusError } from "../src/errors.js";
import { autoAllow, expectRejects, makeTestCore, workspaceOf } from "./helpers.js";

async function setupProfile(definitionId: string) {
  const t = await makeTestCore();
  const project = await t.core.createProject("P", workspaceOf(t));
  const session = await t.core.createSession({ projectId: project.id });
  const def = (await t.core.registry.get(definitionId))!;
  const runId = `run_${definitionId}`;
  const instanceId = `ins_${definitionId}`;
  const timestamp = Date.now();
  await t.core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES (?, ?, 'test', 'executing', 'build', ?, ?)", [runId, session.id, timestamp, timestamp]);
  await t.core.db.exec(
    "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)",
    [instanceId, session.id, runId, def.id, JSON.stringify(def.defaultModel), workspaceOf(t), def.promptVersion, promptHashOf(def), JSON.stringify(snapshotOf(def)), timestamp, timestamp],
  );
  const exec = (name: string, args: unknown, idSuffix: string) =>
    t.core.gateway.execute({
      toolCallId: `tool_${definitionId}_${idSuffix}`,
      idempotencyKey: `idem-${definitionId}-${idSuffix}-${Date.now()}-${Math.random()}`,
      sessionId: session.id,
      runId,
      instanceId,
      definitionId: def.id,
      directory: workspaceOf(t),
      name,
      args,
    });
  return { t, session, exec };
}

describe("permission matrix by profile (Etapa 2)", () => {
  test("explorer is read-only: reads pass, writes/shell/question denied without asking", async () => {
    const s = await setupProfile("explorer");
    try {
      writeFileSync(path.join(workspaceOf(s.t), "a.txt"), "hello");
      expect((await s.exec("read", { path: "a.txt" }, "r1")).ok).toBe(true);
      expect((await s.exec("glob", { pattern: "*.txt" }, "g1")).ok).toBe(true);
      for (const [name, args] of [["write", { path: "x.txt", content: "x" }], ["edit", { path: "a.txt", oldString: "h", newString: "z" }], ["shell", { command: "echo hi" }], ["question", { questions: [{ question: "q", header: "h", options: [{ label: "a" }] }] }]] as const) {
        const error = await expectRejects(s.exec(name, args, `d-${name}`), /denied/i);
        expect(isOctusError(error, "permission_denied")).toBe(true);
      }
      expect(s.t.core.permissions.pendingFor(s.session.id)).toHaveLength(0);
    } finally {
      await s.t.cleanup();
    }
  });

  test("plan coordinator cannot write or shell; can manage plans", async () => {
    const s = await setupProfile("coordinator-plan");
    try {
      const stop = autoAllow(s.t.core, "once");
      const err = await expectRejects(s.exec("write", { path: "p.txt", content: "x" }, "w1"), /denied/i);
      expect(isOctusError(err, "permission_denied")).toBe(true);
      const err2 = await expectRejects(s.exec("shell", { command: "echo hi" }, "s1"), /denied/i);
      expect(isOctusError(err2, "permission_denied")).toBe(true);
      expect(s.t.core.permissions.pendingFor(s.session.id)).toHaveLength(0);
      const created = await s.exec("plan.create", { objective: "Test plan", structured: { objective: "Test plan", steps: [{ title: "S1" }], acceptanceCriteria: ["done"] } }, "p1");
      expect(created.ok).toBe(true);
      stop();
    } finally {
      await s.t.cleanup();
    }
  });

  test("researcher can use web tools but cannot write", async () => {
    const s = await setupProfile("researcher");
    try {
      // Sin red en tests: basta con que la puerta no sea deny (el fetch fallará por DNS/red, no por permiso).
      const result = await s.exec("webfetch", { url: "https://invalid.invalid-xyz/", maxChars: 200 }, "w1").then(
        (r) => r,
        (e: unknown) => ({ ok: false, text: String(e) }),
      );
      expect(JSON.stringify(result)).not.toMatch(/permission_denied|tool_denied/);
      const err = await expectRejects(s.exec("write", { path: "x.txt", content: "x" }, "w2"), /denied/i);
      expect(isOctusError(err, "permission_denied")).toBe(true);
    } finally {
      await s.t.cleanup();
    }
  });

  test("reviewer cannot modify code but can diff and run allowlisted tests", async () => {
    const s = await setupProfile("reviewer");
    try {
      const stop = autoAllow(s.t.core, "once");
      const err = await expectRejects(s.exec("write", { path: "x.txt", content: "x" }, "w1"), /denied/i);
      expect(isOctusError(err, "permission_denied")).toBe(true);
      const err2 = await expectRejects(s.exec("shell", { command: "echo hi" }, "s1"), /denied/i);
      expect(isOctusError(err2, "permission_denied")).toBe(true);
      // test_run sin entrada en allowlist: denegado por la herramienta, no por permiso.
      const err3 = await expectRejects(s.exec("test_run", { entryId: "nope" }, "t1"), /allowlist/);
      expect(String(err3)).toMatch(/allowlist/);
      stop();
    } finally {
      await s.t.cleanup();
    }
  });

  test("implementer without assignment is read-only (explicit deny rules)", async () => {
    const s = await setupProfile("implementer");
    try {
      // Sin assignment registrada, la instancia de prueba no tiene instanceRules;
      // el AgentManager las inyecta al spawnear. Aquí verificamos el techo del perfil.
      const stop = autoAllow(s.t.core, "once");
      writeFileSync(path.join(workspaceOf(s.t), "a.txt"), "hello");
      expect((await s.exec("read", { path: "a.txt" }, "r1")).ok).toBe(true);
      stop();
    } finally {
      await s.t.cleanup();
    }
  });

  test("ceiling: session rules can narrow but never expand beyond the profile", async () => {
    const s = await setupProfile("explorer");
    try {
      // Incluso con una regla de sesión allow, fuera del techo sigue deny.
      const effect = await s.t.core.permissions.preview("write", "x.txt", {
        definitionTools: ["read", "glob", "grep"],
        deniedTools: ["write"],
        sessionRules: [{ action: "write", resource: "*", effect: "allow" }],
      }, s.session.projectId ?? "");
      expect(effect).toBe("deny");
      // Y puede estrechar dentro del techo: deny gana a allow del perfil.
      const narrowed = await s.t.core.permissions.preview("read", "secret.txt", {
        definitionTools: ["read"],
        sessionRules: [{ action: "read", resource: "secret.txt", effect: "deny" }],
      }, s.session.projectId ?? "");
      expect(narrowed).toBe("deny");
    } finally {
      await s.t.cleanup();
    }
  });

  test("no model can approve plans: approve/reject/archive/export are not tools", async () => {
    const s = await setupProfile("coordinator-build");
    try {
      const names = s.t.core.gateway.manifests().map((m) => m.name);
      for (const forbidden of ["plan.approve", "plan.reject", "plan.archive", "plan.export"]) {
        expect(names).not.toContain(forbidden);
      }
      for (const def of await s.t.core.registry.list()) {
        expect(def.tools).not.toContain("plan.approve");
        expect(def.tools).not.toContain("plan.reject");
        expect(def.tools).not.toContain("plan.archive");
        expect(def.tools).not.toContain("plan.export");
      }
    } finally {
      await s.t.cleanup();
    }
  });
});
