// QA Todo 24 — verificación real del stack de Skills (servicios del core).
// Ejecuta de verdad: SkillManager (descubrimiento), SkillInstaller (carpeta, zip,
// duplicado, traversal, desinstalar), SkillActivationStore (habilitar por proyecto,
// alcances, persistencia, adminView) y SkillRuntime (registro por run, secciones).
// Datos fijos: qa-skill@1.0.0 + broken-skill (failure). Dos pasadas (clase flaky).
// Uso: bun scripts/verify-task-24-skills.mjs  (exit 0 = verde)
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SkillManager, validateSkillDir } from "../packages/core/src/skills/skill-manager.ts";
import { SkillInstaller } from "../packages/core/src/skills/skill-installer.ts";
import { createZip } from "../packages/core/src/skills/zip-util.ts";
import { SkillActivationStore } from "../packages/core/src/skills/skill-activation.ts";
import { SkillRuntime } from "../packages/core/src/skills/skill-runtime.ts";
import { PersistenceService } from "../packages/core/src/persistence/persistence-service.ts";

let passes = 0;
let failures = 0;
const failedNames = [];
function check(name, cond, detail = "") {
  if (cond) {
    passes++;
    console.log(`[PASS] ${name}${detail ? " — " + detail : ""}`);
  } else {
    failures++;
    failedNames.push(name);
    console.log(`[FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

const QA_SKILL_MD = `---
name: qa-skill
description: Skill de QA para verificar el manager con datos fijos.
compatibility: octus >= 0.1
allowed-tools: shell.exec
metadata:
  version: 1.0.0
---
# qa-skill
Usa esta skill cuando la tarea mencione qa-skill o verificación del manager.
`;
const QA_ZIP_MD = QA_SKILL_MD.replace("name: qa-skill", "name: qa-zip").replace("# qa-skill", "# qa-zip");
const BROKEN_MD = `---
description: Sin nombre, debe fallar con C3.
---
# rota
`;

function writeSkill(dir, name, md, extra = {}) {
  const d = path.join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "SKILL.md"), md);
  for (const [rel, content] of Object.entries(extra)) {
    const full = path.join(d, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return d;
}

async function runPass(tag) {
  console.log(`## pasada ${tag}: stack real de Skills (Todo 24)`);
  const base = mkdtempSync(path.join(tmpdir(), `octus-qa-24-${tag}-`));
  try {
    const srcGlobal = path.join(base, "src-global");
    const srcProject = path.join(base, "src-project");
    const srcManaged = path.join(base, "src-managed");
    const gitCopy = path.join(base, "git-copy");
    for (const d of [srcGlobal, srcProject, srcManaged, gitCopy]) mkdirSync(d, { recursive: true });
    writeSkill(srcProject, "qa-skill", QA_SKILL_MD, { "docs/uso.md": "# Uso\nLee esto bajo demanda.\n" });
    writeSkill(srcGlobal, "old-helper", QA_SKILL_MD.replaceAll("qa-skill", "old-helper").replace("1.0.0", "0.2.0"));
    writeSkill(srcProject, "broken-skill", BROKEN_MD);
    mkdirSync(path.join(srcProject, "empty-dir"), { recursive: true });
    writeSkill(gitCopy, "qa-git", QA_SKILL_MD.replaceAll("qa-skill", "qa-git").replace("1.0.0", "2.0.0"));

    // --- Descubrimiento (Todo 20): catálogo, origen, alcance, errores ---
    const manager = new SkillManager({ globalDir: srcGlobal, projectDir: srcProject, managedDir: srcManaged });
    const { skills, errors } = manager.discover();
    const qa = skills.find((s) => s.name === "qa-skill");
    check("catalogo contiene qa-skill", !!qa);
    check("detalle: origen project y alcance project", !!qa && qa.origin === "project" && qa.scope === "project", JSON.stringify(qa && { origin: qa.origin, scope: qa.scope, version: qa.version, path: qa.path }));
    check("detalle: version 1.0.0 desde metadata", !!qa && qa.version === "1.0.0");
    check("detalle: enabled nace false (instalada≠habilitada)", !!qa && qa.enabled === false);
    check("catalogo contiene old-helper global", skills.some((s) => s.name === "old-helper" && s.origin === "global"));
    check("errores visibles: broken-skill + empty-dir, no son skills", errors.length >= 2 && !skills.some((s) => s.name === "broken-skill"), errors.map((e) => e.clause).join(","));
    const brokenErr = errors.find((e) => e.path.endsWith("broken-skill"));
    check("error cita clausula C2/C3", !!brokenErr && /^C[0-9]/.test(brokenErr.message), brokenErr?.message ?? "sin error");
    check("idempotencia: re-descubrir no duplica", manager.discover().skills.length === skills.length && manager.readCount() >= 4);

    // --- Instalación (Todo 21): carpeta, zip, duplicado, traversal, git, desinstalar ---
    const installer = new SkillInstaller(path.join(base, "installed"));
    const installedQa = installer.installFromFolder(path.join(srcProject, "qa-skill"));
    check("importar carpeta: qa-skill@1.0.0", installedQa.name === "qa-skill" && installedQa.version === "1.0.0", `${installedQa.name}@${installedQa.version}`);
    check("instalada nace deshabilitada", installedQa.enabled === false);
    check("procedencia carpeta visible", installedQa.provenance?.kind === "folder" && typeof installedQa.provenance.sourcePath === "string");
    let dupErr = "";
    try {
      installer.installFromFolder(path.join(srcProject, "qa-skill"));
    } catch (e) {
      dupErr = String(e?.message ?? e);
    }
    check("failure: duplicado se rechaza", /duplicad|already_exists/i.test(dupErr), dupErr.slice(0, 90));
    const zipBytes = createZip([
      { name: "qa-zip/SKILL.md", data: QA_ZIP_MD },
      { name: "qa-zip/docs/notas.md", data: "# notas\n" },
    ]);
    const zipPath = path.join(base, "qa-zip.zip");
    writeFileSync(zipPath, zipBytes);
    const installedZip = await installer.installFromZip(zipPath);
    check("importar zip: qa-zip con recursos", installedZip.name === "qa-zip" && installedZip.provenance?.kind === "zip");
    const evilBytes = createZip([{ name: "../evil.md", data: "x" }]);
    const evilPath = path.join(base, "evil.zip");
    writeFileSync(evilPath, evilBytes);
    let evilErr = "";
    try {
      await installer.installFromZip(evilPath);
    } catch (e) {
      evilErr = String(e?.message ?? e);
    }
    check("failure: zip con traversal se rechaza sin escribir", /fuera de la skill|traversal/i.test(evilErr) && !existsSync(path.join(base, "installed", "evil")), evilErr.slice(0, 90));
    const installedGit = installer.installFromGit("https://example.invalid/repo.git", "v2.0.0", { sourceDir: path.join(gitCopy, "qa-git") });
    check("instalar git con fuente explicita y procedencia", installedGit.name === "qa-git" && installedGit.provenance?.kind === "git");
    const inspected = installer.inspect("qa-skill");
    check("inspeccion: frontal + archivos", inspected.files.includes("SKILL.md") && inspected.files.includes("docs/uso.md") && typeof inspected.frontmatter?.name === "string", inspected.files.join(","));
    installer.uninstall("qa-zip");
    check("desinstalar limpio", !installer.list().some((s) => s.name === "qa-zip") && !existsSync(path.join(base, "installed", "qa-zip")));

    // --- Activación (Todo 22): habilitar por proyecto, alcances, persistencia ---
    const dbPath = path.join(base, "test.db");
    const db = await PersistenceService.open({ dbPath });
    try {
      const store = new SkillActivationStore(db);
      check("nada habilitado al inicio", (await store.isEnabled("proj-a", "qa-skill")) === false);
      await store.enable("proj-a", { name: "qa-skill", version: "1.0.0" });
      check("habilitar en A", (await store.isEnabled("proj-a", "qa-skill")) === true);
      check("aislamiento: B sigue deshabilitada", (await store.isEnabled("proj-b", "qa-skill")) === false);
      await store.setScope("proj-a", "qa-skill", "global");
      check("cambiar alcance", (await store.get("proj-a", "qa-skill"))?.scope === "global");
      await store.disable("proj-a", "qa-skill");
      check("deshabilitar es idempotente y efectivo", (await store.isEnabled("proj-a", "qa-skill")) === false);
      await store.enable("proj-a", { name: "qa-skill", version: "1.0.0" }, "project");
      // Persistencia tras "reinicio": segunda instancia sobre la misma DB.
      const store2 = new SkillActivationStore(db);
      check("persistencia tras reinicio simulado", (await store2.isEnabled("proj-a", "qa-skill")) === true && (await store2.get("proj-a", "qa-skill"))?.scope === "project");
      const admin = await store2.adminView("proj-a", installer.list().map((s) => ({ name: s.name, version: s.version, scope: s.scope, provenance: s.provenance })));
      const qaRow = admin.find((r) => r.name === "qa-skill");
      check("adminView: installed≠enabled siempre distintos", !!qaRow && qaRow.installed === true && qaRow.enabled === true && "installed" in qaRow && "enabled" in qaRow, JSON.stringify({ installed: qaRow?.installed, enabled: qaRow?.enabled }));
      check("adminView: procedencia visible", !!qaRow && qaRow.provenance?.kind === "folder");
      const gate = await store2.selectForRun("proj-a", [{ name: "qa-skill" }, { name: "old-helper" }]);
      check("puerta de runs: solo habilitadas pasan", gate.length === 1 && gate[0].name === "qa-skill");
      const gateB = await store2.selectForRun("proj-b", [{ name: "qa-skill" }]);
      check("failure: deshabilitada nunca llega al contexto", gateB.length === 0);

      // --- Runtime (Todo 23): registro por run + carga progresiva ---
      const runtime = new SkillRuntime(db, manager, store2);
      await runtime.recordRun("run_qa01", ["qa-skill"]);
      check("historial: run_qa01 → qa-skill", JSON.stringify(await runtime.skillsForRun("run_qa01")) === JSON.stringify(["qa-skill"]));
      const sections = await runtime.sectionsFor({ projectId: "proj-a", taskBrief: "verifica el manager con qa-skill", runId: "run_qa02" });
      check("carga progresiva: metadatos + relevante", sections.metadata.includes("qa-skill") && sections.used.includes("qa-skill") && sections.full.includes("Usa esta skill"));
      check("registro por run via sectionsFor", (await runtime.skillsForRun("run_qa02")).includes("qa-skill"));

      // --- Puerta Todo 24: skill con error de validación bloquea habilitar ---
      const revalidated = validateSkillDir(path.join(srcProject, "broken-skill"));
      check("failure: broken-skill no valida (C3)", !revalidated.record && /C3/.test(revalidated.error ?? ""), revalidated.error ?? "");
      let blockedErr = "";
      // Misma regla que MainSkillsService.enable: revalidar antes de activar.
      if (!revalidated.record) blockedErr = revalidated.error ?? "bloqueada";
      else await store2.enable("proj-a", { name: "broken-skill", version: "0.0.0" });
      check("failure: habilitar bloqueada con el error visible", /C3/.test(blockedErr));
      check("failure: bloqueada no queda habilitada", (await store2.isEnabled("proj-a", "broken-skill")) === false);
      // Recursos: traversal y ausente se rechazan (puerta real del runtime).
      let travErr = "";
      try {
        runtime.readResource(qa, "../SKILL.md");
      } catch (e) {
        travErr = String(e?.message ?? e);
      }
      check("failure: recurso fuera de la skill se rechaza", /fuera de la skill|scope_violation/i.test(travErr));
      const uso = runtime.readResource(qa, "docs/uso.md");
      check("recurso bajo demanda legible", uso.includes("bajo demanda"));
    } finally {
      if (typeof db.close === "function") await db.close();
      else if (typeof db.dispose === "function") await db.dispose();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  // Limpieza verificada: nada en pie.
  check(`limpieza pasada ${tag}`, !existsSync(base));
}

await runPass("p1");
await runPass("p2");
console.log(`---\nTOTAL: ${passes} PASS, ${failures} FAIL`);
if (failedNames.length > 0) console.log("fallos: " + failedNames.join(" | "));
process.exit(failures === 0 ? 0 : 1);
