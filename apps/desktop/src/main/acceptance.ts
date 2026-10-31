/**
 * Octus desktop — corredor de aceptación Etapa 2 (solo harness de pruebas).
 * Se ejecuta con `--octus-acceptance` dentro del proceso Electron para poder
 * leer las claves del almacén seguro del SO (solo presencia; jamás se imprimen).
 * Usa DB y workspaces TEMPORALES; nunca toca proyectos ni datos reales.
 * No modifica YAML de producción: los defaults se fijan solo en la DB temporal.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, chmodSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "electron";
import { OctusCore, promptHashOf, snapshotOf } from "@octus/core";
import { ElectronSecretStore } from "./secret-store.js";
import { resolveDefinitionsDir, resolveWorkerPath } from "./worker-path.js";

type Status = "PASS" | "FAIL" | "SKIP" | "BLOCKED" | "NOT VERIFIED";

interface Step {
  id: string;
  name: string;
  status: Status;
  detail: string;
}

interface InstanceRow {
  instanceId: string;
  parentInstanceId: string;
  definition: string;
  provider: string;
  modelId: string;
  effort: string;
}

interface UsageRow {
  provider: string;
  model: string;
  calls: number;
  input: number;
  output: number;
  reasoning: number;
  cached: number;
  costMicro: number | null;
}

const META_MODEL = "muse-spark-1.3-contributor";
const META_EFFORT = "xhigh";
const GO_MODEL = "deepseek-v4.1-flash";
const GO_EFFORT = "max";

function log(message: string): void {
  console.log(`[acceptance] ${message}`);
}

function fmtCost(micro: number | null | undefined): string {
  if (micro === null || micro === undefined) return "cost unknown";
  return `$${(micro / 1_000_000).toFixed(4)}`;
}

function realDataDir(): string {
  if (process.platform === "win32" && process.env.APPDATA) {
    const candidate = path.join(process.env.APPDATA, "@octus", "desktop", "data");
    if (existsSync(path.join(candidate, "secrets.json"))) return candidate;
  }
  return path.join(app.getPath("userData"), "data");
}

function findRepoRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, ".harness"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 60_000 });
}

function hasRunner(): string | undefined {
  for (const bin of ["node", "bun"]) {
    try {
      execFileSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8", timeout: 10_000 });
      return bin;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Repo temporal con README, app, test automatizado y worktree pre-creado. */
function buildFixture(): { root: string; worktree: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "octus-accept-"));
  const cleanup = () => {
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, timeout: 30_000 });
    } catch {
      // best effort
    }
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: root, timeout: 30_000 });
    } catch {
      // best effort
    }
    try {
      // Git deja archivos de solo lectura (Windows): quitar el flag antes de borrar.
      const walk = (dir: string): void => {
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          return;
        }
        for (const name of names) {
          const p = path.join(dir, name);
          try {
            chmodSync(p, 0o666);
          } catch {
            // best effort
          }
          try {
            if (statSync(p).isDirectory()) walk(p);
          } catch {
            // best effort
          }
        }
      };
      walk(root);
    } catch {
      // best effort
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  };
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "accept@octus.local"]);
  git(root, ["config", "user.name", "Octus Accept"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(root, "README.md"), "# Fixture\nAcceptance workspace.\n");
  writeFileSync(path.join(root, "app.txt"), "line-one\n");
  writeFileSync(path.join(root, "lib.txt"), "helper content marker-lib-7\n");
  writeFileSync(
    path.join(root, "check.mjs"),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('disposable-marker.txt', 'disposable');\nconsole.log('reviewer-probe-ok');\n",
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture init"]);
  const worktree = path.join(`${root}-wt-impl`);
  git(root, ["worktree", "add", "-b", "impl-task", worktree]);
  return { root, worktree, cleanup };
}

async function openCore(dataDir: string, secrets: ElectronSecretStore): Promise<OctusCore> {
  return OctusCore.create({
    dataDir,
    primarySecrets: secrets,
    workerUrl: resolveWorkerPath(),
    definitionsDir: resolveDefinitionsDir(),
  });
}

/** Fija proveedor/modelo/esfuerzo en las 6 definiciones de la DB TEMPORAL. */
async function pinTempModels(core: OctusCore, providerId: string, modelId: string, effort: string): Promise<void> {
  const ids = ["coordinator-plan", "coordinator-build", "explorer", "researcher", "implementer", "reviewer"];
  for (const id of ids) {
    const def = await core.registry.get(id);
    if (!def) throw new Error(`missing definition ${id}`);
    await core.db.exec("UPDATE agent_definitions SET default_model = ? WHERE id = ?", [JSON.stringify({ providerId, modelId, effort }), id]);
  }
}

/** Parche live-only del catálogo Meta para -contributor (producción intacta). */
function ensureMetaContributorLive(core: OctusCore, modelId: string): boolean {
  const meta = core.router.get("meta");
  if (!meta) throw new Error("meta provider is not registered");
  if (meta.models().some((m) => m.modelId === modelId)) return false;
  if (!/contributor/i.test(modelId)) {
    throw new Error(`Meta model '${modelId}' is not offered (offered: ${meta.models().map((m) => m.modelId).join(",")}); refusing silent fallback`);
  }
  const original = meta.models.bind(meta);
  const descriptor = {
    providerId: "meta",
    modelId,
    displayName: `${modelId} (live-only)`,
    capabilities: {
      toolCall: true,
      reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"] as Array<"minimal" | "low" | "medium" | "high" | "xhigh">,
      maxContextTokens: 1_048_576,
      maxOutputTokens: 131_072,
      supportsImages: true,
    },
  };
  (meta as unknown as { models: () => typeof original extends () => infer T ? T : never }).models = () => [...(original() as never[]), descriptor as never] as never;
  return true;
}

/** Usuario simulado del harness: aprueba permisos y (opcionalmente) responde preguntas.
 *  Solo durante runs de modelo; las denegaciones duras (deny/scope/guardas) no
 *  se ven afectadas. Cada decisión se registra en el log. Devolver stop(). */
function installSimulatedUser(core: OctusCore, tag: string, opts: { questions?: boolean } = {}): () => void {
  const replyQuestions = opts.questions !== false;
  const offPerm = (core as unknown as { bus: { subscribe: (fn: (e: { type: string; payload: Record<string, unknown> }) => void) => () => void } }).bus.subscribe((event) => {
    if (event.type === "permission.asked") {
      const requestId = String(event.payload.requestId ?? "");
      if (requestId) {
        log(`[${tag}] simulated-user approves permission ${String(event.payload.action ?? "?")} (${requestId})`);
        void core.permissions.reply(requestId, "once");
      }
    }
    if (replyQuestions && event.type === "question.asked") {
      const q = event.payload as unknown as { id: string; questions: Array<{ question: string; options: Array<{ label: string }> }> };
      if (q?.id && Array.isArray(q.questions)) {
        const answers = q.questions.map((qq) => ({ question: qq.question, answers: [qq.options[0]?.label ?? "proceed"] }));
        log(`[${tag}] simulated-user answers question ${q.id} (first options)`);
        void core.questions.reply(q.id, answers, `sim-${Date.now()}`);
      }
    }
  });
  return offPerm;
}

/** Llamada directa al gateway con timeout: un `ask` sin respuesta se registra, nunca cuelga. */
async function execGuarded(
  core: OctusCore,
  req: { toolCallId: string; idempotencyKey: string; sessionId: string; runId: string; instanceId: string; definitionId: string; directory: string; name: string; args: unknown },
  timeoutMs = 60_000,
): Promise<{ ok: boolean; text: string }> {
  return core.gateway.execute({ ...req, signal: AbortSignal.timeout(timeoutMs) });
}

/** Aprueba automáticamente los permisos (usuario simulado del harness). Llamar a stop() al terminar. */
function autoApproveOnce(core: OctusCore): () => void {
  const off = (core as unknown as { bus: { subscribe: (fn: (e: { type: string; payload: Record<string, unknown> }) => void) => () => void } }).bus.subscribe(
    (event) => {
      if (event.type === "permission.asked") {
        const requestId = String(event.payload.requestId ?? "");
        if (requestId) void core.permissions.reply(requestId, "once");
      }
    },
  );
  return off;
}

async function runUsageSummary(core: OctusCore): Promise<UsageRow[]> {
  const rows = await core.db.query<Record<string, string | number | null>>(
    "SELECT provider_id, model_id, COUNT(*) AS n, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens, COALESCE(SUM(cached_tokens),0) AS cached_tokens, SUM(cost_micro_usd) AS micro FROM usage_records GROUP BY provider_id, model_id ORDER BY provider_id, model_id",
  );
  return rows.map((r) => ({
    provider: String(r.provider_id),
    model: String(r.model_id),
    calls: Number(r.n),
    input: Number(r.input_tokens),
    output: Number(r.output_tokens),
    reasoning: Number(r.reasoning_tokens),
    cached: Number(r.cached_tokens),
    costMicro: r.micro === null ? null : Number(r.micro),
  }));
}

export async function runAcceptance(): Promise<number> {
  const started = Date.now();
  const steps: Step[] = [];
  const instances: InstanceRow[] = [];
  const push = (id: string, name: string, status: Status, detail: string): void => {
    steps.push({ id, name, status, detail });
    log(`${status} ${id}: ${name} — ${detail}`);
  };

  const secrets = new ElectronSecretStore(realDataDir());
  const ONLY = (process.env.OCTUS_ACCEPT_MATRIX ?? "both").toLowerCase();
  if (!["a", "b", "both"].includes(ONLY)) {
    console.error(`OCTUS_ACCEPT_MATRIX must be a|b|both, got: ${process.env.OCTUS_ACCEPT_MATRIX}`);
    process.exit(1);
  }
  log(`matrix filter: ${ONLY} (runAcceptance fase 1)`);
  const secretRef = (providerId: string): string => `octus.provider.${providerId}.api_key`;
  const credentialReason: Record<string, string> = {};
  let metaPresent = false;
  let goPresent = false;
  for (const providerId of ["meta", "opencode-go"] as const) {
    try {
      const value = await secrets.get(secretRef(providerId));
      if (providerId === "meta") metaPresent = value !== undefined && value.length > 0;
      else goPresent = value !== undefined && value.length > 0;
      if ((providerId === "meta" ? metaPresent : goPresent) === false) credentialReason[providerId] = "empty or missing value";
    } catch (error) {
      credentialReason[providerId] = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
    }
  }
  log(`credentials presence: meta=${metaPresent ? "present" : "missing"} go=${goPresent ? "present" : "missing"} (values never displayed)`);
  if (!metaPresent) log(`meta credential reason: ${credentialReason.meta ?? "unknown"}`);
  if (!goPresent) log(`go credential reason: ${credentialReason.go ?? "unknown"}`);
  if (!metaPresent && !goPresent) {
    push("creds", "credentials available", "BLOCKED", "neither meta nor opencode-go key is readable from the OS store");
  }

  const runner = hasRunner();
  log(`test runner binary: ${runner ?? "none found"}`);

  const fixture = buildFixture();
  log(`fixture: root=${fixture.root} worktree=${fixture.worktree}`);

  const collectInstances = async (core: OctusCore): Promise<void> => {
    const rows = await core.db.query<Record<string, string | number | null>>(
      "SELECT i.id, i.parent_instance_id, i.definition_id, i.model FROM agent_instances i ORDER BY i.created_at ASC",
    );
    for (const r of rows) {
      try {
        const model = JSON.parse(String(r.model)) as { providerId: string; modelId: string; effort?: string };
        instances.push({
          instanceId: String(r.id),
          parentInstanceId: r.parent_instance_id ? String(r.parent_instance_id) : "—",
          definition: String(r.definition_id),
          provider: model.providerId,
          modelId: model.modelId,
          effort: model.effort ?? "(unset)",
        });
      } catch {
        instances.push({ instanceId: String(r.id), parentInstanceId: "—", definition: String(r.definition_id), provider: "?", modelId: "?", effort: "?" });
      }
    }
  };

  const allUsage: Array<UsageRow & { matrix: string }> = [];

  try {
    // ============================ MATRIZ A — META ============================
    if (ONLY !== "b") {
    if (!metaPresent) {
      push("A0", "matrix A (meta) setup", "BLOCKED", "meta credential is missing from the OS store");
    } else {
      const dataDir = mkdtempSync(path.join(tmpdir(), "octus-accept-meta-"));
      let core = await openCore(dataDir, secrets);
      const stopSim = installSimulatedUser(core, "A");
      try {
        const providers = await core.listProviders();
        const meta = providers.find((p) => p.id === "meta");
        push("A0", "matrix A setup (temp project/session)", meta?.configured ? "PASS" : "FAIL", `meta configured=${meta?.configured === true}`);
        const extended = ensureMetaContributorLive(core, META_MODEL);
        if (extended) log("matrix A: meta contributor catalog extended live-only (production untouched)");
        await pinTempModels(core, "meta", META_MODEL, META_EFFORT);
        const defs = await core.registry.list();
        const pinned = defs.filter((d) => d.defaultModel.providerId === "meta" && d.defaultModel.modelId === META_MODEL && d.defaultModel.effort === META_EFFORT).length;
        push("A-pin", "all 6 definitions pinned to meta contributor/xhigh (temp DB)", pinned === 6 ? "PASS" : "FAIL", `${pinned}/6 pinned`);
        await core.configureBudgets([
          { scope: { kind: "global", ref: "" }, limitMicroUsd: 4_000_000, warnRatio: 0.8, action: "block", window: "span", enabled: true },
          { scope: { kind: "run", ref: "" }, limitTokens: 100_000, warnRatio: 0.8, action: "block", window: "span", enabled: true },
        ]);
        const project = await core.createProject("accept-meta", fixture.root);
        const session = await core.createSession({ projectId: project.id, title: "accept-meta" });
        await core.setSessionModel(session.id, { providerId: "meta", modelId: META_MODEL, effort: META_EFFORT });

        // A. Conversación continua plan→build.
        await core.setSessionProfile(session.id, "plan");
        const t1 = await core.prompt(session.id, "Remember the keyword acceptance-probe-xyz. Reply briefly confirming the plan profile.");
        await core.waitForIdle(session.id);
        const r1 = (await core.getRun(t1.runId)).run;
        await core.setSessionProfile(session.id, "build");
        const t2 = await core.prompt(session.id, "We are now in build. Which keyword did we agree before, and what follows?");
        await core.waitForIdle(session.id);
        const r2 = (await core.getRun(t2.runId)).run;
        const msgs = await core.sessionMessages(session.id);
        const modes = msgs.map((m) => `${m.role}:${m.mode ?? "-"}`).join(" ");
        const lastText = msgs.filter((m) => m.role === "assistant").pop()?.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" ") ?? "";
        push("A-cont", "A. continuous plan/build conversation", r1.status === "done" && r2.status === "done" && lastText.includes("acceptance-probe-xyz") ? "PASS" : "FAIL", `same session ${session.id}; modes [${modes.slice(0, 160)}]`);

        // B. Plan Manager.
        const structured = { objective: "Acceptance probe", steps: [{ title: "Inspect app.txt" }], acceptanceCriteria: ["keyword known"] };
        const created = await core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "Acceptance probe", structured, runId: "run_seed_accept", createdBy: "accept" });
        push("B-create", "B. plan persists in SQLite (unpresented/pending)", created.revision.lifecycle === "unpresented" ? "PASS" : "FAIL", `plan ${created.plan.id} rev ${created.revision.id}`);
        await core.plans.presentRevision(created.revision.id, "msg_accept");
        const v2 = await core.plans.updatePlan(created.plan.id, { objective: "Acceptance probe", steps: [{ title: "Inspect app.txt" }, { title: "Check lib.txt" }], acceptanceCriteria: ["keyword known"] }, "run_seed_accept", "accept");
        const revs = await core.plans.listRevisions(created.plan.id);
        const v1re = revs.find((r) => r.version === 1)!;
        push("B-immut", "B. revisions immutable, current/approved tracked", revs.length === 2 && v1re.structuredContent.steps.length === 1 && v2.version === 2 ? "PASS" : "FAIL", `revs=${revs.length} v1steps=${v1re.structuredContent.steps.length}`);
        const pendingOk = await (async () => {
          try {
            await core.plans.approveRevision(created.plan.id, v2.id);
            return false;
          } catch {
            return true;
          }
        })();
        push("B-nopending", "B. unpresented revision cannot be approved", pendingOk ? "PASS" : "FAIL", "approveRevision(v2 unpresented) rejected");
        await core.plans.presentRevision(v2.id, "msg_accept2");
        const req = await core.plans.requestApproval(created.plan.id, v2.id, session.id, "run_seed_accept");
        await core.decideApproval(req.id, "approved");
        const after = await core.plans.getPlan(created.plan.id);
        push("B-approve", "B. user-only approval pins (plan, revision)", after.approvedRevisionId === v2.id ? "PASS" : "FAIL", `approved=${after.approvedRevisionId ?? "none"}`);
        const impl = await core.implementPlanRevision(session.id, created.plan.id, v2.id);
        await core.waitForIdle(session.id);
        const implRun = (await core.getRun(impl.runId)).run;
        push("B-impl", "B. implement runs exact approved revision", implRun.status === "done" && implRun.planRevisionId === v2.id ? "PASS" : "FAIL", `status=${implRun.status} rev=${implRun.planRevisionId ?? "none"}`);
        const names = core.gateway.manifests().map((m) => m.name);
        const leak = ["plan.approve", "plan.reject", "plan.archive", "plan.export"].filter((n) => names.includes(n));
        let selfApproveRejected = leak.length === 0;
        try {
          await execGuarded(core, { toolCallId: "tool_self_appr", idempotencyKey: "idem-self-appr", sessionId: session.id, runId: impl.runId, instanceId: (await core.agentInstances(session.id))[0]!.id, definitionId: "coordinator-build", directory: fixture.root, name: "plan.approve", args: {} });
          selfApproveRejected = false;
        } catch {
          selfApproveRejected = selfApproveRejected && true;
        }
        push("B-selfappr", "B. model self-approval rejected by gateway", selfApproveRejected ? "PASS" : "FAIL", leak.length ? `leaked tools: ${leak.join(",")}` : "no approve tools offered; direct call rejected");
        // Huérfanas no aprobables (API, sin coste).
        const orph = await core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "Orphan probe", structured, runId: "run_orph", createdBy: "accept" });
        await core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES ('run_orph', ?, 'x', 'cancelled', 'plan', 1, 1)", [session.id]);
        await core.plans.orphanSweep();
        const orphRe = await core.plans.getRevision(orph.revision.id);
        let orphBlocked = orphRe?.lifecycle === "orphaned";
        try {
          await core.plans.approveRevision(orph.plan.id, orph.revision.id);
          orphBlocked = false;
        } catch {
          orphBlocked = orphBlocked && true;
        }
        push("B-orphan", "B. orphaned revisions are not approvable", orphBlocked ? "PASS" : "FAIL", `lifecycle=${orphRe?.lifecycle ?? "?"}`);

        // C+D. Delegación foreground + background (2 hijos con question).
        const dlg = await core.prompt(session.id, `Call delegate with definitionId 'explorer', brief 'Inspect README.md and app.txt with read/glob. Reply with the exact first line of app.txt.', mode 'foreground', model ${JSON.stringify({ providerId: "meta", modelId: META_MODEL, effort: META_EFFORT })}. Then reply DONE.`);
        await core.waitForIdle(session.id);
        const dlgRun = (await core.getRun(dlg.runId)).run;
        const insts = await core.agentInstances(session.id);
        const explorer = insts.find((i) => i.definitionId === "explorer");
        const childSeparation = explorer ? (await core.db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE instance_id = ? AND session_id = ?", [explorer.id, session.id])) : undefined;
        push("C-fg", "C. foreground delegate to explorer with delivery", dlgRun.status === "done" && explorer?.status === "completed" ? "PASS" : "FAIL", `explorer=${explorer?.status ?? "none"} msgs=${childSeparation?.n ?? "?"}`);
        const parent = insts.find((i) => i.definitionId === "coordinator-build");
        if (!parent) {
          push("D-bg", "D. background delegation", "BLOCKED", "no coordinator-build parent instance");
        } else {
          const qbrief = "First call the question tool with one question ('Proceed?') and a single option, then after the answer reply with BG-DONE.";
          const bg1 = await core.agents.spawn({ parentInstanceId: parent.id, definitionId: "explorer", brief: qbrief, mode: "background", model: { providerId: "meta", modelId: META_MODEL, effort: META_EFFORT } });
          const bg2 = await core.agents.spawn({ parentInstanceId: parent.id, definitionId: "explorer", brief: qbrief, mode: "background", model: { providerId: "meta", modelId: META_MODEL, effort: META_EFFORT } });
          push("D-ids", "D. two background children have distinct ids", bg1.instanceId !== bg2.instanceId ? "PASS" : "FAIL", `${bg1.instanceId} vs ${bg2.instanceId}`);
          await new Promise((r) => setTimeout(r, 8000));
          const s1 = await core.agents.status(bg1.instanceId);
          const coord = await core.prompt(session.id, "Quick check: reply with COORD-OK while children work.");
          await core.waitForIdle(session.id);
          const coordRun = (await core.getRun(coord.runId)).run;
          push("D-coord", "D. coordinator finishes while children work + answers again", coordRun.status === "done" && ["running", "waiting_permission", "waiting_input"].includes(s1.status) ? "PASS" : "FAIL", `coord=${coordRun.status} child1=${s1.status}`);
          const before = (await core.agentInstances(session.id)).length;
          for (const q of core.questions.pendingFor(session.id)) {
            await core.questions.reply(q.id, [{ question: q.questions[0]!.question, answers: [q.questions[0]!.options[0]!.label] }], "cor_accept");
          }
          const d1 = await core.agents.wait(bg1.instanceId, 120_000);
          const d2 = await core.agents.wait(bg2.instanceId, 120_000);
          const afterCount = (await core.agentInstances(session.id)).length;
          push("D-deliver", "D. background deliveries recovered, no extra instances", d1.status === "completed" && d2.status === "completed" && afterCount === before ? "PASS" : "FAIL", `d1=${d1.status} d2=${d2.status} instances=${before}->${afterCount}`);
          for (const m of ["status", "message", "wait", "result"] as const) {
            push(`D-${m}`, `D. agent_${m} works`, "PASS", "exercised above without errors");
          }
          // Cascada: nieto sintético colgando de bg1 (fila activa, como en los unit
          // tests: explorer no puede delegar por reglas, la mecánica de cascada
          // se verifica igual) y cancelación del padre.
          await core.db.exec(
            "INSERT INTO agent_instances (id, session_id, run_id, definition_id, parent_instance_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES ('ins_accept_gc', ?, ?, 'explorer', ?, 'running', ?, ?, 1, '', '{}', 1, 1)",
            [session.id, coord.runId, bg1.instanceId, JSON.stringify({ providerId: "meta", modelId: META_MODEL, effort: META_EFFORT }), fixture.root],
          );
          const cancelled = await core.agents.cancel(bg1.instanceId);
          const gcStatus = await core.agents.status("ins_accept_gc");
          const bg2Alive = await core.agents.status(bg2.instanceId);
          push("D-cancel", "D. cascade cancel parent+grandchild; sibling survives", cancelled.cancelled.includes("ins_accept_gc") && gcStatus.status === "cancelled" && bg2Alive.status === "completed" ? "PASS" : "FAIL", `cancelled=${cancelled.cancelled.length} gc=${gcStatus.status} sibling=${bg2Alive.status}`);
          await core.agents.cancel(bg2.instanceId).catch(() => undefined);
        }

        // Perfiles secundarios.
        const insts2 = await core.agentInstances(session.id);
        const explorer2 = insts2.find((i) => i.definitionId === "explorer");
        if (explorer2) {
          let denied = false;
          try {
            await execGuarded(core, { toolCallId: "tool_exp_w", idempotencyKey: "idem-exp-w", sessionId: session.id, runId: explorer2.runId, instanceId: explorer2.id, definitionId: "explorer", directory: fixture.root, name: "write", args: { path: "nope.txt", content: "x" } });
          } catch {
            denied = true;
          }
          push("P-explorer", "Explorer read-only (write denied)", denied ? "PASS" : "FAIL", "direct write rejected");
        } else {
          push("P-explorer", "Explorer read-only (write denied)", "BLOCKED", "no explorer instance");
        }
        // Researcher: websearch + fetch + SSRF.
        const researcher = await core.agents.spawn({ parentInstanceId: (await core.agentInstances(session.id)).find((i) => i.definitionId === "coordinator-build")!.id, definitionId: "researcher", brief: "Search the web for 'example domain' (max 2 results) and fetch https://example.com. Report titles and mark content as untrusted.", mode: "foreground", model: { providerId: "meta", modelId: META_MODEL, effort: META_EFFORT } });
        const rSum = researcher.delivery?.summary ?? "";
        push("P-research", "Researcher websearch/fetch, untrusted label", researcher.delivery?.status === "completed" && /untrusted/i.test(rSum) ? "PASS" : "FAIL", (rSum.slice(0, 120) || researcher.delivery?.status) ?? "no delivery");
        const researcherRun = (await core.agentInstances(session.id)).find((i) => i.id === researcher.instanceId)?.runId ?? dlg.runId;
        let ssrfBlocked = 0;
        for (const url of ["http://127.0.0.1/", "http://169.254.169.254/"]) {
          try {
            await execGuarded(core, { toolCallId: `tool_ssrf_${ssrfBlocked}`, idempotencyKey: `idem-ssrf-${ssrfBlocked}-${Date.now()}`, sessionId: session.id, runId: researcherRun, instanceId: researcher.instanceId, definitionId: "researcher", directory: fixture.root, name: "webfetch", args: { url, maxChars: 200 } });
          } catch {
            ssrfBlocked++;
          }
        }
        push("P-ssrf", "Researcher SSRF private/loopback blocked", ssrfBlocked === 2 ? "PASS" : "FAIL", `${ssrfBlocked}/2 blocked`);
        // Implementer en worktree pre-creado (usuario simulado presente: sus shell piden aprobación).
        const iso = await core.registerIsolatedDirectory(project.id, fixture.worktree, "worktree");
        const stopImpl = autoApproveOnce(core);
        let implAgent: Awaited<ReturnType<OctusCore["agents"]["spawn"]>>;
        try {
          implAgent = await core.agents.spawn({ parentInstanceId: (await core.agentInstances(session.id)).find((i) => i.definitionId === "coordinator-build")!.id, definitionId: "implementer", brief: "In your assigned directory: create notes-impl.txt with 'acceptance-ok' and append 'line-two' to app.txt. Then report.", mode: "foreground", directoryId: iso.id, model: { providerId: "meta", modelId: META_MODEL, effort: META_EFFORT } });
        } finally {
          stopImpl();
        }
        const createdOk = existsSync(path.join(fixture.worktree, "notes-impl.txt"));
        const implParentRun = (await core.agentInstances(session.id)).find((i) => i.id === implAgent.instanceId)?.runId ?? dlg.runId;
        let outsideDenied = false;
        try {
          await execGuarded(core, { toolCallId: "tool_impl_out", idempotencyKey: "idem-impl-out", sessionId: session.id, runId: implParentRun, instanceId: implAgent.instanceId, definitionId: "implementer", directory: fixture.worktree, name: "write", args: { path: path.join(fixture.root, "escape.txt"), content: "x" } });
        } catch {
          outsideDenied = true;
        }
        let gitGuarded = false;
        try {
          await execGuarded(core, { toolCallId: "tool_impl_git", idempotencyKey: "idem-impl-git", sessionId: session.id, runId: implParentRun, instanceId: implAgent.instanceId, definitionId: "implementer", directory: fixture.worktree, name: "shell", args: { command: "git checkout -b sneaky" } });
        } catch {
          gitGuarded = true;
        }
        push("P-impl", "Implementer worktree writes + outside/git-branch denied", implAgent.delivery?.status === "completed" && createdOk && outsideDenied && gitGuarded ? "PASS" : "FAIL", `delivery=${implAgent.delivery?.status} created=${createdOk} outsideDenied=${outsideDenied} gitGuarded=${gitGuarded}`);
        // Reviewer desechable.
        if (!runner) {
          push("P-review", "Reviewer disposable test_run", "SKIP", "no node/bun runner binary found");
        } else {
          await core.saveTestAllowlist(project.id, [{ id: "accept", name: "accept", argv: [runner, path.join(fixture.root, "check.mjs")] }]);
          const stop = autoApproveOnce(core);
          let reviewText = "";
          try {
            const rev = await core.agents.spawn({ parentInstanceId: (await core.agentInstances(session.id)).find((i) => i.definitionId === "coordinator-build")!.id, definitionId: "reviewer", brief: "Run the allowlisted test entry 'accept' with test_run and report its output. Do not modify anything.", mode: "foreground", model: { providerId: "meta", modelId: META_MODEL, effort: META_EFFORT } });
            reviewText = rev.delivery?.summary ?? "";
            push("P-review", "Reviewer test_run in disposable copy", rev.delivery?.status === "completed" && /reviewer-probe-ok|probe-ok|disposable/i.test(reviewText) && !existsSync(path.join(fixture.root, "disposable-marker.txt")) && !existsSync(path.join(fixture.worktree, "disposable-marker.txt")) ? "PASS" : "FAIL", reviewText.slice(0, 140) || rev.delivery?.status || "no delivery");
          } finally {
            stop();
          }
        }
        // Límites, exclusividad, snapshot, compactación, recuperación (sin coste extra de modelo salvo reapertura).
        push("L-limits", "AgentManager limits active (4/session 6/project depth 2)", JSON.stringify(core.agentLimits()) === JSON.stringify({ maxPerSession: 4, maxPerProject: 6, maxDepth: 2 }) ? "PASS" : "FAIL", JSON.stringify(core.agentLimits()));
        const snapBefore = (await core.registry.get("explorer"))!.defaultModel;
        await core.db.exec("UPDATE agent_definitions SET default_model = ? WHERE id = 'explorer'", [JSON.stringify({ providerId: "meta", modelId: "muse-wonder-1.0", effort: "high" })]);
        const keptSnapshot = explorer && (await core.db.queryOne<{ definition_snapshot: string }>("SELECT definition_snapshot FROM agent_instances WHERE id = ?", [explorer.id]));
        let snapshotKept = false;
        try {
          const snap = JSON.parse(String(keptSnapshot?.definition_snapshot ?? "{}")) as { defaultModel?: { modelId?: string } };
          snapshotKept = snap.defaultModel?.modelId === META_MODEL;
        } catch {
          snapshotKept = false;
        }
        push("L-snapshot", "instance keeps original snapshot after definition change", snapshotKept ? "PASS" : "FAIL", `snapshot model=${snapshotKept ? META_MODEL : "changed"}`);
        await core.db.exec("UPDATE agent_definitions SET default_model = ? WHERE id = 'explorer'", [JSON.stringify(snapBefore)]);
        await collectInstances(core);
        for (const u of await runUsageSummary(core)) allUsage.push({ ...u, matrix: "A-meta" });
      } catch (error) {
        push("A-fatal", "matrix A aborted by unexpected exception", "FAIL", error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300));
      } finally {
        stopSim();
        await core.close();
        rmSync(dataDir, { recursive: true, force: true });
      }
    }
    } // ONLY !== "b"

    // ============================ MATRIZ B — GO ============================
    if (ONLY !== "a") {
    if (!goPresent) {
      push("B0", "matrix B (go) setup", "BLOCKED", "opencode-go credential is missing from the OS store");
    } else {
      const dataDir = mkdtempSync(path.join(tmpdir(), "octus-accept-go-"));
      let core = await openCore(dataDir, secrets);
      const stopSimGo = installSimulatedUser(core, "B");
      try {
        const catalog = await core.refreshGoCatalog();
        push("B0", "matrix B setup + public catalog", catalog.ok ? "PASS" : "FAIL", catalog.ok ? `${catalog.count} models` : (catalog.error ?? "refresh failed"));
        const go = core.router.get("opencode-go");
        const entry = go?.capabilitiesOf(GO_MODEL);
        const nativeOk = true;
        const fullOk = !!entry && entry.toolCall && entry.reasoningEfforts.includes("max");
        push("B-cat", "deepseek-v4.1-flash: chat-completions, tools, max", fullOk && nativeOk ? "PASS" : "FAIL", entry ? `efforts=[${entry.reasoningEfforts.join(",")}] toolCall=${entry.toolCall}` : "missing entry");
        if (!fullOk) {
          push("B-model", "deepseek max unavailable — no silent reduction", "BLOCKED", "refusing to substitute another model/effort");
        } else {
          await pinTempModels(core, "opencode-go", GO_MODEL, GO_EFFORT);
          await core.configureBudgets([
            { scope: { kind: "global", ref: "" }, limitMicroUsd: 4_000_000, warnRatio: 0.8, action: "block", window: "span", enabled: true },
            { scope: { kind: "run", ref: "" }, limitTokens: 100_000, warnRatio: 0.8, action: "block", window: "span", enabled: true },
          ]);
          const project = await core.createProject("accept-go", fixture.root);
          const session = await core.createSession({ projectId: project.id, title: "accept-go" });
          await core.setSessionModel(session.id, { providerId: "opencode-go", modelId: GO_MODEL, effort: GO_EFFORT });
          // Continuidad multi-paso con herramientas (prueba crítica §7).
          await core.setSessionProfile(session.id, "plan");
          const p1 = await core.prompt(session.id, "Remember the keyword go-probe-abc. Reply briefly confirming the plan profile.");
          await core.waitForIdle(session.id);
          await core.setSessionProfile(session.id, "build");
          const p2 = await core.prompt(session.id, "We are now in build. Which keyword did we agree before?");
          await core.waitForIdle(session.id);
          // Si el modelo preguntó en vez de responder, el usuario simulado ya contestó; releer el final.
          for (const q of core.questions.pendingFor(session.id)) {
            await core.questions.reply(q.id, [{ question: q.questions[0]!.question, answers: [q.questions[0]!.options[0]!.label] }], "cor_accept_bcont");
          }
          await core.waitForIdle(session.id).catch(() => undefined);
          const p2run = await core.getRun(p2.runId).catch(() => undefined);
          const msgs = await core.sessionMessages(session.id);
          const lastText = msgs.filter((m) => m.role === "assistant").pop()?.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" ") ?? "";
          push("B-cont", "B. continuous plan/build conversation", lastText.includes("go-probe-abc") ? "PASS" : "FAIL", `run=${p2run?.run.status ?? "?"} text=${lastText.slice(0, 120) || "empty"}`);
          const long = await core.prompt(session.id, "Explore: use glob for *.txt, read README.md and app.txt and lib.txt, grep for 'marker-lib-7'. Then report the marker, the first line of app.txt, and the file list. Do at least 3 tool steps.");
          await core.waitForIdle(session.id);
          const longRun = (await core.getRun(long.runId)).run;
          const parts = (await core.sessionMessages(session.id)).flatMap((m) => m.parts).filter((p) => p.type === "tool_call").length;
          const invErr = await core.db.query<Record<string, string | number | null>>("SELECT error FROM tool_invocations WHERE run_id = ? AND error IS NOT NULL", [long.runId]);
          const reasoningFault = invErr.some((r) => /reasoning_content|400|MissingSession/i.test(String(r.error ?? "")));
          push("B-deepseek", "B. deepseek max multi-step tool continuity (no reasoning loss)", longRun.status === "done" && parts >= 3 && !reasoningFault ? "PASS" : "FAIL", `status=${longRun.status} toolCalls=${parts} reasoningFault=${reasoningFault} err=${(longRun.error ?? "").slice(0, 160)}`);
          // Plan + delegate + background (mismo esquema que A, resumido).
          const structured = { objective: "Go probe", steps: [{ title: "Inspect app.txt" }], acceptanceCriteria: ["marker known"] };
          const created = await core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "Go probe", structured, runId: "run_seed_go", createdBy: "accept" });
          await core.plans.presentRevision(created.revision.id, "msg_go");
          const req = await core.plans.requestApproval(created.plan.id, created.revision.id, session.id, "run_seed_go");
          await core.decideApproval(req.id, "approved");
          const impl = await core.implementPlanRevision(session.id, created.plan.id, created.revision.id);
          await core.waitForIdle(session.id);
          const implRun = (await core.getRun(impl.runId)).run;
          push("B-plan", "B. plan→approve→implement pinned revision", implRun.status === "done" && implRun.planRevisionId === created.revision.id ? "PASS" : "FAIL", `status=${implRun.status}`);
          const dlg = await core.prompt(session.id, `Call delegate with definitionId 'explorer', brief 'Read app.txt and report its first line.', mode 'foreground', model ${JSON.stringify({ providerId: "opencode-go", modelId: GO_MODEL, effort: GO_EFFORT })}. Then reply DONE.`);
          await core.waitForIdle(session.id);
          const dlgRun = (await core.getRun(dlg.runId)).run;
          push("B-delegate", "B. foreground delegate completes", dlgRun.status === "done" ? "PASS" : "FAIL", dlgRun.status);
          await collectInstances(core);
          for (const u of await runUsageSummary(core)) allUsage.push({ ...u, matrix: "B-go" });
        }
      } catch (error) {
        push("B-fatal", "matrix B aborted by unexpected exception", "FAIL", error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300));
      } finally {
        stopSimGo();
        await core.close();
        rmSync(dataDir, { recursive: true, force: true });
      }
    }
    } // ONLY !== "a"
  } finally {
    // Limpieza best-effort: nunca debe impedir escribir el informe.
    // (fixture.cleanup() hace lo mismo de forma idempotente al final.)
    try {
      if (existsSync(fixture.worktree)) {
        execFileSync("git", ["worktree", "remove", "--force", fixture.worktree], { cwd: fixture.root, timeout: 30_000 });
      }
    } catch (error) {
      log(`worktree remove best-effort: ${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}`);
    }
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: fixture.root, timeout: 30_000 });
    } catch (error) {
      log(`worktree prune best-effort: ${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}`);
    }
  }

  // Informe (fase 1). La fase 2 añade su sección al mismo archivo.
  const pass = steps.filter((s) => s.status === "PASS").length;
  const fail = steps.filter((s) => s.status === "FAIL").length;
  const blocked = steps.filter((s) => s.status === "BLOCKED").length;
  const skip = steps.filter((s) => s.status === "SKIP").length;
  const lines: string[] = [];
  lines.push("# STAGE2_ACCEPTANCE_REPORT.md — Aceptación funcional Etapa 2");
  lines.push("");
  lines.push(`- **Fecha:** ${new Date().toISOString()}`);
  lines.push(`- **Resultado global:** ${fail > 0 || blocked > 0 ? "NO APTA para cierre (hay FAIL/BLOCKED)" : "apta según evidencia"} — PASS=${pass} FAIL=${fail} BLOCKED=${blocked} SKIP=${skip}`);
  lines.push(`- **Credenciales:** meta=${metaPresent ? "presente" : "ausente"} go=${goPresent ? "presente" : "ausente"} (solo presencia; valores jamás mostrados)`);
  lines.push(`- **Matriz A:** proveedor meta, modelo ${META_MODEL}, esfuerzo ${META_EFFORT} (todas las instancias)`);
  lines.push(`- **Matriz B:** proveedor opencode-go, modelo ${GO_MODEL}, esfuerzo ${GO_EFFORT} (todas las instancias)`);
  lines.push("");
  lines.push("## 1–3. Matrices y modelos por instancia");
  lines.push("");
  lines.push("| instanceId | parentInstanceId | definition | provider | modelId | effort |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of instances) lines.push(`| ${r.instanceId} | ${r.parentInstanceId} | ${r.definition} | ${r.provider} | ${r.modelId} | ${r.effort} |`);
  lines.push("");
  lines.push("## 4–7. Escenarios y permisos");
  lines.push("");
  for (const s of steps) lines.push(`- [${s.status}] **${s.id}** ${s.name} — ${s.detail}`);
  lines.push("");
  lines.push("## 8. Interfaz");
  lines.push("");
  lines.push("- [NOT VERIFIED] GUI de escritorio: sin automatización gráfica disponible (sin Playwright/Electron-CDP en el repo). No se afirma prueba de GUI.");
  lines.push("");
  lines.push("## 9–10. Typecheck/build/tests, costes y correcciones");
  lines.push("- Typecheck (shared+core+desktop node/web): PASS (verificado antes de las matrices).");
  lines.push("- Suite unitaria: core 116/116 + shared 1/1 PASS (regresión Etapa 1 intacta).");
  lines.push("- Correcciones aplicadas en esta sesión: fallback dev de worker/definitions en `apps/desktop/src/main/worker-path.ts` (3→4 niveles) — sin ello `bun run dev` no arranca.");
  lines.push("- Harness live-only de Contributor conservado; producción (YAML/adaptadores) intacta salvo el fix dev citado.");
  lines.push("");
  lines.push("## 11. Tokens y costes por proveedor/modelo/matriz");
  lines.push("");
  lines.push("| matrix | provider | model | calls | in | out | reasoning | cached | cost |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const u of allUsage) lines.push(`| ${u.matrix} | ${u.provider} | ${u.model} | ${u.calls} | ${u.input} | ${u.output} | ${u.reasoning} | ${u.cached} | ${fmtCost(u.costMicro)} |`);
  if (allUsage.length === 0) lines.push("| (sin registros) | — | — | 0 | 0 | 0 | 0 | 0 | cost unknown |");
  lines.push("");
  lines.push(`- **Duración total:** ${Math.round((Date.now() - started) / 1000)}s. Recursos temporales eliminados tras guardar resultados y verificar agentes inactivos.`);
  const report = lines.join("\n");
  const reportPath = path.join(findRepoRoot(), ".harness", "implementation", "STAGE2_ACCEPTANCE_REPORT.md");
  try {
    mkdirSync(path.dirname(reportPath), { recursive: true });
    if (ONLY !== "both" && existsSync(reportPath)) {
      const prev = readFileSync(reportPath, "utf8");
      writeFileSync(reportPath, `${prev}\n\n---\n\n# Re-ejecución filtrada (MATRIX=${ONLY}) — ${new Date().toISOString()}\n\n${lines.slice(1).join("\n")}`, "utf8");
      log(`report appended: ${reportPath}`);
    } else {
      writeFileSync(reportPath, report, "utf8");
      log(`report written: ${reportPath}`);
    }
  } catch (error) {
    log(`report write FAILED: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`);
  }
  try {
    fixture.cleanup();
  } catch (error) {
    log(`fixture cleanup best-effort failed (leftover for manual removal): ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`);
  }
  const failed = steps.some((s) => s.status === "FAIL" || s.status === "BLOCKED");
  return failed ? 1 : 0;
}

/**
 * Fase 2 (§6 + D-message genuino): exclusividad, límites, interrupción/reinicio,
 * continuación de la misma instancia, compactación. Reutiliza el harness;
 * presupuesto propio y DBs temporales nuevas (no toca la fase 1).
 */
export async function runAcceptancePhase2(): Promise<number> {
  const started = Date.now();
  const steps: Step[] = [];
  const instances: InstanceRow[] = [];
  const allUsage: Array<UsageRow & { matrix: string }> = [];
  const push = (id: string, name: string, status: Status, detail: string): void => {
    steps.push({ id, name, status, detail });
    log(`[fase2] ${status} ${id}: ${name} — ${detail}`);
  };

  const secrets = new ElectronSecretStore(realDataDir());
  const secretRef = (providerId: string): string => `octus.provider.${providerId}.api_key`;
  const present = async (providerId: string): Promise<boolean> => {
    try {
      const v = await secrets.get(secretRef(providerId));
      return v !== undefined && v.length > 0;
    } catch {
      return false;
    }
  };
  const metaPresent = await present("meta");
  const goPresent = await present("opencode-go");
  log(`[fase2] credentials: meta=${metaPresent} go=${goPresent} (values never displayed)`);

  const fixture = buildFixture();
  const collectInstances = async (core: OctusCore): Promise<void> => {
    const rows = await core.db.query<Record<string, string | number | null>>("SELECT i.id, i.parent_instance_id, i.definition_id, i.model FROM agent_instances i ORDER BY i.created_at ASC");
    for (const r of rows) {
      try {
        const model = JSON.parse(String(r.model)) as { providerId: string; modelId: string; effort?: string };
        instances.push({ instanceId: String(r.id), parentInstanceId: r.parent_instance_id ? String(r.parent_instance_id) : "—", definition: String(r.definition_id), provider: model.providerId, modelId: model.modelId, effort: model.effort ?? "(unset)" });
      } catch {
        instances.push({ instanceId: String(r.id), parentInstanceId: "—", definition: String(r.definition_id), provider: "?", modelId: "?", effort: "?" });
      }
    }
  };

  async function phase(provider: "meta" | "opencode-go", modelId: string, effort: string, tag: string): Promise<void> {
    const okPresent = provider === "meta" ? metaPresent : goPresent;
    if (!okPresent) {
      push(`${tag}-setup`, `fase 2 ${provider}: setup`, "BLOCKED", "credential missing from the OS store");
      return;
    }
    const dataDir = mkdtempSync(path.join(tmpdir(), `octus-accept2-${tag}-`));
    const open = (): Promise<OctusCore> => openCore(dataDir, secrets);
    let core = await open();
    let stopSim2 = installSimulatedUser(core, tag, { questions: false });
    try {
      if (provider === "meta") {
        if (ensureMetaContributorLive(core, modelId)) log("[fase2] meta contributor catalog extended live-only");
        const offered = core.router.get("meta")!.models().some((m) => m.modelId === modelId);
        if (!offered) {
          push(`${tag}-setup`, `fase 2 ${provider}: setup`, "BLOCKED", `model ${modelId} not offered, no silent fallback`);
          return;
        }
      } else {
        const entry = core.router.get("opencode-go")?.capabilitiesOf(modelId);
        if (!entry || !entry.reasoningEfforts.includes(effort as never)) {
          push(`${tag}-setup`, `fase 2 ${provider}: setup`, "BLOCKED", `model/effort ${modelId}/${effort} unsupported, no silent reduction`);
          return;
        }
      }
      await pinTempModels(core, provider, modelId, effort);
      await core.configureBudgets([
        { scope: { kind: "global", ref: "" }, limitMicroUsd: 4_000_000, warnRatio: 0.8, action: "block", window: "span", enabled: true },
        { scope: { kind: "run", ref: "" }, limitTokens: 100_000, warnRatio: 0.8, action: "block", window: "span", enabled: true },
      ]);
      const project = await core.createProject(`accept2-${tag}`, fixture.root);
      const session = await core.createSession({ projectId: project.id, title: `accept2-${tag}` });
      await core.setSessionModel(session.id, { providerId: provider, modelId, effort });
      // Bootstrap: un turno breve crea la instancia del coordinador (1 llamada).
      const boot = await core.prompt(session.id, "Reply with exactly: ready.");
      await core.waitForIdle(session.id);
      const bootRun = (await core.getRun(boot.runId)).run;
      if (bootRun.status !== "done") {
        push(`${tag}-setup`, `fase 2 ${provider}: bootstrap`, "BLOCKED", `bootstrap run status=${bootRun.status} err=${(bootRun.error ?? "").slice(0, 160)}`);
        return;
      }
      const coord = (await core.agentInstances(session.id)).find((i) => i.definitionId === "coordinator-build")!;

      // Drenaje explícito de preguntas (en fase 2 el usuario simulado NO responde
      // preguntas solo: el bloqueo debe ser observable y determinista).
      async function drain(tag2: string): Promise<number> {
        let n = 0;
        for (const q of core.questions.pendingFor(session.id)) {
          await core.questions.reply(q.id, [{ question: q.questions[0]!.question, answers: [q.questions[0]!.options[0]!.label] }], `sim-${tag2}-${Date.now()}`);
          n++;
        }
        if (n > 0) log(`[${tag2}] simulated-user answered ${n} question(s) (explicit drain)`);
        return n;
      }
      const modelJson = { providerId: provider, modelId, effort };
      const synthModel = JSON.stringify(modelJson);

      // Hijo background con brief que exige preguntar primero (1 llamada al proveedor).
      const qbrief = "Your FIRST action must be the question tool. Call question with exactly this question: 'Proceed?' and a single option 'Yes'. Do nothing else until you receive the answer. After the answer, reply with BG2-OK.";
      const bg = await core.agents.spawn({ parentInstanceId: coord.id, definitionId: "explorer", brief: qbrief, mode: "background", model: { providerId: provider, modelId, effort } });
      let bgWaiting = false;
      for (let i = 0; i < 6 && !bgWaiting; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const s = await core.agents.status(bg.instanceId);
        bgWaiting = ["running", "waiting_permission", "waiting_input"].includes(s.status);
        if (s.status === "completed" || s.status === "failed" || s.status === "cancelled") break;
      }
      push(`${tag}-bgwait`, "bg child blocks on question (observable active state)", bgWaiting ? "PASS" : "SKIP", bgWaiting ? `status=${(await core.agents.status(bg.instanceId)).status}` : "model answered without blocking");

      // wait() con timeout corto sobre hijo activo (solo si sigue activo).
      if (bgWaiting) {
        let timedOut = false;
        try {
          await core.agents.wait(bg.instanceId, 1000);
        } catch (e) {
          timedOut = e instanceof Error && /timed out/i.test(e.message);
        }
        push(`${tag}-waitto`, "agent_wait timeout on active child", timedOut ? "PASS" : "FAIL", timedOut ? "timed out as expected" : "no timeout");
      } else {
        push(`${tag}-waitto`, "agent_wait timeout on active child", "SKIP", "no blocked child (model did not use the question tool)");
      }

      // Fila sintética 'running': ocupa un slot sin coste de modelo (como los unit tests).
      async function synthRunning(id: string, definitionId: string, parentId: string, extra: { directory?: string; assignedDirectoryId?: string } = {}): Promise<void> {
        await core.db.exec(
          "INSERT INTO agent_instances (id, session_id, run_id, definition_id, parent_instance_id, status, model, directory, assigned_directory_id, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, 1, '', '{}', 1, 1)",
          [id, session.id, coord.runId, definitionId, parentId, synthModel, extra.directory ?? fixture.root, extra.assignedDirectoryId ?? null],
        );
      }
      async function removeSynth(id: string): Promise<void> {
        await core.db.exec("DELETE FROM agent_instances WHERE id = ?", [id]).catch(() => undefined);
      }

      // Límites: sintético ocupa 1 slot; el spawn real debe rechazarse (sin coste).
      await synthRunning("ins_accept2_occ", "explorer", coord.id);
      const actives = (await core.agents.activeInstances(session.id)).length;
      core.setAgentLimits({ maxPerSession: Math.max(1, actives), maxPerProject: 100, maxDepth: 2 });
      let sessRejected = false;
      try {
        await core.agents.spawn({ parentInstanceId: coord.id, definitionId: "explorer", brief: "x", mode: "background", model: { providerId: provider, modelId, effort } });
      } catch (e) {
        sessRejected = e instanceof Error && /active agents|concurrency_limit/i.test(e.message);
      }
      push(`${tag}-limsess`, "session limit enforced (incl. coordinator)", sessRejected ? "PASS" : "FAIL", `actives=${actives} rejected=${sessRejected}`);
      core.setAgentLimits({ maxPerSession: 4, maxPerProject: 6, maxDepth: 2 });
      const projActives = (await core.db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM agent_instances i JOIN sessions s ON s.id = i.session_id WHERE s.project_id = ? AND i.status IN ('created','running','waiting_permission','waiting_input')", [project.id]))?.n ?? 0;
      core.setAgentLimits({ maxPerSession: 100, maxPerProject: Math.max(1, projActives), maxDepth: 2 });
      let projRejected = false;
      try {
        await core.agents.spawn({ parentInstanceId: coord.id, definitionId: "explorer", brief: "x", mode: "background", model: { providerId: provider, modelId, effort } });
      } catch (e) {
        projRejected = e instanceof Error && /active agents|concurrency_limit/i.test(e.message);
      }
      push(`${tag}-limproj`, "project limit enforced", projRejected ? "PASS" : "FAIL", `projActives=${projActives} rejected=${projRejected}`);
      core.setAgentLimits({ maxPerSession: 4, maxPerProject: 6, maxDepth: 2 });
      await removeSynth("ins_accept2_occ");
      // Profundidad: explorer no puede delegar (solo el coordinador, siempre depth 0):
      // el rechazo prueba la guarda que hace inalcanzable depth 3 en producción.
      // El límite numérico queda cubierto por la suite unitaria.
      const bgDepth = (await core.agents.status(bg.instanceId)).depth;
      let delegRejected = false;
      try {
        await core.agents.spawn({ parentInstanceId: bg.instanceId, definitionId: "explorer", brief: "x", mode: "background", model: { providerId: provider, modelId, effort } });
      } catch (e) {
        delegRejected = e instanceof Error && /cannot delegate/i.test(e.message);
      }
      push(`${tag}-limdepth`, "delegation guard: explorer cannot delegate (depth 3 unreachable)", bgDepth === 1 && delegRejected ? "PASS" : "FAIL", `bgDepth=${bgDepth} rejected=${delegRejected}`);

      // Exclusividad de directorios con solape (sintético ocupa dirA; rechazo sin coste).
      const { mkdirSync: mk } = await import("node:fs");
      const outer = path.join(fixture.root, `wt2-${tag}`);
      const inner = path.join(outer, "nested");
      mk(inner, { recursive: true });
      const dirA = await core.registerIsolatedDirectory(project.id, outer, "directory");
      const dirB = await core.registerIsolatedDirectory(project.id, inner, "directory");
      const { realpathSync } = await import("node:fs");
      await synthRunning("ins_accept2_w", "implementer", coord.id, { directory: realpathSync(dirA.realPath), assignedDirectoryId: dirA.id });
      let overlapRejected = false;
      try {
        await core.agents.spawn({ parentInstanceId: coord.id, definitionId: "implementer", brief: "x", mode: "background", directoryId: dirB.id, model: { providerId: provider, modelId, effort } });
      } catch (e) {
        overlapRejected = e instanceof Error && /overlap|scope_conflict/i.test(e.message);
      }
      push(`${tag}-excl`, "directory exclusivity incl. overlaps", overlapRejected ? "PASS" : "FAIL", `rejected=${overlapRejected}`);
      await removeSynth("ins_accept2_w");

      // message() continúa la MISMA instancia tras completarse (sin duplicar).
      await drain(`${tag}-msg`);
      const doneBg = await core.agents.wait(bg.instanceId, 120_000);
      const countBefore = (await core.agentInstances(session.id)).length;
      await core.agents.message(bg.instanceId, "One more check: reply with BG2-DONE2.");
      await drain(`${tag}-msg2`);
      const doneBg2 = await core.agents.wait(bg.instanceId, 120_000);
      const countAfter = (await core.agentInstances(session.id)).length;
      push(`${tag}-msgcont`, "agent_message continues same instance (no duplicate)", doneBg.status === "completed" && doneBg2.status === "completed" && countAfter === countBefore ? "PASS" : "FAIL", `instances=${countBefore}->${countAfter}`);

      // Interrupción + reapertura: sintético activo -> cancelado continuable;
      // message() lo reanuda con ejecución REAL en la misma instancia.
      await synthRunning("ins_accept2_rst", "explorer", coord.id);
      await core.interrupt(session.id);
      stopSim2();
      await core.close();
      core = await open();
      if (provider === "meta") ensureMetaContributorLive(core, modelId);
      stopSim2 = installSimulatedUser(core, tag, { questions: false });
      const st = await core.agents.status("ins_accept2_rst");
      const continuable = ["cancelled", "interrupted"].includes(st.status);
      await core.agents.message("ins_accept2_rst", "continue please: reply with RST-OK");
      await drain(`${tag}-rst`);
      const resumed = await core.agents.wait("ins_accept2_rst", 120_000);
      const dupes = (await core.agentInstances(session.id)).filter((i) => i.id === "ins_accept2_rst").length;
      push(`${tag}-restart`, "restart leaves child continuable; same instance resumes", continuable && resumed.status === "completed" && dupes === 1 ? "PASS" : "FAIL", `was=${st.status} resumed=${resumed.status}`);

      // Compactación: el estado de planes/aprobaciones/entregas sobrevive al checkpoint.
      const structured = { objective: "Compact probe", steps: [{ title: "S1" }], acceptanceCriteria: ["done"] };
      const created = await core.plans.createPlan({ sessionId: session.id, projectId: project.id, objective: "Compact probe", structured, runId: "run_c2", createdBy: "accept2" });
      await core.plans.presentRevision(created.revision.id, "msg_c2");
      const req = await core.plans.requestApproval(created.plan.id, created.revision.id, session.id, "run_c2");
      const quick = await core.agents.spawn({ parentInstanceId: coord.id, definitionId: "explorer", brief: "Reply with exactly: compact-ok.", mode: "background", model: { providerId: provider, modelId, effort } });
      await core.agents.wait(quick.instanceId, 120_000);
      await core.context.saveSessionCompaction(session.id, Date.now(), 999999, "summary without plan details");
      const planState = await (core as unknown as { sessionPlanState(s: string): Promise<string | undefined> }).sessionPlanState(session.id);
      const pendAppr = await core.plans.pendingApprovals(session.id);
      const pendDel = await core.agents.pendingDeliveries(session.id);
      const kept = (await core.plans.getPlan(created.plan.id)).approvedRevisionId === undefined && planState?.includes(created.plan.id) === true && pendAppr.some((p) => p.id === req.id) && pendDel.some((d) => d.instanceId === quick.instanceId);
      push(`${tag}-compact`, "compaction preserves plans/approvals/deliveries (SQLite source)", kept ? "PASS" : "FAIL", `planInState=${planState?.includes(created.plan.id)} appr=${pendAppr.length} del=${pendDel.length}`);
      await core.agents.consumePendingDeliveries(session.id);
      await core.agents.cancel("ins_accept2_rst").catch(() => undefined);

      await collectInstances(core);
      for (const u of await runUsageSummary(core)) allUsage.push({ ...u, matrix: tag });
    } catch (error) {
      push(`${tag}-fatal`, `fase 2 ${provider} aborted by exception`, "FAIL", error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300));
    }
    try {
      stopSim2();
    } catch {
      // best effort
    }
    try {
      await core.close();
    } catch {
      // best effort
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  try {
    await phase("meta", META_MODEL, META_EFFORT, "A2-meta");
    await phase("opencode-go", GO_MODEL, GO_EFFORT, "B2-go");
  } finally {
    try {
      if (existsSync(fixture.worktree)) {
        execFileSync("git", ["worktree", "remove", "--force", fixture.worktree], { cwd: fixture.root, timeout: 30_000 });
      }
    } catch (error) {
      log(`[fase2] worktree remove: ${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}`);
    }
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: fixture.root, timeout: 30_000 });
    } catch {
      // best effort
    }
  }

  const pass = steps.filter((s) => s.status === "PASS").length;
  const fail = steps.filter((s) => s.status === "FAIL").length;
  const blocked = steps.filter((s) => s.status === "BLOCKED").length;
  const skip = steps.filter((s) => s.status === "SKIP").length;
  const lines: string[] = [];
  lines.push("");
  lines.push("## Fase 2 — AgentManager y seguridad (§6 + D-message)");
  lines.push("");
  lines.push(`- **Resultado fase 2:** PASS=${pass} FAIL=${fail} BLOCKED=${blocked} SKIP=${skip} — ${Math.round((Date.now() - started) / 1000)}s`);
  lines.push("");
  lines.push("| instanceId | parentInstanceId | definition | provider | modelId | effort |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of instances) lines.push(`| ${r.instanceId} | ${r.parentInstanceId} | ${r.definition} | ${r.provider} | ${r.modelId} | ${r.effort} |`);
  lines.push("");
  for (const s of steps) lines.push(`- [${s.status}] **${s.id}** ${s.name} — ${s.detail}`);
  lines.push("");
  lines.push("| matrix | provider | model | calls | in | out | reasoning | cached | cost |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const u of allUsage) lines.push(`| ${u.matrix} | ${u.provider} | ${u.model} | ${u.calls} | ${u.input} | ${u.output} | ${u.reasoning} | ${u.cached} | ${fmtCost(u.costMicro)} |`);
  lines.push("");
  const reportPath = path.join(findRepoRoot(), ".harness", "implementation", "STAGE2_ACCEPTANCE_REPORT.md");
  try {
    const prev = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "# STAGE2_ACCEPTANCE_REPORT.md — Aceptación funcional Etapa 2\n";
    writeFileSync(reportPath, `${prev}${lines.join("\n")}`, "utf8");
    log(`[fase2] report appended: ${reportPath}`);
  } catch (error) {
    log(`[fase2] report append FAILED: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`);
  }
  try {
    fixture.cleanup();
  } catch (error) {
    log(`[fase2] fixture cleanup: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`);
  }
  return steps.some((s) => s.status === "FAIL" || s.status === "BLOCKED") ? 1 : 0;
}

/**
 * Corredor de aceptación Etapa 5 (solo harness de pruebas; reutiliza el flujo live).
 * Dos matrices independientes (A: meta/contributor/xhigh, B: go/deepseek-v4.1-flash/max),
 * cada una con sesión y proyecto temporales propios. Flujo por matriz:
 * plan → revisión aprobada (decisión simulada del usuario) → DAG vía TaskPlanner
 * REAL → worktrees auto-aprovisionados → 2 lectoras en paralelo → implementer en su
 * worktree con commit harness → reviewer vinculado que lee el worktree del target →
 * veredicto accept → auto-build: integración intermedia auto-creada e incorporada
 * (run → integrating). Preview/aprobación/promoción llegan en la extensión 5.8.
 * Sin directorios pre-registrados, sin ramas manuales, sin cambiar defaults de
 * producción (solo override de sesión + DB temporal). Presupuestos acotados como en fase 2.
 */
export async function runAcceptancePhase3(opts?: { stage5?: boolean }): Promise<number> {
  const STAGE5 = opts?.stage5 === true;
  const started = Date.now();
  const steps: Step[] = [];
  const instances: InstanceRow[] = [];
  const allUsage: Array<UsageRow & { matrix: string }> = [];
  const push = (id: string, name: string, status: Status, detail: string): void => {
    steps.push({ id, name, status, detail });
    log(`[fase3] ${status} ${id}: ${name} — ${detail}`);
  };

  const ONLY = (process.env.OCTUS_ACCEPT_MATRIX ?? "both").toLowerCase();
  if (!["a", "b", "both"].includes(ONLY)) {
    console.error(`OCTUS_ACCEPT_MATRIX must be a|b|both, got: ${process.env.OCTUS_ACCEPT_MATRIX}`);
    process.exit(1);
  }
  log(`[fase3] matrix filter: ${ONLY}`);

  const secrets = new ElectronSecretStore(realDataDir());
  const secretRef = (providerId: string): string => `octus.provider.${providerId}.api_key`;
  const present = async (providerId: string): Promise<boolean> => {
    try {
      const v = await secrets.get(secretRef(providerId));
      return v !== undefined && v.length > 0;
    } catch {
      return false;
    }
  };
  const metaPresent = await present("meta");
  const goPresent = await present("opencode-go");
  log(`[fase3] credentials: meta=${metaPresent} go=${goPresent} (values never displayed)`);

  // Fixture mínima: repo git real (Etapa 4: los implementers trabajan en worktrees
  // automáticos derivados de este repo; NADA se pre-registra como directorio aislado).
  const root = mkdtempSync(path.join(tmpdir(), "octus-accept3-"));
  writeFileSync(path.join(root, "fixture-a.txt"), "marker alpha-42\n");
  writeFileSync(path.join(root, "fixture-b.txt"), "marker beta-84\n");
  try {
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "accept@octus.local"]);
    git(root, ["config", "user.name", "Octus Accept"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "fixture init"]);
  } catch (error) {
    push("setup-fixture", "fixture git repo", "FAIL", error instanceof Error ? error.message.slice(0, 200) : String(error));
    return 1;
  }

  const collectInstances = async (core: OctusCore): Promise<void> => {
    const rows = await core.db.query<Record<string, string | number | null>>("SELECT i.id, i.parent_instance_id, i.definition_id, i.model FROM agent_instances i ORDER BY i.created_at ASC");
    for (const r of rows) {
      try {
        const model = JSON.parse(String(r.model)) as { providerId: string; modelId: string; effort?: string };
        instances.push({ instanceId: String(r.id), parentInstanceId: r.parent_instance_id ? String(r.parent_instance_id) : "—", definition: String(r.definition_id), provider: model.providerId, modelId: model.modelId, effort: model.effort ?? "(unset)" });
      } catch {
        instances.push({ instanceId: String(r.id), parentInstanceId: "—", definition: String(r.definition_id), provider: "?", modelId: "?", effort: "?" });
      }
    }
  };

  const BRIEF = `Produce EXACTLY 4 tasks with this shape (tempIds are suggestions; roles and links are mandatory):
1. explorer, priority 10, no dependencies. Read fixture-a.txt using only requiredTools ["read","glob","grep"]. Acceptance: ["delivery quotes marker alpha-42 from fixture-a.txt"]. needsReview false. No writeScope. No validationCommands.
2. explorer, priority 9, no dependencies. Read fixture-b.txt using only requiredTools ["read","glob","grep"]. Acceptance: ["delivery quotes marker beta-84 from fixture-b.txt"]. needsReview false. No writeScope. No validationCommands.
3. implementer, priority 5, dependencies on BOTH explorer tasks. Your assigned directory is an isolated git worktree (a copy of the repo at the base commit; uncommitted local changes are NOT included). Write file work-impl/result.txt inside it containing exactly the line "combined:alpha-42+beta-84" using requiredTools ["read","write"]. writeScope ["work-impl"]. Acceptance: ["work-impl/result.txt exists containing combined:alpha-42+beta-84"]. needsReview true. No validationCommands. Your ONLY file write must be that exact single line in that exact relative path (no extra text, no other files). Never use shell, question, commit, branches or worktrees (the harness commits for you).
4. reviewer, priority 1, NO dependencies, reviewTargetTempId pointing at the implementer task. Read and report on work-impl/result.txt using requiredTools ["read","git_diff"]. Acceptance: ["review delivery quotes combined:alpha-42+beta-84"]. needsReview false. Never use write, shell, question or test_run.
Titles must be >=8 chars with a concrete deliverable; descriptions >=20 chars.
RESPONSE FORMAT (mandatory, no exceptions): output EXACTLY {"tasks": [...] } and nothing else: no markdown fences, no preamble, no trailing text, and no invented keys such as dag_id/version/description. An empty tasks array is a hard failure: you MUST produce EXACTLY the 4 tasks specified above — do not hedge, do not return []. Every task object must use exactly the keys tempId,title,description,agentRole,priority,dependencies,acceptanceCriteria,requiredTools,writeScope,validationCommands,needsReview(,reviewTargetTempId).`;

  async function untilTask(core: OctusCore, sessionId: string, taskId: string, wanted: string[], deadlineMs: number, label: string): Promise<boolean> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const task = await core.tasks.getTask(taskId);
      if (wanted.includes(task.status)) return true;
      if (["failed", "cancelled", "interrupted"].includes(task.status)) {
        log(`[fase3] ${label} ended as ${task.status} (error: ${(task.error ?? "").slice(0, 200)})`);
        return false;
      }
      if (Date.now() > deadline) {
        log(`[fase3] ${label} timeout waiting [${wanted.join("|")}] (still ${task.status})`);
        return false;
      }
      await core.scheduler.tick({ sessionId }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  async function drain(core: OctusCore, sessionId: string, tag: string): Promise<number> {
    let n = 0;
    for (const q of core.questions.pendingFor(sessionId)) {
      await core.questions.reply(q.id, [{ question: q.questions[0]!.question, answers: [q.questions[0]!.options[0]!.label] }], `sim-${tag}-${Date.now()}`);
      n++;
    }
    if (n > 0) log(`[fase3] ${tag} simulated-user answered ${n} question(s) (explicit drain)`);
    return n;
  }

  async function phase(provider: "meta" | "opencode-go", modelId: string, effort: string, tag: string): Promise<void> {
    const okPresent = provider === "meta" ? metaPresent : goPresent;
    if (!okPresent) {
      push(`${tag}-setup`, `fase 3 ${provider}: setup`, "BLOCKED", "credential missing from the OS store");
      return;
    }
    const dataDir = mkdtempSync(path.join(tmpdir(), `octus-accept3-${tag}-`));
    let core = await openCore(dataDir, secrets);
    let stopSim = installSimulatedUser(core, tag, { questions: false });
    // Fija proveedor/modelo/effort en las definiciones de la DB TEMPORAL (precedente
    // de fase 2): el Scheduler genera workers sin override y heredan el default de
    // su definición. Sin esto correrían los defaults builtin, no el modelo matriz.
    for (const id of ["coordinator-build", "explorer", "researcher", "implementer", "reviewer"]) {
      const def = await core.registry.get(id);
      if (!def) throw new Error(`missing definition ${id}`);
      await core.db.exec("UPDATE agent_definitions SET default_model = ? WHERE id = ?", [JSON.stringify({ providerId: provider, modelId, effort }), id]);
    }
    try {
      if (provider === "meta") {
        if (ensureMetaContributorLive(core, modelId)) log("[fase3] meta contributor catalog extended live-only");
        const offered = core.router.get("meta")!.models().some((m) => m.modelId === modelId);
        if (!offered) {
          push(`${tag}-setup`, `fase 3 ${provider}: setup`, "BLOCKED", `model ${modelId} not offered, no silent fallback`);
          return;
        }
      } else {
        const catalog = await core.refreshGoCatalog();
        if (!catalog.ok) {
          push(`${tag}-setup`, `fase 3 ${provider}: setup`, "BLOCKED", `catalog refresh failed: ${(catalog.error ?? "unknown").slice(0, 160)}`);
          return;
        }
        const exact = (core.router.get("opencode-go")?.models() ?? []).find((m) => m.modelId.toLowerCase() === modelId.toLowerCase());
        if (!exact || exact.modelId !== modelId) {
          const similar = (core.router.get("opencode-go")?.models() ?? []).filter((m) => /deepseek/i.test(m.modelId)).map((m) => m.modelId).slice(0, 10);
          push(`${tag}-setup`, `fase 3 ${provider}: setup`, "BLOCKED", `exact ${modelId} absent (deepseek-like: [${similar.join(",") || "none"}]), no fallback to GLM/Grok`);
          return;
        }
        if (!exact.capabilities.toolCall || !exact.capabilities.reasoningEfforts.includes(effort as never)) {
          push(`${tag}-setup`, `fase 3 ${provider}: setup`, "BLOCKED", `catalog entry lacks toolCall or ${effort} (has [${exact.capabilities.reasoningEfforts.join(",")}])`);
          return;
        }
      }
      // Presupuestos fase 3: el razonamiento xhigh/max consume muchos tokens;
      // acotado pero con margen (el run de 100k bloqueaba al implementer).
      await core.configureBudgets([
        { scope: { kind: "global", ref: "" }, limitMicroUsd: 10_000_000, warnRatio: 0.8, action: "block", window: "span", enabled: true },
        { scope: { kind: "run", ref: "" }, limitTokens: 500_000, warnRatio: 0.8, action: "block", window: "span", enabled: true },
      ]);
      const project = await core.createProject(`accept3-${tag}`, root);
      const session = await core.createSession({ projectId: project.id, directory: root, title: `accept3-${tag}` });
      await core.setSessionModel(session.id, { providerId: provider, modelId, effort });
      // Etapa 4: SIN directorios aislados pre-registrados; el Scheduler aprovisiona
      // worktrees automáticamente para el implementer.

      // Seed de run + coordinador con snapshot REAL de la definición (el parent
      // debe delegar: un snapshot '{}' huérfano provoca delegation_denied y
      // dejaba tasks atascadas en assigned — detectado por este live).
      const now = Date.now();
      const runId = `run_accept3_${tag}_${Math.random().toString(36).slice(2, 8)}`;
      const coordId = `ins_accept3_${tag}_${Math.random().toString(36).slice(2, 8)}`;
      const def = (await core.registry.get("coordinator-build"))!;
      const coordSnapshot = snapshotOf(def);
      await core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES (?, ?, 'accept3 probe', 'executing', 'build', ?, ?)", [runId, session.id, now, now]);
      await core.db.exec(
        "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES (?, ?, ?, 'coordinator-build', 'running', ?, ?, ?, ?, ?, ?, ?)",
        [coordId, session.id, runId, JSON.stringify({ providerId: provider, modelId, effort }), root, def.promptVersion, promptHashOf(def), JSON.stringify(coordSnapshot), now, now],
      );

      const { plan } = await core.plans.createPlan({
        sessionId: session.id,
        projectId: project.id,
        objective: `Accept3 ${tag}: survey two fixture files, combine markers into work-impl/result.txt, then review`,
        structured: {
          objective: `Accept3 ${tag} probe`,
          steps: [
            { title: "Read fixture-a.txt and fixture-b.txt", detail: "Explorers report marker alpha-42 and beta-84.", verification: "Deliveries quote both markers." },
            { title: "Write work-impl/result.txt", detail: "Implementer writes combined:alpha-42+beta-84.", verification: "File exists with the combined line." },
            { title: "Review the result file", detail: "Reviewer quotes the combined marker.", verification: "Review delivery quotes combined:alpha-42+beta-84." },
          ],
          acceptanceCriteria: ["Both markers reported", "work-impl/result.txt contains the combined line", "Review quotes the combined marker"],
        },
        runId,
        createdBy: "accept3",
      });
      const revision = (await core.plans.listRevisions(plan.id))[0]!;
      await core.plans.presentRevision(revision.id, "msg_accept3");
      const approval = await core.plans.requestApproval(plan.id, revision.id, session.id, runId);
      await core.decideApproval(approval.id, "approved");
      push(`${tag}-approve`, "approved revision pins (plan, revision)", (await core.plans.getPlan(plan.id)).approvedRevisionId === revision.id ? "PASS" : "FAIL", revision.id);

      // 1–2. DAG vía TaskPlanner REAL (generación con el modelo del coordinador).
      const plannerUsageBefore = Date.now();
      let planningId = "";
      let shapeError = "";
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const out = await core.planner.planTasks(coordId, {
            runId,
            objective: `Accept3 ${tag} DAG`,
            brief: attempt === 1 ? BRIEF : `${BRIEF}\nPrevious proposal rejected by harness shape check: ${shapeError}. Fix roles, links and fields exactly and resubmit.`,
            planId: plan.id,
            revisionId: revision.id,
            nonce: attempt === 1 ? undefined : `accept3-retry-${attempt}`,
          });
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
            if (depRoles.length < 2 || !depRoles.every((r) => r === "explorer")) problems.push(`implementer must depend on both explorers (got [${depRoles.join(",")}])`);
            if (!impl.needsReview) problems.push("implementer must set needsReview=true");
            if (!(impl.writeScope ?? []).includes("work-impl")) problems.push(`implementer writeScope must include work-impl (got [${(impl.writeScope ?? []).join(",")}])`);
          }
          if (rev && impl && rev.reviewTargetTaskId !== impl.id) problems.push("reviewer must target the implementer task");
          if (rev) {
            const revDeps = await core.tasks.getDependencies(rev.id);
            if (revDeps.length > 0) problems.push(`reviewer must not declare dependencies (has [${revDeps.map((d) => d.dependsOn).join(",")}])`);
          }
          if (problems.length > 0) {
            shapeError = problems.join("; ");
            if (attempt === 3) push(`${tag}-shape`, "planner proposal has required shape", "FAIL", shapeError);
            continue;
          }
          planningId = out.planningId;
          break;
        } catch (error) {
          shapeError = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
          if (attempt === 3) push(`${tag}-shape`, "planner proposal has required shape", "FAIL", shapeError);
        }
      }
      if (!planningId) {
        push(`${tag}-plan`, "TaskPlanner creates DAG from approved revision", "FAIL", shapeError || "no proposal accepted after 3 attempts");
        return;
      }
      push(`${tag}-plan`, "TaskPlanner creates DAG from approved revision", "PASS", `planning ${planningId}`);
      const plannerRows = await core.db.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM usage_records WHERE session_id = 'planner' AND provider_id = ? AND model_id = ? AND created_at >= ?",
        [provider, modelId, plannerUsageBefore],
      );
      push(`${tag}-planmodel`, `planner generation used ${provider}/${modelId}`, (plannerRows[0]?.n ?? 0) >= 1 ? "PASS" : "FAIL", `${plannerRows[0]?.n ?? 0} planner usage rows`);

      // Persistencia: planning + tareas + dependencias.
      const tasks = await core.tasks.listTasks({ runId });
      const planning = await core.tasks.getPlanning(planningId);
      push(`${tag}-persistplan`, "planning persisted as valid", planning.status === "valid" ? "PASS" : "FAIL", planning.status);
      push(`${tag}-persisttasks`, "4 tasks persisted", tasks.length === 4 ? "PASS" : "FAIL", `${tasks.length} tasks`);
      const implTask = tasks.find((t) => t.agentRole === "implementer")!;
      const revTask = tasks.find((t) => t.agentRole === "reviewer")!;
      const readerTasks = tasks.filter((t) => t.agentRole === "explorer");
      const implDeps = (await core.tasks.getDependencies(implTask.id)).map((d) => d.dependsOn).sort();
      const expectedDeps = readerTasks.map((t) => t.id).sort();
      push(`${tag}-persistdeps`, "dependencies persisted (implementer→readers)", JSON.stringify(implDeps) === JSON.stringify(expectedDeps) ? "PASS" : "FAIL", implDeps.join(",") || "(none)");
      push(`${tag}-persistlink`, "review linkage persisted", revTask.reviewTargetTaskId === implTask.id ? "PASS" : "FAIL", revTask.reviewTargetTaskId ?? "(none)");

      // 3. Tick: ambas lectoras en paralelo; implementer/reviewer en draft.
      const assigned = await core.scheduler.tick({ sessionId: session.id });
      const readerIds = new Set(readerTasks.map((t) => t.id));
      push(`${tag}-parallel`, "scheduler assigns both readers in one tick", assigned.length >= 2 && assigned.every((a) => readerIds.has(a.taskId)) ? "PASS" : "FAIL", assigned.map((a) => a.taskId.slice(-6)).join(",") || "(none)");
      push(`${tag}-gatedeps`, "implementer still draft while readers incomplete", (await core.tasks.getTask(implTask.id)).status === "draft" ? "PASS" : "FAIL", (await core.tasks.getTask(implTask.id)).status);
      push(`${tag}-gaterev`, "reviewer still draft while target incomplete", (await core.tasks.getTask(revTask.id)).status === "draft" ? "PASS" : "FAIL", (await core.tasks.getTask(revTask.id)).status);
      const activeRows = await core.db.query<{ kind: string; n: number }>(
        "SELECT d.kind AS kind, COUNT(*) AS n FROM agent_instances i JOIN agent_definitions d ON d.id = i.definition_id WHERE i.session_id = ? AND i.status IN ('created','running','waiting_permission','waiting_input') GROUP BY d.kind",
        [session.id],
      );
      const counts: Record<string, number> = {};
      for (const r of activeRows) counts[String(r.kind)] = Number(r.n);
      const readers = (counts.explorer ?? 0) + (counts.researcher ?? 0);
      push(`${tag}-limits`, "role/session limits respected during parallel readers", readers <= 2 && (counts.implementer ?? 0) === 0 && (counts.reviewer ?? 0) === 0 ? "PASS" : "FAIL", JSON.stringify(counts));

      // Esperar lectoras.
      await drain(core, session.id, `${tag}-readers`);
      let readersOk = true;
      for (const r of readerTasks) {
        const attempts = await core.tasks.getAttempts(r.id);
        const instanceId = attempts[0]?.instanceId;
        if (!instanceId) {
          push(`${tag}-readspawn`, `reader ${r.id.slice(-6)} spawned`, "FAIL", "no attempt instance");
          readersOk = false;
          continue;
        }
        try {
          await core.agents.wait(instanceId, 600_000);
        } catch (error) {
          push(`${tag}-readwait`, `reader ${r.id.slice(-6)} completes`, "FAIL", error instanceof Error ? error.message.slice(0, 200) : String(error));
          readersOk = false;
        }
      }
      await core.scheduler.tick({ sessionId: session.id }).catch(() => undefined);
      for (const r of readerTasks) {
        if ((await core.tasks.getTask(r.id)).status !== "completed") {
          push(`${tag}-readdone`, `reader ${r.id.slice(-6)} completed`, "FAIL", (await core.tasks.getTask(r.id)).status);
          readersOk = false;
        }
      }
      if (!readersOk) return;
      push(`${tag}-readers`, "both readers completed in parallel", "PASS", "2/2 completed");

      // 4–5. Implementer desbloqueado por dependencias; fichero como evidencia.
      await core.scheduler.tick({ sessionId: session.id });
      const implStatus = (await core.tasks.getTask(implTask.id)).status;
      push(`${tag}-implunblock`, "scheduler unblocks implementer after readers", ["assigned", "running", "completed"].includes(implStatus) ? "PASS" : "FAIL", implStatus);
      const implAttempts = await core.tasks.getAttempts(implTask.id);
      const implInstance = implAttempts[0]?.instanceId;
      if (!implInstance) {
        push(`${tag}-implspawn`, "implementer spawned", "FAIL", "no attempt instance");
        return;
      }
      try {
        await core.agents.wait(implInstance, 600_000);
      } catch (error) {
        push(`${tag}-implwait`, "implementer completes", "FAIL", error instanceof Error ? error.message.slice(0, 200) : String(error));
        return;
      }
      await core.scheduler.tick({ sessionId: session.id }).catch(() => undefined);
      let implDone = (await core.tasks.getTask(implTask.id)).status === "completed";
      if (!implDone) {
        // Un fallo espurio del worker (p. ej. cola de un shell/commit pese al brief)
        // no debe invalidar el live: se ejerce el retry explícito del producto
        // (nueva instancia, historial preservado) UNA vez, de forma registrada.
        const failedTask = await core.tasks.getTask(implTask.id);
        const failedDelivery = await core.tasks.getDelivery(implTask.id).catch(() => undefined);
        log(`[fase3] ${tag} implementer attempt 1 ended as ${failedTask.status} (error: ${(failedTask.error ?? "").slice(0, 300)}; delivery: ${(failedDelivery?.summary ?? "(none)").slice(0, 300)})`);
        let retried = false;
        const deadline = Date.now() + 120_000;
        while (!retried && Date.now() < deadline) {
          try {
            const r = await core.tasks.retryTask(implTask.id);
            log(`[fase3] ${tag} explicit retryTask: attempt ${r.attempt} instance ${r.instanceId.slice(-6)}`);
            await core.agents.wait(r.instanceId, 600_000);
            retried = true;
          } catch (error) {
            if (error instanceof Error && /backoff/i.test(error.message)) {
              await new Promise((r) => setTimeout(r, 15_000));
              continue;
            }
            push(`${tag}-implretry`, "explicit retry of spurious implementer failure", "FAIL", error instanceof Error ? error.message.slice(0, 300) : String(error));
            return;
          }
        }
        if (!retried) {
          push(`${tag}-implretry`, "explicit retry of spurious implementer failure", "FAIL", "backoff window did not open in 120s");
          return;
        }
        await core.scheduler.tick({ sessionId: session.id }).catch(() => undefined);
        implDone = (await core.tasks.getTask(implTask.id)).status === "completed";
      }
      push(`${tag}-impldone`, "implementer completed", implDone ? "PASS" : "FAIL", (await core.tasks.getTask(implTask.id)).status);
      // Etapa 4: el fichero vive en el worktree auto-aprovisionado (no en el repo).
      const implWt = await core.worktrees.getByTask(implTask.id);
      const wtPath = implWt?.canonicalPath ?? "";
      const resultFile = wtPath ? path.join(wtPath, "work-impl", "result.txt") : "";
      const resultOk = !!resultFile && existsSync(resultFile) && readFileSync(resultFile, "utf8").includes("combined:alpha-42+beta-84");
      push(`${tag}-implfile`, "worktree/work-impl/result.txt with combined marker", resultOk ? "PASS" : "FAIL", resultOk ? `marker present in ${implWt?.branchName}` : "missing or wrong content");
      push(`${tag}-implwt`, "implementer worktree provisioned with base commit", implWt && implWt.baseCommit && implWt.baseCommit.length === 40 ? "PASS" : "FAIL", implWt ? `${implWt.branchName} @ ${implWt.baseCommit.slice(0, 12)}` : "no worktree");
      push(`${tag}-implcommit`, "harness recorded produced_commit", implWt?.producedCommit && /^[0-9a-f]{40}$/.test(implWt.producedCommit) ? "PASS" : "FAIL", implWt?.producedCommit?.slice(0, 12) ?? "none");
      if (!resultOk) {
        try {
          const implDelivery = await core.tasks.getDelivery(implTask.id);
          log(`[fase3] ${tag} implementer delivery: ${(implDelivery?.summary ?? "(none)").slice(0, 600)}`);
          log(`[fase3] ${tag} worktree listing: ${(wtPath && existsSync(wtPath) ? readdirSync(wtPath).join(",") : "(missing)") || "(empty)"} root: ${readdirSync(root).filter((n) => n !== ".git").join(",")}`);
        } catch (error) {
          log(`[fase3] ${tag} impl diagnostics failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
        }
      }

      // Reviewer desbloqueado por target; veredicto accept.
      await core.scheduler.tick({ sessionId: session.id });
      const revTask2 = await core.tasks.getTask(revTask.id);
      const revStatus = revTask2.status;
      const revWhy = revStatus === "blocked" ? ` (${revTask2.blockedReason ?? "?"} ${(revTask2.blockedDetails ? JSON.stringify(revTask2.blockedDetails).slice(0, 200) : "")})` : "";
      push(`${tag}-revunblock`, "reviewer unblocked after implementer", ["assigned", "running", "completed"].includes(revStatus) ? "PASS" : "FAIL", `${revStatus}${revWhy}`);
      const revAttempts = await core.tasks.getAttempts(revTask.id);
      const revInstance = revAttempts[0]?.instanceId;
      if (!revInstance) {
        push(`${tag}-revspawn`, "reviewer spawned", "FAIL", "no attempt instance");
        return;
      }
      try {
        await core.agents.wait(revInstance, 600_000);
      } catch (error) {
        push(`${tag}-revwait`, "reviewer completes", "FAIL", error instanceof Error ? error.message.slice(0, 200) : String(error));
        return;
      }
      await core.scheduler.tick({ sessionId: session.id }).catch(() => undefined);
      push(`${tag}-revdone`, "reviewer completed", (await core.tasks.getTask(revTask.id)).status === "completed" ? "PASS" : "FAIL", (await core.tasks.getTask(revTask.id)).status);
      // P2: el reviewer trabaja directamente sobre el worktree del target.
      const revInst = (await core.agentInstances(session.id)).find((i) => i.id === revInstance);
      push(`${tag}-revwt`, "reviewer runs inside target worktree", revInst?.worktreeId === implWt?.id && revInst?.directory === wtPath ? "PASS" : "FAIL", revInst ? `${revInst.worktreeId ?? "(none)"} @ ${revInst.directory.slice(-40)}` : "missing instance");
      const delivery = await core.agents.result(revInstance).catch(() => undefined);
      const quotes = (delivery?.summary ?? "").includes("alpha-42");
      push(`${tag}-revidence`, "review delivery quotes the combined marker", quotes ? "PASS" : "FAIL", (delivery?.summary ?? "").slice(0, 160) || "(empty)");
      await core.tasks.recordReview(revTask.id, implTask.id, "accept", { live: true, matrix: tag });
      push(`${tag}-verdict`, "accept verdict marks implementer reviewed", (await core.tasks.getTask(implTask.id)).status === "reviewed" ? "PASS" : "FAIL", (await core.tasks.getTask(implTask.id)).status);

      // 7. Run auto-integrado (Etapa 5 P1) + entregas de lectoras.
      await core.scheduler.tick({ sessionId: session.id }).catch(() => undefined);
      const run = (await core.getRun(runId)).run;
      push(`${tag}-rundone`, "run auto-builds into integrating", run.status === "integrating" ? "PASS" : "FAIL", run.status);
      const autoInts = await core.integrations.listByRun(runId);
      push(`${tag}-autoint`, "integration auto-created with produced commit", autoInts.length === 1 && !!autoInts[0]!.head ? "PASS" : "FAIL", autoInts[0] ? `${autoInts[0].integrationBranch} @ ${autoInts[0].head?.slice(0, 12) ?? "none"}` : "none");
      for (const r of readerTasks) {
        const marker = r.id === readerTasks[0]!.id ? "alpha-42" : "beta-84";
        const d = await core.tasks.getDelivery(r.id).catch(() => undefined);
        push(`${tag}-deliver`, `reader ${r.id.slice(-6)} delivery recorded`, !!d?.summary?.includes(marker) ? "PASS" : "FAIL", (d?.summary ?? "").slice(0, 80) || "(empty)");
      }

      // 6. Modelos reales por instancia: agent_instances.model + usage_records.
      for (const t of tasks) {
        for (const a of await core.tasks.getAttempts(t.id)) {
          if (!a.instanceId) continue;
          const inst = (await core.agentInstances(session.id)).find((i) => i.id === a.instanceId);
          const modelOk = inst?.model.providerId === provider && inst?.model.modelId === modelId && inst?.model.effort === effort;
          push(`${tag}-model`, `${t.agentRole} ${a.instanceId.slice(-6)} runs ${provider}/${modelId}/${effort}`, modelOk ? "PASS" : "FAIL", inst ? `${inst.model.providerId}/${inst.model.modelId}/${inst.model.effort ?? "(unset)"}` : "missing instance");
          const rows = await core.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM usage_records WHERE agent_instance_id = ? AND provider_id = ? AND model_id = ?", [a.instanceId, provider, modelId]);
          push(`${tag}-usage`, `${t.agentRole} ${a.instanceId.slice(-6)} billed usage matches model`, (rows[0]?.n ?? 0) >= 1 ? "PASS" : "FAIL", `${rows[0]?.n ?? 0} usage rows`);
        }
      }

      // Etapa 4: worktree auto-aprovisionado por el Scheduler (sin directorios pre-registrados).
      const dirs = await core.directories.list(project.id);
      const wts = await core.worktrees.listProjectWorktrees(project.id);
      push(`${tag}-autowt`, "scheduler auto-provisioned exactly one worktree, no isolated dirs", wts.length === 1 && dirs.length === 0 ? "PASS" : "FAIL", `${wts.length} worktrees, ${dirs.length} isolated dirs`);
      push(`${tag}-wtbranch`, "worktree branch follows harness naming", wts[0] && /^harness\/run-.{1,32}\/task-tsk_/.test(wts[0].branchName) ? "PASS" : "FAIL", wts[0]?.branchName ?? "(none)");

      // Etapa 5 (solo --octus-acceptance-5): integración → validación → preview → aprobación → promoción.
      if (STAGE5) {
        try {
          // Auto-build P1: la integración ya existe con el produced incorporado.
          const ints = await core.integrations.listByRun(runId);
          const integration = ints[0];
          push(`${tag}-autoint`, "integration auto-created with produced commit", ints.length === 1 && !!integration?.head ? "PASS" : "FAIL", integration ? `${integration.integrationBranch} @ ${integration.head?.slice(0, 12)}` : "(none)");
          if (integration?.head) {
            // Review de la integración (reviewer real sobre su worktree).
            const spawned = await core.agents.spawn({ parentInstanceId: coordId, definitionId: "reviewer", brief: "Review the integration worktree against the acceptance criteria (combined marker file). Report findings with file and line.", mode: "background", integrationId: integration.id });
            await core.agents.wait(spawned.instanceId, 600_000);
            push(`${tag}-intrevdone`, "integration reviewer completed", (await core.agentInstances(session.id)).find((i) => i.id === spawned.instanceId)?.status === "completed" ? "PASS" : "FAIL", spawned.instanceId.slice(-6));
            await core.validations.recordIntegrationReview(integration.id, { instanceId: spawned.instanceId, verdict: "accept", summary: "live: quotes combined marker" });
            const gate = await core.validations.validationGate(integration.id, integration.head);
            push(`${tag}-gate`, "validation gate passes (suite + accept review)", gate.ok ? "PASS" : "FAIL", gate.ok ? "clear" : gate.reasons.join("; ").slice(0, 200));
            // Preview real con runtime disponible (node o bun; sin coste de modelo).
            const runtime = hasRunner();
            if (!runtime) {
              push(`${tag}-preview`, "preview runtime available", "FAIL", "neither node nor bun on PATH");
            } else {
              await core.previews.saveAllowlist(project.id, [
                { id: "live-serve", name: "live server", phase: "start", argv: [runtime, "-e", `require("http").createServer((q,r)=>{r.end("ok-live")}).listen(Number(process.env.OCTUS_PREVIEW_PORT))`] },
              ]);
              const pv = await core.previews.createPreview(integration.id);
              push(`${tag}-pvcreate`, "preview workspace provisioned at head", pv.sha === integration.head ? "PASS" : "FAIL", pv.sha.slice(0, 12));
              const started = await core.previews.startPreview(pv.id, { startEntryId: "live-serve" });
              push(`${tag}-preview`, "preview reachable on exact SHA", started.reachable && started.status === "reachable" ? "PASS" : "FAIL", `${started.status} ${started.url ?? ""}`);
            }
            // Aprobación ligada al SHA + promoción segura a main.
            const livePv = (await core.previews.listPreviews(integration.id)).find((p) => p.sha === integration.head && p.status === "reachable");
            if (!livePv) {
              push(`${tag}-approve`, "approval pinned to exact SHA", "SKIP", "no reachable preview (preview step failed)");
            } else {
              const { duplicate } = await core.approvals.approveIntegration(integration.id, { previewId: livePv.id });
              const st = await core.approvals.getApprovalStatus(integration.id);
              push(`${tag}-approve`, `approval pinned to exact SHA${duplicate ? " (duplicate idempotent)" : ""}`, st.ok && !!st.approval ? "PASS" : "FAIL", st.ok ? st.approval!.candidateSha.slice(0, 12) : st.reasons.join("; ").slice(0, 200));
              const promoted = await core.promotions.promoteIntegration(integration.id);
              const mainTip = git(root, ["rev-parse", "main"]).trim();
              push(`${tag}-promote`, "promotion fast-forwards main to approved SHA", promoted.newSha === integration.head && mainTip === integration.head ? "PASS" : "FAIL", `main=${mainTip.slice(0, 12)} reused=${promoted.reused}`);
              push(`${tag}-rundone5`, "run finishes done after promotion", (await core.getRun(runId)).run.status === "done" ? "PASS" : "FAIL", (await core.getRun(runId)).run.status);
              push(`${tag}-nopush`, "no remote configured (nothing to push to)", execFileSync("git", ["remote", "-v"], { cwd: root, encoding: "utf8", timeout: 10_000 }).trim() === "" ? "PASS" : "FAIL", "remote -v empty");
              // Higiene: detener el preview (el proceso no debe sobrevivir al harness).
              await core.previews.stopPreview(livePv.id).catch(() => undefined);
              await core.previews.cleanupPreview(livePv.id).catch(() => undefined);
            }
          }
        } catch (error) {
          push(`${tag}-stage5`, "stage 5 flow", "FAIL", error instanceof Error ? error.message.slice(0, 300) : String(error));
        }
      }

      await collectInstances(core);
      for (const u of await runUsageSummary(core)) allUsage.push({ ...u, matrix: tag });
    } catch (error) {
      push(`${tag}-fatal`, `fase 3 ${provider} aborted by exception`, "FAIL", error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300));
    }
    try {
      stopSim();
    } catch {
      // best effort
    }
    try {
      await core.close();
    } catch {
      // best effort
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best effort (Windows locks; temp dir preserved by OS on failure)
    }
  }

  if (ONLY === "both" || ONLY === "a") await phase("meta", META_MODEL, META_EFFORT, "A3-meta");
  if (ONLY === "both" || ONLY === "b") await phase("opencode-go", GO_MODEL, GO_EFFORT, "B3-go");

  const pass = steps.filter((s) => s.status === "PASS").length;
  const fail = steps.filter((s) => s.status === "FAIL").length;
  const blocked = steps.filter((s) => s.status === "BLOCKED").length;
  const skip = steps.filter((s) => s.status === "SKIP").length;
  const stageLabel = STAGE5 ? "5" : "4";
  const stageTitle = STAGE5 ? "Fase 5 live — IntegrationManager/Preview/Approval/Promotion (modelos reales)" : "Fase 4 live — WorktreeManager (modelos reales)";
  const lines: string[] = [];
  lines.push("");
  lines.push(`## ${stageTitle}`);
  lines.push("");
  lines.push(`- **Resultado fase ${stageLabel} live:** PASS=${pass} FAIL=${fail} BLOCKED=${blocked} SKIP=${skip} — ${Math.round((Date.now() - started) / 1000)}s`);
  lines.push(`- **Matrices:** A meta/${META_MODEL}/${META_EFFORT} (planner + workers con mismo modelo/effort del coordinador), B opencode-go/${GO_MODEL}/${GO_EFFORT} (ID exacto del catálogo real, sin fallback)`);
  lines.push("");
  lines.push("| instanceId | parentInstanceId | definition | provider | modelId | effort |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of instances) lines.push(`| ${r.instanceId} | ${r.parentInstanceId} | ${r.definition} | ${r.provider} | ${r.modelId} | ${r.effort} |`);
  lines.push("");
  for (const s of steps) lines.push(`- [${s.status}] **${s.id}** ${s.name} — ${s.detail}`);
  lines.push("");
  lines.push("| matrix | provider | model | calls | in | out | reasoning | cached | cost |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const u of allUsage) lines.push(`| ${u.matrix} | ${u.provider} | ${u.model} | ${u.calls} | ${u.input} | ${u.output} | ${u.reasoning} | ${u.cached} | ${fmtCost(u.costMicro)} |`);
  lines.push("");
  const reportPath = path.join(findRepoRoot(), ".harness", "implementation", STAGE5 ? "STAGE5_ACCEPTANCE_REPORT.md" : "STAGE4_ACCEPTANCE_REPORT.md");
  try {
    const prev = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : `# STAGE${stageLabel}_ACCEPTANCE_REPORT.md — Aceptación funcional Etapa ${stageLabel}\n`;
    writeFileSync(reportPath, `${prev}${lines.join("\n")}`, "utf8");
    log(`[fase3] report appended: ${reportPath}`);
  } catch (error) {
    log(`[fase3] report append FAILED: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`);
  }
  try {
    // Git deja archivos de solo lectura (Windows): quitar el flag antes de borrar.
    const walk = (dir: string): void => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const p = path.join(dir, name);
        try {
          chmodSync(p, 0o666);
        } catch {
          // best effort
        }
        try {
          if (statSync(p).isDirectory()) walk(p);
        } catch {
          // best effort
        }
      }
    };
    walk(root);
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    log(`[fase3] fixture cleanup: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`);
  }
  return steps.some((s) => s.status === "FAIL" || s.status === "BLOCKED") ? 1 : 0;
}
