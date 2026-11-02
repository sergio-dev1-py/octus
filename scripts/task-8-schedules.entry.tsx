/** Entrada QA del todo 8 (solo verificación, no producto).
 * Se compila con vite + vite-plugin-solid en scripts/qa-task-8-schedules.mjs
 * y se abre en Chromium real. No se importa desde App ni desde el workbench. */
import { render } from "solid-js/web";
import { SchedulesSection } from "../apps/desktop/src/renderer/src/views/schedules.jsx";
import { openSchedulesModal } from "../apps/desktop/src/renderer/src/store/schedules.js";
import "../apps/desktop/src/renderer/src/design/tokens.css";
import "../apps/desktop/src/renderer/src/design/components.css";
import "../apps/desktop/src/renderer/src/styles.css";

const NOW = Date.now();
const schedules = [
  {
    id: "sch-manana",
    name: "Resumen de mañana",
    prompt: "Resume el estado del proyecto.",
    profile: "build",
    cron: "0 9 * * 1-5",
    timezone: "local",
    enabled: true,
    consecutiveFailures: 0,
    nextRunAt: NOW + 3_600_000,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 3_600_000,
  },
  {
    id: "sch-noche",
    name: "Vigía nocturno",
    prompt: "Revisa errores del día.",
    profile: "plan",
    cron: "30 23 * * *",
    timezone: "Europe/Madrid",
    enabled: false,
    consecutiveFailures: 2,
    lastStatus: "failed",
    nextRunAt: 0,
    createdAt: NOW - 172_800_000,
    updatedAt: NOW - 7_200_000,
  },
];
const runs = [
  { id: "run-1", taskId: "sch-manana", sessionId: "sess-abcdef01", status: "fired", scheduledAt: NOW - 86_400_000, firedAt: NOW - 86_400_000 + 5_000, createdAt: NOW - 86_400_000 },
  { id: "run-2", taskId: "sch-manana", status: "skipped_overlap", scheduledAt: NOW - 82_800_000, firedAt: NOW - 82_800_000, createdAt: NOW - 82_800_000 },
];

const calls: Array<{ channel: string; payload: unknown }> = [];
(window as unknown as { __qaCalls: unknown }).__qaCalls = calls;
(window as unknown as { octus: unknown }).octus = {
  invoke: async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === "schedules.list") return { schedules: schedules.filter((s) => !(window as unknown as { __qaGone?: boolean }).__qaGone || s.id !== "sch-noche") };
    if (channel === "schedules.runs") return { runs: (payload as { taskId: string }).taskId === "sch-manana" ? runs : [] };
    if (channel === "schedules.create") {
      const p = payload as { name: string; cron: string };
      if (p.cron === "mal") return { ok: false, error: "boom" };
      return { ok: true, schedule: { ...schedules[0], id: "sch-new", name: p.name, cron: p.cron } };
    }
    if (channel === "schedules.remove") {
      (window as unknown as { __qaGone?: boolean }).__qaGone = true;
      return { ok: true };
    }
    return { ok: true };
  },
  onEvent: () => () => {},
};

const root = document.getElementById("oc-qa-root");
if (!root) throw new Error("missing #oc-qa-root");
render(() => (
  <div style={{ "max-width": "560px", padding: "16px" }}>
    <SchedulesSection />
  </div>
), root);

// El modal arranca abierto para la captura: la sección ya pinta la lista detrás.
openSchedulesModal();
