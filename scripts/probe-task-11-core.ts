/** Pico de recuperación Todo 11 (runtime real, sin UI): ciclo crear →
 * aislar → renombrar → cerrar → recuperar sobre OctusCore + SQLite reales
 * en un dataDir temporal, más el failure con fila corrupta.
 * Uso: bun probe-task-11-core.ts (cwd = packages/core). Exit 0 = verde. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OctusCore } from "../packages/core/src/sessions/octus-core.js";
import { MemorySecretStore } from "../packages/core/src/secrets/secret-store.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"} [core] ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

const dir = mkdtempSync(path.join(tmpdir(), "octus-t11-probe-"));
const dataDir = path.join(dir, "data");
const core = await OctusCore.create({ dataDir, primarySecrets: new MemorySecretStore(), providers: [] });
try {
  const wsA = path.join(dir, "A");
  const wsB = path.join(dir, "B");
  await (await import("node:fs")).promises.mkdir(wsA, { recursive: true });
  await (await import("node:fs")).promises.mkdir(wsB, { recursive: true });
  const pA = await core.createProject("QA-A", wsA);
  const pB = await core.createProject("QA-B", wsB);
  const sA1 = await core.createSession({ projectId: pA.id, title: "A-uno" });
  const sA2 = await core.createSession({ projectId: pA.id, title: "A-dos" });
  const sB1 = await core.createSession({ projectId: pB.id, title: "B-uno" });
  check("crear: 2 sesiones en A, 1 en B", (await core.listSessions(pA.id)).length === 2 && (await core.listSessions(pB.id)).length === 1);
  check("aislamiento: B no ve sesiones de A", !(await core.listSessions(pB.id)).some((s) => s.id === sA1.id));
  check("cambiar: getSession devuelve la sesión pedida", (await core.getSession(sB1.id)).session.id === sB1.id);
  await core.renameSession(sA1.id, "A-uno-qa");
  check("renombrar persiste", (await core.listSessions(pA.id)).find((s) => s.id === sA1.id)?.title === "A-uno-qa");
  const healthy = await core.recoverSession(sA1.id);
  check("recuperar sana: sin incidente", healthy.recovered === false && healthy.messages.length === 0);
  check("recuperar sana: no emite error.raised", (await core.events.listByType("error.raised")).length === 0);
  await core.deleteSession(sA2.id);
  check("cerrar: A queda con 1 sesión", (await core.listSessions(pA.id)).length === 1);
  try {
    await core.getSession(sA2.id);
    check("cerrar: continuar cerrada es not_found", false);
  } catch (e) {
    check("cerrar: continuar cerrada es not_found", String(e).includes("Session not found"));
  }

  // Failure: mensaje + evento corruptos.
  const sF = await core.createSession({ projectId: pA.id, title: "fragil" });
  await core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES ('run_f', ?, 'x', 'done', 'build', 1, 1)", [sF.id]);
  await core.db.exec(
    "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES ('ins_f', ?, 'run_f', 'coordinator-build', 'done', '{\"providerId\":\"p\",\"modelId\":\"m\"}', ?, 1, 'h', '{}', 1, 1)",
    [sF.id, wsA],
  );
  await core.db.exec("INSERT INTO messages (id, session_id, run_id, instance_id, role, mode, parts, trust, seq, created_at) VALUES ('msg_bad', ?, 'run_f', 'ins_f', 'user', 'build', ?, 'user', 0, 1)", [sF.id, "¡corrupto{"]);
  await core.db.exec("INSERT INTO events (id, type, aggregate_kind, aggregate_id, seq, occurred_at, correlation_id, idempotency_key, payload) VALUES ('evt_bad', 'session.created', 'session', ?, 77, 1, 'c', 'i', ?)", [sF.id, "¡corrupto{"]);
  const rec = await core.recoverSession(sF.id);
  check("failure: sesión vacía", rec.messages.length === 0 && rec.recovered === true);
  check("failure: conteo exacto de corruptas", rec.skippedMessages.join(",") === "msg_bad" && rec.skippedEvents === 1);
  const raised = await core.events.listByType("error.raised");
  check("failure: incidente registrado (no silencioso)", raised.length === 1 && (raised[0]!.payload.sessionId as string) === sF.id);
  check("failure: filas corruptas conservadas", (await core.db.queryOne<{ parts: string }>("SELECT parts FROM messages WHERE id = 'msg_bad'"))?.parts === "¡corrupto{");
  check("failure: sesión sigue navegable", (await core.getSession(sF.id)).session.id === sF.id);
} finally {
  await core.close();
  rmSync(dir, { recursive: true, force: true });
}
if (failures > 0) {
  console.log(`PROBE-CORE: ${failures} fallo(s)`);
  process.exit(1);
}
console.log("PROBE-CORE: OK");
