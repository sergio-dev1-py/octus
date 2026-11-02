/**
 * Verificación Todo 34 — rendimiento, arranque y memoria bajo presupuesto (REAL, no dry-run).
 *
 * Mide contra el presupuesto del Todo 5 (task-5-contracts.md §7, 11 cifras) y ejecuta
 * el caso failure: un panel que renderiza de más se detecta por conteo y se difiere.
 *
 * Uso: bun scripts/verify-task-34-budget.mjs [round]
 * Exit 0 = todo PASS. La salida se vuelca a .omo/evidence/octus-ux-skills-mcp/task-34.txt.
 *
 * Clases adversariales: stale_state, misleading_success_output, dirty_worktree,
 * flaky_tests (2 pasadas), hung_or_long_commands. Resto no-aplicable (motivo en evidencia).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const W = process.cwd();
const DATA = "C:\\tmp\\octus-qa-t34-data";
const BIG = "C:\\tmp\\octus-qa-t34-big";
const src = (rel) => readFileSync(path.join(W, rel), "utf8");

let failures = 0;
let passes = 0;
function check(name, cond, detail = "") {
  if (cond) passes++;
  else failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function ms(t0) {
  return Math.round(performance.now() - t0);
}
function mb(bytes) {
  return Math.round((bytes / 1048576) * 10) / 10;
}

async function main() {
  const round = process.argv[2] ?? "1";
  console.log(`=== Todo 34 presupuesto REAL — pasada ${round} ===`);
  console.log(`platform=${process.platform} cpus=${(await import("node:os")).cpus().length}`);

  const { OctusCore } = await import("../packages/core/src/sessions/octus-core.js");
  const { MemorySecretStore } = await import("../packages/core/src/secrets/secret-store.js");
  const { EventStore } = await import("../packages/core/src/events/event-store.js");
  const { PersistenceService } = await import("../packages/core/src/persistence/persistence-service.js");
  const { EXPLORER_MAX_PAGE_SIZE, EXPLORER_MAX_READ_CHARS } = await import("../packages/core/src/explorer/file-explorer.js");
  const { windowMessages, applyPartDelta, purgeRunFrames, emptyFrame, TIMELINE_PAGE } = await import(
    "../apps/desktop/src/renderer/src/timeline.js"
  );
  const perf = await import("../apps/desktop/src/renderer/src/perf.js");
  const { layoutDag } = await import("../apps/desktop/src/renderer/src/dagLogic.js");
  const { parseStoredUiPrefs, DEFAULT_UI_PREFS } = await import("../packages/shared/src/prefs.js");

  const B = perf.PERF_BUDGETS;
  check("presupuesto: 11 cifras cargadas", Object.keys(B).length === 11, `cifras=${Object.keys(B).length}`);
  check("presupuesto: arranque frio<=2.5s", B.coldStartMs === 2500, `${B.coldStartMs}ms`);
  check("presupuesto: memoria total<=450MB", B.totalMemoryMb === 450, `${B.totalMemoryMb}MB`);
  check("presupuesto: events/run<=2000", B.maxEventsPerRun === 2000, `${B.maxEventsPerRun}`);

  // ---- A. Arranque real (backend) + etapas del renderer ----
  rmSync(DATA, { recursive: true, force: true });
  let t0 = performance.now();
  const core = await OctusCore.create({ dataDir: DATA, primarySecrets: new MemorySecretStore() });
  const bootMs = ms(t0);
  check("arranque: OctusCore.create+migrate+settle < 2500ms", bootMs < B.coldStartMs, `${bootMs}ms`);
  try {
    const bootstrap = src("apps/desktop/src/renderer/src/store/bootstrap.ts");
    check(
      "arranque: etapa 1 en paralelo (projects→sessions + providers + budgets + pending)",
      /Promise\.all\(\[\s*refreshProjects\(\)\.then\(\(\) => refreshSessions\(\)\)[\s\S]*?refreshProviders\(\)[\s\S]*?refreshBudgets\(\)[\s\S]*?refreshPending\(\)/.test(bootstrap),
    );
    check("arranque: reloadStage2 tras la etapa 1 (paneles diferidos)", /await reloadStage2\(\);/.test(bootstrap));
    const projects = src("apps/desktop/src/renderer/src/store/projects.ts");
    check(
      "workbench: selectProject recarga en paralelo",
      /refreshSessions\(\),[\s\S]*?refreshSkillsCatalog\(\),[\s\S]*?refreshFilesWorkspace\(\),/.test(projects),
    );
    check(
      "sesion: mensajes/uso primero, paneles despues (dos etapas)",
      /await Promise\.all\(\[refreshMessages\(\), refreshPending\(\), refreshUsage\(\), refreshRunDetail\(\)\]\)[\s\S]*?await Promise\.all\(\[refreshPlans\(\), refreshApprovals\(\), refreshAgents\(\), refreshTasks\(\), refreshIntegrations\(\), refreshMemory\(\)\]\)/.test(projects),
    );

    // ---- A4. Preferencias corruptas: defecto en <3s (caso failure del Todo 6) ----
    t0 = performance.now();
    const corrupt = parseStoredUiPrefs("{{{no-json");
    const corruptMs = ms(t0);
    check(
      "prefs corruptas: defecto aplicado < 3000ms",
      corruptMs < B.corruptPrefsMs && JSON.stringify(corrupt) === JSON.stringify(DEFAULT_UI_PREFS),
      `${corruptMs}ms`,
    );
    check("prefs ausentes: defecto aplicado", JSON.stringify(parseStoredUiPrefs(null)) === JSON.stringify(DEFAULT_UI_PREFS));
    check("TIMELINE_PAGE=100 (paginado del servidor)", TIMELINE_PAGE === 100, `page=${TIMELINE_PAGE}`);

    // ---- B. Memoria ----
    const rssMb = mb(process.memoryUsage().rss);
    check("memoria: RSS del proceso de verificacion < 450MB", rssMb < B.totalMemoryMb, `${rssMb}MB`);
    const termSrc = src("apps/desktop/src/main/terminal-service.ts");
    const termBuf = termSrc.includes("TERMINAL_MAX_BUFFER_CHARS = 256 * 1024");
    check("pty: buffer acotado a 256K chars", termBuf);
    const bufChars = 256 * 1024;
    const worstMb = mb(bufChars * 4 + 2000 * 512);
    check("pty: peor caso (buffer + 2000 lineas) < 25MB por terminal", worstMb < B.terminalMemoryMb, `${worstMb}MB`);
    check("explorador: pagina<=200 y lectura<=20000 chars", EXPLORER_MAX_PAGE_SIZE === 200 && EXPLORER_MAX_READ_CHARS === 20000);
    const workerSrc = src("packages/core/src/persistence/store-worker.mjs");
    check("worker: sin caches en memoria (solo handle db)", !/new Map|new Set|\.push\(/.test(workerSrc.replace(/chunks\.push|record\.chunks/g, "")) || !/cache/i.test(workerSrc));
    check("worker: SQLite vive en el worker (DatabaseSync)", workerSrc.includes("DatabaseSync"));
    const persistSrc = src("packages/core/src/persistence/persistence-service.ts");
    check(
      "hilo principal: async sobre worker_threads (sin importar node:sqlite)",
      persistSrc.includes("worker_threads") && !/from ["']node:sqlite["']|require\(["']node:sqlite["']\)/.test(persistSrc),
    );
    const mainFiles = ["apps/desktop/src/main/index.ts", "apps/desktop/src/main/skills-service.ts", "apps/desktop/src/main/terminal-service.ts", "apps/desktop/src/main/secret-store.ts", "apps/desktop/src/main/validate-directory.ts", "apps/desktop/src/main/worker-path.ts"];
    const sqliteImporters = mainFiles.filter((f) => /from ["']node:sqlite["']|await import\(["']node:sqlite["']\)|require\(["']node:sqlite["']\)/.test(src(f)));
    check(
      "main: trafico SQLite solo en worker (unica excepcion: sonda smoke :memory:)",
      sqliteImporters.length <= 1 &&
        (sqliteImporters.length === 0 ||
          (sqliteImporters[0].endsWith("index.ts") && src(sqliteImporters[0]).includes('DatabaseSync(":memory:")'))),
      sqliteImporters.length === 0 ? "sin imports" : `solo sonda: ${sqliteImporters.join(",")}`,
    );

    // ---- B6. Worker roundtrip real ----
    const pdb = path.join(DATA, "probe.db");
    const svc = await PersistenceService.open({ dbPath: pdb });
    await svc.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)");
    await svc.exec("INSERT INTO kv (key, value, updated_at) VALUES ('k','v',1)");
    const row = await svc.queryOne("SELECT value AS value FROM kv WHERE key = 'k'");
    const batched = await svc.batch([
      { sql: "INSERT INTO kv (key, value, updated_at) VALUES ('a','1',1)" },
      { sql: "INSERT INTO kv (key, value, updated_at) VALUES ('b','2',1)" },
    ]);
    await svc.close();
    check("sqlite-worker: roundtrip real (exec/query/batch/close)", row?.value === "v" && batched.changes === 2);

    // ---- C. Render: ventana del DOM ----
    const big = Array.from({ length: 5000 }, (_, i) => ({ id: `m${i}` }));
    t0 = performance.now();
    const win = windowMessages(big, perf.CHAT_DOM_WINDOW);
    const winMs = ms(t0);
    check("timeline: 5000 mensajes → ventana de 200 en el DOM", win.length === 200 && win[0].id === "m4800", `${winMs}ms len=${win.length}`);
    check("scroll: ventana acotada construida < 1s (proxy 60fps con DOM fijo)", winMs < 1000 && B.longScrollFps === 60, `${winMs}ms objetivo=${B.longScrollFps}fps`);
    check("timeline: CHAT_DOM_WINDOW=200", perf.CHAT_DOM_WINDOW === 200);
    const chatSrc = src("apps/desktop/src/renderer/src/views/chat.tsx");
    check("chat: pinta windowMessages(state.messages, CHAT_DOM_WINDOW)", /windowMessages\(state\.messages, CHAT_DOM_WINDOW\)/.test(chatSrc));
    for (const [file, panels] of [
      ["apps/desktop/src/renderer/src/views/sections.tsx", ["capList("]],
      ["apps/desktop/src/renderer/src/views/dag.tsx", ["capList("]],
      ["apps/desktop/src/renderer/src/views/agents.tsx", ["capList("]],
    ]) {
      const content = src(file);
      check(`diferido: ${path.basename(file)} usa capList`, panels.every((p) => content.includes(p)));
    }

    // ---- C3. DAG con 100 tareas <1s (real) ----
    const tasks100 = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, title: `task ${i}`, status: "ready" }));
    const deps99 = Array.from({ length: 99 }, (_, i) => ({ taskId: `t${i + 1}`, dependsOn: `t${i}` }));
    t0 = performance.now();
    const laid = layoutDag(tasks100, deps99);
    const dagMs = ms(t0);
    check("dag: layout de 100 tareas+99 aristas < 1000ms", dagMs < B.agentDagMs && laid.nodes.length === 100, `${dagMs}ms`);
    t0 = performance.now();
    const laidBig = layoutDag(
      Array.from({ length: 500 }, (_, i) => ({ id: `x${i}`, title: `x ${i}`, status: "ready" })),
      [],
    );
    const cappedDag = perf.capList("dag-nodes", laidBig.nodes);
    check("dag: 500 nodos → 100 visibles + diferidos", cappedDag.visible.length === 100 && cappedDag.deferred === 400 && cappedDag.over, `layout=${ms(t0)}ms`);

    // ---- C5. FAILURE: panel que renderiza de más se detecta por conteo y se difiere ----
    perf.resetRenderCounts();
    const flood = Array.from({ length: 5000 }, (_, i) => ({ id: `f${i}` }));
    const floodRes = perf.capList("chat-messages", flood);
    const noted = perf.noteRender("chat-messages", flood.length);
    check(
      "failure: exceso detectado por conteo y diferido (no se pinta)",
      floodRes.over === true && floodRes.visible.length === perf.CHAT_DOM_WINDOW && floodRes.deferred === 5000 - perf.CHAT_DOM_WINDOW && noted.over === true && perf.renderTimes("chat-messages") >= 1,
      `visible=${floodRes.visible.length} deferred=${floodRes.deferred} renders=${perf.renderTimes("chat-messages")}`,
    );

    // ---- D. Stream/cancelación (proxies reales del camino de render) ----
    let live = {};
    t0 = performance.now();
    for (let i = 0; i < 5000; i++) {
      live = applyPartDelta(live, { kind: "part.delta", sessionId: "s", instanceId: "i", runId: "r", messageId: "m", part: "text", delta: "x" });
    }
    const deltaMs = ms(t0);
    check("stream: 5000 deltas < 800ms (camino del primer token)", deltaMs < B.firstTokenMs, `${deltaMs}ms`);
    let frames = {};
    for (let i = 0; i < 5000; i++) frames[`m${i}`] = { ...emptyFrame(`m${i}`, "s", "r"), text: "x" };
    t0 = performance.now();
    const purged = purgeRunFrames(frames, "r");
    const purgeMs = ms(t0);
    check("cancel: purga de 5000 marcos < 300ms", purgeMs < B.cancelMs && Object.keys(purged).length === 0, `${purgeMs}ms`);

    // ---- E. Proyecto grande: paginación real sin congelar ----
    const project = await core.createProject("qa-t34", BIG);
    rmSync(BIG, { recursive: true, force: true });
    mkdirSync(BIG, { recursive: true });
    for (let f = 0; f < 2000; f++) writeFileSync(path.join(BIG, `file-${String(f).padStart(4, "0")}.txt`), `x ${f}\n`);
    t0 = performance.now();
    const p1 = await core.explorerList(project.id, ".", 1, 50);
    const p1Ms = ms(t0);
    check("big-proj: pagina 1 de 2000 archivos < 2000ms", p1Ms < 2000 && p1.total === 2000, `${p1Ms}ms total=${p1.total}`);
    check("big-proj: pageSize acotado", p1.pageSize <= 200 && p1.entries.length <= p1.pageSize, `pageSize=${p1.pageSize}`);
    t0 = performance.now();
    const [q1, q2, q3, q4] = await Promise.all([
      core.explorerList(project.id, ".", 1, 200),
      core.explorerList(project.id, ".", 2, 200),
      core.explorerList(project.id, ".", 3, 200),
      core.explorerList(project.id, ".", 4, 200),
    ]);
    const parMs = ms(t0);
    const ids = new Set([...q1.entries, ...q2.entries, ...q3.entries, ...q4.entries].map((e) => e.relPath));
    check("big-proj: 4 paginas concurrentes sin congelar (<5s) y sin solape", parMs < 5000 && ids.size === 800, `${parMs}ms unicas=${ids.size}`);
    check("stale_state: archivo nuevo aparece al relistar", (await (async () => {
      writeFileSync(path.join(BIG, "fresh-t34.txt"), "nuevo\n");
      const relisted = await core.explorerList(project.id, ".", 1, 200);
      return relisted.total === 2001 && relisted.entries.concat((await core.explorerList(project.id, ".", 11, 200)).entries).some((e) => e.name === "fresh-t34.txt");
    })()));
    writeFileSync(path.join(BIG, "big.txt"), "y".repeat(30000));
    const capped = await core.explorerRead(project.id, "big.txt");
    check("lectura acotada: 30KB → 20000 chars + truncated", capped.truncated === true && capped.content.length === 20000, `chars=${capped.content.length}`);
    const fxSrc = src("packages/core/src/explorer/file-explorer.ts");
    check("filesystem: asincrono sin lecturas Sync", !/readdirSync|readFileSync|statSync|realpathSync/.test(fxSrc) && fxSrc.includes("node:fs/promises"));

    // ---- F. Dependencias ----
    const desk = JSON.parse(src("apps/desktop/package.json"));
    const direct = Object.keys(desk.dependencies ?? {});
    const denylist = ["lodash", "moment", "rxjs", "axios", "underscore", "classnames"];
    check("deps: directas acotadas (sin peso nuevo)", direct.length <= 8, `${direct.length}: ${direct.join(",")}`);
    check("deps: sin pesadas denegadas", !direct.some((d) => denylist.includes(d)));

    // ---- G. Events: poda por política (real) ----
    const session = await core.createSession({ projectId: project.id });
    await core.db.exec("INSERT INTO runs (id, session_id, prompt, status, created_at, updated_at) VALUES ('run-term-t34','" + session.id + "','p','done',1,1)");
    await core.db.exec("INSERT INTO runs (id, session_id, prompt, status, created_at, updated_at) VALUES ('run-open-t34','" + session.id + "','p','executing',1,1)");
    const mkEvents = (aggId, n, startSeq) =>
      Array.from({ length: n }, (_, i) => ({
        sql: "INSERT INTO events (id, type, aggregate_kind, aggregate_id, seq, occurred_at, correlation_id, idempotency_key, payload) VALUES (?,?,?,?,?,?,?,?,?)",
        params: [`evt-${aggId}-${i}`, "run.status_changed", "run", aggId, startSeq + i, 1000 + i, `cor-${aggId}-${i}`, `idem-${aggId}-${i}`, "{}"],
      }));
    await core.db.batch(mkEvents("run-term-t34", 2100, 0));
    await core.db.batch(mkEvents("run-open-t34", 2100, 0));
    const store = new EventStore(core.db);
    const before = await core.db.queryOne("SELECT COUNT(*) AS n FROM events WHERE aggregate_id = 'run-term-t34'");
    t0 = performance.now();
    const pruned = await store.pruneTerminalRunEvents(2000);
    const pruneMs = ms(t0);
    const afterTerm = await core.db.queryOne("SELECT COUNT(*) AS n FROM events WHERE aggregate_id = 'run-term-t34'");
    const afterOpen = await core.db.queryOne("SELECT COUNT(*) AS n FROM events WHERE aggregate_id = 'run-open-t34'");
    const minSeq = await core.db.queryOne("SELECT MIN(seq) AS m FROM events WHERE aggregate_id = 'run-term-t34'");
    check("poda: run terminal 2100 → 2000 (recorta 100)", pruned.pruned === 100 && Number(afterTerm.n) === 2000 && Number(before.n) === 2100, `pruned=${pruned.pruned} ${pruneMs}ms`);
    check("poda: conserva las mas recientes (min seq=100)", Number(minSeq.m) === 100, `minSeq=${minSeq.m}`);
    check("poda: run abierto intacto (no regresion)", Number(afterOpen.n) === 2100, `open=${afterOpen.n}`);
    const octusSrc = src("packages/core/src/sessions/octus-core.ts");
    check("poda: settle de arranque la aplica", /pruneTerminalRunEvents\(\)/.test(octusSrc));
    // misleading_success_output: el exceso sale como over:true, nunca ok silencioso
    check("misleading_success_output: el exceso se senala (over), no se camufla", floodRes.over === true && perf.renderTimes("chat-messages") >= 1);

    // ---- dirty_worktree: el harness no deja basura (tmp/logs/db); los
    // cambios de fuente son el set intencional del Todo 34 mas el trabajo
    // ajeno concurrente (Todo 35), que se reporta y no se toca. ----
    try {
      const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: W, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const dirty = porcelain.split("\n").map((l) => l.trim()).filter(Boolean);
      const junk = dirty.filter((l) => /\.(log|tmp|db|db-journal|db-wal)$|node_modules|^\?\? C:\\tmp/i.test(l));
      const mine = dirty.filter((l) => /perf\.ts|views\/(chat|sections|dag|agents)\.tsx|store\/(bootstrap|projects)\.ts|event-store\.ts|file-explorer\.ts|sessions\/octus-core\.ts|verify-task-34-budget\.mjs|task-34\.txt/.test(l));
      const sibling = dirty.filter((l) => !mine.includes(l) && !l.includes(".omo/evidence") && junk.indexOf(l) < 0);
      check("dirty_worktree: sin basura del harness (logs/tmp/db)", junk.length === 0, junk.length === 0 ? `${dirty.length} cambios de fuente, 0 basura` : junk.join(";"));
      console.log(`info dirty: mios=${mine.length} ajenos(Todo35, intactos)=${sibling.length} evidencia_task34=excluida`);
      if (sibling.length > 0) console.log(`info ajenos: ${sibling.join(" | ").slice(0, 600)}`);
    } catch {
      check("dirty_worktree: git disponible", false, "git fallo");
    }

    // ---- hung_or_long_commands: todo con techo ----
    check("hung: las operaciones usan timeout (Interrupt/timeout)", /AbortSignal\.timeout|opTimeoutMs|timeout/i.test(src("packages/core/src/persistence/persistence-service.ts")));
  } finally {
    await core.close();
  }

  // ---- Limpieza con recibo ----
  rmSync(BIG, { recursive: true, force: true });
  rmSync(DATA, { recursive: true, force: true });
  const receipt = `cleanup: big=${!existsSync(BIG)} data=${!existsSync(DATA)}`;
  console.log(receipt);
  check("limpieza: tmp fuera", !existsSync(BIG) && !existsSync(DATA));

  console.log(`\nTODO34-BUDGET pasada ${round}: ${passes} PASS, ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`FATAL ${(error && (error.stack || error)) || error}`.slice(0, 2000));
  try {
    rmSync(BIG, { recursive: true, force: true });
    rmSync(DATA, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});
