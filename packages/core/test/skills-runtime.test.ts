/**
 * Todo 23 — Integración de Skills con runtime y agentes (carga progresiva).
 * Datos fijos: skills `qa-skill@1.0.0` y `other-skill@2.0.0` en ámbito project.
 * Determinista: sin temporizadores, sin azar; DBs y dirs efímeros con limpieza.
 * - Happy: el prompt lleva metadatos de habilitadas + SOLO la relevante completa;
 *   el run registra la skill usada; el coordinador real la recibe end-to-end.
 * - Guion rojo: una skill que pide `shell` NO autoriza shell prohibida
 *   (se niega con `permission_denied` y queda auditada en kv + evento + fila).
 * - Failure: deshabilitada o sin estado NUNCA llega al contexto ni al registro.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createId } from "@octus/shared";
import type { PersistedEvent } from "@octus/shared";
import { isOctusError } from "../src/errors.js";
import { PersistenceService } from "../src/persistence/persistence-service.js";
import { SkillActivationStore } from "../src/skills/skill-activation.js";
import { SkillManager } from "../src/skills/skill-manager.js";
import { SkillRuntime, relevanceScore, skillAllowsAction, stripFrontmatter } from "../src/skills/skill-runtime.js";
import { MemorySecretStore } from "../src/secrets/secret-store.js";
import { FakeProvider, fakeGoModels, fakeMetaModels } from "../src/testing/fake-providers.js";
import { OctusCore } from "../src/sessions/octus-core.js";
import { promptHashOf, snapshotOf } from "../src/agents/definition-loader.js";
import { now } from "../src/util.js";
import { expectRejects } from "./helpers.js";

const QA_BODY_MARK = "MARCADOR-QA-CUERPO-23";
const OTHER_BODY_MARK = "MARCADOR-OTHER-CUERPO-23";
const BRIEF = "Review the QA test runs and evidence checks";

function writeSkill(scopeDir: string, name: string, opts: { description: string; version: string; allowedTools: string; body: string }): void {
  const dir = path.join(scopeDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${opts.description}\nmetadata:\n  version: ${opts.version}\nallowed-tools: ${opts.allowedTools}\n---\n${opts.body}\n`,
    "utf8",
  );
}

function fixtureDirs(): { root: string; projectDir: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "octus-qa-23-skills-"));
  const projectDir = path.join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  writeSkill(projectDir, "qa-skill", {
    description: "QA helper for octus test runs and evidence checks",
    version: "1.0.0",
    // Guion rojo: la skill PIDE shell, pero eso nunca autoriza nada.
    allowedTools: "read, shell",
    body: `# qa-skill\nGuía QA: ejecuta bun test y vuelca la evidencia.\n${QA_BODY_MARK}\n`,
  });
  writeSkill(projectDir, "other-skill", {
    description: "Unrelated helper for nothing in particular",
    version: "2.0.0",
    allowedTools: "read",
    body: `# other-skill\nAyuda no relacionada con QA.\n${OTHER_BODY_MARK}\n`,
  });
  // Recurso bajo demanda de qa-skill.
  mkdirSync(path.join(projectDir, "qa-skill", "docs"), { recursive: true });
  writeFileSync(path.join(projectDir, "qa-skill", "docs", "notas.md"), "# notas QA\nContenido bajo demanda.\n", "utf8");
  return { root, projectDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function openDb(dir: string): Promise<PersistenceService> {
  return PersistenceService.open({ dbPath: path.join(dir, "test.db") });
}

function localRuntime(db: PersistenceService, projectDir: string): SkillRuntime {
  return new SkillRuntime(db, new SkillManager({ projectDir }), new SkillActivationStore(db));
}

interface SkillsCore {
  core: OctusCore;
  dir: string;
  workspace: string;
  fakeMeta: FakeProvider;
  cleanup: () => Promise<void>;
}

async function makeSkillsCore(projectDir: string, metaTurns: Array<{ text?: string }> = [{ text: "hello from fake" }]): Promise<SkillsCore> {
  const dir = mkdtempSync(path.join(tmpdir(), "octus-qa-23-core-"));
  const workspace = path.join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const fakeMeta = new FakeProvider("fake-meta", "Fake Meta", fakeMetaModels(), { turns: metaTurns as never });
  const fakeGo = new FakeProvider("fake-go", "Fake Go", fakeGoModels(), { turns: [{ text: "hello from fake go" }] as never });
  const core = await OctusCore.create({
    dataDir: path.join(dir, "data"),
    primarySecrets: new MemorySecretStore(),
    providers: [fakeMeta, fakeGo],
    skillsDirs: { projectDir },
  });
  return {
    core,
    dir,
    workspace,
    fakeMeta,
    cleanup: async () => {
      await core.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Run + instancia con la definición indicada (patrón de helpers.makeRun). */
async function makeRunAs(core: OctusCore, sessionId: string, definitionId: string): Promise<{ runId: string; instanceId: string }> {
  const session = (await core.listSessions()).find((s) => s.id === sessionId)!;
  const def = (await core.registry.get(definitionId))!;
  const runId = createId("run");
  const instanceId = createId("ins");
  await core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES (?, ?, 'test', 'executing', 'build', 1, 1)", [runId, sessionId]);
  await core.db.exec(
    "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, 1, 1)",
    [instanceId, sessionId, runId, definitionId, JSON.stringify({ providerId: "fake-meta", modelId: "muse-wonder-1.0" }), session.directory, def.promptVersion, promptHashOf(def), JSON.stringify(snapshotOf(def))],
  );
  return { runId, instanceId };
}

async function permissionRuleCount(db: PersistenceService): Promise<number> {
  const row = await db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM permission_rules");
  return Number(row?.n ?? -1);
}

describe("skills runtime integration (Todo 23)", () => {
  test("carga progresiva: metadatos de habilitadas + solo la relevante completa", async () => {
    const fx = fixtureDirs();
    const tmp = mkdtempSync(path.join(tmpdir(), "octus-qa-23-t1-"));
    const db = await openDb(tmp);
    try {
      const activation = new SkillActivationStore(db);
      const runtime = localRuntime(db, fx.projectDir);
      await activation.enable("proj-a", { name: "qa-skill", version: "1.0.0" });
      await activation.enable("proj-a", { name: "other-skill", version: "2.0.0" });

      const sections = await runtime.sectionsFor({ projectId: "proj-a", taskBrief: BRIEF, runId: "run_t1" });
      // Metadatos: AMBAS habilitadas, con id nombre@versión.
      expect(sections.metadata).toContain("qa-skill@1.0.0");
      expect(sections.metadata).toContain("other-skill@2.0.0");
      // Completa: SOLO la relevante (qa-skill); la otra NUNCA va completa.
      expect(sections.full).toContain(QA_BODY_MARK);
      expect(sections.full).not.toContain(OTHER_BODY_MARK);
      expect(sections.full).not.toContain("allowed-tools");
      expect(sections.used).toEqual(["qa-skill"]);

      // El ContextBuilder inyecta metadatos + relevante al prompt.
      const definition = {
        id: "coordinator-build",
        kind: "coordinator",
        name: "Build",
        description: "d",
        defaultModel: { providerId: "fake-meta", modelId: "muse-wonder-1.0" },
        maxSteps: 1,
        timeoutMs: 1000,
        idleTimeoutMs: 1000,
        systemPrompt: "SYS",
        tools: [],
        deniedTools: [],
        permissionRules: [],
        deliveryFormat: "",
        canDelegateTo: [],
        promptVersion: 1,
      } as never;
      const { ContextBuilder } = await import("../src/runtime/context-builder.js");
      const prompt = await new ContextBuilder(db).buildInstructions(definition, tmp, [], {
        projectId: "proj-a",
        skillMetadata: sections.metadata,
        skillInstructions: sections.full,
      });
      expect(prompt).toContain("<available-skills>");
      expect(prompt).toContain("qa-skill@1.0.0");
      expect(prompt).toContain(QA_BODY_MARK);
      expect(prompt).not.toContain(OTHER_BODY_MARK);

      // El run registra la skill usada.
      expect(await runtime.skillsForRun("run_t1")).toEqual(["qa-skill"]);
    } finally {
      await db.close();
      rmSync(tmp, { recursive: true, force: true });
      fx.cleanup();
    }
  });

  test("failure: deshabilitada o sin estado nunca llega al contexto ni al registro", async () => {
    const fx = fixtureDirs();
    const tmp = mkdtempSync(path.join(tmpdir(), "octus-qa-23-t2-"));
    const db = await openDb(tmp);
    try {
      const activation = new SkillActivationStore(db);
      const runtime = localRuntime(db, fx.projectDir);
      // En proj-b solo qa-skill está habilitada; other-skill, jamás.
      await activation.enable("proj-b", { name: "qa-skill", version: "1.0.0" });

      const sections = await runtime.sectionsFor({ projectId: "proj-b", taskBrief: BRIEF, runId: "run_t2" });
      expect(sections.metadata).toContain("qa-skill@1.0.0");
      expect(sections.metadata).not.toContain("other-skill");
      expect(sections.full).toContain(QA_BODY_MARK);
      expect(sections.used).toEqual(["qa-skill"]);

      // Proyecto sin estado: vacío total, sin registro.
      const empty = await runtime.sectionsFor({ projectId: "proj-z", taskBrief: BRIEF, runId: "run_t2z" });
      expect(empty.metadata).toBe("");
      expect(empty.full).toBe("");
      expect(empty.used).toEqual([]);
      expect(await runtime.skillsForRun("run_t2z")).toEqual([]);

      // Sin tarea no hay completa (solo metadatos): nunca todas completas.
      const noTask = await runtime.sectionsFor({ projectId: "proj-b", runId: "run_t2n" });
      expect(noTask.metadata).toContain("qa-skill@1.0.0");
      expect(noTask.full).toBe("");
      expect(await runtime.skillsForRun("run_t2n")).toEqual([]);
    } finally {
      await db.close();
      rmSync(tmp, { recursive: true, force: true });
      fx.cleanup();
    }
  });

  test("relevancia determinista y allowed-tools descriptivo (puro, sin E/S)", () => {
    const qa = { name: "qa-skill", description: "QA helper for octus test runs and evidence checks" };
    const other = { name: "other-skill", description: "Unrelated helper for nothing in particular" };
    expect(relevanceScore(BRIEF, qa)).toBeGreaterThan(0);
    expect(relevanceScore(BRIEF, other)).toBe(0);
    expect(relevanceScore("", qa)).toBe(0);
    // Evidencia solo existe en la descripción de qa-skill.
    expect(relevanceScore("evidence pending", qa)).toBeGreaterThan(relevanceScore("evidence pending", other));
    expect(skillAllowsAction({ allowedTools: "read, shell" }, "shell")).toBe(true);
    expect(skillAllowsAction({ allowedTools: "read, shell" }, "write")).toBe(false);
    expect(skillAllowsAction({}, "read")).toBe(false);
    expect(stripFrontmatter("---\nname: x\n---\nBODY")).toBe("BODY");
  });

  test("recursos bajo demanda: lectura interna sí, escape o ausente no", async () => {
    const fx = fixtureDirs();
    const tmp = mkdtempSync(path.join(tmpdir(), "octus-qa-23-t5-"));
    const db = await openDb(tmp);
    try {
      const runtime = localRuntime(db, fx.projectDir);
      const { skills } = runtime["manager"].discover();
      const qa = skills.find((s) => s.name === "qa-skill")!;
      expect(runtime.readResource(qa, "docs/notas.md")).toContain("bajo demanda");
      // readResource es síncrono: envolver el lanzamiento en promesa para expectRejects.
      const attempt = (rel: string): Promise<unknown> => {
        try {
          return Promise.resolve(runtime.readResource(qa, rel));
        } catch (error) {
          return Promise.reject(error);
        }
      };
      await expectRejects(attempt("../SKILL.md"), "recurso fuera de la skill");
      await expectRejects(attempt("/abs/path.md"), "recurso fuera de la skill");
      await expectRejects(attempt("docs/falta.md"), "recurso inexistente");
    } finally {
      await db.close();
      rmSync(tmp, { recursive: true, force: true });
      fx.cleanup();
    }
  });

  test("guion rojo: la skill que pide shell no autoriza shell prohibida (niega + audita)", async () => {
    const fx = fixtureDirs();
    const t = await makeSkillsCore(fx.projectDir);
    try {
      const project = await t.core.createProject("P", t.workspace);
      const session = await t.core.createSession({ projectId: project.id });
      const { runId, instanceId } = await makeRunAs(t.core, session.id, "explorer");
      const failed: PersistedEvent[] = [];
      const stop = t.core.bus.subscribe((e) => {
        if (e.type === "tool_call.failed") failed.push(e);
      });

      // La skill qa-skill PIDE shell en `allowed-tools`, pero explorer la niega.
      // (expectRejects solo ve nombre+mensaje: el código se afirma con isOctusError.)
      const err = await expectRejects(
        t.core.gateway.execute({
          toolCallId: createId("tool"),
          idempotencyKey: createId("idem"),
          sessionId: session.id,
          runId,
          instanceId,
          definitionId: "explorer",
          directory: t.workspace,
          name: "shell",
          args: { command: "echo hola" },
          skillName: "qa-skill",
        }),
        "Permission denied: shell",
      );
      expect(isOctusError(err, "permission_denied")).toBe(true);

      // Auditoría triple: fila denied con marca, kv de evasión y evento con flag.
      const row = await t.core.db.queryOne<{ status: string; error: string }>("SELECT status, error FROM tool_invocations WHERE run_id = ?", [runId]);
      expect(row?.status).toBe("denied");
      expect(String(row?.error)).toContain("[skill-bypass-denied skill=qa-skill]");
      expect(await t.core.skills!.bypassForRun(runId)).toHaveLength(1);
      expect(await t.core.skills!.bypassForRun(runId)).toMatchObject([{ skill: "qa-skill", action: "shell" }]);
      const flagged = failed.filter((e) => (e.payload as Record<string, unknown>).skillBypassAttempt === true);
      expect(flagged).toHaveLength(1);
      expect((flagged[0]!.payload as Record<string, unknown>).skill).toBe("qa-skill");
      stop();

      // Control: skill que NO pide shell también se niega, pero sin marca de evasión.
      const row2id = createId("run");
      await t.core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES (?, ?, 'test', 'executing', 'build', 1, 1)", [row2id, session.id]);
      const otherIns = createId("ins");
      const def = (await t.core.registry.get("explorer"))!;
      await t.core.db.exec(
        "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES (?, ?, ?, 'explorer', 'running', ?, ?, ?, ?, ?, 1, 1)",
        [otherIns, session.id, row2id, JSON.stringify({ providerId: "fake-meta", modelId: "muse-wonder-1.0" }), session.directory, def.promptVersion, promptHashOf(def), JSON.stringify(snapshotOf(def))],
      );
      await expectRejects(
        t.core.gateway.execute({
          toolCallId: createId("tool"),
          idempotencyKey: createId("idem"),
          sessionId: session.id,
          runId: row2id,
          instanceId: otherIns,
          definitionId: "explorer",
          directory: t.workspace,
          name: "shell",
          args: { command: "echo hola" },
          skillName: "other-skill",
        }),
        "Permission denied: shell",
      );
      const row2 = await t.core.db.queryOne<{ error: string }>("SELECT error FROM tool_invocations WHERE run_id = ?", [row2id]);
      expect(String(row2?.error)).not.toContain("skill-bypass-denied");
      expect(await t.core.skills!.bypassForRun(row2id)).toEqual([]);

      // Control positivo: la skill con read permitido SÍ lee (vía normal, auditada).
      writeFileSync(path.join(t.workspace, "nota.txt"), "contenido visible\n", "utf8");
      const read = await t.core.gateway.execute({
        toolCallId: createId("tool"),
        idempotencyKey: createId("idem"),
        sessionId: session.id,
        runId,
        instanceId,
        definitionId: "explorer",
        directory: t.workspace,
        name: "read",
        args: { path: "nota.txt" },
        skillName: "qa-skill",
      });
      expect(read.ok).toBe(true);
      expect(read.text).toContain("contenido visible");
    } finally {
      await t.cleanup();
      fx.cleanup();
    }
  });

  test("spawn: workers solo con autorizadas (niega sin puerta y con deshabilitada)", async () => {
    const fx = fixtureDirs();
    const t = await makeSkillsCore(fx.projectDir);
    try {
      const project = await t.core.createProject("P", t.workspace);
      const session = await t.core.createSession({ projectId: project.id });
      const { instanceId: parentId } = await makeRunAs(t.core, session.id, "coordinator-build");

      // Deshabilitada → scope_violation (deny-by-default en spawn; el código
      // viaja en err.code, el mensaje lleva el detalle en español).
      await expectRejects(
        t.core.agents.spawn({
          parentInstanceId: parentId,
          definitionId: "explorer",
          brief: "Summarize.",
          mode: "foreground",
          model: { providerId: "fake-meta", modelId: "muse-wonder-1.0" },
          skillNames: ["qa-skill"],
        }),
        "no habilitada en este proyecto",
      );
      // Fantasma → scope_violation también.
      await expectRejects(
        t.core.agents.spawn({
          parentInstanceId: parentId,
          definitionId: "explorer",
          brief: "Summarize.",
          mode: "foreground",
          model: { providerId: "fake-meta", modelId: "muse-wonder-1.0" },
          skillNames: ["ghost-skill"],
        }),
        "no habilitada en este proyecto",
      );

      // Habilitada → el worker nace y completa (vía el store ÚNICO del runtime).
      await t.core.skills!.enable(project.id, { name: "qa-skill", version: "1.0.0" });
      const spawned = await t.core.agents.spawn({
        parentInstanceId: parentId,
        definitionId: "explorer",
        brief: "Summarize.",
        mode: "foreground",
        model: { providerId: "fake-meta", modelId: "muse-wonder-1.0" },
        skillNames: ["qa-skill"],
      });
      expect(spawned.delivery?.status).toBe("completed");
    } finally {
      await t.cleanup();
      fx.cleanup();
    }
  });

  test("end-to-end: el coordinador recibe metadatos + relevante y el run queda registrado", async () => {
    const fx = fixtureDirs();
    const t = await makeSkillsCore(fx.projectDir, [{ text: "QA reviewed, all green." }]);
    try {
      const project = await t.core.createProject("P", t.workspace);
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      await t.core.skills!.enable(project.id, { name: "qa-skill", version: "1.0.0" });
      await t.core.skills!.enable(project.id, { name: "other-skill", version: "2.0.0" });

      const { runId } = await t.core.prompt(session.id, "Review the QA test runs and evidence checks");
      await t.core.waitForIdle(session.id);
      const { run } = await t.core.getRun(runId);
      expect(run.status).toBe("done");

      // El prompt REAL del proveedor: metadatos de ambas + SOLO qa completa.
      const instructions = String(t.fakeMeta.seen[0]?.instructions ?? "");
      expect(instructions).toContain("<available-skills>");
      expect(instructions).toContain("qa-skill@1.0.0");
      expect(instructions).toContain("other-skill@2.0.0");
      expect(instructions).toContain(QA_BODY_MARK);
      expect(instructions).not.toContain(OTHER_BODY_MARK);

      // Registro por run: la usada consta; la no usada, no.
      expect(await t.core.skills!.skillsForRun(runId)).toEqual(["qa-skill"]);
    } finally {
      await t.cleanup();
      fx.cleanup();
    }
  });

  test("activar/seleccionar/registrar nunca otorga permisos de herramientas", async () => {
    const fx = fixtureDirs();
    const tmp = mkdtempSync(path.join(tmpdir(), "octus-qa-23-t7-"));
    const db = await openDb(tmp);
    try {
      expect(await permissionRuleCount(db)).toBe(0);
      const activation = new SkillActivationStore(db);
      const runtime = localRuntime(db, fx.projectDir);
      await activation.enable("proj-a", { name: "qa-skill", version: "1.0.0" });
      await activation.setScope("proj-a", "qa-skill", "managed");
      await runtime.sectionsFor({ projectId: "proj-a", taskBrief: BRIEF, runId: "run_t7" });
      await runtime.noteBypass("run_t7", "qa-skill", "shell");
      expect(await permissionRuleCount(db)).toBe(0);
      // Sin importaciones hacia permisos o gateway: descriptivo, no autoridad.
      // (Se revisan las líneas `import`; la prosa del módulo puede nombrarlos.)
      const src = readFileSync(new URL("../src/skills/skill-runtime.ts", import.meta.url), "utf8");
      const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l));
      for (const banned of ["permission-manager", "tool-gateway", "permission_rules", "PermissionManager", "ToolGateway"]) {
        expect(importLines.some((l) => l.includes(banned)), `importación prohibida presente: ${banned}`).toBe(false);
      }
    } finally {
      await db.close();
      rmSync(tmp, { recursive: true, force: true });
      fx.cleanup();
    }
  });

  test("sin skillsDirs el núcleo no cambia (skills ausente, spawn con skills se niega)", async () => {
    const { makeTestCore, workspaceOf } = await import("./helpers.js");
    const t = await makeTestCore();
    try {
      expect(t.core.skills).toBeUndefined();
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const { makeRun } = await import("./helpers.js");
      const { instanceId: parentId } = await makeRun(t, session.id);
      await expectRejects(
        t.core.agents.spawn({
          parentInstanceId: parentId,
          definitionId: "explorer",
          brief: "Summarize.",
          mode: "foreground",
          model: { providerId: "fake-meta", modelId: "muse-wonder-1.0" },
          skillNames: ["qa-skill"],
        }),
        "sin puerta de autorización",
      );
    } finally {
      await t.cleanup();
    }
  });
});
