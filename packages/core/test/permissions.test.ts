import { describe, expect, test } from "bun:test";
import { evaluateRules } from "../src/permissions/permission-manager.js";
import { isOctusError } from "../src/errors.js";
import { makeTestCore } from "./helpers.js";

describe("permissions", () => {
  test("last matching rule wins", () => {
    const rules = [
      { action: "*", resource: "*", effect: "allow" as const },
      { action: "shell", resource: "*", effect: "ask" as const },
    ];
    expect(evaluateRules("shell", "ls", rules)?.effect).toBe("ask");
    expect(evaluateRules("read", "a.txt", rules)?.effect).toBe("allow");
    expect(evaluateRules("read", "a.txt", [])).toBeUndefined();
  });

  test("deny by default outside the profile; allow/ask inside", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", t.dir);
      const layers = { definitionTools: ["read", "glob", "grep", "question"] };
      expect(await t.core.permissions.preview("read", "a.txt", layers, project.id)).toBe("allow");
      expect(await t.core.permissions.preview("write", "a.txt", layers, project.id)).toBe("deny");
      const full = { definitionTools: ["read", "write", "shell"] };
      expect(await t.core.permissions.preview("write", "a.txt", full, project.id)).toBe("ask");
      expect(await t.core.permissions.preview("shell", "ls", full, project.id)).toBe("ask");
    } finally {
      await t.cleanup();
    }
  });

  test("ask flow: reply once allows; saved always upgrades next time; revoke removes", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", t.dir);
      const layers = { definitionTools: ["write"] };
      const ctx = { sessionId: "ses_1", runId: "run_1", instanceId: "ins_1", projectId: project.id, toolCallId: "tool_1", action: "write", correlationId: "cor_1" };
      const pending = t.core.permissions.decide("write", ["a.txt"], layers, ctx);
      await Bun.sleep(50);
      expect(t.core.permissions.pendingFor("ses_1")).toHaveLength(1);
      expect(t.core.permissions.reply(t.core.permissions.pendingFor("ses_1")[0]!.id, "once")).toBe(true);
      expect((await pending).decision).toBe("allow");

      const ctx2 = { ...ctx, toolCallId: "tool_2" };
      const pending2 = t.core.permissions.decide("write", ["b.txt"], layers, ctx2);
      await Bun.sleep(50);
      t.core.permissions.reply(t.core.permissions.pendingFor("ses_1")[0]!.id, "always");
      expect((await pending2).decision).toBe("allow");
      // Segunda vez: permitido sin preguntar
      expect((await t.core.permissions.decide("write", ["b.txt"], layers, { ...ctx, toolCallId: "tool_3" })).via).toBe("rule");
      const saved = await t.core.permissions.savedRules(project.id);
      expect(saved).toHaveLength(1);
      await t.core.permissions.revokeSaved(saved[0]!.id);
      expect(await t.core.permissions.savedRules(project.id)).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });

  test("shell can never be always-allowed and deny beats saved rules", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", t.dir);
      // Guardado malicioso a mano: no eleva shell.
      await t.core.db.exec("INSERT INTO permission_rules (id, project_id, action, resource, effect, created_at) VALUES ('x', ?, 'shell', '*', 'allow', 1)", [project.id]);
      expect(await t.core.permissions.preview("shell", "ls", { definitionTools: ["shell"] }, project.id)).toBe("ask");
      // Deny explícito gana a cualquier guardado.
      const layers = { definitionTools: ["read"], sessionRules: [{ action: "read", resource: "*", effect: "deny" as const }] };
      expect(await t.core.permissions.preview("read", "a.txt", layers, project.id)).toBe("deny");
      void isOctusError;
    } finally {
      await t.cleanup();
    }
  });
});
