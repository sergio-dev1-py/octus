import { describe, expect, test } from "bun:test";
import type { PermissionLayers } from "../src/permissions/permission-manager.js";
import { expectRejects, makeRun, makeTestCore, workspaceOf, type TestCore } from "./helpers.js";

async function layersFor(t: TestCore, definitionId: string): Promise<PermissionLayers> {
  const def = await t.core.registry.get(definitionId);
  if (!def) throw new Error(`missing definition ${definitionId}`);
  return {
    definitionTools: def.tools,
    deniedTools: def.deniedTools ?? [],
    definitionRules: def.permissionRules ?? [],
    instanceRules: [],
  };
}

describe("permisos por perfil (build todo / plan solo lectura)", () => {
  test("build: escribir y shell normal van sin preguntar; lo crítico se deniega; lo propio se niega", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const build = await layersFor(t, "coordinator-build");
      expect(await t.core.permissions.preview("write", "x.txt", build, project.id)).toBe("allow");
      expect(await t.core.permissions.preview("edit", "x.txt", build, project.id)).toBe("allow");
      expect(await t.core.permissions.preview("shell", "node -v", build, project.id)).toBe("allow");
      expect(await t.core.permissions.preview("shell", "del C:\\temp\\a.txt", build, project.id)).toBe("deny");
      expect(await t.core.permissions.preview("shell", "del ..\\secrets.txt", build, project.id)).toBe("allow");
      expect(await t.core.permissions.preview("shell", "del archivo.txt", build, project.id)).toBe("allow");
      expect(await t.core.permissions.preview("shell", "Remove-Item .\\a.txt", build, project.id)).toBe("allow");
      expect(await t.core.permissions.preview("shell", "taskkill /F /IM node.exe", build, project.id)).toBe("deny");
    } finally {
      await t.cleanup();
    }
  });

  test("plan: sin herramientas de escritura (denegado, nunca pregunta)", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const plan = await layersFor(t, "coordinator-plan");
      expect(await t.core.permissions.preview("write", "x.txt", plan, project.id)).toBe("deny");
      expect(await t.core.permissions.preview("shell", "node -v", plan, project.id)).toBe("deny");
      expect(await t.core.permissions.preview("read", "x.txt", plan, project.id)).toBe("allow");
    } finally {
      await t.cleanup();
    }
  });

  test("implementer asignado hereda escritura; sin asignar sigue denegado", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const impl = await layersFor(t, "implementer");
      expect(await t.core.permissions.preview("write", "x.txt", impl, project.id)).toBe("allow");
      expect(await t.core.permissions.preview("shell", "del work\\a.txt", impl, project.id)).toBe("allow");
      expect(await t.core.permissions.preview("shell", "del C:\\temp\\a.txt", impl, project.id)).toBe("deny");
      // Sin asignación, las instanceRules del manager deniegan por encima.
      const unassigned: PermissionLayers = { ...impl, instanceRules: [{ action: "write", resource: "*", effect: "deny" }] };
      expect(await t.core.permissions.preview("write", "x.txt", unassigned, project.id)).toBe("deny");
    } finally {
      await t.cleanup();
    }
  });

  test("build no puede abrir preguntas ni desde un snapshot antiguo", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      const { runId, instanceId } = await makeRun(t, session.id);
      await expectRejects(
        t.core.gateway.execute({
          toolCallId: "tool_q_build",
          idempotencyKey: "idem-q-build",
          sessionId: session.id,
          runId,
          instanceId,
          definitionId: "coordinator-build",
          directory: workspaceOf(t),
          name: "question",
          args: { questions: [{ header: "Replan", question: "¿Autorizas replan?", options: [{ label: "Sí" }] }] },
          signal: new AbortController().signal,
        }),
        /only available in PLAN/i,
      );
      void project;
    } finally {
      await t.cleanup();
    }
  });

  test("las definiciones traen las reglas (seed por promptVersion)", async () => {
    const t = await makeTestCore();
    try {
      const build = await t.core.registry.get("coordinator-build");
      const rules = build!.permissionRules ?? [];
      expect(rules.some((r) => r.action === "write" && r.resource === "*" && r.effect === "allow")).toBe(true);
      expect(rules.some((r) => r.action === "shell" && r.resource === "*taskkill*node*" && r.effect === "deny")).toBe(true);
      expect(rules.some((r) => r.action === "shell" && r.resource === "*del C:*" && r.effect === "deny")).toBe(true);
      const impl = await t.core.registry.get("implementer");
      expect((impl!.permissionRules ?? []).some((r) => r.action === "edit" && r.effect === "allow")).toBe(true);
    } finally {
      await t.cleanup();
    }
  });
});
