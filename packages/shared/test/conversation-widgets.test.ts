/**
 * Widgets de conversación (Todo 14): helpers puros sobre eventos y tipos reales.
 * Datos fijos espejo de la especificación del Todo 4 (msg_qa01, tc_qa01, apr_qa01, que_qa01).
 */
import { describe, expect, test } from "bun:test";
import {
  buildSubagentTree,
  indexToolResults,
  isSessionEmpty,
  messageRenderItems,
  approvalGateForRevision,
  collectModifiedFiles,
  collectRunErrors,
  formatTimeoutRemainingMs,
  formatToolDurationMs,
  mayGrantApproval,
  orderPendingQuestions,
  pairToolParts,
  questionTimeoutRemainingMs,
  subagentLineage,
  subagentRollup,
  summarizeAgentActivity,
  toolStatusMeta,
  type ModifiedFile,
} from "../src/conversation-widgets.js";
import type { MessagePart, ToolCallRecord } from "../src/domain.js";

const TC_QA01 = {
  id: "tc_qa01",
  sessionId: "ses_qa01",
  runId: "run_qa01",
  instanceId: "ins_qa01",
  name: "read",
  argumentsJson: JSON.stringify({ path: "src/form.ts" }),
  status: "completed" as const,
  idempotencyKey: "idem_qa01",
  permission: { decision: "allow" as const },
  resultText: "42 líneas, exporta validateForm",
  startedAt: 1000,
  completedAt: 1320,
};

describe("widgets de conversación (Todo 14)", () => {
  test("happy: los 6 estados de ToolCallRecord tienen etiqueta y tono", () => {
    const tones = {
      pending: "muted",
      running: "warn",
      completed: "ok",
      failed: "err",
      denied: "err",
      cancelled: "muted",
    } as const;
    for (const [status, tone] of Object.entries(tones)) {
      const meta = toolStatusMeta(status as ToolCallRecord["status"]);
      expect(meta.label).toBe(status);
      expect(meta.tone).toBe(tone);
    }
    expect(toolStatusMeta("completed").terminal).toBe(true);
    expect(toolStatusMeta("running").terminal).toBe(false);
  });

  test("happy: duración de tc_qa01 = 320 ms; en curso y sin inicio degradan", () => {
    expect(formatToolDurationMs(TC_QA01.startedAt, TC_QA01.completedAt)).toBe("320 ms");
    expect(formatToolDurationMs(1000, 2500)).toBe("1.5 s");
    expect(formatToolDurationMs(1000, undefined)).toBe("en curso");
    expect(formatToolDurationMs(undefined, undefined)).toBe("—");
  });

  test("happy: empareja tool_call con su tool_result por toolCallId", () => {
    const parts: MessagePart[] = [
      { type: "text", text: "Voy a añadir la validación con zod…" },
      { type: "tool_call", toolCallId: "tc_qa01", name: "read", argumentsJson: JSON.stringify({ path: "src/form.ts" }) },
      { type: "tool_result", toolCallId: "tc_qa01", providerCallId: "call_1", ok: true, text: "42 líneas, exporta validateForm" },
      { type: "tool_call", toolCallId: "tc_qa02", name: "shell", argumentsJson: "{}" },
    ];
    const paired = pairToolParts(parts);
    expect(paired).toHaveLength(2);
    expect(paired[0]!.result?.ok).toBe(true);
    expect(paired[1]!.result).toBeUndefined();
  });

  test("happy: revisión presentada y pendiente es decidible por el humano", () => {
    const gate = approvalGateForRevision({ lifecycle: "presented", approval: "pending" }, { status: "pending" });
    expect(gate.decidable).toBe(true);
  });

  test("failure: fuera de revisión o ya decidida no es decidible (idempotencia)", () => {
    expect(approvalGateForRevision({ lifecycle: "unpresented", approval: "pending" }).decidable).toBe(false);
    expect(approvalGateForRevision({ lifecycle: "presented", approval: "approved" }).decidable).toBe(false);
    expect(approvalGateForRevision({ lifecycle: "orphaned", approval: "pending" }).decidable).toBe(false);
    expect(approvalGateForRevision({ lifecycle: "presented", approval: "pending" }, { status: "decided" }).decidable).toBe(false);
  });

  test("ningún modelo concede aprobaciones: solo el gesto humano decide", () => {
    expect(mayGrantApproval("human-gesture")).toBe(true);
    expect(mayGrantApproval("model-tool")).toBe(false);
    expect(mayGrantApproval("unknown")).toBe(false);
  });

  test("happy: timeout de pregunta que_qa01 con 300 s por defecto", () => {
    expect(questionTimeoutRemainingMs(0, 60_000)).toBe(240_000);
    expect(formatTimeoutRemainingMs(240_000)).toBe("4m 0s left");
    expect(formatTimeoutRemainingMs(45_000)).toBe("45s left");
    expect(questionTimeoutRemainingMs(0, 300_001)).toBeLessThanOrEqual(0);
    expect(formatTimeoutRemainingMs(-1)).toBe("expired");
  });

  test("happy: actividad resume instancias reales por estado", () => {
    const summary = summarizeAgentActivity([
      { id: "ins_qa_impl", sessionId: "s", runId: "r", definitionId: "implementer", status: "running" },
      { id: "ins_qa_wait", sessionId: "s", runId: "r", definitionId: "reviewer", status: "waiting_input" },
      { id: "ins_qa_done", sessionId: "s", runId: "r", definitionId: "explorer", status: "completed" },
    ] as never);
    expect(summary.active).toBe(2);
    expect(summary.total).toBe(3);
    expect(summary.byStatus.running).toBe(1);
  });

  test("happy: errores unifican run failed, tarea bloqueada e incidente raised", () => {
    const items = collectRunErrors({
      runs: [{ id: "run_qa02", sessionId: "s", prompt: "x", status: "failed", mode: "build", error: "provider timeout tras 30 s", createdAt: 1, updatedAt: 9 }],
      tasks: [{ id: "tsk_qa03", runId: "run_qa02", planningId: "p", planId: "pl", revisionId: "rev", title: "t", description: "d", agentRole: "implementer", priority: 1, acceptanceCriteria: [], requiredTools: [], writeScope: [], validationCommands: [], needsReview: false, status: "blocked", blockedReason: "needs-approval", attempt: 0, createdAt: 1, updatedAt: 8 }],
      instances: [],
      raised: [{ id: "evt_1", message: "fila corrupta omitida", aggregateId: "ses_qa01", at: 7 }],
    } as never);
    expect(items.map((item) => item.id)).toEqual(["run-run_qa02", "task-tsk_qa03", "raised-evt_1"]);
    expect(items[0]!.scope).toBe("run");
  });

  test("failure: run cancelado muestra su estado final, nunca progreso congelado", () => {
    const items = collectRunErrors({
      runs: [{ id: "run_qa03", sessionId: "s", prompt: "x", status: "cancelled", mode: "build", createdAt: 1, updatedAt: 5 }],
      tasks: [],
      instances: [],
      raised: [],
    } as never);
    expect(items).toHaveLength(1);
    expect(items[0]!.message).toContain("cancelled");
  });

  test("happy: archivos modificados desde artifacts de intentos y de tools", () => {
    const files: ModifiedFile[] = collectModifiedFiles(
      [
        {
          taskId: "tsk_qa02",
          attempt: 1,
          status: "completed",
          createdAt: 1,
          artifacts: [
            { kind: "diff", path: "src/form.ts", summary: "+38, -4" },
            { kind: "diff", path: "src/form.test.ts", summary: "+25, -0" },
          ],
        },
      ],
      [{ ...TC_QA01, artifactId: "art_qa01" }],
    );
    expect(files.map((f) => f.path)).toContain("src/form.ts");
    expect(files.map((f) => f.path)).toContain("src/form.test.ts");
    expect(files.find((f) => f.source === "tool-artifact")?.artifactId).toBe("art_qa01");
  });

  test("happy: items de render emparejan call+result y conservan huérfanos", () => {
    const items = messageRenderItems([
      { type: "text", text: "hola" },
      { type: "tool_call", toolCallId: "tc_qa01", name: "read", argumentsJson: "{}" },
      { type: "tool_result", toolCallId: "tc_qa01", providerCallId: "call_1", ok: true, text: "ok" },
      { type: "tool_result", toolCallId: "tc_huerfano", providerCallId: "call_9", ok: false, text: "sin call" },
    ]);
    expect(items.map((item) => item.kind)).toEqual(["part", "tool", "part"]);
    const tool = items[1]!;
    expect(tool.kind).toBe("tool");
    if (tool.kind === "tool") expect(tool.result?.text).toBe("ok");
  });

  test("happy: índice cruza mensajes (el result vive en el mensaje tool)", () => {
    const index = indexToolResults([
      { parts: [{ type: "tool_call", toolCallId: "tc_qa01", name: "read", argumentsJson: "{}" }] },
      { parts: [{ type: "tool_result", toolCallId: "tc_qa01", providerCallId: "call_1", ok: true, text: "42 líneas" }] },
    ]);
    expect(index.get("tc_qa01")?.text).toBe("42 líneas");
    expect(index.get("tc_ausente")).toBeUndefined();
  });

  test("happy: preguntas pendientes ordenadas por creación", () => {
    const ordered = orderPendingQuestions([
      { id: "que_b", sessionId: "s", runId: "r", instanceId: "i", toolCallId: "t", questions: [], createdAt: 20 },
      { id: "que_a", sessionId: "s", runId: "r", instanceId: "i", toolCallId: "t", questions: [], createdAt: 10 },
    ]);
    expect(ordered.map((q) => q.id)).toEqual(["que_a", "que_b"]);
  });
});

describe("chat limpio + subagentes (workbench-chat-terminal/3)", () => {
  test("sesion vacia solo sin mensajes ni runs", () => {
    expect(isSessionEmpty([], [])).toBe(true);
    expect(isSessionEmpty([{ id: "m1" }], [])).toBe(false);
    expect(isSessionEmpty([], [{ id: "r1" }])).toBe(false);
    expect(isSessionEmpty([{ id: "m1" }], [{ id: "r1" }])).toBe(false);
  });

  const inst = (id: string, parentInstanceId?: string, status: "running" | "completed" | "failed" = "completed") =>
    ({
      id,
      sessionId: "s",
      runId: "r",
      definitionId: `def-${id}`,
      parentInstanceId,
      status,
      createdAt: Number(id.slice(-1)) || 0,
    }) as never;

  test("arbol sobre parentInstanceId con profundidad y huerfano como raiz", () => {
    const roots = buildSubagentTree([inst("i1"), inst("i2", "i1"), inst("i3", "i2"), inst("i9", "ausente")]);
    expect(roots.map((n) => n.instance.id).sort()).toEqual(["i1", "i9"]);
    const i1 = roots.find((n) => n.instance.id === "i1")!;
    expect(i1.depth).toBe(0);
    expect(i1.children.map((n) => n.instance.id)).toEqual(["i2"]);
    expect(i1.children[0]!.depth).toBe(1);
    expect(i1.children[0]!.children[0]!.depth).toBe(2);
  });

  test("ciclo puro no cuelga: degrada a raiz", () => {
    const roots = buildSubagentTree([inst("a", "b"), inst("b", "a")]);
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.every((n) => n.depth === 0)).toBe(true);
  });

  test("linaje raiz->hoja para el breadcrumb; desconocido vacio", () => {
    const all = [inst("i1"), inst("i2", "i1"), inst("i3", "i2")];
    expect(subagentLineage(all, "i3").map((i) => (i as { id: string }).id)).toEqual(["i1", "i2", "i3"]);
    expect(subagentLineage(all, "i1").map((i) => (i as { id: string }).id)).toEqual(["i1"]);
    expect(subagentLineage(all, "nope")).toEqual([]);
  });

  test("rollup: failed domina, luego active, luego done; vacio idle", () => {
    expect(subagentRollup(["completed", "running"]).status).toBe("active");
    expect(subagentRollup(["completed", "running"]).tone).toBe("warn");
    expect(subagentRollup(["completed", "failed"]).status).toBe("failed");
    expect(subagentRollup(["denied"]).tone).toBe("err");
    expect(subagentRollup(["completed"]).status).toBe("done");
    expect(subagentRollup([]).status).toBe("idle");
    const r = subagentRollup(["failed", "running", "completed"]);
    expect([r.failed, r.active, r.total]).toEqual([1, 1, 3]);
  });
});
