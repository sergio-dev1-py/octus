/**
 * Etapa 1+2 — validación live contra Meta y OpenCode Go (puertas de salida §G).
 * Sin claves en el entorno: SKIP (exit 0). Con claves: coste mínimo y acotado.
 *
 *   MODEL_API_KEY=... OPENCODE_API_KEY=... bun scripts/check-live.ts
 *   OCTUS_LIVE_META_MODEL=muse-spark-1.3-contributor OCTUS_LIVE_META_REASONING_EFFORT=low \
 *     MODEL_API_KEY=... bun scripts/check-live.ts
 *
 * Overrides de coste (solo harness live; la producción no cambia):
 *   OCTUS_LIVE_META_MODEL: modelId de Meta para TODAS las pruebas live de Meta.
 *     Predeterminado documentado: "muse-spark-1.3".
 *   OCTUS_LIVE_META_REASONING_EFFORT: esfuerzo para las solicitudes Meta.
 *     Predeterminado documentado: "low".
 * Sin variable se usa el predeterminado y se muestra "(default)"; con variable,
 * "(env)". Esfuerzo inválido = error inmediato sin fallback. Si el modelo
 * configurado es `-contributor` y el adaptador Meta no lo lista, el harness lo
 * añade SOLO en memoria para la validación (producción intacta). Otro modelo
 * desconocido = FAIL rápido listando la oferta real, nunca fallback a Wonder.
 *
 * Etapa 1: generación de texto, tool loop con call_id preservado, esfuerzos de
 * razonamiento (P-01), ambas rutas de Go (responses y chat-completions) y
 * registro de uso con coste. Nunca escribe fuera de un workspace temporal.
 * Etapa 2 (requiere MODEL_API_KEY): planes vía plan.* con aprobación exclusiva
 * del usuario e implementación fijada, más delegación foreground/background
 * con proveedores reales.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OctusCore } from "../src/sessions/octus-core.js";
import { MemorySecretStore } from "../src/secrets/secret-store.js";
import {
  ensureLiveMetaModel,
  liveConfigBanner,
  resolveLiveMetaConfig,
} from "./live-config.js";

const MODEL_KEY = process.env.MODEL_API_KEY?.trim();
const GO_KEY = process.env.OPENCODE_API_KEY?.trim();

let live: ReturnType<typeof resolveLiveMetaConfig>;
try {
  live = resolveLiveMetaConfig(process.env);
} catch (error) {
  console.error(`LIVE CONFIG ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
console.log(liveConfigBanner(live));

if (!MODEL_KEY && !GO_KEY) {
  console.log("SKIP: neither MODEL_API_KEY nor OPENCODE_API_KEY is set. Live validation pending.");
  process.exit(0);
}

let failures = 0;
let skips = 0;
let keepDir = false;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  live: ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function skip(name: string, reason: string): void {
  skips++;
  console.log(`SKIP  live: ${name} — ${reason}`);
}
function formatCost(micro: number | null | undefined): string {
  if (micro === null || micro === undefined) return "cost unknown";
  return `$${(micro / 1_000_000).toFixed(4)}`;
}

interface ToolLoopEvidence {
  runStatus: string;
  runError?: string;
  requested: number;
  executed: number;
  usageCalls: number;
  delivered: boolean;
  finalText: string;
}

async function toolLoopEvidence(core: OctusCore, runId: string, sessionId: string): Promise<ToolLoopEvidence> {
  const run = (await core.getRun(runId)).run;
  const messages = await core.sessionMessages(sessionId);
  const requested = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool_call").length;
  const invocations = await core.db.query<Record<string, string | number | null>>(
    "SELECT name, status, completed_at FROM tool_invocations WHERE run_id = ? ORDER BY started_at ASC",
    [runId],
  );
  const executed = invocations.filter((row) => row.status === "completed").length;
  const usage = await core.runUsage(runId);
  const firstCompletion = invocations
    .filter((row) => row.status === "completed" && row.completed_at !== null)
    .map((row) => Number(row.completed_at));
  // Entregado = el proveedor fue llamado de nuevo DESPUÉS de completarse la herramienta.
  const delivered =
    usage.length >= 2 && firstCompletion.length > 0 && usage.slice(1).some((u) => u.createdAt >= Math.min(...firstCompletion));
  const assistants = messages.filter((m) => m.role === "assistant");
  const last = assistants[assistants.length - 1];
  const finalText = (last?.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n");
  return { runStatus: run.status, runError: run.error, requested, executed, usageCalls: usage.length, delivered, finalText };
}

/** Diagnóstico seguro: estados y conteos, jamás claves ni estado cifrado del proveedor. */
async function safeDiagnostics(core: OctusCore, label: string, runId: string, evidence: ToolLoopEvidence): Promise<void> {
  keepDir = true;
  console.log(`--- diagnostics: ${label} ---`);
  console.log(`run status=${evidence.runStatus} error=${evidence.runError ?? "(none)"}`);
  console.log(`requested=${evidence.requested} executed=${evidence.executed} providerCalls=${evidence.usageCalls} delivered=${evidence.delivered}`);
  const invocations = await core.db.query<Record<string, string | number | null>>(
    "SELECT name, status, error FROM tool_invocations WHERE run_id = ? ORDER BY started_at ASC",
    [runId],
  );
  for (const row of invocations) {
    console.log(`tool name=${row.name} status=${row.status} error=${row.error ? String(row.error).slice(0, 200) : "(none)"}`);
  }
  const usage = await core.runUsage(runId);
  for (const record of usage) {
    console.log(`usage ${record.providerId}/${record.modelId} in=${record.inputTokens} out=${record.outputTokens} status=${record.status}`);
  }
}

/** Verifica que un run Meta usó exactamente el modelo configurado y muestra tokens/coste. */
async function assertLiveModel(core: OctusCore, label: string, runId: string, effort: string): Promise<void> {
  const usage = await core.runUsage(runId);
  if (usage.length === 0) {
    check(`${label} recorded usage for meta/${live.modelId}`, false, "no usage rows");
    return;
  }
  const bad = usage.filter((u) => u.providerId !== "meta" || u.modelId !== live.modelId);
  check(
    `${label} uses configured model meta/${live.modelId}`,
    bad.length === 0,
    bad.length > 0 ? `got ${bad.map((u) => `${u.providerId}/${u.modelId}`).join(",")}` : `${usage.length} calls`,
  );
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cached = 0;
  let micro: number | null = 0;
  for (const u of usage) {
    input += u.inputTokens;
    output += u.outputTokens;
    reasoning += u.reasoningTokens;
    cached += u.cachedTokens;
    if (u.costMicroUsd === null) micro = null;
    else if (micro !== null) micro += u.costMicroUsd;
  }
  console.log(
    `live usage: ${label} model=meta/${live.modelId} effort=${effort} calls=${usage.length} in=${input} out=${output} reasoning=${reasoning} cached=${cached} cost=${formatCost(micro)}`,
  );
}

async function logAggregateUsage(core: OctusCore): Promise<void> {
  const rows = await core.db.query<Record<string, string | number | null>>(
    "SELECT provider_id, model_id, COUNT(*) AS n, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens, COALESCE(SUM(cached_tokens),0) AS cached_tokens, SUM(cost_micro_usd) AS micro FROM usage_records GROUP BY provider_id, model_id ORDER BY provider_id, model_id",
  );
  for (const row of rows) {
    const micro = row.micro === null ? null : Number(row.micro);
    console.log(
      `live usage by model: ${row.provider_id}/${row.model_id} calls=${row.n} in=${row.input_tokens} out=${row.output_tokens} reasoning=${row.reasoning_tokens} cached=${row.cached_tokens} cost=${formatCost(micro)}`,
    );
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "octus-live-"));
const workspace = path.join(dir, "workspace");
mkdirSync(workspace, { recursive: true });
writeFileSync(path.join(workspace, "fixture.txt"), "live-fixture-content-42\n");

const core = await OctusCore.create({ dataDir: path.join(dir, "data"), primarySecrets: new MemorySecretStore() });
try {
  // Presupuestos estrictos para la propia validación (la puerta los exige).
  await core.configureBudgets([
    { scope: { kind: "global", ref: "" }, limitMicroUsd: 500_000, warnRatio: 0.8, action: "block", window: "span", enabled: true },
    { scope: { kind: "run", ref: "" }, limitTokens: 25_000, warnRatio: 0.8, action: "block", window: "span", enabled: true },
  ]);
  const project = await core.createProject("live", workspace);

  if (MODEL_KEY) {
    await core.setProviderKey("meta", MODEL_KEY);
    const metaProvider = core.router.get("meta");
    if (!metaProvider) {
      check("meta provider registered", false, "router has no meta provider");
    } else {
      const ensured = ensureLiveMetaModel(metaProvider, live.modelId);
      if (ensured.extended) {
        console.log(`live catalog: meta/${live.modelId} added live-only (production still offers only the builtin catalog)`);
      }
      const offered = metaProvider.models().map((m) => m.modelId);
      if (!offered.includes(live.modelId)) {
        check(
          `meta configured model meta/${live.modelId} is offered`,
          false,
          `offered: ${offered.join(",") || "(none)"}. Refusing silent fallback to another model.`,
        );
      } else {
        check(`meta configured model meta/${live.modelId} is offered`, true, `${offered.length} models`);
      }
    }
    const test = await core.testProvider("meta");
    check("meta connectivity (/v1/models)", test.ok, test.error ?? `${test.models} models`);

    const session = await core.createSession({ projectId: project.id, title: "live-meta" });
    await core.setSessionModel(session.id, { providerId: "meta", modelId: live.modelId, effort: live.effort });
    const { runId } = await core.prompt(session.id, "Reply with exactly: live-ok");
    await core.waitForIdle(session.id);
    const run = (await core.getRun(runId)).run;
    check(`meta ${live.modelId} text turn completes`, run.status === "done", run.error ?? run.status);
    await assertLiveModel(core, "meta text turn", runId, live.effort);
    const messages = await core.sessionMessages(session.id);
    check("meta history persists user+assistant", messages.length >= 2);

    const session2 = await core.createSession({ projectId: project.id, title: "live-meta-tools" });
    await core.setSessionModel(session2.id, { providerId: "meta", modelId: live.modelId, effort: live.effort });
    const tools = await core.prompt(session2.id, "Read fixture.txt with the read tool and reply with its exact content.");
    await core.waitForIdle(session2.id);
    const metaTools = await toolLoopEvidence(core, tools.runId, session2.id);
    check(`meta ${live.modelId} tool loop completes`, metaTools.runStatus === "done", metaTools.runError ?? metaTools.runStatus);
    check("meta tool requested", metaTools.requested >= 1, `${metaTools.requested} tool_call parts`);
    check("meta tool executed", metaTools.executed >= 1, `${metaTools.executed} invocations completed`);
    check("meta tool result delivered", metaTools.delivered, `${metaTools.usageCalls} provider calls`);
    check("meta final answer echoes fixture", metaTools.finalText.includes("live-fixture-content-42"));
    await assertLiveModel(core, "meta tool loop", tools.runId, live.effort);
    if (metaTools.runStatus !== "done" || metaTools.requested < 1 || metaTools.executed < 1 || !metaTools.delivered || !metaTools.finalText.includes("live-fixture-content-42")) {
      await safeDiagnostics(core, "meta-tools", tools.runId, metaTools);
    }

    // P-01: ¿acepta reasoning.effort=max el modelo configurado? Sin max → SKIP, sin Wonder.
    const metaCaps = core.router.get("meta")?.capabilitiesOf(live.modelId);
    if (!metaCaps?.reasoningEfforts.includes("max")) {
      skip(
        "meta reasoning.effort=max accepted",
        `model meta/${live.modelId} supports [${metaCaps?.reasoningEfforts.join(",") ?? "unknown"}]; max not applicable, no Wonder fallback`,
      );
    } else {
      const session3 = await core.createSession({ projectId: project.id, title: "live-meta-max" });
      await core.setSessionModel(session3.id, { providerId: "meta", modelId: live.modelId, effort: "max" });
      const maxed = await core.prompt(session3.id, "Reply with exactly: max-ok");
      await core.waitForIdle(session3.id);
      const maxRun = (await core.getRun(maxed.runId)).run;
      check(`meta ${live.modelId} reasoning.effort=max accepted`, maxRun.status === "done", maxRun.error ?? maxRun.status);
      await assertLiveModel(core, "meta max effort", maxed.runId, "max");
    }
  }

  if (GO_KEY) {
    await core.setProviderKey("opencode-go", GO_KEY);
    const catalog = await core.refreshGoCatalog();
    check("go catalog refresh (public /v1/models)", catalog.ok, catalog.error ?? `${catalog.count} models`);

    const session = await core.createSession({ projectId: project.id, title: "live-go-chat" });
    await core.setSessionModel(session.id, { providerId: "opencode-go", modelId: "glm-5.3-flash", effort: "low" });
    const { runId } = await core.prompt(session.id, "Read fixture.txt with the read tool and reply with its exact content.");
    await core.waitForIdle(session.id);
    const goTools = await toolLoopEvidence(core, runId, session.id);
    check("go glm-5.3-flash (chat native) tool loop completes", goTools.runStatus === "done", goTools.runError ?? goTools.runStatus);
    check("go tool requested+executed", goTools.requested >= 1 && goTools.executed >= 1, `requested=${goTools.requested} executed=${goTools.executed}`);
    check("go tool result delivered", goTools.delivered, `${goTools.usageCalls} provider calls`);
    if (goTools.runStatus !== "done" || goTools.requested < 1 || goTools.executed < 1 || !goTools.delivered) {
      await safeDiagnostics(core, "go-chat-tools", runId, goTools);
    }

    const session2 = await core.createSession({ projectId: project.id, title: "live-go-responses" });
    await core.setSessionModel(session2.id, { providerId: "opencode-go", modelId: "grok-4.7", effort: "low" });
    const grok = await core.prompt(session2.id, "Reply with exactly: grok-ok");
    await core.waitForIdle(session2.id);
    const grokRun = (await core.getRun(grok.runId)).run;
    check("go grok-4.7 (responses native) text turn completes", grokRun.status === "done", grokRun.error ?? grokRun.status);
  }

  // ---------------------------------------------------------------- Stage 2 (requiere Meta)
  if (!MODEL_KEY) {
    console.log("SKIP  live: stage2 delegation+plans (requires MODEL_API_KEY)");
  } else {
    // Todas las instancias Meta de la Etapa 2 usan el modelo/esfuerzo configurados.
    // Plan vía tool loop en perfil plan: crear, presentar, solicitar, aprobar, implementar.
    const planSession = await core.createSession({ projectId: project.id, title: "live-stage2-plan" });
    await core.setSessionModel(planSession.id, { providerId: "meta", modelId: live.modelId, effort: live.effort });
    await core.setSessionProfile(planSession.id, "plan");
    const planPrompt =
      "Call plan.create with objective 'Live plan probe' and structured {\"objective\":\"Live plan probe\"," +
      "\"steps\":[{\"title\":\"Read fixture.txt\"}],\"acceptanceCriteria\":[\"fixture content known\"]}. Then reply briefly presenting the plan.";
    const planRun = await core.prompt(planSession.id, planPrompt);
    await core.waitForIdle(planSession.id);
    const planRunRow = (await core.getRun(planRun.runId)).run;
    check("stage2 plan run completes", planRunRow.status === "done", planRunRow.error ?? planRunRow.status);
    await assertLiveModel(core, "stage2 plan run", planRun.runId, live.effort);
    const plans = await core.listPlans(planSession.id);
    check("stage2 plan created via tool", plans.length === 1, `${plans.length} plans`);
    const plan = plans[0];
    const revisions = plan ? await core.plans.listRevisions(plan.id) : [];
    const v1 = revisions[0];
    check("stage2 revision v1 presented after run", v1?.lifecycle === "presented", v1 ? `${v1.lifecycle}/${v1.approval}` : "no revision");
    check("stage2 current revision pinned", plan?.currentRevisionId === v1?.id, plan?.currentRevisionId ?? "(none)");
    if (plan && v1 && v1.lifecycle === "presented") {
      const approval = await core.plans.requestApproval(plan.id, v1.id, planSession.id, planRun.runId);
      check("stage2 approval requested (user-only decision pending)", approval.status === "pending", approval.id);
      const pending = await core.pendingApprovals(planSession.id);
      check("stage2 exactly one pending approval", pending.length === 1, `${pending.length} pending`);
      await core.decideApproval(approval.id, "approved");
      const afterApprove = await core.plans.getPlan(plan.id);
      check("stage2 user approval pins (plan, revision)", afterApprove.approvedRevisionId === v1.id, afterApprove.approvedRevisionId ?? "(none)");
      const implemented = await core.implementPlanRevision(planSession.id, plan.id, v1.id);
      await core.waitForIdle(planSession.id);
      const implRun = (await core.getRun(implemented.runId)).run;
      check("stage2 implement runs pinned approved revision", implRun.status === "done" && implRun.planRevisionId === v1.id, `${implRun.status} rev=${implRun.planRevisionId ?? "(none)"}`);
      check("stage2 implement switches session to build", (await core.getSession(planSession.id)).session.profile === "build");
      await assertLiveModel(core, "stage2 implement run", implemented.runId, live.effort);
    } else {
      check("stage2 approval requested (user-only decision pending)", false, "no presented revision");
      check("stage2 exactly one pending approval", false, "no presented revision");
      check("stage2 user approval pins (plan, revision)", false, "no presented revision");
      check("stage2 implement runs pinned approved revision", false, "no presented revision");
      check("stage2 implement switches session to build", false, "no presented revision");
      await safeDiagnostics(core, "stage2-plan", planRun.runId, await toolLoopEvidence(core, planRun.runId, planSession.id));
    }

    // Delegación foreground vía herramienta delegate (coordinador -> explorer real).
    // El modelo hijo se fija por override para que también use el modelo configurado.
    const dlgSession = await core.createSession({ projectId: project.id, title: "live-stage2-delegate" });
    await core.setSessionModel(dlgSession.id, { providerId: "meta", modelId: live.modelId, effort: live.effort });
    const delegateModelJson = JSON.stringify({ providerId: "meta", modelId: live.modelId, effort: live.effort });
    const dlg = await core.prompt(
      dlgSession.id,
      `Call delegate with definitionId 'explorer', brief 'List workspace files with glob and read fixture.txt. Reply with its exact content.', mode 'foreground', model ${delegateModelJson}. Then reply with DONE.`,
    );
    await core.waitForIdle(dlgSession.id);
    const dlgRun = (await core.getRun(dlg.runId)).run;
    check("stage2 delegate run completes", dlgRun.status === "done", dlgRun.error ?? dlgRun.status);
    await assertLiveModel(core, "stage2 delegate run", dlg.runId, live.effort);
    const instances = await core.agentInstances(dlgSession.id);
    const explorer = instances.find((i) => i.definitionId === "explorer");
    check("stage2 foreground explorer completed", explorer?.status === "completed", explorer ? `${explorer.status}` : "no explorer instance");
    check(
      `stage2 foreground explorer uses configured model meta/${live.modelId}`,
      explorer?.model.providerId === "meta" && explorer?.model.modelId === live.modelId,
      explorer ? `${explorer.model.providerId}/${explorer.model.modelId}` : "no explorer instance",
    );
    const dlgMessages = await core.sessionMessages(dlgSession.id);
    const dlgFinal = dlgMessages.filter((m) => m.role === "assistant").pop()?.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n") ?? "";
    check("stage2 coordinator reports after delivery", dlgFinal.includes("DONE") || dlgFinal.includes("live-fixture-content-42"), dlgFinal.slice(0, 120) || "(empty)");
    if (dlgRun.status !== "done" || explorer?.status !== "completed") {
      await safeDiagnostics(core, "stage2-delegate", dlg.runId, await toolLoopEvidence(core, dlg.runId, dlgSession.id));
    }

    // Background directo: sobrevive sin run del coordinador y deja entrega pendiente.
    const parent = instances.find((i) => i.definitionId === "coordinator-build");
    if (parent) {
      const bg = await core.agents.spawn({
        parentInstanceId: parent.id,
        definitionId: "explorer",
        brief: "Reply with exactly: bg-ok",
        mode: "background",
        model: { providerId: "meta", modelId: live.modelId, effort: live.effort },
      });
      const delivery = await core.agents.wait(bg.instanceId, 120_000);
      check("stage2 background delivery completes", delivery.status === "completed", delivery.status);
      check("stage2 background summary delivered", delivery.summary.includes("bg-ok"), delivery.summary.slice(0, 120) || "(empty)");
      const bgInstance = (await core.agentInstances(dlgSession.id)).find((i) => i.id === bg.instanceId);
      check(
        `stage2 background uses configured model meta/${live.modelId}`,
        bgInstance?.model.providerId === "meta" && bgInstance?.model.modelId === live.modelId,
        bgInstance ? `${bgInstance.model.providerId}/${bgInstance.model.modelId}` : "missing instance",
      );
      await assertLiveModel(core, "stage2 delegate+background run", dlg.runId, live.effort);
      const pendingDeliveries = await core.agents.pendingDeliveries(dlgSession.id);
      check("stage2 background delivery stays pending", pendingDeliveries.some((d) => d.instanceId === bg.instanceId), `${pendingDeliveries.length} pending`);
      await core.agents.consumePendingDeliveries(dlgSession.id);
    } else {
      check("stage2 background delivery completes", false, "no coordinator parent");
      check("stage2 background summary delivered", false, "no coordinator parent");
      check("stage2 background delivery stays pending", false, "no coordinator parent");
    }
  }

  // Gasto total y por modelo, desde el registro (nunca estimado a mano).
  const rows = await core.db.query<{ n: number; micro: number | null }>(
    "SELECT COUNT(*) AS n, SUM(cost_micro_usd) AS micro FROM usage_records",
  );
  const spent = rows[0];
  console.log(`live spend: ${spent?.n ?? 0} calls, ${formatCost(spent?.micro ?? 0)}`);
  await logAggregateUsage(core);
  if (skips > 0) console.log(`live skips: ${skips} (e.g. effort=max on models without max, no Wonder fallback)`);
} finally {
  await core.close();
  if (keepDir || failures > 0) {
    console.log(`live workspace preserved for inspection: ${dir}`);
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`LIVE VALIDATION FAILED (${failures} checks)`);
  process.exit(1);
}
console.log("LIVE VALIDATION PASSED");
