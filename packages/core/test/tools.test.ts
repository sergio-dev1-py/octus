import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isOctusError } from "../src/errors.js";
import { autoAllow, expectRejects, makeRun, makeTestCore, workspaceOf } from "./helpers.js";

async function setup() {
  const t = await makeTestCore();
  const project = await t.core.createProject("P", workspaceOf(t));
  const session = await t.core.createSession({ projectId: project.id });
  const { runId, instanceId } = await makeRun(t, session.id);
  return { t, project, session, runId, instanceId };
}

function baseRequest(t: Awaited<ReturnType<typeof setup>>, name: string, args: unknown, toolCallId = `tool_${name}_1`) {
  return {
    toolCallId,
    idempotencyKey: `idem-${toolCallId}`,
    sessionId: t.session.id,
    runId: t.runId,
    instanceId: t.instanceId,
    definitionId: "coordinator-build",
    directory: workspaceOf(t.t),
    name,
    args,
  };
}

describe("tool gateway", () => {
  test("read/glob/grep run without asking (profile allow)", async () => {
    const t = await setup();
    try {
      writeFileSync(path.join(workspaceOf(t.t), "a.txt"), "hello\nworld\n");
      const read = await t.t.core.gateway.execute(baseRequest(t, "read", { path: "a.txt" }));
      expect(read.ok).toBe(true);
      expect(read.text).toContain("1: hello");
      const glob = await t.t.core.gateway.execute(baseRequest(t, "glob", { pattern: "*.txt" }));
      expect(glob.text).toContain("a.txt");
      const grep = await t.t.core.gateway.execute(baseRequest(t, "grep", { pattern: "wor.d" }));
      expect(grep.text).toContain("a.txt:2");
    } finally {
      await t.t.cleanup();
    }
  });

  test("write asks once: approved run writes, then always-rule skips asking", async () => {
    const t = await setup();
    try {
      const stop = autoAllow(t.t.core, "once");
      const first = await t.t.core.gateway.execute(baseRequest(t, "write", { path: "w.txt", content: "one" }, "tool_w_1"));
      expect(first.ok).toBe(true);
      expect(readFileSync(path.join(workspaceOf(t.t), "w.txt"), "utf8")).toBe("one");
      stop();
      // ask de nuevo sin auto-respuesta pendiente: respondemos always a mano
      const second = t.t.core.gateway.execute(baseRequest(t, "write", { path: "w.txt", content: "two" }, "tool_w_2"));
      await Bun.sleep(50);
      const pending = t.t.core.permissions.pendingFor(t.session.id);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.detail).toContain("w.txt");
      t.t.core.permissions.reply(pending[0]!.id, "always");
      expect((await second).ok).toBe(true);
      // Tercera escritura en el mismo recurso: sin pregunta
      const third = await t.t.core.gateway.execute(baseRequest(t, "write", { path: "w.txt", content: "three" }, "tool_w_3"));
      expect(third.ok).toBe(true);
      expect(t.t.core.permissions.pendingFor(t.session.id)).toHaveLength(0);
      expect(readFileSync(path.join(workspaceOf(t.t), "w.txt"), "utf8")).toBe("three");
    } finally {
      await t.t.cleanup();
    }
  });

  test("reject ends as tool_denied with a stored record", async () => {
    const t = await setup();
    try {
      const stop = autoAllow(t.t.core, "reject");
      const error = await expectRejects(t.t.core.gateway.execute(baseRequest(t, "write", { path: "x.txt", content: "x" })), /declined|reject/i);
      expect(isOctusError(error, "tool_denied")).toBe(true);
      stop();
      const row = await t.t.core.db.queryOne<Record<string, string>>("SELECT status FROM tool_invocations WHERE id = ?", ["tool_write_1"]);
      expect(row?.status).toBe("denied");
    } finally {
      await t.t.cleanup();
    }
  });

  test("edit enforces exact-match rules", async () => {
    const t = await setup();
    try {
      const stop = autoAllow(t.t.core, "once");
      writeFileSync(path.join(workspaceOf(t.t), "e.txt"), "aaa bbb aaa");
      await expectRejects(t.t.core.gateway.execute(baseRequest(t, "edit", { path: "e.txt", oldString: "aaa", newString: "zzz" }, "tool_e_1")), /2 times/);
      const result = await t.t.core.gateway.execute(baseRequest(t, "edit", { path: "e.txt", oldString: "aaa", newString: "zzz", replaceAll: true }, "tool_e_2"));
      expect(result.ok).toBe(true);
      expect(readFileSync(path.join(workspaceOf(t.t), "e.txt"), "utf8")).toBe("zzz bbb zzz");
      stop();
    } finally {
      await t.t.cleanup();
    }
  });

  test("idempotency: same key never re-executes the effect", async () => {
    const t = await setup();
    try {
      const stop = autoAllow(t.t.core, "once");
      const request = baseRequest(t, "write", { path: "i.txt", content: "first" }, "tool_i_1");
      expect((await t.t.core.gateway.execute(request)).ok).toBe(true);
      const replay = await t.t.core.gateway.execute({ ...request, toolCallId: "tool_i_1b", args: { path: "i.txt", content: "SECOND" } });
      expect(replay.ok).toBe(true);
      expect(readFileSync(path.join(workspaceOf(t.t), "i.txt"), "utf8")).toBe("first");
      stop();
    } finally {
      await t.t.cleanup();
    }
  });

  test("plan profile cannot write even with approval (deny, not ask)", async () => {
    const t = await setup();
    try {
      const stop = autoAllow(t.t.core, "once");
      // Instancia real del perfil plan: la identidad de la instancia manda, no el parámetro.
      const def = (await t.t.core.registry.get("coordinator-plan"))!;
      const { snapshotOf, promptHashOf } = await import("../src/agents/definition-loader.js");
      const planInstanceId = "ins_plan_profile";
      await t.t.core.db.exec(
        "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, 1, 1)",
        [planInstanceId, t.session.id, t.runId, def.id, JSON.stringify(def.defaultModel), workspaceOf(t.t), def.promptVersion, promptHashOf(def), JSON.stringify(snapshotOf(def))],
      );
      const request = { ...baseRequest(t, "write", { path: "p.txt", content: "x" }), definitionId: "coordinator-plan", instanceId: planInstanceId };
      const error = await expectRejects(t.t.core.gateway.execute(request), /denied/i);
      expect(isOctusError(error, "permission_denied")).toBe(true);
      expect(t.t.core.permissions.pendingFor(t.session.id)).toHaveLength(0);
      stop();
    } finally {
      await t.t.cleanup();
    }
  });

  test("question tool round-trips answers", async () => {
    const t = await setup();
    try {
      const pending = t.t.core.gateway.execute(
        baseRequest(t, "question", { questions: [{ question: "Pick one", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] }),
      );
      await Bun.sleep(50);
      const open = t.t.core.questions.pendingFor(t.session.id);
      expect(open).toHaveLength(1);
      await t.t.core.questions.reply(open[0]!.id, [{ question: "Pick one", answers: ["B"] }], "cor_test");
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(result.text).toContain('"B"');
    } finally {
      await t.t.cleanup();
    }
  });
});
