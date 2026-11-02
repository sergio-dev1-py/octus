// QA Todo 32 — terminal persistente con PTY en main: ciclo real contra TerminalService.
// Uso: node --experimental-transform-types scripts/qa-task-32.mjs — exit 0 = verde.
// Sin dry-run: cada aserción abre PTYs reales (node-pty + ConPTY), ejecuta eco,
// redimensiona, cancela procesos largos y cierra, con salida por streaming afirmada.
// Dos pasadas (clase flaky). Nota: bajo Bun, ConPTY no entrega salida
// (AttachConsole failed); el runtime productivo es Electron/Node, así que la
// verificación corre bajo node puro con el hook task32-resolve-hook.mjs.
import { register } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

register("file:///C:/Users/UserPy/Documents/octus-wt-octus-ux-skills-mcp-w14/scripts/task32-resolve-hook.mjs");

const { TerminalService } = await import(
  "file:///C:/Users/UserPy/Documents/octus-wt-octus-ux-skills-mcp-w14/apps/desktop/src/main/terminal-service.ts"
);
const { isAlive, killTree } = await import("@octus/core");

let passes = 0;
let failures = 0;
const failuresList = [];
function check(pass, name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} [p${pass}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (cond) passes++;
  else {
    failures++;
    failuresList.push(`[p${pass}] ${name} ${detail}`);
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[a-zA-Z]/g;
const OSC = /\u001b\][^\u0007]*\u0007/g;
const strip = (text) => text.replace(ANSI, "").replace(OSC, "");

async function waitFor(cond, timeoutMs, label) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function runPass(pass) {
  const root = mkdtempSync(join(tmpdir(), `octus-term32-p${pass}-`));
  const streamed = [];
  const service = new TerminalService({
    resolveRoot: async (projectId) => {
      if (projectId !== "prj_qa") throw new Error(`unknown project ${projectId}`);
      return root;
    },
    onData: (chunk) => {
      streamed.push(chunk);
    },
  });
  try {
    // happy: crear
    const t1 = await service.create({ projectId: "prj_qa", name: "qa-uno", cols: 80, rows: 24 });
    check(pass, "crear terminal fija CWD a la raíz del proyecto", t1.cwd === root && t1.status === "open", t1.cwd);

    // happy: eco con STREAMING (callback onData, no solo polling)
    const base = streamed.length;
    service.write(t1.id, "echo eco-32-hola\r");
    let streamedOk = false;
    try {
      await waitFor(() => strip(streamed.slice(base).map((c) => c.data).join("")).includes("eco-32-hola"), 15000, "eco streaming");
      streamedOk = true;
    } catch {
      streamedOk = false;
    }
    check(pass, "eco llega por streaming", streamedOk);

    // polling de respaldo
    const page = service.read(t1.id, 0);
    const joined = page.chunks.map((c) => c.data).join("");
    check(pass, "read() de respaldo contiene el eco", strip(joined).includes("eco-32-hola"), `nextSeq=${page.nextSeq}`);
    check(pass, "read(sinceSeq) pagina hacia adelante", service.read(t1.id, page.nextSeq).chunks.length === 0);

    // redimensionar
    service.resize(t1.id, 100, 30);
    const resized = service.list("prj_qa").find((t) => t.id === t1.id);
    check(pass, "resize 100x30 visible en list", resized?.cols === 100 && resized?.rows === 30);

    // elegir entre varias
    const t2 = await service.create({ projectId: "prj_qa", name: "qa-dos" });
    service.select(t2.id);
    const actives = service.list("prj_qa").filter((t) => t.active).map((t) => t.id);
    check(pass, "select elige la segunda entre varias", actives.length === 1 && actives[0] === t2.id, actives.join(","));
    service.write(t1.id, "echo eco-32-primera-sigue\r");
    let firstAlive = false;
    try {
      await waitFor(() => strip(streamed.map((c) => c.data).join("")).includes("eco-32-primera-sigue"), 15000, "primera viva");
      firstAlive = true;
    } catch {
      firstAlive = false;
    }
    check(pass, "la primera terminal sigue viva tras select", firstAlive);

    // cancelar proceso largo: la terminal queda reutilizable
    service.write(t1.id, "ping -n 30 127.0.0.1 >nul\r");
    await new Promise((r) => setTimeout(r, 1500));
    const killed = await service.kill(t1.id);
    check(pass, "kill() cancela y re-spawnea (restarted)", killed.restarted === true, `forced=${killed.forced}`);
    const base2 = streamed.length;
    service.write(t1.id, "echo eco-32-reutilizable\r");
    let reusable = false;
    try {
      await waitFor(() => strip(streamed.slice(base2).map((c) => c.data).join("")).includes("eco-32-reutilizable"), 15000, "reutilizable");
      reusable = true;
    } catch {
      reusable = false;
    }
    check(pass, "terminal reutilizable tras kill", reusable);
    check(pass, "status open tras kill", service.list("prj_qa").find((t) => t.id === t1.id)?.status === "open");

    // failure: proceso que ignora la señal lo termina el harness (killTree)
    const sleeper = spawn("ping", ["-n", "60", "127.0.0.1"], { stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" });
    const wasAlive = isAlive(sleeper.pid);
    killTree(sleeper.pid);
    let harnessOk = false;
    try {
      await waitFor(() => !isAlive(sleeper.pid), 10000, "killTree");
      harnessOk = true;
    } catch {
      harnessOk = false;
    }
    check(pass, "failure: killTree termina al durmiente que ignora la señal", wasAlive && harnessOk, `pid=${sleeper.pid}`);
    // …y la terminal que corría algo largo sigue reutilizable
    service.write(t1.id, "ping -n 30 127.0.0.1 >nul\r");
    await new Promise((r) => setTimeout(r, 1500));
    await service.kill(t1.id);
    const base3 = streamed.length;
    service.write(t1.id, "echo eco-32-tras-failure\r");
    let afterFailure = false;
    try {
      await waitFor(() => strip(streamed.slice(base3).map((c) => c.data).join("")).includes("eco-32-tras-failure"), 15000, "tras failure");
      afterFailure = true;
    } catch {
      afterFailure = false;
    }
    check(pass, "failure: terminal reutilizable tras harness-kill", afterFailure);

    // cerrar
    service.close(t2.id);
    check(pass, "close elimina una terminal", service.list("prj_qa").map((t) => t.id).join(",") === t1.id);
    service.close(t1.id);
    check(pass, "close deja list vacío", service.list("prj_qa").length === 0);

    // malformed_input
    let m1 = "";
    try {
      await service.create({ projectId: "" });
    } catch (e) {
      m1 = String(e?.message ?? e);
    }
    check(pass, "malformed: projectId vacío se rechaza", /invalid_payload|Invalid projectId/.test(m1), m1.slice(0, 80));
    let m2 = "";
    try {
      await service.create({ projectId: "no-existe" });
    } catch (e) {
      m2 = String(e?.message ?? e);
    }
    check(pass, "malformed: proyecto desconocido se rechaza", m2.includes("unknown project"), m2.slice(0, 80));
    const tm = await service.create({ projectId: "prj_qa", name: "qa-mala" });
    let m3 = "";
    try {
      service.write(tm.id, "");
    } catch (e) {
      m3 = String(e?.message ?? e);
    }
    check(pass, "malformed: write vacío se rechaza", /invalid_payload|Invalid data/.test(m3));
    let m4 = "";
    try {
      service.write(tm.id, "x".repeat(64 * 1024 + 1));
    } catch (e) {
      m4 = String(e?.message ?? e);
    }
    check(pass, "malformed: write >64KB se rechaza", /64KB/.test(m4));
    let m5 = "";
    try {
      service.read("term_nope");
    } catch (e) {
      m5 = String(e?.message ?? e);
    }
    check(pass, "malformed: id desconocido (not_found)", /not_found|not found/i.test(m5));
    let m6 = "";
    try {
      service.resize(tm.id, Number.NaN, 24);
    } catch (e) {
      m6 = String(e?.message ?? e);
    }
    check(pass, "malformed: resize NaN se rechaza", /invalid_payload|Invalid cols/.test(m6));
    service.resize(tm.id, 9999, 9999);
    const clamped = service.list("prj_qa").find((t) => t.id === tm.id);
    check(pass, "resize fuera de rango se recorta (240x100)", clamped?.cols === 240 && clamped?.rows === 100);
    service.close(tm.id);
    check(pass, "malformed no deja terminales colgadas", service.list("prj_qa").length === 0);
  } finally {
    const closed = service.disposeAll();
    check(pass, "limpieza: disposeAll cierra todo", service.list().length === 0, `cerradas=${closed}`);
  }
}

await runPass(1);
await runPass(2);

console.log(`\nTOTAL: ${passes} PASS, ${failures} FAIL`);
if (failures > 0) {
  console.log("FALLOS:");
  for (const f of failuresList) console.log(` - ${f}`);
}
// node-pty deja handles nativos abiertos tras dispose: salida explícita.
process.exit(failures > 0 ? 1 : 0);
