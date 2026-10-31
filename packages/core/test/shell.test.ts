import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { isOctusError } from "../src/errors.js";
import { autoAllow, expectRejects, makeRun, makeTestCore, workspaceOf, type TestCore } from "./helpers.js";

let current: TestCore | undefined;
afterEach(async () => {
  await current?.cleanup();
  current = undefined;
});

async function setup() {
  current = await makeTestCore();
  const t = current;
  const project = await t.core.createProject("P", workspaceOf(t));
  const session = await t.core.createSession({ projectId: project.id });
  const { runId, instanceId } = await makeRun(t, session.id);
  return { t, session, runId, instanceId };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function sh(s: Setup, toolCallId: string, args: unknown) {
  return {
    toolCallId,
    idempotencyKey: `idem-${toolCallId}`,
    sessionId: s.session.id,
    runId: s.runId,
    instanceId: s.instanceId,
    definitionId: "coordinator-build",
    directory: workspaceOf(s.t),
    name: "shell",
    args,
  };
}

describe("shell tool (ADR-018)", () => {
  test("requires approval and runs with cwd in the workspace", async () => {
    const s = await setup();
    const stop = autoAllow(s.t.core, "once");
    const result = await s.t.core.gateway.execute(sh(s, "tool_sh_1", { command: "node -e \"console.log('shell-ok')\"" }));
    stop();
    expect(result.ok).toBe(true);
    expect(result.text).toContain("shell-ok");
  });

  test("child environment has no secrets (allowlist only)", async () => {
    const s = await setup();
    process.env.OCTUS_PROBE_SECRET = "super-secret-value";
    try {
      const stop = autoAllow(s.t.core, "once");
      const result = await s.t.core.gateway.execute(
        sh(s, "tool_sh_env", { command: "node -e \"console.log(JSON.stringify(process.env))\"" }),
      );
      stop();
      expect(result.ok).toBe(true);
      expect(result.text).not.toContain("super-secret-value");
      expect(result.text).not.toContain("MODEL_API_KEY");
    } finally {
      delete process.env.OCTUS_PROBE_SECRET;
    }
  });

  test("timeout kills the whole process tree (child and grandchild)", async () => {
    const s = await setup();
    const stop = autoAllow(s.t.core, "once");
    const marker = path.join(workspaceOf(s.t), "grandchild-marker.txt");
    const command = `node -e "const {spawn}=require('child_process');spawn(process.execPath,['-e','setTimeout(()=>{require(\\'fs\\').writeFileSync(${JSON.stringify(marker)},\\'x\\')},3000)'],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>{},30000)"`;
    const error = await expectRejects(s.t.core.gateway.execute(sh(s, "tool_sh_tree", { command, timeoutMs: 1500 })), /timed out/);
    stop();
    expect(isOctusError(error, "timeout")).toBe(true);
    await Bun.sleep(3500);
    expect(existsSync(marker)).toBe(false);
  }, 20000);

  test("non-zero exit becomes a tool failure with the output", async () => {
    const s = await setup();
    const stop = autoAllow(s.t.core, "once");
    const error = await expectRejects(
      s.t.core.gateway.execute(sh(s, "tool_sh_fail", { command: "node -e \"console.log('boom-marker');process.exit(3)\"" })),
      /exit(ed)? with code 3/,
    );
    stop();
    expect(isOctusError(error, "tool_failed")).toBe(true);
  });
});
