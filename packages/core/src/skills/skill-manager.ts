/**
 * @octus/core — SkillManager: descubrimiento de Skills en tres ámbitos (Todo 20).
 *
 * Ámbitos: `global` (usuario), `project` (proyecto) y `managed` (gestionado por Octus).
 * Precedencia ante duplicados: project > global > managed (gana el más específico;
 * el registro guarda una sola entrada por `name` con la lista `seenIn` completa).
 *
 * Validación: réplica exacta de las cláusulas C1..C8 fijadas en el Todo 18
 * (scripts/validate-agent-skill.mjs, fuente https://agentskills.io/specification.md).
 * No inventa formato propietario: `version` se lee de `metadata.version` (Todo 18).
 *
 * Garantías:
 * - Al descubrir NUNCA se ejecuta nada dentro del directorio de la skill: solo se
 *   lee `<dir>/SKILL.md`. Sin spawn, sin import dinámico, sin eval.
 * - `discover()` reconstruye el registro desde cero: es idempotente, no duplica
 *   ni acumula cargas múltiples (re-descubrir no añade entradas).
 * - Los directorios sin SKILL.md o con frontmatter inválido se registran como
 *   ERRORES visibles (`errors()`), nunca como skills.
 * - No añade capas de permisos (brechas 19-A..D del Todo 19 intactas): `allowedTools`
 *   se guarda como dato descriptivo, sin efecto sobre PermissionManager. El filtrado
 *   por scopes para workers es Todo 23; la persistencia, Todo 22 (registro en memoria).
 *
 * Patrón seguido: AgentRegistry (registro con upsert/list/get) sobre datos en memoria
 * en vez de SQLite, porque la persistencia llega en el Todo 22.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type SkillScope = "global" | "project" | "managed";

export const SKILL_SCOPE_PRECEDENCE: readonly SkillScope[] = ["managed", "global", "project"];

export interface SkillSeenIn {
  scope: SkillScope;
  path: string;
}

export interface SkillRecord {
  /** Identificador único del registro: coincide con `name` (C4: name == directorio). */
  id: string;
  name: string;
  description: string;
  /** Ámbito ganador tras aplicar precedencia project > global > managed. */
  origin: SkillScope;
  /** Ruta del directorio de la skill ganadora. */
  path: string;
  /** Alcance aplicable (en este Todo coincide con `origin`; Todo 22/23 lo administran). */
  scope: SkillScope;
  /** De `metadata.version` (la spec no tiene campo version propio; ver Todo 18). */
  version?: string;
  /** Activación: el descubrimiento registra con `false`; la administra el Todo 22. */
  enabled: boolean;
  compatibility?: string;
  /** Dato descriptivo copiado de `allowed-tools`; SIN efecto en permisos (Todo 19). */
  allowedTools?: string;
  /** Avisos no fatales (p. ej. "también vista en global, gana project"). */
  errors: string[];
  /** Todos los ámbitos donde se encontró este `name`, en orden de precedencia. */
  seenIn: SkillSeenIn[];
}

export interface SkillDiscoveryError {
  path: string;
  scope: SkillScope;
  /** Cláusula C1..C8 del Todo 18 que la rechaza. */
  clause: string;
  message: string;
}

export interface SkillDiscoveryOptions {
  globalDir?: string;
  projectDir?: string;
  managedDir?: string;
}

export interface SkillDiscoveryResult {
  skills: SkillRecord[];
  errors: SkillDiscoveryError[];
}

interface ParsedFrontmatter {
  data: Record<string, unknown>;
}

function parseFrontmatter(text: string): { data?: Record<string, unknown>; error?: string } {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { error: "C2: falta apertura `---`" };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---" || lines[i]!.trim() === "...") {
      end = i;
      break;
    }
  }
  if (end === -1) return { error: "C2: falta cierre `---`" };
  const data: Record<string, unknown> = {};
  let parent: string | null = null;
  for (const line of lines.slice(1, end)) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const nested = line.match(/^  ([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nested && parent) {
      (data[parent] as Record<string, string>)[nested[1]!] = unquote(nested[2]!.trim());
      continue;
    }
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!top) return { error: `C2: linea no es par clave: valor: ${JSON.stringify(line)}` };
    const [, key, rest] = top as unknown as [string, string, string];
    if (rest === "") {
      data[key!] = {};
      parent = key!;
    } else {
      data[key!] = unquote(rest.trim());
      parent = null;
    }
  }
  return { data };
}

function unquote(s: string): string {
  const m = s.match(/^(['"])(.*)\1$/s);
  return m ? m[2]! : s;
}

function checkName(name: unknown, dirName: string): string | null {
  if (typeof name !== "string" || name.length === 0) return "C3: `name` ausente o vacio";
  if (name.length > 64) return `C3: \`name\` de ${name.length} chars (>64)`;
  if (!/^[a-z0-9-]+$/.test(name)) return `C3: \`name\` con caracteres fuera de [a-z0-9-]: ${JSON.stringify(name)}`;
  if (name.startsWith("-") || name.endsWith("-")) return "C3: `name` empieza o termina con `-`";
  if (name.includes("--")) return "C3: `name` con `--` consecutivos";
  if (name !== dirName) return `C4: \`name\`=${JSON.stringify(name)} != directorio ${JSON.stringify(dirName)}`;
  return null;
}

/** Valida un directorio candidato SIN ejecutar nada: solo lee SKILL.md. */
export function validateSkillDir(skillDir: string): { record?: Omit<SkillRecord, "origin" | "scope" | "path" | "enabled" | "errors" | "seenIn">; error?: string } {
  let st;
  try {
    st = statSync(skillDir);
  } catch {
    return { error: `C1: directorio inexistente: ${skillDir}` };
  }
  if (!st.isDirectory()) return { error: `C1: no es un directorio: ${skillDir}` };
  const skillFile = path.join(skillDir, "SKILL.md");
  let text: string;
  try {
    text = readFileSync(skillFile, "utf8");
  } catch {
    return { error: "C1: falta SKILL.md en el directorio" };
  }
  const parsed = parseFrontmatter(text);
  if (parsed.error) return { error: parsed.error };
  const data = parsed.data!;

  const nameProblem = checkName(data["name"], path.basename(path.resolve(skillDir)));
  if (nameProblem) return { error: nameProblem };

  const desc = data["description"];
  if (typeof desc !== "string" || desc.length === 0) return { error: "C5: `description` ausente o vacia" };
  if (desc.length > 1024) return { error: `C5: \`description\` de ${desc.length} chars (>1024)` };

  const out: Omit<SkillRecord, "origin" | "scope" | "path" | "enabled" | "errors" | "seenIn"> & { id: string; name: string; description: string } = {
    id: data["name"] as string,
    name: data["name"] as string,
    description: desc,
  };
  if (data["compatibility"] !== undefined) {
    if (typeof data["compatibility"] !== "string" || data["compatibility"].length === 0) return { error: "C6: `compatibility` vacia" };
    if ((data["compatibility"] as string).length > 500) return { error: `C6: \`compatibility\` de ${(data["compatibility"] as string).length} chars (>500)` };
    out.compatibility = data["compatibility"] as string;
  }
  let version: string | undefined;
  if (data["metadata"] !== undefined) {
    if (typeof data["metadata"] !== "object" || data["metadata"] === null || Array.isArray(data["metadata"])) return { error: "C7: `metadata` no es un mapa" };
    for (const [k, v] of Object.entries(data["metadata"] as Record<string, unknown>)) {
      if (typeof v !== "string") return { error: `C7: \`metadata.${k}\` no es cadena` };
    }
    const meta = data["metadata"] as Record<string, string>;
    if (meta["version"] !== undefined) version = meta["version"];
  }
  if (version !== undefined) out.version = version;
  if (data["allowed-tools"] !== undefined) {
    if (typeof data["allowed-tools"] !== "string") return { error: "C8: `allowed-tools` no es cadena" };
    out.allowedTools = data["allowed-tools"] as string;
  }
  return { record: out };
}

export class SkillManager {
  private readonly defaultDirs: SkillDiscoveryOptions;
  private records = new Map<string, SkillRecord>();
  private lastErrors: SkillDiscoveryError[] = [];
  /** Lecturas de SKILL.md por llamada a discover (detector de cargas múltiples). */
  private lastReadCount = 0;

  constructor(defaultDirs: SkillDiscoveryOptions = {}) {
    this.defaultDirs = { ...defaultDirs };
  }

  /**
   * Descubre skills en los tres ámbitos y reconstruye el registro desde cero
   * (idempotente: dos llamadas no duplican). Solo lee SKILL.md; nunca ejecuta.
   */
  discover(options: SkillDiscoveryOptions = {}): SkillDiscoveryResult {
    const dirs: Array<{ scope: SkillScope; dir: string | undefined }> = [
      { scope: "global", dir: options.globalDir ?? this.defaultDirs.globalDir },
      { scope: "project", dir: options.projectDir ?? this.defaultDirs.projectDir },
      { scope: "managed", dir: options.managedDir ?? this.defaultDirs.managedDir },
    ];
    const found = new Map<string, Array<{ scope: SkillScope; path: string; record: SkillRecord }>>();
    const errors: SkillDiscoveryError[] = [];
    let reads = 0;

    for (const { scope, dir } of dirs) {
      if (!dir) continue;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue; // Ámbito ausente: no es error, simplemente no aporta skills.
      }
      for (const entry of entries.sort()) {
        const candidate = path.join(dir, entry);
        let st;
        try {
          st = statSync(candidate);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue; // Solo subdirectorios son candidatos (C1).
        reads++;
        const validated = validateSkillDir(candidate);
        if (!validated.record) {
          const clause = validated.error!.slice(0, 2);
          errors.push({ path: candidate, scope, clause, message: validated.error! });
          continue;
        }
        const r = validated.record;
        const list = found.get(r.name) ?? [];
        list.push({
          scope,
          path: candidate,
          record: {
            id: r.id,
            name: r.name,
            description: r.description,
            origin: scope,
            path: candidate,
            scope,
            ...(r.version !== undefined ? { version: r.version } : {}),
            enabled: false,
            ...(r.compatibility !== undefined ? { compatibility: r.compatibility } : {}),
            ...(r.allowedTools !== undefined ? { allowedTools: r.allowedTools } : {}),
            errors: [],
            seenIn: [],
          },
        });
        found.set(r.name, list);
      }
    }

    // Deduplicación por `name` con precedencia project > global > managed.
    const rank = (s: SkillScope): number => SKILL_SCOPE_PRECEDENCE.indexOf(s);
    const records = new Map<string, SkillRecord>();
    for (const [name, occurrences] of [...found.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const ordered = [...occurrences].sort((x, y) => rank(y.scope) - rank(x.scope));
      const winner = ordered[0]!.record;
      winner.seenIn = ordered.map((o) => ({ scope: o.scope, path: o.path }));
      if (ordered.length > 1) {
        const others = ordered
          .slice(1)
          .map((o) => `${o.scope} (${o.path})`)
          .join(", ");
        winner.errors.push(`duplicada en ${others}: gana ${winner.scope} por precedencia project > global > managed`);
      }
      records.set(name, winner);
    }

    this.records = records;
    this.lastErrors = [...errors].sort((a, b) => (a.path < b.path ? -1 : 1));
    this.lastReadCount = reads;
    return { skills: this.list(), errors: this.errors() };
  }

  list(): SkillRecord[] {
    return [...this.records.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  get(name: string): SkillRecord | undefined {
    return this.records.get(name);
  }

  errors(): SkillDiscoveryError[] {
    return [...this.lastErrors];
  }

  /** Nº de SKILL.md leídos en el último discover (cada candidato se lee una sola vez). */
  readCount(): number {
    return this.lastReadCount;
  }
}
