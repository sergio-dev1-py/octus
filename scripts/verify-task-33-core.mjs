/**
 * Verificación Todo 33 (backend REAL, no dry-run): explorador paginado, diff,
 * modificados y pruebas sobre C:\tmp\octus-qa-proj + caso failure de proyecto
 * grande (paginación sin congelar). Clases adversariales: stale_state,
 * misleading_success_output, dirty_worktree, flaky_tests (2 pasadas).
 *
 * Uso: bun scripts/verify-task-33-core.mjs [round]
 * Exit 0 = todo PASS. La evidencia se vuelca a task-33.txt.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const QA = "C:\\tmp\\octus-qa-proj";
const BIG = "C:\\tmp\\octus-qa-big";
const DATA = "C:\\tmp\\octus-qa-t33-data";

let failures = 0;
let passes = 0;
function check(name, cond, detail = "") {
  if (cond) passes++;
  else failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function setupQaProj() {
  rmSync(QA, { recursive: true, force: true });
  mkdirSync(path.join(QA, "src"), { recursive: true });
  writeFileSync(path.join(QA, "README.md"), "# octus-qa-proj\nfixture del Todo 33\n");
  writeFileSync(path.join(QA, "src", "app.ts"), "export const APP_MARKER = \"app-v1\";\nexport function app(): string { return APP_MARKER; }\n");
  writeFileSync(path.join(QA, "src", "util.ts"), "export function util(): number { return 42; }\n");
  git(QA, "init");
  git(QA, "config", "user.email", "qa@localhost");
  git(QA, "config", "user.name", "QA");
  git(QA, "add", "-A");
  git(QA, "commit", "-m", "qa fixture");
  // Dirty deliberado: modificación + untracked.
  writeFileSync(path.join(QA, "src", "app.ts"), "export const APP_MARKER = \"app-v1\";\nexport function app(): string { return APP_MARKER; }\n// T33-DIRTY\n");
  writeFileSync(path.join(QA, "notes.txt"), "nota sin seguimiento\n");
}

async function main() {
  const round = process.argv[2] ?? "1";
  console.log(`=== Todo 33 backend REAL — pasada ${round} ===`);
  setupQaProj();

  const { OctusCore } = await import("../packages/core/src/sessions/octus-core.js");
  const { MemorySecretStore } = await import("../packages/core/src/secrets/secret-store.js");
  rmSync(DATA, { recursive: true, force: true });
  const core = await OctusCore.create({ dataDir: DATA, primarySecrets: new MemorySecretStore() });
  try {
    const project = await core.createProject("qa-proj", QA);
    const pid = project.id;

    // 1. Explorar raíz.
    const root = await core.explorerList(pid, ".", 1, 50);
    check("explorar: raíz lista total>=4", root.total >= 4, `total=${root.total}`);
    check("explorar: contiene src/", root.entries.some((e) => e.name === "src" && e.kind === "dir"));

    // 2. Explorar subdir + leer archivo.
    const src = await core.explorerList(pid, "src", 1, 50);
    check("explorar: src contiene app.ts", src.entries.some((e) => e.name === "app.ts" && e.kind === "file"));
    const file = await core.explorerRead(pid, "src/app.ts");
    check("explorar: ver archivo con marcador", file.content.includes("APP_MARKER") && file.content.includes("T33-DIRTY"));

    // 3. Diff + modificados (dirty_worktree).
    const diff = await core.repoDiff(pid, {});
    check("diff: muestra modificación", diff.diff.includes("T33-DIRTY"), `chars=${diff.diff.length}`);
    const mod = await core.modifiedFiles(pid);
    check("modificados: app.ts M", mod.files.some((f) => f.path === "src/app.ts" || f.path.endsWith("app.ts")));
    check("modificados: notes.txt untracked", mod.files.some((f) => f.path === "notes.txt" && f.x === "?"));
    const summary = await core.inspectRepository(pid);
    check("dirty_worktree: repo sucio con conteos", summary.status === "dirty" && summary.unstaged + summary.untracked > 0, summary.status);

    // 4. Resultado de prueba (allowlist explícita, copia desechable).
    await core.saveTestAllowlist(pid, [
      { id: "qa-echo", name: "QA echo", argv: [process.execPath, "-e", "console.log('qa-ok')"] },
      { id: "qa-fail", name: "QA fail", argv: [process.execPath, "-e", "process.exit(3)"] },
    ]);
    const ok = await core.runProjectTest(pid, "qa-echo", AbortSignal.timeout(120000));
    check("prueba: exit 0 con salida real", ok.exitCode === 0 && ok.output.includes("qa-ok"), `dur=${ok.durationMs}ms`);

    // 5. stale_state: archivo nuevo aparece al relistar.
    writeFileSync(path.join(QA, "fresh-t33.txt"), "recién creado\n");
    const relisted = await core.explorerList(pid, ".", 1, 50);
    check("stale_state: relistar ve fresh-t33.txt", relisted.entries.some((e) => e.name === "fresh-t33.txt"));

    // 6. misleading_success_output: el fallo sale como error, nunca ok:true.
    let failSurfaced = false;
    try {
      await core.runProjectTest(pid, "qa-fail", AbortSignal.timeout(120000));
    } catch (error) {
      failSurfaced = /exit|failed/i.test(error instanceof Error ? error.message : String(error));
    }
    check("misleading_success_output: fallo no se camufla como éxito", failSurfaced);

    // 7. Diagnósticos agregados.
    const diag = await core.projectDiagnostics(pid);
    check("diagnósticos: lista disponible", Array.isArray(diag.problems), `${diag.problems.length} problemas`);

    // 8. FAILURE: proyecto grande pagina sin congelar.
    rmSync(BIG, { recursive: true, force: true });
    mkdirSync(BIG, { recursive: true });
    for (let d = 0; d < 10; d++) {
      const sub = path.join(BIG, `mod-${d}`);
      mkdirSync(sub, { recursive: true });
      for (let f = 0; f < 50; f++) writeFileSync(path.join(sub, `file-${f}.txt`), `x ${d} ${f}\n`);
    }
    git(BIG, "init");
    git(BIG, "config", "user.email", "qa@localhost");
    git(BIG, "config", "user.name", "QA");
    git(BIG, "add", "-A");
    git(BIG, "commit", "-m", "big fixture");
    const bigProject = await core.createProject("qa-big", BIG);
    const t0 = Date.now();
    const p1 = await core.explorerList(bigProject.id, ".", 1, 50);
    const firstMs = Date.now() - t0;
    check("big-proj: página 1 rápida (<2s)", firstMs < 2000, `${firstMs}ms total=${p1.total}`);
    const t1 = Date.now();
    const pages = [];
    for (const sub of p1.entries.filter((e) => e.kind === "dir" && !e.name.startsWith(".")).slice(0, 3)) {
      pages.push(await core.explorerList(bigProject.id, sub.relPath, 1, 50));
    }
    const restMs = Date.now() - t1;
    check("big-proj: 3 subdirs sin congelar (<5s)", restMs < 5000 && pages.every((p) => p.total === 50), `${restMs}ms`);
    check("big-proj: paginación acota (pageSize<=200)", p1.pageSize <= 200 && p1.entries.length <= p1.pageSize);

    // 9. Escape rechazado (seguridad del explorador).
    let escapeDenied = false;
    try {
      await core.explorerRead(pid, "..\\..\\Windows\\System32\\drivers\\etc\\hosts");
    } catch {
      escapeDenied = true;
    }
    check("seguridad: escape del root denegado", escapeDenied);
  } finally {
    await core.close();
  }

  // Limpieza con recibo.
  rmSync(BIG, { recursive: true, force: true });
  rmSync(DATA, { recursive: true, force: true });
  try { rmSync(path.join(QA, "fresh-t33.txt"), { force: true }); } catch {}
  const receipt = `cleanup: big=${!existsSync(BIG)} data=${!existsSync(DATA)} qaProj=${existsSync(QA)}`;
  console.log(receipt);
  // Deja qa-proj en estado sucio deliberado (fixture de diff); el surface lo reutiliza.
  console.log(`\nTODO33-CORE pasada ${round}: ${passes} PASS, ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("FATAL " + String((error && error.stack) || error).slice(0, 2000));
  process.exit(1);
});
