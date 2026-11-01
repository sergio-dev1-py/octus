import { describe, expect, test } from "bun:test";
import {
  appendMessage,
  applyPartDelta,
  applyPartDone,
  applyStepRetry,
  buildPromptText,
  cancelReasonOf,
  emptyFrame,
  purgeRunFrames,
  windowMessages,
  type LiveMap,
} from "../src/renderer/src/timeline.js";
import type { Message } from "@octus/shared";

function msg(id: string, sessionId = "s1", runId = "r1"): Message {
  return {
    id,
    sessionId,
    runId,
    instanceId: "i1",
    role: "assistant",
    parts: [{ type: "text", text: "hi" }],
    trust: "user",
    seq: 1,
    createdAt: 1,
  };
}

/** Todo 13: marcos de streaming, purga terminal, ventana e idempotencia. */

describe("streaming frames (N-C-12a/12b)", () => {
  test("deltas accumulate with streaming status; done closes frames", () => {
    let live: LiveMap = {};
    live = applyPartDelta(live, { kind: "part.delta", sessionId: "s", runId: "r", instanceId: "i", messageId: "m", part: "text", delta: "Hel" });
    live = applyPartDelta(live, { kind: "part.delta", sessionId: "s", runId: "r", instanceId: "i", messageId: "m", part: "text", delta: "lo" });
    expect(live["m"]!.text).toBe("Hello");
    expect(live["m"]!.textStatus).toBe("streaming");
    live = applyPartDelta(live, { kind: "part.delta", sessionId: "s", runId: "r", instanceId: "i", messageId: "m", part: "reasoning_summary", delta: "plan" });
    expect(live["m"]!.reasoning).toBe("plan");
    // tool_call.started llega como delta vacío: la llamada en vuelo ya es visible.
    live = applyPartDelta(live, { kind: "part.delta", sessionId: "s", runId: "r", instanceId: "i", messageId: "m", part: "tool_arguments", key: "call_1", delta: "" });
    expect(live["m"]!.tools["call_1"]!.status).toBe("streaming");
    live = applyPartDelta(live, { kind: "part.delta", sessionId: "s", runId: "r", instanceId: "i", messageId: "m", part: "tool_arguments", key: "call_1", delta: "{\"a\":1}" });
    expect(live["m"]!.tools["call_1"]!.args).toBe("{\"a\":1}");
    // part.done cierra cada marco sin borrar su contenido.
    live = applyPartDone(live, { kind: "part.done", sessionId: "s", runId: "r", instanceId: "i", messageId: "m", part: "tool_arguments", key: "call_1" });
    expect(live["m"]!.tools["call_1"]!.status).toBe("done");
    expect(live["m"]!.tools["call_1"]!.args).toBe("{\"a\":1}");
    live = applyPartDone(live, { kind: "part.done", sessionId: "s", runId: "r", instanceId: "i", messageId: "m", part: "text" });
    expect(live["m"]!.textStatus).toBe("done");
    expect(live["m"]!.text).toBe("Hello");
  });

  test("part.done on unknown frame and step.retry reset are safe", () => {
    const live: LiveMap = {};
    expect(applyPartDone(live, { kind: "part.done", sessionId: "s", runId: "r", instanceId: "i", messageId: "nope", part: "text" })).toEqual({});
    const seeded: LiveMap = { m: { ...emptyFrame("m", "s", "r"), text: "stale" } };
    const retried = applyStepRetry(seeded, { kind: "step.retry", sessionId: "s", runId: "r", instanceId: "i", messageId: "m", attempt: 2, reason: "x" });
    expect(retried["m"]!.text).toBe("");
    expect(retried["m"]!.textStatus).toBe("streaming");
  });
});

describe("terminal purge (cancel_resume, sin fantasma ni duplicado)", () => {
  test("cancel mid-stream clears only that run; message.appended never duplicates", () => {
    let live: LiveMap = {};
    live = applyPartDelta(live, { kind: "part.delta", sessionId: "s", runId: "r-cancel", instanceId: "i", messageId: "m1", part: "text", delta: "half" });
    live = applyPartDelta(live, { kind: "part.delta", sessionId: "s", runId: "r-other", instanceId: "i", messageId: "m2", part: "text", delta: "keep" });
    live = purgeRunFrames(live, "r-cancel");
    expect(live["m1"]).toBeUndefined();
    expect(live["m2"]!.text).toBe("keep");
    // El historial inserta una vez aunque el evento llegue dos veces.
    let history = [msg("a")];
    history = appendMessage(history, msg("b"));
    history = appendMessage(history, msg("b"));
    expect(history.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("virtualized window (N-C-06)", () => {
  test("only the last N render; counts stay exact", () => {
    const all = Array.from({ length: 250 }, (_, i) => msg(`m${i}`));
    const win = windowMessages(all, 100);
    expect(win.length).toBe(100);
    expect(win[0]!.id).toBe("m150");
    expect(win[99]!.id).toBe("m249");
    expect(windowMessages(all, 0)).toEqual([]);
    expect(windowMessages([msg("x")], 100).length).toBe(1);
  });
});

describe("composer attachments + cancel reason (N-C-12c)", () => {
  test("attachments inline as fenced blocks; prompt untouched without them", () => {
    expect(buildPromptText("  hola  ", [])).toBe("hola");
    const full = buildPromptText("revisa", [{ id: "1", name: "notas.txt", size: 4, text: "hola" }]);
    expect(full).toBe("revisa\n\nAdjunto notas.txt:\n```\nhola\n```");
  });

  test("cancel reason surfaces user interrupt by default", () => {
    expect(cancelReasonOf({ status: "cancelled" })).toBe("Cancelado por el usuario");
    expect(cancelReasonOf({ status: "cancelled", error: "  " })).toBe("Cancelado por el usuario");
    expect(cancelReasonOf({ status: "cancelled", error: "timeout: sin actividad" })).toBe("timeout: sin actividad");
    expect(cancelReasonOf(undefined)).toBe("Cancelado por el usuario");
  });
});
