import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { StreamEvent } from "@octus/shared";
import { autoAllow, makeTestCore, workspaceOf } from "./helpers.js";

describe("agent runtime (end to end with fakes)", () => {
  test("simple turn: prompt → stream → persisted history → run done", async () => {
    const t = await makeTestCore({ metaTurns: [{ text: "Hello there, all good." }] });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const stream: StreamEvent[] = [];
      const { runId } = await t.core.prompt(session.id, "Say hello", (e) => stream.push(e));
      await t.core.waitForIdle(session.id);
      const { run } = await t.core.getRun(runId);
      expect(run.status).toBe("done");
      expect(stream.some((e) => e.kind === "part.delta")).toBe(true);
      const messages = await t.core.sessionMessages(session.id);
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(JSON.stringify(messages[1])).toContain("Hello there");
      // Uso registrado aunque el fake no facture
      expect(await t.core.runUsage(runId)).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });

  test("tool loop: call id preserved, result returns to the model, model continues", async () => {
    const t = await makeTestCore({
      metaTurns: [
        { text: "Let me read it.", toolCalls: [{ name: "read", args: { path: "note.txt" }, providerCallId: "call_read_1" }] },
        { text: "The file says hello." },
      ],
    });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      writeFileSync(path.join(workspaceOf(t), "note.txt"), "hello file");
      await t.core.prompt(session.id, "Read note.txt");
      await t.core.waitForIdle(session.id);
      expect(t.fakeMeta.seen).toHaveLength(2);
      const second = t.fakeMeta.seen[1]!;
      const toolMsg = second.messages.find((m) => m.role === "tool")!;
      expect(toolMsg.blocks[0]).toMatchObject({ type: "tool_result", providerCallId: "call_read_1", ok: true });
      expect((toolMsg.blocks[0] as { text: string }).text).toContain("hello file");
      const messages = await t.core.sessionMessages(session.id);
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    } finally {
      await t.cleanup();
    }
  });

  test("retryable error retries the step without duplicating text", async () => {
    const t = await makeTestCore({
      metaTurns: [
        { text: "partial-", error: { code: "rate_limit", message: "slow down", retryable: true } },
        { text: "final answer" },
      ],
    });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const stream: StreamEvent[] = [];
      await t.core.prompt(session.id, "go", (e) => stream.push(e));
      await t.core.waitForIdle(session.id);
      const messages = await t.core.sessionMessages(session.id);
      const assistants = messages.filter((m) => m.role === "assistant");
      expect(assistants).toHaveLength(1);
      expect(JSON.stringify(assistants[0])).toContain("final answer");
      expect(JSON.stringify(assistants[0])).not.toContain("partial-");
      expect(stream.some((e) => e.kind === "step.retry")).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  test("non-retryable failure ends the run but preserves the conversation", async () => {
    const t = await makeTestCore({
      metaTurns: [{ error: { code: "bad_request", message: "invalid", retryable: false } }],
    });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const { runId } = await t.core.prompt(session.id, "go");
      await t.core.waitForIdle(session.id);
      const { run } = await t.core.getRun(runId);
      expect(run.status).toBe("failed");
      const messages = await t.core.sessionMessages(session.id);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe("user");
    } finally {
      await t.cleanup();
    }
  });

  test("declined permission ends the run as failed with a clear error", async () => {
    const t = await makeTestCore({
      metaTurns: [{ toolCalls: [{ name: "write", args: { path: "x.txt", content: "x" } }] }],
    });
    try {
      const stop = autoAllow(t.core, "reject");
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const { runId } = await t.core.prompt(session.id, "write x");
      await t.core.waitForIdle(session.id);
      stop();
      const { run } = await t.core.getRun(runId);
      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/declined/i);
    } finally {
      await t.cleanup();
    }
  });

  test("interrupt while blocked on a question cancels the run", async () => {
    const t = await makeTestCore({
      metaTurns: [{ toolCalls: [{ name: "question", args: { questions: [{ question: "Q?", header: "Q", options: [{ label: "A" }] }] } }] }],
    });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const { runId } = await t.core.prompt(session.id, "ask me");
      await Bun.sleep(150);
      expect(t.core.questions.pendingFor(session.id)).toHaveLength(1);
      await t.core.interrupt(session.id);
      const { run } = await t.core.getRun(runId);
      expect(run.status).toBe("cancelled");
    } finally {
      await t.cleanup();
    }
  });

  test("steering: a second prompt joins the active run and both are visible", async () => {
    const t = await makeTestCore({
      metaTurns: [
        { toolCalls: [{ name: "question", args: { questions: [{ question: "Q?", header: "Q", options: [{ label: "A" }] }] } }] },
        { text: "done with both" },
      ],
    });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const first = await t.core.prompt(session.id, "first message");
      await Bun.sleep(150);
      const second = await t.core.prompt(session.id, "second message");
      expect(second.runId).toBe(first.runId);
      const open = t.core.questions.pendingFor(session.id);
      expect(open).toHaveLength(1);
      await t.core.questions.reply(open[0]!.id, [{ question: "Q?", answers: ["A"] }], "cor_test");
      await t.core.waitForIdle(session.id);
      const last = t.fakeMeta.seen[t.fakeMeta.seen.length - 1]!;
      const userTexts = last.messages.filter((m) => m.role === "user").flatMap((m) => m.blocks.map((b) => (b as { text: string }).text ?? ""));
      expect(userTexts.join("\n")).toContain("first message");
      expect(userTexts.join("\n")).toContain("second message");
    } finally {
      await t.cleanup();
    }
  });

  test("compaction keeps the recent window and checkpoints the rest", async () => {
    const t = await makeTestCore({
      metaTurns: ((_callIndex: number, input: never) => {
        const messages = (input as unknown as { tools?: unknown[] }).tools;
        return messages ? { text: "fresh answer" } : { text: "CHECKPOINT of older work" };
      }) as never,
    });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const { runId, instanceId } = await (await import("./helpers.js")).makeRun(t, session.id);
      // 20 pares de mensajes (~150 tokens cada uno) directamente en el historial.
      for (let i = 0; i < 20; i++) {
        const userText = `old-message-${String(i).padStart(2, "0")} ` + "x".repeat(400);
        await t.core.db.exec(
          "INSERT INTO messages (id, session_id, run_id, instance_id, role, parts, trust, seq, created_at) VALUES (?, ?, ?, ?, 'user', ?, 'user', ?, 1)",
          [`msg-u-${i}`, session.id, runId, instanceId, JSON.stringify([{ type: "text", text: userText }]), i * 2],
        );
        await t.core.db.exec(
          "INSERT INTO messages (id, session_id, run_id, instance_id, role, parts, trust, seq, created_at) VALUES (?, ?, ?, ?, 'assistant', ?, 'tool', ?, 1)",
          [`msg-a-${i}`, session.id, runId, instanceId, JSON.stringify([{ type: "text", text: `reply-${i}` }]), i * 2 + 1],
        );
      }
      const { AgentRuntime } = await import("../src/runtime/agent-runtime.js");
      const runtime = new AgentRuntime(t.core.db, t.core.events, t.core.bus, t.core.router, t.core.gateway, t.core.context, {
        compactionThresholdRatio: 0.004, // techo ~4200 tokens: base (~2700) cabe, base+historial (~5600) no
        compactionKeepTokens: 120,
      });
      const result = await runtime.runInstance(instanceId, { signal: new AbortController().signal, correlationId: "cor_compact", onStream: () => undefined });
      expect(result.status).toBe("completed");
      // El coordinador compacta la conversación de sesión (clave de sesión, no de instancia).
      const cutoff = await t.core.context.sessionCompactionCutoff(session.id);
      expect(cutoff.checkpoint).toContain("CHECKPOINT");
      // La generación real recibió checkpoint + tramo reciente, sin lo antiguo.
      const generation = t.fakeMeta.seen.find((s) => (s.tools?.length ?? 0) > 0)!;
      expect(generation).toBeDefined();
      const first = generation.messages[0]!;
      expect(first.role).toBe("developer");
      expect(JSON.stringify(first)).toContain("CHECKPOINT");
      const full = JSON.stringify(generation.messages);
      expect(full).toContain("old-message-19");
      expect(full).not.toContain("old-message-00");
      // Dos llamadas con coste registrado: compactación + generación.
      expect(await t.core.runUsage(runId)).toHaveLength(2);
    } finally {
      await t.cleanup();
    }
  });
});
