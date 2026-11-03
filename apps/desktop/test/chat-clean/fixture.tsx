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

if (variant === "working" || variant === "failed" || variant === "completed") {
  const failed = variant === "failed";
  const completed = variant === "completed";
  setState("runs", [
    {
      id: "run_t3",
      sessionId: "ses_t3",
      prompt: "implementa el login",
      status: failed ? "failed" : completed ? "done" : "executing",
      mode: "build",
      error: failed ? "provider timeout tras 30 s" : undefined,
      createdAt: 3,
      updatedAt: completed ? 10_000 : 4,
      completedAt: completed ? 10_000 : undefined,
    },
  ] as never);
  setState("agentInstances", [
    {
      id: "ins_root",
      sessionId: "ses_t3",
      runId: "run_t3",
      definitionId: "explorer",
      status: "completed",
      model: { providerId: "meta", modelId: "muse-spark-1.3" },
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
      status: failed ? "failed" : completed ? "completed" : "running",
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
      instanceId: "ins_root",
      role: "assistant",
      parts: [{ type: "text", text: "Delego la implementación del login en un implementer." }],
      trust: "tool",
      seq: 2,
      createdAt: 10,
    },
    {
      id: "msg_leaf",
      sessionId: "ses_t3",
      runId: "run_t3",
      instanceId: "ins_leaf",
      role: "assistant",
      parts: [
        { type: "tool_call", toolCallId: "tc_t3", name: "read", argumentsJson: JSON.stringify({ path: "src/login.ts" }) },
        {
          type: "tool_result",
          toolCallId: "tc_t3",
          providerCallId: "call_1",
          ok: !failed,
          text: failed ? "provider timeout tras 30 s" : "42 líneas, exporta validateLogin",
        },
        ...(completed
          ? [
              { type: "tool_call", toolCallId: "tc_diff", name: "edit", argumentsJson: JSON.stringify({ path: "components/Header.tsx", oldString: "old", newString: "new" }) },
              {
                type: "tool_result",
                toolCallId: "tc_diff",
                providerCallId: "call_diff",
                ok: true,
                text: "Replaced 1 occurrence(s) in components/Header.tsx",
                diff: { path: "components/Header.tsx", before: "const title = \"old\";\n", after: "const title = \"new\";\n" },
              },
            ]
          : []),
      ],
      trust: "tool",
      seq: 1,
      createdAt: 11,
    },
  ] as never);
  if (completed) {
    const records = [
      {
        id: "use_root",
        providerId: "meta",
        modelId: "muse-spark-1.3",
        agentDefinitionId: "coordinator-build",
        agentInstanceId: "ins_root",
        runId: "run_t3",
        sessionId: "ses_t3",
        messageId: "msg_asst",
        inputTokens: 1200,
        outputTokens: 300,
        reasoningTokens: 0,
        cachedTokens: 0,
        durationMs: 5000,
        status: "completed",
        costMicroUsd: null,
        pricingMissing: true,
      },
      {
        id: "use_leaf",
        providerId: "meta",
        modelId: "muse-spark-1.3",
        agentDefinitionId: "implementer",
        agentInstanceId: "ins_leaf",
        runId: "run_t3",
        sessionId: "ses_t3",
        messageId: "msg_leaf",
        inputTokens: 800,
        outputTokens: 120,
        reasoningTokens: 0,
        cachedTokens: 0,
        durationMs: 3000,
        status: "completed",
        costMicroUsd: null,
        pricingMissing: true,
      },
    ];
    setState("usageByRun", { run_t3: records } as never);
  }
}

render(() => <ChatView />, document.getElementById("root")!);
