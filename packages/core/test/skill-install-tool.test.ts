import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { makeTestCore, workspaceOf, makeRun, autoAllow } from "./helpers.js";

function fixtureSkill(root: string, name = "cool-skill"): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Hace cosas guays.\nmetadata:\n  version: 1.0.0\n  allowed-tools: read\n---\n# ${name}\nInstrucciones.\n`,
  );
  return dir;
}

describe("skill_install por el agente (a petición del usuario)", () => {
  test("instala desde carpeta y habilita en el proyecto", async () => {
    const t = await makeTestCore();
    const stop = autoAllow(t.core, "once");
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const fx = mkdtempSync(path.join(tmpdir(), "octus-skill-install-"));
      try {
        const src = fixtureSkill(fx);
        const { runId, instanceId } = await makeRun(t, session.id);
        const out = await t.core.gateway.execute({
          toolCallId: "tool_skill_1",
          idempotencyKey: "idem-skill-1",
          sessionId: session.id,
          runId,
          instanceId,
          definitionId: "coordinator-build",
          directory: workspaceOf(t),
          name: "skill_install",
          args: { kind: "folder", path: src, scope: "project", enable: true },
          signal: new AbortController().signal,
        });
        expect(out.ok).toBe(true);
        expect(out.text).toContain("cool-skill@1.0.0");
        const enabled = await t.core.skills!.resolveForRun(project.id);
        expect(enabled.map((s) => s.name)).toContain("cool-skill");
      } finally {
        rmSync(fx, { recursive: true, force: true });
      }
    } finally {
      stop();
      await t.cleanup();
    }
  });

  test("rechaza duplicados sin romper nada", async () => {
    const t = await makeTestCore();
    const stop = autoAllow(t.core, "once");
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const fx = mkdtempSync(path.join(tmpdir(), "octus-skill-install-"));
      try {
        const src = fixtureSkill(fx);
        const first = await makeRun(t, session.id);
        await t.core.gateway.execute({
          toolCallId: "tool_skill_2",
          idempotencyKey: "idem-skill-2",
          sessionId: session.id,
          runId: first.runId,
          instanceId: first.instanceId,
          definitionId: "coordinator-build",
          directory: workspaceOf(t),
          name: "skill_install",
          args: { kind: "folder", path: src, scope: "project", enable: false },
          signal: new AbortController().signal,
        });
        const second = await makeRun(t, session.id);
        const err = await t.core.gateway
          .execute({
            toolCallId: "tool_skill_3",
            idempotencyKey: "idem-skill-3",
            sessionId: session.id,
            runId: second.runId,
            instanceId: second.instanceId,
            definitionId: "coordinator-build",
            directory: workspaceOf(t),
            name: "skill_install",
            args: { kind: "folder", path: src, scope: "project", enable: false },
            signal: new AbortController().signal,
          })
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(err).not.toBeNull();
      } finally {
        rmSync(fx, { recursive: true, force: true });
      }
    } finally {
      stop();
      await t.cleanup();
    }
  });
});
