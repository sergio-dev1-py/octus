/**
 * Harness live-local (sin proveedor ni claves): verifica herramientas Git
 * controladas, contención de rutas y denegaciones de perfiles con el gateway
 * real sobre un repo temporal. Cero llamadas a proveedores (cero coste).
 *
 *   bun scripts/accept-local-tools.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createId } from "@octus/shared";
import { OctusCore } from "../src/sessions/octus-core.js";
import { promptHashOf, snapshotOf } from "../src/agents/definition-loader.js";
import { MemorySecretStore } from "../src/secrets/secret-store.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  local-tools: ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
}

const root = mkdtempSync(path.join(tmpdir(), "octus-accept-local-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "octus-accept-local-db-"));
const core = await OctusCore.create({ dataDir, primarySecrets: new MemorySecretStore() });
try {
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "accept@octus.local"]);
  git(root, ["config", "user.name", "Octus Accept"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(root, "app.txt"), "line-one\n");
  writeFileSync(path.join(root, ".env.example"), "KEY=\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  const wt = path.join(`${root}-wt`);
  git(root, ["worktree", "add", "-b", "impl-local", wt]);

  const project = await core.createProject("accept-local", root);
  const session = await core.createSession({ projectId: project.id, title: "accept-local" });
  const mkInstance = async (definitionId: string, directory: string): Promise<{ runId: string; instanceId: string }> => {
    const def = (await core.registry.get(definitionId))!;
    const runId = createId("run");
    const instanceId = createId("ins");
    await core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES (?, ?, 'local', 'executing', 'build', 1, 1)", [runId, session.id]);
    await core.db.exec(
      "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, assigned_directory_id, instance_rules, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, 1, 1)",
      [instanceId, session.id, runId, def.id, JSON.stringify(def.defaultModel), directory, def.promptVersion, promptHashOf(def), JSON.stringify(snapshotOf(def)), null, "[]"],
    );
    return { runId, instanceId };
  };
  const stop = core.bus.subscribe((event) => {
    if (event.type === "permission.asked") {
      const requestId = String((event.payload as Record<string, unknown>).requestId ?? "");
      if (requestId) void core.permissions.reply(requestId, "once");
    }
  });
  let seq = 0;
  const nextId = (prefix: string): string => `${prefix}-${++seq}`;
  try {
    const impl = await mkInstance("implementer", wt);
    const call = (name: string, args: unknown, id: string) =>
      core.gateway.execute({ toolCallId: id, idempotencyKey: `idem-${id}`, sessionId: session.id, runId: impl.runId, instanceId: impl.instanceId, definitionId: "implementer", directory: wt, name, args });
    const status = await call("git_status", {}, "t-status");
    check("implementer git_status reads worktree", status.ok && /nothing to commit|branch|clean|main|##/i.test(status.text), status.text.slice(0, 80));
    writeFileSync(path.join(wt, "app.txt"), "line-one\nline-two\n");
    const diff = await call("git_diff", {}, "t-diff");
    check("implementer git_diff shows modification", diff.ok && /line-two/.test(diff.text), diff.text.slice(0, 80));
    const staged = await call("git_stage", { paths: ["app.txt"] }, "t-stage");
    check("implementer git_stage with approval", staged.ok, staged.text.slice(0, 80));
    const committed = await call("git_commit", { message: "acceptance: second line" }, "t-commit");
    check("implementer git_commit with approval", committed.ok, committed.text.slice(0, 80));
    check("commit recorded in worktree", git(wt, ["log", "--oneline"]).includes("acceptance: second line"), "git log verified");

    const denies: Array<[string, unknown, RegExp]> = [
      ["shell git checkout -b", { command: "git checkout -b sneaky" }, /not available|scope_violation|denied/i],
      ["shell git push", { command: "git push origin main" }, /not available|scope_violation|denied/i],
      ["shell git reset --hard", { command: "git reset --hard" }, /not available|scope_violation|denied/i],
      ["write outside scope", { path: path.join(root, "escape.txt"), content: "x" }, /scope|denied|escapes/i],
      ["read traversal", { path: "../../escape.txt" }, /scope|denied|escapes/i],
      ["read UNC", { path: "\\\\server\\share\\file.txt" }, /UNC|scope|denied/i],
      ["read .env", { path: ".env" }, /secret|scope|denied/i],
    ];
    for (const [label, args, pattern] of denies) {
      const name = String(label).startsWith("shell") ? "shell" : String(label).startsWith("write") ? "write" : "read";
      const id = nextId("t-deny");
      try {
        const r = await call(name, args, id);
        check(`implementer denied: ${label}`, !r.ok || pattern.test(r.text), r.text.slice(0, 100));
      } catch (e) {
        check(`implementer denied: ${label}`, pattern.test(String(e instanceof Error ? e.message : e)), String(e instanceof Error ? e.message : e).slice(0, 100));
      }
    }
    check("original workspace untouched by worktree commit", git(root, ["log", "--oneline"]).split("\n").length <= 2, "main repo history intact");

    const rev = await mkInstance("reviewer", root);
    const revCall = (name: string, args: unknown, id: string) =>
      core.gateway.execute({ toolCallId: id, idempotencyKey: `idem-${id}`, sessionId: session.id, runId: rev.runId, instanceId: rev.instanceId, definitionId: "reviewer", directory: root, name, args });
    try {
      await revCall("shell", { command: "echo hi" }, "t-rev-shell");
      check("reviewer has no generic shell", false, "shell executed");
    } catch (e) {
      check("reviewer has no generic shell", /denied/i.test(String(e instanceof Error ? e.message : e)), String(e instanceof Error ? e.message : e).slice(0, 100));
    }
    try {
      await revCall("write", { path: "rev.txt", content: "x" }, "t-rev-write");
      check("reviewer cannot write", false, "write executed");
    } catch (e) {
      check("reviewer cannot write", /denied/i.test(String(e instanceof Error ? e.message : e)), String(e instanceof Error ? e.message : e).slice(0, 100));
    }
    const revDiff = await revCall("git_diff", {}, "t-rev-diff");
    check("reviewer git_diff read-only", revDiff.ok, revDiff.text.slice(0, 60));
  } finally {
    stop();
  }
} finally {
  await core.close();
  try {
    execFileSync("git", ["worktree", "remove", "--force", `${root}-wt`], { cwd: root, timeout: 30_000 });
  } catch {
    // best effort
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`LOCAL-TOOLS FAILED (${failures})`);
  process.exit(1);
}
console.log("LOCAL-TOOLS PASSED");
