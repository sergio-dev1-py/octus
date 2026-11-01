import { describe, expect, test } from "bun:test";
import { makeTestCore, workspaceOf } from "./helpers.js";

/** Todo 13 (N-C-06): paginación aditiva del historial por cursor estable.
 *  sessionMessages legacy sigue devolviendo todo (compatibilidad intacta). */
describe("chat history pagination (N-C-06)", () => {
  test("latest window, older pages, unknown cursor and legacy compat", async () => {
    const t = await makeTestCore({ metaTurns: [{ text: "one" }, { text: "two" }, { text: "three" }] });
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      for (const text of ["first request", "second request", "third request"]) {
        const { runId } = await t.core.prompt(session.id, text);
        void runId;
        await t.core.waitForIdle(session.id);
      }

      // Legacy intacto: todo el historial sin opciones.
      const all = await t.core.sessionMessages(session.id);
      expect(all.length).toBe(6);

      // Ventana inicial: últimos 2, con total y resto.
      const page1 = await t.core.sessionMessagesPage(session.id, undefined, { limit: 2 });
      expect(page1.messages.length).toBe(2);
      expect(page1.total).toBe(6);
      expect(page1.hasOlder).toBe(true);
      expect(page1.messages[1]!.parts.length).toBeGreaterThan(0);

      // Página anterior por cursor: los 2 previos, sin solape.
      const page2 = await t.core.sessionMessagesPage(session.id, undefined, { limit: 2, beforeId: page1.messages[0]!.id });
      expect(page2.messages.length).toBe(2);
      expect(page2.hasOlder).toBe(true);
      const ids1 = new Set(page1.messages.map((m) => m.id));
      for (const m of page2.messages) expect(ids1.has(m.id)).toBe(false);

      // Primera página: sin resto.
      const page3 = await t.core.sessionMessagesPage(session.id, undefined, { limit: 2, beforeId: page2.messages[0]!.id });
      expect(page3.messages.length).toBe(2);
      expect(page3.hasOlder).toBe(false);

      // Cursor desconocido: degrada a la ventana más reciente.
      const unknown = await t.core.sessionMessagesPage(session.id, undefined, { limit: 2, beforeId: "msg_nope" });
      expect(unknown.messages.map((m) => m.id)).toEqual(page1.messages.map((m) => m.id));

      // runId sigue filtrando y pagina sobre el subconjunto.
      const runId = (await t.core.sessionMessages(session.id))[0]!.runId;
      const scoped = await t.core.sessionMessagesPage(session.id, runId, { limit: 10 });
      expect(scoped.total).toBe(2);
      expect(scoped.hasOlder).toBe(false);
      expect(scoped.messages.every((m) => m.runId === runId)).toBe(true);

      // El run termina y su estado final es legible (base de N-C-12c en el renderer).
      const { runId: lastRun } = await t.core.prompt(session.id, "fourth request");
      await t.core.waitForIdle(session.id);
      expect((await t.core.getRun(lastRun)).run.status).toBe("done");
    } finally {
      await t.cleanup();
    }
  });
});
