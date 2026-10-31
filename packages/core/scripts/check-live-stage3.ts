/**
 * Etapa 3 — validación live de TaskGraph/Planner/Scheduler con modelos reales.
 * Harness-only: no toca la arquitectura de producción (solo usa su API pública).
 *
 *   MODEL_API_KEY=... OPENCODE_API_KEY=... bun scripts/check-live-stage3.ts
 *
 * Matriz A (Meta):   muse-spark-1.3-contributor, effort xhigh (requiere MODEL_API_KEY).
 * Matriz B (Go):     DeepSeek V4.1 Flash exacto del catálogo real, effort max
 *                    (requiere OPENCODE_API_KEY). Sin fallback silencioso a GLM/Grok.
 *
 * Sin la clave de una matriz: esa matriz queda BLOCKED (exit 1 si alguna matriz
 * no pasa; exit 0 solo si todas las matrices disponibles pasan). Sin ninguna
 * clave: SKIP (exit 0), igual que check-live.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OctusCore } from "../src/sessions/octus-core.js";
import { MemorySecretStore } from "../src/secrets/secret-store.js";
import { promptHashOf, snapshotOf } from "../src/agents/definition-loader.js";
import {
  ensureLiveMetaModel,
  liveConfigBanner,
  resolveLiveMetaConfig,
} from "./live-config.js";

const MODEL_KEY = process.env.MODEL_API_KEY?.trim();
const GO_KEY = process.env.OPENCODE_API_KEY?.trim();

let failures = 0;
let blocked: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  live-stage3: ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function block(name: string, reason: string): void {
  blocked.push(name);
  console.log(`BLOCKED  live-stage3: ${name} — ${reason}`);
}
function formatCost(micro: number | null | undefined): string {
  if (micro === null || micro === undefined) return "cost unknown";
  return `$${(micro / 1_000_000).toFixed(4)}`;
}

const WAIT_MS = 900_000; // 15 min por tarea (razonamiento xhigh/max real puede tardar)
const TICK_MS = 10_000;

interface MatrixConfig {
  name: string;
  providerId: "meta" | "opencode-go";
  modelId: string;
  effort: "xhigh" | "max";
}

async function waitForTaskStatus(
  core: OctusCore,
  taskId: string,
  wanted: string[],
  sessionId: string,
  label: string,
): Promise<boolean> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const task = await core.tasks.getTask(taskId);
    if (wanted.includes(task.status)) return true;
    if (["failed", "cancelled", "interrupted"].includes(task.status) && !wanted.includes(task.status)) {
      console.log(`live-stage3: ${label} entró en ${task.status} (error: ${(task.error ?? "").slice(0, 200)})`);
      return false;
    }
    if (Date.now() > deadline) {
      console.log(`live-stage3: ${label} timeout esperando [${wanted.join("|")}] (está en ${task.status})`);
      return false;
    }
    await core.scheduler.tick({ sessionId }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

async function activeCounts(core: OctusCore, sessionId: string): Promise<Record<string, number>> {
  const rows = await core.db.query<{ kind: string; n: number }>(
    `SELECT d.kind AS kind, COUNT(*) AS n FROM agent_instances i
     JOIN agent_definitions d ON d.id = i.definition_id
     WHERE i.session_id = ? AND i.status IN ('created','running','waiting_permission','waiting_input')
     GROUP BY d.kind`,
    [sessionId],
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.kind)] = Number(r.n);
  return out;
}

async function runMatrix(core: OctusCore, dir: string, matrix: MatrixConfig): Promise<void> {
  const tag = matrix.name;
  const workspace = path.join(dir, `workspace-${tag}`);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, "fixture-a.txt"), "marker alpha-42\n");
  writeFileSync(path.join(workspace, "fixture-b.txt"), "marker beta-84\n");
  const implDir = path.join(workspace, "work-impl");
  mkdirSync(implDir, { recursive: true });

  const project = await core.createProject(`live-stage3-${tag}`, workspace);
  const session = await core.createSession({ projectId: project.id, directory: workspace, title: `live-stage3-${tag}` });
  await core.setSessionModel(session.id, { providerId: matrix.providerId, modelId: matrix.modelId, effort: matrix.effort });
  await core.registerIsolatedDirectory(project.id, implDir, "directory");

  // Permisos: el harness simula el "allow once" del usuario (igual que los tests).
  // Sin esto, write/shell del implementer quedarían en espera eternamente.
  let approvals = 0;
  const stopAllow = core.bus.subscribe((event) => {
    if (event.type === "permission.asked") {
      const requestId = (event.payload as Record<string, unknown>).requestId as string | undefined;
      const pending = requestId ?? core.permissions.pendingFor(session.id)[0]?.id;
      if (pending && core.permissions.reply(pending, "once")) approvals++;
    }
  });

  try {
    // Seed de run + coordinador (igual que test/helpers makeRun): el coste live
    // está en la llamada del planner y en los workers, no en este andamiaje.
    const runId = `run_live3_${tag}_${Math.random().toString(36).slice(2, 8)}`;
    const coordId = `ins_live3_${tag}_${Math.random().toString(36).slice(2, 8)}`;
    const def = (await core.registry.get("coordinator-build"))!;
    await core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES (?, ?, 'live-stage3 probe', 'executing', 'build', 1, 1)", [runId, session.id]);
    await core.db.exec(
      "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES (?, ?, ?, 'coordinator-build', 'running', ?, ?, ?, ?, ?, 1, 1)",
      [coordId, session.id, runId, JSON.stringify({ providerId: matrix.providerId, modelId: matrix.modelId, effort: matrix.effort }), workspace, def.promptVersion, promptHashOf(def), JSON.stringify(snapshotOf(def))],
    );

    // Plan + revisión aprobada (decisión de usuario simulada por el harness).
    const { plan } = await core.plans.createPlan({
      sessionId: session.id,
      projectId: project.id,
      objective: "Live Stage 3 probe: survey two fixture files, combine markers into work-impl/result.txt, then review",
      structured: {
        objective: "Live Stage 3 probe",
        steps: [
          { title: "Read fixture-a.txt and fixture-b.txt", detail: "Explorers report marker alpha-42 and beta-84.", verification: "Deliveries quote both markers." },
          { title: "Write work-impl/result.txt", detail: "Implementer writes combined:alpha-42+beta-84.", verification: "File exists with the combined line." },
          { title: "Review the result file", detail: "Reviewer quotes the combined marker.", verification: "Review delivery quotes combined:alpha-42+beta-84." },
        ],
        acceptanceCriteria: ["Both markers reported", "work-impl/result.txt contains the combined line", "Review quotes the combined marker"],
      },
      runId,
      createdBy: "live-stage3",
    });
    const revision = (await core.plans.listRevisions(plan.id))[0]!;
    await core.plans.presentRevision(revision.id, "live-seed");
    const approval = await core.plans.requestApproval(plan.id, revision.id, session.id, runId);
    await core.decideApproval(approval.id, "approved");
    check(`${tag} plan revision approved pins (plan, revision)`, (await core.plans.getPlan(plan.id)).approvedRevisionId === revision.id);

    // 1–2. DAG mediante TaskPlanner REAL (una generación con el modelo del coordinador).
    const brief = `Produce EXACTLY 4 tasks with this shape (tempIds are suggestions; roles and links are mandatory):
1. explorer, priority 10, no dependencies. Read fixture-a.txt using only requiredTools ["read","glob","grep"]. Acceptance: ["delivery quotes marker alpha-42 from fixture-a.txt"]. needsReview false. No writeScope. No validationCommands.
2. explorer, priority 9, no dependencies. Read fixture-b.txt using only requiredTools ["read","glob","grep"]. Acceptance: ["delivery quotes marker beta-84 from fixture-b.txt"]. needsReview false. No writeScope. No validationCommands.
3. implementer, priority 5, dependencies on BOTH explorer tasks. Write file work-impl/result.txt containing exactly the line "combined:alpha-42+beta-84" using requiredTools ["read","write"]. writeScope ["work-impl"]. Acceptance: ["work-impl/result.txt exists containing combined:alpha-42+beta-84"]. needsReview true. No validationCommands. Never use shell, question, commit, branches or worktrees.
4. reviewer, priority 1, reviewTargetTempId pointing at the implementer task. Read and report on work-impl/result.txt using requiredTools ["read","git_diff"]. Acceptance: ["review delivery quotes combined:alpha-42+beta-84"]. needsReview false. Never use write, shell, question or test_run.
Titles must be >=8 chars with a concrete deliverable; descriptions >=20 chars.`;
    const plannerUsageBefore = Date.now();
    let dag: { planningId: string; taskIds: string[]; created: boolean } | undefined;
    let shapeError = "";
    for (let attempt = 1; attempt <= 3 && !dag; attempt++) {
      try {
        const out = await core.planner.planTasks(coordId, {
          runId,
          objective: "Live Stage 3 probe DAG",
          brief: attempt === 1 ? brief : `${brief}\nPrevious proposal rejected by harness shape check: ${shapeError}. Fix roles, links and fields exactly and resubmit.`,
          planId: plan.id,
          revisionId: revision.id,
          nonce: attempt === 1 ? undefined : `live-retry-${attempt}`,
        });
        // Verificación de forma por rol y enlaces (los tempIds los elige el modelo).
        const tasks = await core.tasks.listTasks({ runId });
        const byId = new Map(tasks.map((t) => [t.id, t]));
        const explorers = tasks.filter((t) => t.agentRole === "explorer");
        const implementers = tasks.filter((t) => t.agentRole === "implementer");
        const reviewers = tasks.filter((t) => t.agentRole === "reviewer");
        const problems: string[] = [];
        if (explorers.length !== 2) problems.push(`expected 2 explorers, got ${explorers.length}`);
        if (implementers.length !== 1) problems.push(`expected 1 implementer, got ${implementers.length}`);
        if (reviewers.length !== 1) problems.push(`expected 1 reviewer, got ${reviewers.length}`);
        const impl = implementers[0];
        const rev = reviewers[0];
        if (impl) {
          const deps = await core.tasks.getDependencies(impl.id);
          const depRoles = deps.map((d) => byId.get(d.dependsOn)?.agentRole);
          if (depRoles.length < 2 || !depRoles.every((r) => r === "explorer")) {
            problems.push(`implementer must depend on both explorers (got [${depRoles.join(",")}])`);
          }
          if (!impl.needsReview) problems.push("implementer must set needsReview=true");
          if (!(impl.writeScope ?? []).includes("work-impl")) problems.push(`implementer writeScope must include work-impl (got [${(impl.writeScope ?? []).join(",")}])`);
        }
        if (rev && impl && rev.reviewTargetTaskId !== impl.id) {
          problems.push("reviewer must target the implementer task");
        }
        if (problems.length > 0) {
          shapeError = problems.join("; ");
          dag = undefined;
          if (attempt === 3) {
            check(`${tag} planner proposal has required shape`, false, shapeError);
          }
          continue;
        }
        dag = out;
      } catch (error) {
        shapeError = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
        if (attempt === 3) {
          check(`${tag} TaskPlanner creates DAG from approved revision`, false, shapeError);
        }
      }
    }
    if (!dag) {
      check(`${tag} TaskPlanner creates DAG from approved revision`, false, shapeError || "no proposal accepted after 3 attempts");
      return;
    }
    check(`${tag} TaskPlanner creates DAG from approved revision`, true, `planning ${dag.planningId}, ${dag.taskIds.length} tasks`);

    // Uso del planner: filas nuevas con session_id='planner' y el modelo de la matriz.
    const plannerRows = await core.db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM usage_records WHERE session_id = 'planner' AND provider_id = ? AND model_id = ? AND created_at >= ?",
      [matrix.providerId, matrix.modelId, plannerUsageBefore],
    );
    check(`${tag} planner generation used ${matrix.providerId}/${matrix.modelId}`, (plannerRows[0]?.n ?? 0) >= 1, `${plannerRows[0]?.n ?? 0} planner usage rows`);

    // Persistencia: planning + tareas + dependencias.
    const tasks = await core.tasks.listTasks({ runId });
    const planning = await core.tasks.getPlanning(dag.planningId);
    check(`${tag} planning persisted as valid`, planning.status === "valid", planning.status);
    check(`${tag} 4 tasks persisted`, tasks.length === 4, `${tasks.length} tasks`);
    const depRows = await core.db.query<{ task_id: string; depends_on: string }>("SELECT task_id, depends_on FROM task_dependencies");
    const implTask = tasks.find((t) => t.agentRole === "implementer")!;
    const revTask = tasks.find((t) => t.agentRole === "reviewer")!;
    const readerTasks = tasks.filter((t) => t.agentRole === "explorer");
    const implDeps = depRows.filter((d) => d.task_id === implTask.id).map((d) => d.depends_on).sort();
    const expectedDeps = readerTasks.map((t) => t.id).sort();
    check(`${tag} dependencies persisted (implementer→readers)`, JSON.stringify(implDeps) === JSON.stringify(expectedDeps), implDeps.join(",") || "(none)");
    check(`${tag} review linkage persisted`, revTask.reviewTargetTaskId === implTask.id);

    // 3. Tick: las dos lectoras en paralelo; implementer/reviewer siguen en draft.
    const assigned = await core.scheduler.tick({ sessionId: session.id });
    const readerIds = new Set(readerTasks.map((t) => t.id));
    check(`${tag} scheduler assigns both readers in one tick`, assigned.length >= 2 && assigned.every((a) => readerIds.has(a.taskId)), assigned.map((a) => a.taskId.slice(-6)).join(",") || "(none)");
    check(`${tag} implementer still draft while readers incomplete`, (await core.tasks.getTask(implTask.id)).status === "draft");
    check(`${tag} reviewer still draft while target incomplete`, (await core.tasks.getTask(revTask.id)).status === "draft");
    const counts = await activeCounts(core, session.id);
    check(`${tag} role limits respected during parallel readers`, (counts.explorer ?? 0) <= 2 && (counts.implementer ?? 0) === 0, JSON.stringify(counts));

    // Esperar lectoras; el auto-tick del core también avanza, el tick explícito asegura supervisión.
    let readersDone = true;
    for (const r of readerTasks) {
      const attempts = await core.tasks.getAttempts(r.id);
      const instanceId = attempts[0]?.instanceId;
      if (!instanceId) {
        check(`${tag} reader ${r.id.slice(-6)} spawned an instance`, false, "no attempt");
        readersDone = false;
        continue;
      }
      try {
        await core.agents.wait(instanceId, WAIT_MS);
      } catch (error) {
        check(`${tag} reader ${r.id.slice(-6)} completes`, false, error instanceof Error ? error.message.slice(0, 200) : String(error));
        readersDone = false;
      }
    }
    await core.scheduler.tick({ sessionId: session.id }).catch(() => undefined);
    for (const r of readerTasks) {
      const st = (await core.tasks.getTask(r.id)).status;
      if (st !== "completed") {
        check(`${tag} reader ${r.id.slice(-6)} completed`, false, `status=${st}`);
        readersDone = false;
      }
    }
    if (!readersDone) return;
    check(`${tag} both readers completed in parallel`, true);

    // 4–5. Implementer desbloqueado por dependencias (no por capacidad).
    await core.scheduler.tick({ sessionId: session.id });
    const implStatus = (await core.tasks.getTask(implTask.id)).status;
    check(`${tag} scheduler unblocks implementer after readers`, ["assigned", "running", "completed"].includes(implStatus), implStatus);
    const implAttempts = await core.tasks.getAttempts(implTask.id);
    const implInstance = implAttempts[0]?.instanceId;
    if (!implInstance) {
      check(`${tag} implementer spawned`, false, "no attempt instance");
      return;
    }
    try {
      await core.agents.wait(implInstance, WAIT_MS);
    } catch (error) {
      check(`${tag} implementer completes`, false, error instanceof Error ? error.message.slice(0, 200) : String(error));
      return;
    }
    await core.scheduler.tick({ sessionId: session.id }).catch(() => undefined);
    check(`${tag} implementer completed`, (await core.tasks.getTask(implTask.id)).status === "completed", (await core.tasks.getTask(implTask.id)).status);
    const resultFile = path.join(implDir, "result.txt");
    const resultOk = existsSync(resultFile) && readFileSync(resultFile, "utf8").includes("combined:alpha-42+beta-84");
    check(`${tag} implementer wrote work-impl/result.txt with combined marker`, resultOk, resultOk ? "marker present" : "missing or wrong content");

    // Reviewer desbloqueado por target completado → veredicto accept.
    await core.scheduler.tick({ sessionId: session.id });
    const revStatus = (await core.tasks.getTask(revTask.id)).status;
    check(`${tag} reviewer unblocked after implementer`, ["assigned", "running", "completed"].includes(revStatus), revStatus);
    const revAttempts = await core.tasks.getAttempts(revTask.id);
    const revInstance = revAttempts[0]?.instanceId;
    if (!revInstance) {
      check(`${tag} reviewer spawned`, false, "no attempt instance");
      return;
    }
    try {
      await core.agents.wait(revInstance, WAIT_MS);
    } catch (error) {
      check(`${tag} reviewer completes`, false, error instanceof Error ? error.message.slice(0, 200) : String(error));
      return;
    }
    await core.scheduler.tick({ sessionId: session.id }).catch(() => undefined);
    check(`${tag} reviewer completed`, (await core.tasks.getTask(revTask.id)).status === "completed", (await core.tasks.getTask(revTask.id)).status);
    const delivery = await core.agents.result(revInstance).catch(() => undefined);
    const quotesMarker = (delivery?.summary ?? "").includes("alpha-42");
    check(`${tag} review delivery quotes the combined marker`, quotesMarker, (delivery?.summary ?? "").slice(0, 160) || "(empty)");
    await core.tasks.recordReview(revTask.id, implTask.id, "accept", { live: true, matrix: matrix.name });
    check(`${tag} accept verdict marks implementer reviewed`, (await core.tasks.getTask(implTask.id)).status === "reviewed");

    // 7. Run final + entregas.
    await core.scheduler.tick({ sessionId: session.id }).catch(() => undefined);
    const run = (await core.getRun(runId)).run;
    check(`${tag} run finishes done`, run.status === "done", run.status);
    for (const r of readerTasks) {
      const d = await core.tasks.getDelivery(r.id).catch(() => undefined);
      check(`${tag} reader ${r.id.slice(-6)} delivery recorded`, !!d?.summary?.includes(r.id === readerTasks[0]!.id ? "alpha-42" : "beta-84"), (d?.summary ?? "").slice(0, 80) || "(empty)");
    }

    // 6. Modelos reales por instancia: agent_instances.model + usage_records.
    for (const t of tasks) {
      const attempts = await core.tasks.getAttempts(t.id);
      for (const a of attempts) {
        if (!a.instanceId) continue;
        const inst = (await core.agentInstances(session.id)).find((i) => i.id === a.instanceId);
        const modelOk = inst?.model.providerId === matrix.providerId && inst?.model.modelId === matrix.modelId && inst?.model.effort === matrix.effort;
        check(
          `${tag} ${t.agentRole} ${a.instanceId.slice(-6)} runs ${matrix.providerId}/${matrix.modelId}/${matrix.effort}`,
          !!modelOk,
          inst ? `${inst.model.providerId}/${inst.model.modelId}/${inst.model.effort ?? "(no effort)"}` : "missing instance",
        );
        const rows = await core.db.query<{ n: number }>(
          "SELECT COUNT(*) AS n FROM usage_records WHERE agent_instance_id = ? AND provider_id = ? AND model_id = ?",
          [a.instanceId, matrix.providerId, matrix.modelId],
        );
        check(`${tag} ${t.agentRole} ${a.instanceId.slice(-6)} billed usage matches model`, (rows[0]?.n ?? 0) >= 1, `${rows[0]?.n ?? 0} usage rows`);
      }
    }

    // Sin worktrees automáticos: solo el directorio pre-asignado.
    const dirs = await core.directories.list(project.id);
    check(`${tag} no auto-created worktrees/dirs`, dirs.length === 1 && dirs[0]?.path === implDir, `${dirs.length} isolated dirs`);
    console.log(`live-stage3: ${tag} permission auto-approvals granted: ${approvals}`);
  } finally {
    stopAllow();
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "octus-live-stage3-"));
let keepDir = false;
const core = await OctusCore.create({ dataDir: path.join(dir, "data"), primarySecrets: new MemorySecretStore() });
try {
  await core.configureBudgets([
    { scope: { kind: "global", ref: "" }, limitMicroUsd: 10_000_000, warnRatio: 0.8, action: "block", window: "span", enabled: true },
    { scope: { kind: "run", ref: "" }, limitTokens: 500_000, warnRatio: 0.8, action: "block", window: "span", enabled: true },
  ]);

  // Matriz A — Meta.
  if (MODEL_KEY) {
    await core.setProviderKey("meta", MODEL_KEY);
    const metaProvider = core.router.get("meta");
    if (!metaProvider) {
      check("matrix A meta provider registered", false, "no meta provider");
    } else {
      const live = resolveLiveMetaConfig({ OCTUS_LIVE_META_MODEL: "muse-spark-1.3-contributor", OCTUS_LIVE_META_REASONING_EFFORT: "xhigh" });
      console.log(liveConfigBanner(live));
      const ensured = ensureLiveMetaModel(metaProvider, live.modelId);
      if (ensured.extended) console.log("live catalog: meta/muse-spark-1.3-contributor added live-only (production intact)");
      const caps = metaProvider.capabilitiesOf(live.modelId);
      if (!caps) {
        check("matrix A meta model offered", false, "muse-spark-1.3-contributor not in catalog even live-extended");
      } else if (!caps.reasoningEfforts.includes("xhigh")) {
        block("matrix A (meta/contributor/xhigh)", `xhigh not in [${caps.reasoningEfforts.join(",")}]`);
      } else {
        try {
          await runMatrix(core, dir, { name: "matrix-A", providerId: "meta", modelId: live.modelId, effort: "xhigh" });
        } catch (error) {
          check("matrix A completes without harness exception", false, error instanceof Error ? error.message.slice(0, 300) : String(error));
        }
      }
    }
  } else {
    block("matrix A (meta/contributor/xhigh)", "MODEL_API_KEY not set");
  }

  // Matriz B — OpenCode Go, DeepSeek V4.1 Flash exacto del catálogo, sin fallback.
  if (GO_KEY) {
    await core.setProviderKey("opencode-go", GO_KEY);
    const catalog = await core.refreshGoCatalog();
    check("matrix B go catalog refresh", catalog.ok, catalog.error ?? `${catalog.count} models`);
    if (catalog.ok) {
      const models = core.router.get("opencode-go")?.models() ?? [];
      const exact = models.find((m) => m.modelId.toLowerCase() === "deepseek-v4.1-flash");
      if (!exact) {
        const similar = models.filter((m) => /deepseek/i.test(m.modelId)).map((m) => m.modelId).slice(0, 10);
        check("matrix B exact deepseek-v4.1-flash in real catalog (no fallback)", false, `absent; deepseek-like: [${similar.join(",") || "none"}] of ${models.length}`);
      } else if (!exact.capabilities.toolCall) {
        block("matrix B (go/deepseek-v4.1-flash/max)", "catalog entry lacks toolCall");
      } else if (!exact.capabilities.reasoningEfforts.includes("max")) {
        block("matrix B (go/deepseek-v4.1-flash/max)", `max not in [${exact.capabilities.reasoningEfforts.join(",")}]`);
      } else {
        try {
          await runMatrix(core, dir, { name: "matrix-B", providerId: "opencode-go", modelId: exact.modelId, effort: "max" });
        } catch (error) {
          check("matrix B completes without harness exception", false, error instanceof Error ? error.message.slice(0, 300) : String(error));
        }
      }
    }
  } else {
    block("matrix B (go/deepseek-v4.1-flash/max)", "OPENCODE_API_KEY not set");
  }

  const rows = await core.db.query<{ n: number; micro: number | null }>(
    "SELECT COUNT(*) AS n, SUM(cost_micro_usd) AS micro FROM usage_records",
  );
  const spent = rows[0];
  console.log(`live-stage3 spend: ${spent?.n ?? 0} calls, ${formatCost(spent?.micro ?? 0)}`);
  const byModel = await core.db.query<Record<string, string | number | null>>(
    "SELECT provider_id, model_id, COUNT(*) AS n FROM usage_records GROUP BY provider_id, model_id ORDER BY provider_id, model_id",
  );
  for (const row of byModel) {
    console.log(`live-stage3 usage by model: ${row.provider_id}/${row.model_id} calls=${row.n}`);
  }
} finally {
  await core.close();
  if (keepDir || failures > 0) {
    console.log(`live-stage3 workspace preserved for inspection: ${dir}`);
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (blocked.length > 0) {
  console.error(`LIVE STAGE3 BLOCKED (${blocked.join("; ")})`);
  process.exit(1);
}
if (failures > 0) {
  console.error(`LIVE STAGE3 FAILED (${failures} checks)`);
  process.exit(1);
}
console.log("LIVE STAGE3 PASSED");
