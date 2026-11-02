/** Entrada QA del MCP Manager Todo 30 (solo verificación, no producto).
 * Se compila con vite + vite-plugin-solid en scripts/qa-task-30.mjs y se abre
 * en Chromium real. Monta la vista REAL McpManagerView con un McpClient fetch
 * contra el puente HTTP del harness (datos simulados SOLO aquí, rotulados con
 * el badge #mcp-sim-badge; la vista de producto no incluye mocks).
 * No se importa desde App ni desde ningún módulo de producto. */
import { render } from "solid-js/web";
import { McpManagerView } from "../apps/desktop/src/renderer/src/views/mcp.jsx";
import { setMcpClient, type McpClient } from "../apps/desktop/src/renderer/src/store/mcp.js";
import "../apps/desktop/src/renderer/src/design/tokens.css";
import "../apps/desktop/src/renderer/src/components/oc-components.css";
import "../apps/desktop/src/renderer/src/styles.css";

async function call<T>(op: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`puente QA ${op}: http ${res.status}`);
  const body = (await res.json()) as { ok: boolean; data?: T; error?: string };
  if (!body.ok) throw new Error(body.error ?? `puente QA ${op} falló`);
  return body.data as T;
}

const fetchClient: McpClient = {
  list: (projectId) => call("list", { projectId }),
  add: (input) => call("add", { ...input }),
  importJson: (jsonText) => call("import", { jsonText }),
  update: (id, patch) => call("update", { id, ...patch }),
  remove: (id) => call("remove", { id }),
  verify: (id, projectId) => call("verify", { id, projectId }),
  connect: (id, projectId) => call("connect", { id, projectId }),
  disconnect: (id, projectId) => call("disconnect", { id, projectId }),
  retry: (id, projectId) => call("retry", { id, projectId }),
  setTrust: (id, scope, trusted, projectId) => call("setTrust", { id, scope, trusted, projectId }),
  setSecret: (id, token) => call("setSecret", { id, token }),
  tools: (id, projectId) => call("tools", { id, projectId }),
  resources: (id) => call("resources", { id }),
  prompts: (id) => call("prompts", { id }),
  audit: (id) => call("audit", { id }),
};

setMcpClient(fetchClient);

const params = new URLSearchParams(window.location.search);
const projectId = params.get("project") ?? "prj_qa";

const root = document.getElementById("oc-qa-root");
if (!root) throw new Error("missing #oc-qa-root");
const badge = document.createElement("p");
badge.id = "mcp-sim-badge";
badge.textContent = "SIMULADO — harness QA Todo 30, sin servidores reales";
document.body.prepend(badge);
render(() => <McpManagerView projectId={projectId} />, root);
