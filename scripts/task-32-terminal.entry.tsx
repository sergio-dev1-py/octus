/** Entrada QA de la terminal Todo 32 (solo verificación, no producto).
 * Se compila con vite + vite-plugin-solid en scripts/qa-task-32-surface.mjs y se abre
 * en Chromium real. Monta la vista REAL TerminalPanel con un puente window.octus
 * contra el harness HTTP (servicio TerminalService REAL con node-pty; solo el
 * transporte IPC está puenteado, rotulado con el badge #term-sim-badge).
 * No se importa desde App ni desde ningún módulo de producto. */
import { render } from "solid-js/web";
import { TerminalPanel } from "../apps/desktop/src/renderer/src/views/terminal-panel.jsx";
import "../apps/desktop/src/renderer/src/design/tokens.css";
import "../apps/desktop/src/renderer/src/components/oc-components.css";
import "../apps/desktop/src/renderer/src/styles.css";

type Chunk = { id: string; seq: number; data: string };

async function call(channel: string, payload: Record<string, unknown>): Promise<never> {
  const res = await fetch("/api/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel, payload }),
  });
  if (!res.ok) throw new Error(`puente QA ${channel}: http ${res.status}`);
  const body = (await res.json()) as { ok: boolean; data?: unknown; error?: string };
  if (!body.ok) throw new Error(body.error ?? `puente QA ${channel} falló`);
  return body.data as never;
}

let pollSince = 0;
let pollActive = true;
async function pollLoop(handlers: Array<(c: Chunk) => void>): Promise<void> {
  while (pollActive) {
    try {
      const res = await fetch(`/api/poll?since=${pollSince}`);
      if (res.ok) {
        const body = (await res.json()) as { chunks: Chunk[]; next: number };
        pollSince = body.next;
        for (const c of body.chunks) for (const h of handlers) h(c);
      }
    } catch {
      // reintenta: el puente puede reiniciarse entre pasadas
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
const handlers: Array<(c: Chunk) => void> = [];
void pollLoop(handlers);
/** Traza visible por CDP: seqs recibidos por la página (depuración QA). */
(window as unknown as { __termSeen: Array<{ seq: number; preview: string }> }).__termSeen = [];
handlers.push((c) => {
  const seen = (window as unknown as { __termSeen: Array<{ seq: number; preview: string }> }).__termSeen;
  seen.push({ seq: c.seq, preview: c.data.slice(0, 60) });
  if (seen.length > 200) seen.splice(0, seen.length - 200);
});

(window as unknown as { octus: unknown }).octus = {
  invoke: (channel: string, payload: Record<string, unknown>) => call(channel, payload),
  onEvent: () => () => {},
  onTerminalData: (handler: (c: Chunk) => void) => {
    handlers.push(handler);
    return () => {
      const i = handlers.indexOf(handler);
      if (i >= 0) handlers.splice(i, 1);
    };
  },
};

const params = new URLSearchParams(window.location.search);
const projectId = params.get("project") ?? "prj_qa";

const root = document.getElementById("oc-qa-root");
if (!root) throw new Error("missing #oc-qa-root");
const badge = document.createElement("p");
badge.id = "term-sim-badge";
badge.textContent = "PUENTE QA Todo 32 — servicio PTY real, solo el transporte IPC está puenteado";
document.body.prepend(badge);
render(() => <TerminalPanel projectId={projectId} projectRoot="C:\\tmp\\octus-qa-32" />, root);
