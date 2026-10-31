import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertShellGitAllowed } from "../src/tools/shell-guard.js";
import { autoAllow, expectRejects, makeTestCore, workspaceOf } from "./helpers.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
}

async function setupGitProject() {
  const t = await makeTestCore();
  const project = await t.core.createProject("P", workspaceOf(t));
  const session = await t.core.createSession({ projectId: project.id });
  const dir = workspaceOf(t);
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@octus.local"]);
  git(dir, ["config", "user.name", "Octus Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return { t, project, session, dir };
}

async function setupInstance(t: Awaited<ReturnType<typeof setupGitProject>>, definitionId: string) {
  const def = (await t.t.core.registry.get(definitionId))!;
  const runId = `run_${definitionId}`;
  const instanceId = `ins_${definitionId}`;
  await t.t.core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES (?, ?, 't', 'executing', 'build', 1, 1)", [runId, t.session.id]);
  const { snapshotOf, promptHashOf } = await import("../src/agents/definition-loader.js");
  await t.t.core.db.exec(
    "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, 1, 1)",
    [instanceId, t.session.id, runId, def.id, JSON.stringify(def.defaultModel), t.dir, def.promptVersion, promptHashOf(def), JSON.stringify(snapshotOf(def))],
  );
  let counter = 0;
  const exec = (name: string, args: unknown) =>
    t.t.core.gateway.execute({
      toolCallId: `tool_${definitionId}_${counter}`,
      idempotencyKey: `idem-${definitionId}-${counter++}-${Date.now()}`,
      sessionId: t.session.id,
      runId,
      instanceId,
      definitionId: def.id,
      directory: t.dir,
      name,
      args,
    });
  return { exec };
}

describe("git tools + shell guard (Etapa 2)", () => {
  test("git_status/git_diff read without modifying; stage+commit with approval", async () => {
    const s = await setupGitProject();
    try {
      const { exec } = await setupInstance(s, "implementer");
      const stop = autoAllow(s.t.core, "once");
      writeFileSync(path.join(s.dir, "a.txt"), "one\ntwo\n");
      const status = await exec("git_status", {});
      expect(status.text).toContain("a.txt");
      const diff = await exec("git_diff", {});
      expect(diff.text).toContain("+two");
      const staged = await exec("git_stage", { paths: ["a.txt"] });
      expect(staged.ok).toBe(true);
      const committed = await exec("git_commit", { message: "second line" });
      expect(committed.ok).toBe(true);
      expect(git(s.dir, ["log", "--oneline"])).toContain("second line");
      stop();
    } finally {
      await s.t.cleanup();
    }
  });

  test("stage/commit paths outside the scope are blocked", async () => {
    const s = await setupGitProject();
    try {
      const { exec } = await setupInstance(s, "implementer");
      const stop = autoAllow(s.t.core, "once");
      const outside = path.join(tmpdir(), `octus-outside-${Date.now()}.txt`);
      writeFileSync(outside, "x");
      try {
        await expectRejects(exec("git_stage", { paths: [outside] }), /scope|escapes/i);
      } finally {
        rmSync(outside, { force: true });
      }
      stop();
    } finally {
      await s.t.cleanup();
    }
  });

  test("shell guard denies branch management, merge, push, rebase and reset", () => {
    for (const command of [
      "git push origin main",
      "git checkout -b feat",
      "git switch main",
      "git branch -D x",
      "git merge feat",
      "git pull",
      "git pull --rebase",
      "git clone https://example.com/r.git",
      "git submodule update",
      "git rebase main",
      "git reset --hard",
      "git worktree add ../wt",
      "git stash push",
      "echo ok && git push",
      "GIT_SSH=x git push",
      "git -C /tmp status",
      "git -c core.hooksPath=/tmp status",
      "git --git-dir=/tmp/x status",
      "git \"push\"",
    ]) {
      expect(() => assertShellGitAllowed(command)).toThrow(/not available to agents|forbidden/);
    }
    for (const command of ["git status", "git diff --stat", "git log --oneline", "echo 'git push the docs'", "echo git push", "node build.js"]) {
      expect(() => assertShellGitAllowed(command)).not.toThrow();
    }
  });

  test("guarded git via shell is denied at runtime (not only statically)", async () => {
    const s = await setupGitProject();
    try {
      const { exec } = await setupInstance(s, "implementer");
      const stop = autoAllow(s.t.core, "once");
      await expectRejects(exec("shell", { command: "git checkout -b sneaky" }), /not available to agents/);
      expect(git(s.dir, ["branch", "--show-current"]).trim()).toBe("main");
      stop();
    } finally {
      await s.t.cleanup();
    }
  });
});
