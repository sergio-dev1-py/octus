/** Fixture del test chat-clean (todo workbench-chat-terminal/3): monta el ChatView
 * REAL con el CSS real. `?state=empty` siembra sesión nueva sin mensajes ni runs;
 * `?state=working` siembra conversación con tool calls + instancias padre→hija;
 * `?state=failed` siembra el run fallido con tool_result en error.
 */
import { render } from "solid-js/web";
import { ChatView } from "../../src/renderer/src/views/chat.jsx";
import "../../src/renderer/src/styles.css";
import { setState } from "../../src/renderer/src/store.js";

const variant = new URLSearchParams(location.search).get("state") ?? "empty";

setState("sessions", [
  { id: "ses_t3", projectId: "proj_t3", title: "Sesión todo 3", directory: "/tmp/octus-t3", profile: "build", createdAt: 1, updatedAt: 2 },
] as never);
setState("activeSessionId", "ses_t3");

if (variant === "working" || variant === "failed") {
  const failed = variant === "failed";
  setState("runs", [
    {
      id: "run_t3",
      sessionId: "ses_t3",
      prompt: "implementa el login",
      status: failed ? "failed" : "running",
      mode: "build",
      error: failed ? "provider timeout tras 30 s" : undefined,
      createdAt: 3,
      updatedAt: 4,
    },
  ] as never);
  setState("agentInstances", [
    {
      id: "ins_root",
      sessionId: "ses_t3",
      runId: "run_t3",
      definitionId: "explorer",
      status: "completed",
      model: { providerId: "p", modelId: "m" },
      directory: "/tmp/octus-t3",
      definitionVersion: 1,
      promptHash: "h",
      definitionSnapshot: {},
      createdAt: 5,
      updatedAt: 6,
    },
    {
      id: "ins_leaf",
      sessionId: "ses_t3",
      runId: "run_t3",
      definitionId: "implementer",
      parentInstanceId: "ins_root",
      status: failed ? "failed" : "running",
      error: failed ? "provider timeout tras 30 s" : undefined,
      model: { providerId: "p", modelId: "m" },
      directory: "/tmp/octus-t3",
      definitionVersion: 1,
      promptHash: "h",
      definitionSnapshot: {},
      createdAt: 7,
      updatedAt: 8,
    },
  ] as never);
  setState("messages", [
    {
      id: "msg_user",
      sessionId: "ses_t3",
      runId: "run_t3",
      instanceId: "ins_root",
      role: "user",
      parts: [{ type: "text", text: "implementa el login" }],
      trust: "user",
      seq: 1,
      createdAt: 9,
    },
    {
      id: "msg_asst",
      sessionId: "ses_t3",
      runId: "run_t3",
      instanceId: "ins_leaf",
      role: "assistant",
      parts: [
        { type: "text", text: "Voy a implementar el login con validación." },
        { type: "tool_call", toolCallId: "tc_t3", name: "read", argumentsJson: JSON.stringify({ path: "src/login.ts" }) },
        {
          type: "tool_result",
          toolCallId: "tc_t3",
          providerCallId: "call_1",
          ok: !failed,
          text: failed ? "provider timeout tras 30 s" : "42 líneas, exporta validateLogin",
        },
      ],
      trust: "tool",
      seq: 2,
      createdAt: 10,
    },
  ] as never);
}

render(() => <ChatView />, document.getElementById("root")!);
