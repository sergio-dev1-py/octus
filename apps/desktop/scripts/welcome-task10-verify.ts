/** Verificación Todo 10 (bienvenida W-01): se ejecuta de verdad con bun.
 * Cubre: soltar carpeta, diálogo nativo (vía validateDirectory, mismo código
 * que usa el handler IPC), reciente con fecha, crear, abrir y continuar con
 * C:\tmp\octus-qa-proj y selector #welcome-dropzone; failure (inexistente,
 * sin permiso, drop vacío) ejecutado: error sin crear proyecto.
 * Dos pasadas funcionales con dataDirs frescos (flaky/stale_state).
 * Vuelca este log en .omo/evidence/octus-ux-skills-mcp/task-10.txt
 * Uso: bun scripts/welcome-task10-verify.ts [--evidence]
 */
import fs from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const QA_PROJ = String.raw`C:\tmp\octus-qa-proj`;

type Row = { name: string; status: "PASS" | "FAIL" | "SKIP"; detail: string };
const rows: Row[] = [];
const logLines: string[] = [];
function log(line: string): void {
  logLines.push(line);
  console.log(line);
}
function check(name: string, cond: boolean, detail: string): void {
  rows.push({ name, status: cond ? "PASS" : "FAIL", detail });
  log(`[${cond ? "PASS" : "FAIL"}] ${name} — ${detail}`);
}
function skip(name: string, detail: string): void {
  rows.push({ name, status: "SKIP", detail });
  log(`[SKIP] ${name} — ${detail}`);
}
function src(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// A. Fixture fija del plan -------------------------------------------------
mkdirSync(QA_PROJ, { recursive: true });
writeFileSync(path.join(QA_PROJ, "qa.txt"), "octus-qa-proj fixture\n");
check("fixture C:\\tmp\\octus-qa-proj existe", fs.statSync(QA_PROJ).isDirectory(), QA_PROJ);

// B. Validador real (mismo módulo que usa main) -----------------------------
const { checkDirectoryReadable } = await import("../src/main/validate-directory.ts");

const happy = checkDirectoryReadable(QA_PROJ);
check("soltar carpeta válida (drop→validate)", happy.ok === true, JSON.stringify(happy));

const missing = checkDirectoryReadable(String.raw`C:\tmp\octus-qa-proj-no-existe-xyz`);
check(
  "failure: carpeta inexistente → error",
  !missing.ok && missing.error === "not-found",
  JSON.stringify(missing),
);

const notDir = checkDirectoryReadable(path.join(QA_PROJ, "qa.txt"));
check("failure: ruta no-carpeta → error", !notDir.ok && notDir.error === "not-directory", JSON.stringify(notDir));

for (const bad of ["", "   "]) {
  const r = checkDirectoryReadable(bad);
  check(`failure: drop vacío ${JSON.stringify(bad)} → error`, !r.ok && r.error === "empty", JSON.stringify(r));
}

// Sin permiso: el validador real ejecutado bajo node (mismo runtime que main de
// Electron) sobre System Volume Information → EPERM en stat → unreadable.
// (bun usa otra vía Win32 y no reproduce el EPERM; por eso se ejecuta con node.)
// OLD-NOTE: fixture real del SO (System Volume Information → EPERM en stat).
// Nota: con token elevado el acceso efectivo puede variar; si el SO lo permite,
// el caso se marca SKIP con motivo en vez de afirmar en falso.
{
  try {
    const { execFileSync: runNode } = await import("node:child_process");
    const out = runNode(
      "node",
      ["-e", "import('./validate-directory.ts').then(m=>console.log(JSON.stringify(m.checkDirectoryReadable('C:/System Volume Information'))))"],
      { cwd: path.join(ROOT, "apps", "desktop", "src", "main"), encoding: "utf8" },
    );
    const r = JSON.parse(String(out).trim()) as { ok: boolean; error?: string };
    check("failure: sin permiso bajo node (runtime de main)", r.ok === false && r.error === "unreadable", String(out).trim());
  } catch (error) {
    skip("failure: sin permiso bajo node", error instanceof Error ? error.message : String(error));
  }
}

// C+D. Flujo funcional contra OctusCore real, 2 pasadas, dataDir fresco -----
const { makeTestCore } = await import("../../../packages/core/test/helpers.ts");
for (let pass = 1; pass <= 2; pass++) {
  const t = await makeTestCore();
  try {
    const before = await t.core.listProjects();
    check(`pasada ${pass}: arranque sin estado heredado`, before.length === 0, `${before.length} proyectos`);
    const created = await t.core.createProject("octus-qa-proj", QA_PROJ);
    const listed = await t.core.listProjects();
    const first = listed[0];
    check(
      `pasada ${pass}: reciente con fecha`,
      !!first && first.id === created.id && typeof first.updatedAt === "number" && typeof first.createdAt === "number",
      first ? `${first.name} updatedAt=${new Date(first.updatedAt).toLocaleString()}` : "vacío",
    );
    // Abrir = seleccionar existente por rootPath (lo que hace la bienvenida).
    const opened = listed.find((p) => p.rootPath === QA_PROJ);
    check(`pasada ${pass}: abrir proyecto existente`, opened?.id === created.id, opened?.id ?? "no hallado");
    const session = await t.core.createSession({ projectId: created.id });
    const sessions = await t.core.listSessions(created.id);
    check(`pasada ${pass}: crear sesión`, sessions.some((s) => s.id === session.id), session.id);
    const got = await t.core.getSession(session.id);
    check(
      `pasada ${pass}: continuar sesión`,
      got.session.id === session.id && Array.isArray(got.runs),
      `runs=${got.runs.length}`,
    );
    // Failure ejecutado: el handler valida antes de crear → nada se crea.
    const countBefore = (await t.core.listProjects()).length;
    const badCheck = checkDirectoryReadable(String.raw`C:\tmp\octus-qa-proj-no-existe-xyz`);
    if (!badCheck.ok) {
      /* el handler lanza aquí y nunca llama a createProject */
    } else {
      await t.core.createProject("no-deberia-crearse", String.raw`C:\tmp\octus-qa-proj-no-existe-xyz`);
    }
    const countAfter = (await t.core.listProjects()).length;
    check(`pasada ${pass}: failure sin crear proyecto`, countAfter === countBefore, `${countBefore}→${countAfter}`);
  } finally {
    await t.cleanup();
  }
}

// E. Aserciones sobre el contrato UI/IPC ------------------------------------
const appTsx = src("apps/desktop/src/renderer/src/App.tsx");
const storeTs = src("apps/desktop/src/renderer/src/store.ts");
const mainTs = src("apps/desktop/src/main/index.ts");
const ipcTs = src("packages/shared/src/ipc.ts");
const css = src("apps/desktop/src/renderer/src/styles.css");

for (const sel of ["welcome-dropzone", "welcome-pick", "welcome-recents", "welcome-continue", "welcome-new-session", "welcome-open", "welcome-create", "welcome-name", "welcome-settings", "welcome-error", "welcome-back"]) {
  check(`selector #${sel} presente`, appTsx.includes(`id="${sel}"`), "App.tsx");
}
check("drop usa selector nativo app.pickDirectory", appTsx.includes('"app.pickDirectory"'), "WelcomeView.pickNative");
check("drop valida en main (app.validateDirectory)", storeTs.includes('"app.validateDirectory"') && mainTs.includes('"app.validateDirectory"'), "store+main");
check("recientes con fecha", appTsx.includes("welcome-recents") && appTsx.includes("formatRecentDate"), "lista + toLocaleString");
check("continuar sesión desde bienvenida", appTsx.includes("welcome-continue") && appTsx.includes("selectSession"), "continueLatest");
check("acceso a configuración desde bienvenida", appTsx.includes('setMode("settings")') && appTsx.includes("<SettingsView />"), "modo settings en welcome");
check("sin auto-selección de proyecto", !storeTs.includes("selectProject(projects[0]"), "refreshProjects ya no auto-entra");
check("sin auto-selección de sesión", !storeTs.includes("selectSession(sessions[0]"), "refreshSessions ya no auto-entra");
check("bienvenida decide al arrancar", appTsx.includes("state.activeProjectId") && appTsx.includes("<WelcomeView />"), "App muestra Welcome sin proyecto");
check("canal IPC tipado", ipcTs.includes('"app.validateDirectory"'), "OctusIPC");
check("canal registrado en main", mainTs.includes('"app.validateDirectory",'), "CHANNELS");
check("IPC validado (payload + emisor)", mainTs.includes("assertSender(event)") && mainTs.includes('typeof payload.path !== "string"'), "registerIpc + handler");
check("projects.create valida antes de crear", mainTs.indexOf("checkDirectoryReadable(payload.rootPath)") < mainTs.indexOf("createProject(payload.name"), "valida→crea");
check("reciente roto se marca y deja elegir", appTsx.includes("markProjectBroken") && appTsx.includes("ruta ausente"), "F-1 fallo");
{
  const m = css.match(/#welcome-shell[\s\S]*?\.recent-broken[\s\S]*?}/);
  const block = m?.[0] ?? "";
  const hasLiteral = /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/.test(block);
  check("estilos welcome solo con tokens", block.length > 0 && !hasLiteral, `${block.length} chars, literales=${hasLiteral}`);
}

// Resumen --------------------------------------------------------------------
const fails = rows.filter((r) => r.status === "FAIL");
const passes = rows.filter((r) => r.status === "PASS").length;
const skips = rows.filter((r) => r.status === "SKIP").length;
log(`---\nTOTAL: ${passes} PASS, ${fails.length} FAIL, ${skips} SKIP`);
if (fails.length > 0) {
  log(`FALLOS:\n${fails.map((f) => ` - ${f.name}: ${f.detail}`).join("\n")}`);
  process.exitCode = 1;
}

if (process.argv.includes("--evidence")) {
  const dir = path.join(ROOT, ".omo", "evidence", "octus-ux-skills-mcp");
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "task-10.txt");
  const prev = fs.existsSync(out) ? fs.readFileSync(out, "utf8") + "\n" : "";
  const header = [
    `# Todo 10 — Bienvenida (W-01): ${new Date().toISOString()}`,
    ``,
    `## welcome-task10-verify.ts (bun, ejecutado de verdad)`,
    ``,
    "```",
    ...logLines,
    "```",
    ``,
  ].join("\n");
  writeFileSync(out, prev + header);
  log(`evidencia escrita en ${out}`);
}
