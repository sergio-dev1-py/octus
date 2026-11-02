#!/usr/bin/env bun
/**
 * Todo 18 — Fuente de validación de Skills fijada.
 *
 * Fuente exacta: https://agentskills.io/specification.md
 *   (recuperada 2026-11-01; cabecera Last-Modified: Sat, 31 Oct 2026 18:33:25 GMT;
 *    la pagina no expone dateModified 2026-08-09 como versionado formal).
 * Validador de referencia citado por la spec:
 *   https://github.com/agentskills/agentskills/tree/main/skills-ref
 *   (`skills-ref validate ./my-skill`) — no vendorizado aqui (requiere red);
 *   este script implementa sus mismas clausulas verificables sin inventar formato.
 *
 * Clausulas fijadas (C1..C8), trazables 1:1 a la spec:
 *   C1 Estructura: el skill es un directorio que contiene SKILL.md.
 *   C2 Formato: SKILL.md = frontmatter YAML entre `---` + cuerpo Markdown.
 *   C3 `name` requerido: 1-64 caracteres; solo [a-z0-9-]; sin `-` inicial/final;
 *      sin `--` consecutivos (seccion "`name` field" de la spec).
 *   C4 `name` == nombre del directorio padre (seccion "`name` field").
 *   C5 `description` requerida: no vacia, 1-1024 caracteres
 *      (seccion "`description` field").
 *   C6 `compatibility` opcional: si presente, 1-500 caracteres.
 *   C7 `metadata` opcional: si presente, mapa string->string.
 *   C8 `allowed-tools` opcional: si presente, cadena (lista separada por espacios).
 *   (`license` libre, sin restriccion en la spec.)
 *
 * Uso: bun scripts/validate-agent-skill.mjs <dir-skill> [--json]
 *   exit 0 = valida (PASS), 1 = invalida (FAIL con clausula citada),
 *   2 = error de uso / skill ilegible.
 */
import fs from "node:fs";
import path from "node:path";

const CLAUSES = {
  C1: "estructura: directorio con SKILL.md",
  C2: "formato: frontmatter YAML + cuerpo Markdown",
  C3: "name: 1-64 chars, [a-z0-9-], sin - inicial/final ni -- consecutivos",
  C4: "name == nombre del directorio",
  C5: "description: requerida, no vacia, 1-1024 chars",
  C6: "compatibility: si presente, 1-500 chars",
  C7: "metadata: si presente, mapa string->string",
  C8: "allowed-tools: si presente, cadena separada por espacios",
};

function fail(clause, message) {
  return { ok: false, clause, message: `${clause} [${CLAUSES[clause]}]: ${message}` };
}

// Parser YAML minimo, solo para el subconjunto del frontmatter de la spec:
// escalares `clave: valor` (con o sin comillas) + un nivel de mapa anidado
// (caso `metadata:`). No pretende ser YAML general.
function parseFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { error: "falta apertura `---`" };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---" || lines[i].trim() === "...") { end = i; break; }
  }
  if (end === -1) return { error: "falta cierre `---`" };
  const raw = lines.slice(1, end);
  const data = {};
  let parent = null;
  for (const line of raw) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const nested = line.match(/^  ([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nested && parent) {
      data[parent][nested[1]] = unquote(nested[2].trim());
      continue;
    }
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!top) return { error: `linea no es par clave: valor: ${JSON.stringify(line)}` };
    const [, key, rest] = top;
    if (rest === "") { data[key] = {}; parent = key; }
    else { data[key] = unquote(rest.trim()); parent = null; }
  }
  return { data, body: lines.slice(end + 1).join("\n") };
}

function unquote(s) {
  const m = s.match(/^(['"])(.*)\1$/s);
  return m ? m[2] : s;
}

export function validateSkill(skillDir) {
  let st;
  try {
    st = fs.statSync(skillDir);
  } catch {
    return fail("C1", `directorio inexistente: ${skillDir}`);
  }
  if (!st.isDirectory()) return fail("C1", `no es un directorio: ${skillDir}`);
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillFile)) return fail("C1", "falta SKILL.md en el directorio");
  const text = fs.readFileSync(skillFile, "utf8");
  const parsed = parseFrontmatter(text);
  if (parsed.error) return fail("C2", parsed.error);
  const { data } = parsed;

  const name = data.name;
  if (typeof name !== "string" || name.length === 0)
    return fail("C3", "`name` ausente o vacio");
  if (name.length > 64) return fail("C3", `\`name\` de ${name.length} chars (>64)`);
  if (!/^[a-z0-9-]+$/.test(name))
    return fail("C3", `\`name\` con caracteres fuera de [a-z0-9-]: ${JSON.stringify(name)}`);
  if (name.startsWith("-") || name.endsWith("-"))
    return fail("C3", "`name` empieza o termina con `-`");
  if (name.includes("--")) return fail("C3", "`name` con `--` consecutivos");
  const dirName = path.basename(path.resolve(skillDir));
  if (name !== dirName)
    return fail("C4", `\`name\`=${JSON.stringify(name)} != directorio ${JSON.stringify(dirName)}`);

  const desc = data.description;
  if (typeof desc !== "string" || desc.length === 0)
    return fail("C5", "`description` ausente o vacia");
  if (desc.length > 1024) return fail("C5", `\`description\` de ${desc.length} chars (>1024)`);

  if (data.compatibility !== undefined) {
    if (typeof data.compatibility !== "string" || data.compatibility.length === 0)
      return fail("C6", "`compatibility` vacia");
    if (data.compatibility.length > 500)
      return fail("C6", `\`compatibility\` de ${data.compatibility.length} chars (>500)`);
  }
  if (data.metadata !== undefined) {
    if (typeof data.metadata !== "object" || data.metadata === null || Array.isArray(data.metadata))
      return fail("C7", "`metadata` no es un mapa");
    for (const [k, v] of Object.entries(data.metadata)) {
      if (typeof v !== "string") return fail("C7", `\`metadata.${k}\` no es cadena`);
    }
  }
  if (data["allowed-tools"] !== undefined && typeof data["allowed-tools"] !== "string")
    return fail("C8", "`allowed-tools` no es cadena");
  return { ok: true, name, descriptionLength: desc.length };
}

const args = process.argv.slice(2);
if (import.meta.main) {
  if (args.length === 0 || args[0].startsWith("-")) {
    console.error("Uso: bun scripts/validate-agent-skill.mjs <dir-skill> [--json]");
    process.exit(2);
  } else {
    const asJson = args.includes("--json");
    const res = validateSkill(args[0]);
    if (asJson) console.log(JSON.stringify(res));
    else console.log(res.ok ? `PASS ${res.name} (description ${res.descriptionLength} chars)` : `FAIL ${res.message}`);
    process.exit(res.ok ? 0 : 1);
  }
}
