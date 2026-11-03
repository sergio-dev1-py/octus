/** Fixture del test model-picker (todo 5): monta el ModelPicker REAL con el CSS
 * real. Se compila con el vite + vite-plugin-solid del repo (la misma cadena
 * que produccion) y se maneja en Chromium real via playwright-core.
 * El puente window.octus simula un servidor con estado: sessions.setModel y
 * sessions.setProfile mutan la sesion y sessions.list la devuelve (persistencia
 * por sesion verificable desde el estado del renderer).
 */
import { render } from "solid-js/web";
import { ModelPicker } from "../../src/renderer/src/views/chat.jsx";
import "../../src/renderer/src/styles.css";
import { setState } from "../../src/renderer/src/store.js";
import type { ModelDescriptor, Session } from "@octus/shared";

const effortModel: ModelDescriptor = {
  providerId: "p1",
  modelId: "m-effort",
  displayName: "Modelo con esfuerzo",
  capabilities: {
    toolCall: true,
    reasoningEfforts: ["low", "high"],
    maxContextTokens: 128000,
    maxOutputTokens: 16000,
    supportsImages: false,
  },
};
const plainModel: ModelDescriptor = {
  providerId: "p1",
  modelId: "m-plain",
  displayName: "Modelo simple",
  capabilities: {
    toolCall: true,
    reasoningEfforts: [],
    maxContextTokens: 64000,
    maxOutputTokens: 8000,
    supportsImages: false,
  },
};

const seedSession: Session = {
  id: "s1",
  projectId: "prj1",
  title: "QA picker",
  directory: "/tmp/qa",
  profile: "plan",
  model: { providerId: "p1", modelId: "m-effort" },
  createdAt: 1,
  updatedAt: 1,
};

// Servidor simulado con estado (persiste por sesion).
let serverSessions: Session[] = [structuredClone(seedSession)];
const calls: Array<{ channel: string; payload: unknown }> = [];

(window as unknown as { __calls: unknown }).__calls = calls;
(window as unknown as { octus: unknown }).octus = {
  invoke: async (channel: string, payload: Record<string, any>) => {
    calls.push({ channel, payload });
    if (channel === "sessions.setModel") {
      serverSessions = serverSessions.map((s) =>
        s.id === payload.sessionId ? { ...s, model: payload.model } : s,
      );
      return { ok: true };
    }
    if (channel === "sessions.setProfile") {
      serverSessions = serverSessions.map((s) =>
        s.id === payload.sessionId ? { ...s, profile: payload.profile } : s,
      );
      return { ok: true };
    }
    if (channel === "sessions.list") {
      return { sessions: serverSessions.filter((s) => s.projectId === payload.projectId) };
    }
    if (channel === "providers.models") {
      return { models: [effortModel, plainModel].filter((m) => m.providerId === payload.providerId) };
    }
    if (channel === "providers.list") {
      return {
        providers: [{ id: "p1", displayName: "Proveedor 1", configured: true, models: [effortModel, plainModel] }],
      };
    }
    if (channel === "providers.refreshCatalog") {
      return { ok: true, count: 2 };
    }
    throw new Error(`unexpected channel ${channel}`);
  },
  onEvent: () => () => {},
};

setState("providers", [{ id: "p1", displayName: "Proveedor 1", configured: true, models: [effortModel, plainModel] }]);
// ?nocache=1 ejerce la recarga ante caché ausente (stale_state): el efecto del
// ModelPicker debe pedir providers.models y poblar el picker con el real.
const nocache = new URLSearchParams(location.search).has("nocache");
if (!nocache) setState("modelsByProvider", { p1: [effortModel, plainModel] });
setState("activeProjectId", "prj1");
setState("activeSessionId", "s1");
setState("sessions", [structuredClone(seedSession)]);
setState("busy", false);

render(() => (
  <>
    <div style={{ height: "420px" }} />
    <ModelPicker />
  </>
), document.getElementById("root")!);
