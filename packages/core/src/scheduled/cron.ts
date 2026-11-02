/**
 * @octus/core — cron de 5 campos para tareas programadas (minuto hora dom mes dow).
 * Puro y sin dependencias: validación estricta + próxima ocurrencia.
 * Sin segundos ni alias; la zona se resuelve en hora local o IANA válida.
 */
import { OctusError } from "../errors.js";

const FIELD_SPECS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

const ITEM_PATTERN = /^(\*|\d+|\d+-\d+)(\/\d+)?$/;
/** Un año bisiesto de minutos: tope de búsqueda (evita bucles ante saltos de reloj). */
const MAX_SCAN_MINUTES = 366 * 24 * 60;

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** true cuando el campo es `*` exacto (día: decide la semántica OR/AND). */
  domUnrestricted: boolean;
  dowUnrestricted: boolean;
}

function error(reason: string): OctusError {
  return new OctusError("invalid_cron", reason);
}

function parseField(field: string, min: number, max: number, name: string): { values: Set<number>; unrestricted: boolean } {
  if (field.length === 0) throw error(`cron: empty ${name} field`);
  const values = new Set<number>();
  const unrestricted = field === "*";
  for (const raw of field.split(",")) {
    const item = raw.trim();
    const match = ITEM_PATTERN.exec(item);
    if (!match) throw error(`cron: invalid ${name} item '${item}'`);
    const base = match[1]!;
    const stepText = match[2];
    let step = 1;
    if (stepText !== undefined) {
      step = Number(stepText.slice(1));
      if (!Number.isInteger(step) || step < 1) throw error(`cron: invalid ${name} step '${item}'`);
    }
    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = min;
      hi = max;
    } else if (base.includes("-")) {
      const [aText, bText] = base.split("-") as [string, string];
      lo = Number(aText);
      hi = Number(bText);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
        throw error(`cron: invalid ${name} range '${item}'`);
      }
    } else {
      lo = Number(base);
      hi = max;
      if (!Number.isInteger(lo) || lo < min || lo > max) throw error(`cron: invalid ${name} value '${item}'`);
      if (stepText === undefined) hi = lo;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (values.size === 0) throw error(`cron: empty ${name} field`);
  return { values, unrestricted };
}

/** Valida la sintaxis (5 campos) y devuelve los conjuntos; rechaza lo demás. */
export function parseCron(expr: string): ParsedCron {
  if (typeof expr !== "string" || expr.trim().length === 0) throw error("cron: expression is required");
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw error(`cron: expected 5 fields, got ${fields.length}`);
  const [minute, hour, dom, month, dow] = fields.map((field, i) => parseField(field, FIELD_SPECS[i]!.min, FIELD_SPECS[i]!.max, FIELD_SPECS[i]!.name));
  // dow admite 7 como domingo; se normaliza a 0.
  const dowValues = new Set<number>();
  for (const v of dow!.values) dowValues.add(v === 7 ? 0 : v);
  return {
    minute: minute!.values,
    hour: hour!.values,
    dom: dom!.values,
    month: month!.values,
    dow: dowValues,
    domUnrestricted: dom!.unrestricted,
    dowUnrestricted: dow!.unrestricted,
  };
}

/** true si el cron es sintácticamente válido (no garantiza ocurrencia futura). */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

export interface ZoneParts {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number;
}

function localParts(ms: number): ZoneParts {
  const d = new Date(ms);
  return { minute: d.getMinutes(), hour: d.getHours(), dom: d.getDate(), month: d.getMonth() + 1, dow: d.getDay() };
}

function zoneFormatter(timezone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
  } catch {
    throw new OctusError("invalid_cron", `cron: unknown timezone '${timezone}'`);
  }
}

function zonedParts(ms: number, fmt: Intl.DateTimeFormat): ZoneParts {
  const bag: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type !== "literal") bag[part.type] = Number(part.value);
  }
  const dow = new Date(Date.UTC(bag.year!, bag.month! - 1, bag.day!)).getUTCDay();
  return { minute: bag.minute!, hour: bag.hour!, dom: bag.day!, month: bag.month!, dow };
}

function matches(parsed: ParsedCron, p: ZoneParts): boolean {
  if (!parsed.minute.has(p.minute) || !parsed.hour.has(p.hour) || !parsed.month.has(p.month)) return false;
  // Semántica cron clásica: con ambos días restringidos basta uno (OR);
  // con uno libre manda el otro.
  if (parsed.domUnrestricted) return parsed.dow.has(p.dow);
  if (parsed.dowUnrestricted) return parsed.dom.has(p.dom);
  return parsed.dom.has(p.dom) || parsed.dow.has(p.dow);
}

/**
 * Próxima ocurrencia estrictamente posterior a `fromMs`, en ms epoch.
 * `timezone` es 'local' o una zona IANA; los saltos DST/reloj no lanzan:
 * la hora inexistente simplemente no empareja y se avanza al día siguiente.
 * Devuelve null si no hay ocurrencia dentro de un año (p. ej. 30 de febrero).
 */
export function nextCronRun(expr: string, fromMs: number, timezone = "local"): number | null {
  const parsed = parseCron(expr);
  const tz = timezone.trim() === "" ? "local" : timezone;
  const fmt = tz === "local" ? undefined : zoneFormatter(tz);
  const at = (ms: number): ZoneParts => (fmt ? zonedParts(ms, fmt) : localParts(ms));
  // Límite del próximo minuto estrictamente posterior a fromMs.
  let candidate = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < MAX_SCAN_MINUTES; i++, candidate += 60_000) {
    if (matches(parsed, at(candidate))) return candidate;
  }
  return null;
}
