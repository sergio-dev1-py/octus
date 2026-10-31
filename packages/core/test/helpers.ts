/** Ayudantes de prueba: núcleos efímeros con proveedores falsos. */
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OctusCore } from "../src/sessions/octus-core.js";
import { MemorySecretStore } from "../src/secrets/secret-store.js";
import { FakeProvider, fakeGoModels, fakeMetaModels, type FakeTurn } from "../src/testing/fake-providers.js";

export interface TestCore {
  core: OctusCore;
  dir: string;
  fakeMeta: FakeProvider;
  fakeGo: FakeProvider;
  cleanup: () => Promise<void>;
}

export async function makeTestCore(options?: {
  metaTurns?: FakeTurn[] | ((callIndex: number, input: never) => FakeTurn);
  goTurns?: FakeTurn[] | ((callIndex: number, input: never) => FakeTurn);
  billableFakes?: boolean;
}): Promise<TestCore> {
  const dir = mkdtempSync(path.join(tmpdir(), "octus-test-"));
  const workspace = path.join(dir, "workspace");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(workspace, { recursive: true });
  const fakeMeta = new FakeProvider("fake-meta", "Fake Meta", fakeMetaModels(), {
    turns: (options?.metaTurns ?? [{ text: "hello from fake" }]) as never,
    billable: options?.billableFakes ?? false,
  });
  const fakeGo = new FakeProvider("fake-go", "Fake Go", fakeGoModels(), {
    turns: (options?.goTurns ?? [{ text: "hello from fake go" }]) as never,
    billable: options?.billableFakes ?? false,
  });
  const core = await OctusCore.create({
    dataDir: path.join(dir, "data"),
    primarySecrets: new MemorySecretStore(),
    providers: [fakeMeta, fakeGo],
  });
  return {
    core,
    dir,
    fakeMeta,
    fakeGo,
    cleanup: async () => {
      await core.close();
      // Windows mantiene locks brevemente tras cerrar el worker SQLite; rm asíncrono con reintentos nativos.
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 } as Record<string, unknown> as { recursive: true; force: true });
      } catch (error) {
        // Último recurso: reintento manual espaciado antes de fallar.
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY") {
          await new Promise((r) => setTimeout(r, 1500));
          await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 } as Record<string, unknown> as { recursive: true; force: true });
        } else {
          throw error;
        }
      }
    },
  };
}

/** Rechazo esperado sin `expect().rejects` (retrasa mensajes de workers en Bun 1.4.2). */
export async function expectRejects(promise: Promise<unknown>, match?: RegExp | string): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (match !== undefined) {
      const text = `${err.name}: ${err.message}`;
      if (match instanceof RegExp) {
        if (!match.test(text)) throw new Error(`Expected rejection matching ${match}, got: ${text.slice(0, 300)}`);
      } else if (!text.includes(match)) {
        throw new Error(`Expected rejection including "${match}", got: ${text.slice(0, 300)}`);
      }
    }
    return err;
  }
  throw new Error("Expected promise to reject, but it resolved");
}

/** Aprueba automáticamente cada permiso preguntado (flujo once). Devuelve el stop. */
export function autoAllow(core: OctusCore, decision: "once" | "always" | "reject" = "once"): () => void {
  return core.bus.subscribe((event) => {
    if (event.type === "permission.asked") {
      const requestId = (event.payload.requestId as string) ?? core.permissions.pendingFor()[0]?.id;
      if (requestId) core.permissions.reply(requestId, decision);
    }
  });
}

export function workspaceOf(t: TestCore): string {
  return path.join(t.dir, "workspace");
}

/** Crea un run + instancia coordinator-build reales (las tools exigen FK válidas). */
export async function makeRun(t: TestCore, sessionId: string): Promise<{ runId: string; instanceId: string }> {
  const runId = `run_${Math.random().toString(36).slice(2, 10)}`;
  const instanceId = `ins_${Math.random().toString(36).slice(2, 10)}`;
  const session = (await t.core.listSessions()).find((s) => s.id === sessionId)!;
  const def = (await t.core.registry.get("coordinator-build"))!;
  const { promptHashOf, snapshotOf } = await import("../src/agents/definition-loader.js");
  await t.core.db.exec("INSERT INTO runs (id, session_id, prompt, status, mode, created_at, updated_at) VALUES (?, ?, 'test', 'executing', 'build', 1, 1)", [runId, sessionId]);
  await t.core.db.exec(
    "INSERT INTO agent_instances (id, session_id, run_id, definition_id, status, model, directory, definition_version, prompt_hash, definition_snapshot, created_at, updated_at) VALUES (?, ?, ?, 'coordinator-build', 'running', ?, ?, ?, ?, ?, 1, 1)",
    [instanceId, sessionId, runId, JSON.stringify({ providerId: "fake-meta", modelId: "muse-wonder-1.0" }), session.directory, def.promptVersion, promptHashOf(def), JSON.stringify(snapshotOf(def))],
  );
  return { runId, instanceId };
}
