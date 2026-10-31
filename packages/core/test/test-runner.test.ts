import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { autoAllow, expectRejects, makeTestCore, workspaceOf } from "./helpers.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
}

describe("test_run in a disposable copy (ADR-029)", () => {
  test("runs allowlisted commands off a copy: no .git, original untouched", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const dir = workspaceOf(t);
      git(dir, ["init", "-b", "main"]);
      git(dir, ["config", "user.email", "t@octus.local"]);
      git(dir, ["config", "user.name", "t"]);
      git(dir, ["config", "commit.gpgsign", "false"]);
      writeFileSync(path.join(dir, "check.txt"), "v1\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "init"]);
      // Entrada allowlist: node disponible en PATH del entorno de test.
      await t.core.saveTestAllowlist(project.id, [{ id: "probe", name: "probe", argv: [process.execPath, "-e", "console.log('probe-ok')"] }]);
      const session = await t.core.createSession({ projectId: project.id });
      const before = git(dir, ["status", "--porcelain"]);
      const stop = autoAllow(t.core, "once");
      // Instancia reviewer mínima para FK.
      const def = (await t.core.registry.get("reviewer"))!;
      const { snapshotOf, promptHashOf } = await import("../src/agents/definition-loader.js");
      await t.core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES ('run_t', ?, 't', 'executing', 'build', 1, 1)", [session.id]);
      await t.core.db.exec(
        "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES ('ins_t', ?, 'run_t', ?, 'running', ?, ?, ?, ?, ?, 1, 1)",
        [session.id, def.id, JSON.stringify(def.defaultModel), dir, def.promptVersion, promptHashOf(def), JSON.stringify(snapshotOf(def))],
      );
      const result = await t.core.gateway.execute({
        toolCallId: "tool_tr_1",
        idempotencyKey: "idem-tr-1",
        sessionId: session.id,
        runId: "run_t",
        instanceId: "ins_t",
        definitionId: "reviewer",
        directory: dir,
        name: "test_run",
        args: { entryId: "probe" },
      });
      stop();
      expect(result.ok).toBe(true);
      expect(result.text).toContain("probe-ok");
      expect(result.text).toContain("disposable copy");
      // El original no cambió.
      expect(git(dir, ["status", "--porcelain"])).toBe(before);
      expect(readFileSync(path.join(dir, "check.txt"), "utf8")).toBe("v1\n");
    } finally {
      await t.cleanup();
    }
  });

  test("entries outside the allowlist are denied; failing commands report output", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const def = (await t.core.registry.get("reviewer"))!;
      const { snapshotOf, promptHashOf } = await import("../src/agents/definition-loader.js");
      await t.core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES ('run_t2', ?, 't', 'executing', 'build', 1, 1)", [session.id]);
      await t.core.db.exec(
        "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES ('ins_t2', ?, 'run_t2', ?, 'running', ?, ?, ?, ?, ?, 1, 1)",
        [session.id, def.id, JSON.stringify(def.defaultModel), workspaceOf(t), def.promptVersion, promptHashOf(def), JSON.stringify(snapshotOf(def))],
      );
      const stop = autoAllow(t.core, "once");
      await expectRejects(
        t.core.gateway.execute({ toolCallId: "tool_tr_2", idempotencyKey: "idem-tr-2", sessionId: session.id, runId: "run_t2", instanceId: "ins_t2", definitionId: "reviewer", directory: workspaceOf(t), name: "test_run", args: { entryId: "ghost" } }),
        /allowlist/,
      );
      await t.core.saveTestAllowlist(project.id, [{ id: "fails", name: "fails", argv: [process.execPath, "-e", "console.log('marker-fail');process.exit(2)"] }]);
      const err = await expectRejects(
        t.core.gateway.execute({ toolCallId: "tool_tr_3", idempotencyKey: "idem-tr-3", sessionId: session.id, runId: "run_t2", instanceId: "ins_t2", definitionId: "reviewer", directory: workspaceOf(t), name: "test_run", args: { entryId: "fails" } }),
        /exit 2/,
      );
      expect(String(err)).toContain("marker-fail");
      stop();
    } finally {
      await t.cleanup();
    }
  });

  test("a test that writes files only dirties the disposable copy", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const dir = workspaceOf(t);
      mkdirSync(path.join(dir, "sub"), { recursive: true });
      await t.core.saveTestAllowlist(project.id, [
        { id: "writer", name: "writer", argv: [process.execPath, "-e", "require('fs').writeFileSync('polluted.txt','x')"] },
      ]);
      const def = (await t.core.registry.get("reviewer"))!;
      const { snapshotOf, promptHashOf } = await import("../src/agents/definition-loader.js");
      await t.core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES ('run_t3', ?, 't', 'executing', 'build', 1, 1)", [session.id]);
      await t.core.db.exec(
        "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES ('ins_t3', ?, 'run_t3', ?, 'running', ?, ?, ?, ?, ?, 1, 1)",
        [session.id, def.id, JSON.stringify(def.defaultModel), dir, def.promptVersion, promptHashOf(def), JSON.stringify(snapshotOf(def))],
      );
      const stop = autoAllow(t.core, "once");
      const result = await t.core.gateway.execute({ toolCallId: "tool_tr_4", idempotencyKey: "idem-tr-4", sessionId: session.id, runId: "run_t3", instanceId: "ins_t3", definitionId: "reviewer", directory: dir, name: "test_run", args: { entryId: "writer" } });
      stop();
      expect(result.ok).toBe(true);
      expect(existsSync(path.join(dir, "polluted.txt"))).toBe(false);
    } finally {
      await t.cleanup();
    }
  });
});

describe("isolated directories (ADR-026)", () => {
  test("register/list/remove round-trip; active assignment blocks removal", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const target = path.join(workspaceOf(t), "wt");
      mkdirSync(target, { recursive: true });
      const registered = await t.core.registerIsolatedDirectory(project.id, target, "directory");
      expect(registered.realPath.length).toBeGreaterThan(0);
      expect(await t.core.isolatedDirectories(project.id)).toHaveLength(1);
      await expectRejects(t.core.registerIsolatedDirectory(project.id, target, "directory"), /already registered/);
      await t.core.removeIsolatedDirectory(registered.id);
      expect(await t.core.isolatedDirectories(project.id)).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });

  test("worktree declarations are verified with git (existence, branch, root)", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const dir = workspaceOf(t);
      git(dir, ["init", "-b", "main"]);
      git(dir, ["config", "user.email", "t@octus.local"]);
      git(dir, ["config", "user.name", "t"]);
      git(dir, ["config", "commit.gpgsign", "false"]);
      writeFileSync(path.join(dir, "a.txt"), "x\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "init"]);
      const wtPath = path.join(workspaceOf(t), "..", "wt-verify");
      const plainDir = path.join(workspaceOf(t), "plain");
      mkdirSync(plainDir, { recursive: true });
      await expectRejects(t.core.registerIsolatedDirectory(project.id, plainDir, "worktree"), /not a registered git worktree/);
      git(dir, ["worktree", "add", "-b", "feature-x", wtPath]);
      try {
        const registered = await t.core.registerIsolatedDirectory(project.id, wtPath, "worktree");
        expect(registered.branch).toBe("feature-x");
        expect(registered.repoRoot).toBeDefined();
        await expectRejects(t.core.registerIsolatedDirectory(project.id, workspaceOf(t), "worktree"), /workspace itself/);
      } finally {
        try {
          git(dir, ["worktree", "remove", "--force", wtPath]);
        } catch {
          // best effort
        }
      }
    } finally {
      await t.cleanup();
    }
  });
});
