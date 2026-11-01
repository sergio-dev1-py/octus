/** Entrada QA Todo 24 (solo verificación, no producto).
    Monta la SkillsManagerView + SkillsContextPanel REALES con un puente
    `window.octus` con estado (los datos imitan la forma real del servicio:
    qa-skill@1.0.0 instalada+habilitada, old-helper instalada pero
    deshabilitada, broken-skill con error C3). Compilada con vite +
    vite-plugin-solid en scripts/qa-task-24.mjs. Nadie la importa en producto. */
import { render } from "solid-js/web";
import { SkillsContextPanel, SkillsManagerView } from "../apps/desktop/src/renderer/src/views/skills.jsx";
import { setState } from "../apps/desktop/src/renderer/src/store.js";
import { refreshSkillsCatalog } from "../apps/desktop/src/renderer/src/store/skills.js";
import "../apps/desktop/src/renderer/src/styles.css";

type Row = {
  id: string;
  name: string;
  description: string;
  version?: string;
  origin: "global" | "project" | "managed";
  scope: "global" | "project" | "managed";
  path: string;
  installed: boolean;
  enabled: boolean;
  errors: string[];
  seenIn: Array<{ scope: "global" | "project" | "managed"; path: string }>;
  provenance: unknown;
  compatibility?: string;
  allowedTools?: string;
};

const rows: Row[] = [
  {
    id: "qa-skill",
    name: "qa-skill",
    description: "Skill de QA para verificar el manager con datos fijos.",
    version: "1.0.0",
    origin: "project",
    scope: "project",
    path: "C:\\tmp\\qa-skill",
    installed: true,
    enabled: true,
    errors: [],
    seenIn: [{ scope: "project", path: "C:\\tmp\\qa-skill" }],
    provenance: { kind: "folder", sourcePath: "C:\\tmp\\qa-skill" },
    compatibility: "octus >= 0.1",
    allowedTools: "shell.exec",
  },
  {
    id: "old-helper",
    name: "old-helper",
    description: "Ayudante anterior, instalada pero deshabilitada.",
    version: "0.2.0",
    origin: "global",
    scope: "global",
    path: "C:\\tmp\\old-helper",
    installed: true,
    enabled: false,
    errors: [],
    seenIn: [{ scope: "global", path: "C:\\tmp\\old-helper" }],
    provenance: { kind: "zip", sourcePath: "C:\\tmp\\old-helper.zip" },
  },
];
const catalogErrors = [
  { path: "C:\\tmp\\broken-skill", scope: "project", clause: "C3", message: "C3: `name` ausente o vacio" },
];

const details: Record<string, { frontmatterText: string; body: string; files: string[] }> = {
  "qa-skill": {
    frontmatterText: "name: qa-skill\ndescription: Skill de QA para verificar el manager con datos fijos.",
    body: "Usa esta skill cuando la tarea mencione qa-skill o verificación del manager.",
    files: ["SKILL.md", "docs/uso.md"],
  },
  "old-helper": {
    frontmatterText: "name: old-helper\ndescription: Ayudante anterior, instalada pero deshabilitada.",
    body: "Ayuda antigua.",
    files: ["SKILL.md"],
  },
};

const calls: string[] = (window as unknown as { __qaCalls?: string[] }).__qaCalls ?? [];
(window as unknown as { __qaCalls?: string[] }).__qaCalls = calls;

async function invoke(channel: string, payload: Record<string, unknown>): Promise<unknown> {
  calls.push(`${channel} ${JSON.stringify(payload)}`);
  switch (channel) {
    case "skills.catalog":
      return { skills: rows.map((r) => ({ ...r })), errors: catalogErrors.map((e) => ({ ...e })) };
    case "skills.inspect": {
      const row = rows.find((r) => r.name === payload["name"]);
      if (!row) throw new Error(`skill no instalada ni descubierta: ${String(payload["name"])}`);
      const extra = details[row.name] ?? { frontmatterText: "", body: "", files: [] as string[] };
      return { detail: { ...row, ...extra } };
    }
    case "skills.enable": {
      const row = rows.find((r) => r.name === payload["name"]);
      if (!row) return { ok: false, error: "skill no instalada ni descubierta" };
      if (catalogErrors.some((e) => e.path.endsWith(`\\${row.name}`))) return { ok: false, error: "C3: `name` ausente o vacio" };
      row.enabled = true;
      if (payload["scope"]) row.scope = payload["scope"] as Row["scope"];
      return { ok: true };
    }
    case "skills.disable": {
      const row = rows.find((r) => r.name === payload["name"]);
      if (row) row.enabled = false;
      return { ok: true };
    }
    case "skills.setScope": {
      const row = rows.find((r) => r.name === payload["name"]);
      if (row) row.scope = payload["scope"] as Row["scope"];
      return { ok: true };
    }
    case "skills.uninstall": {
      const i = rows.findIndex((r) => r.name === payload["name"]);
      if (i < 0) return { ok: false, error: "skill no instalada" };
      rows.splice(i, 1);
      return { ok: true };
    }
    case "skills.importFolder": {
      const p = String(payload["path"] ?? "");
      if (rows.some((r) => r.name === "qa-imported")) return { ok: false, error: "skill duplicada: qa-imported (ya instalada, desinstale primero)" };
      const row: Row = {
        id: "qa-imported",
        name: "qa-imported",
        description: "Importada desde carpeta en QA.",
        version: "0.1.0",
        origin: "project",
        scope: "project",
        path: p,
        installed: true,
        enabled: false,
        errors: [],
        seenIn: [{ scope: "project", path: p }],
        provenance: { kind: "folder", sourcePath: p },
      };
      rows.push(row);
      details["qa-imported"] = { frontmatterText: "name: qa-imported", body: "Importada.", files: ["SKILL.md"] };
      return { ok: true, skill: { ...row } };
    }
    case "skills.importZip":
      return { ok: false, error: "zip rechazado: falta qa-zip/SKILL.md" };
    case "skills.installGit":
      return { ok: false, error: "instalación git sin descarga: aporte sourceDir" };
    case "skills.history":
      return payload["runId"] === "run_qa01"
        ? { skills: ["qa-skill"], bypass: [] }
        : { skills: [], bypass: [] };
    case "skills.resource":
      return payload["relativePath"] === "docs/uso.md"
        ? { ok: true, content: "# Uso\nLee esto bajo demanda.\n" }
        : { ok: false, error: "recurso inexistente" };
    case "app.pickDirectory":
      return { path: "C:\\tmp\\qa-imported" };
    default:
      throw new Error(`canal QA no soportado: ${channel}`);
  }
}

(window as unknown as { octus?: unknown }).octus = {
  invoke,
  onEvent: () => () => {},
};

// Proyecto activo para que habilitar/deshabilitar llamen al puente.
// La app real puebla el catálogo en initStore → reloadStage2; aquí se
// dispara el mismo refresh inicial del store (misma ruta de código).
setState("activeProjectId", "prj_qa");
await refreshSkillsCatalog();

const root = document.getElementById("oc-qa-root");
if (!root) throw new Error("missing #oc-qa-root");
render(() => (
  <>
    <SkillsManagerView />
    <SkillsContextPanel />
  </>
), root);
