import { describe, expect, test } from "bun:test";
import type { Message } from "@octus/shared";
import { toNormalized } from "../src/runtime/context-builder.js";

function msg(overrides: Partial<Message> & { id: string }): Message {
  return {
    sessionId: "ses",
    runId: "run",
    instanceId: "ins",
    role: "assistant",
    parts: [],
    trust: "tool",
    seq: 0,
    createdAt: 1,
    ...overrides,
  } as Message;
}

describe("toNormalized (llamadas huérfanas)", () => {
  test("descarta tool_calls sin tool_result para no romper al proveedor (400)", () => {
    const out = toNormalized([
      msg({
        id: "m1",
        parts: [{ type: "tool_call", toolCallId: "tc-dead", name: "shell", argumentsJson: "{}" }],
      }),
      msg({ id: "m2", role: "user", parts: [{ type: "text", text: "continua" }] }),
    ]);
    // m1 queda vacío (solo la huérfana) y se omite; m2 pasa como user.
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });

  test("conserva texto y llamadas pareadas, y omite solo la huérfana", () => {
    const out = toNormalized([
      msg({
        id: "m1",
        parts: [
          { type: "text", text: "voy" },
          { type: "tool_call", toolCallId: "tc-ok", name: "read", argumentsJson: "{}" },
          { type: "tool_call", toolCallId: "tc-dead", name: "shell", argumentsJson: "{}" },
        ],
      }),
      msg({
        id: "m2",
        role: "tool",
        parts: [{ type: "tool_result", toolCallId: "tc-ok", providerCallId: "call_1", ok: true, text: "x" }],
      }),
    ]);
    const assistant = out.find((m) => m.role === "assistant")!;
    expect(assistant.toolCalls?.map((c) => c.providerCallId)).toEqual(["call_1"]);
    expect(out.filter((m) => m.role === "tool")).toHaveLength(1);
  });
});
