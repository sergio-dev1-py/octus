/**
 * Octus desktop — política de seguridad del proceso main (Todo 35, auditoría Electron).
 *
 * Funciones puras (sin Electron) para que el script de auditoría
 * `scripts/verify-task-35-security.ts` las afirme sin GUI:
 *  - navegación permitida dentro de la ventana (solo bundle local o dev server),
 *  - enlaces externos (solo https + http de loopback; jamás file:/data:/blob:/javascript:),
 *  - escaneo de secretos en texto plano (gate de cierre: bloquea el empaquetado).
 */

/** Orígenes de desarrollo: solo loopback. */
const DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** http: solo loopback (previews locales efímeras). */
const LOOPBACK_HTTP_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/;

/**
 * Navegación top-level permitida dentro de la ventana.
 * Solo el bundle empaquetado (file:) o el dev server indicado por
 * ELECTRON_RENDERER_URL (origen exacto, loopback en la práctica).
 */
export function isAllowedNavigationUrl(url: string, devServerUrl?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "file:") return true;
  if (devServerUrl) {
    try {
      const dev = new URL(devServerUrl);
      if (parsed.origin === dev.origin && DEV_ORIGIN_RE.test(dev.origin)) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Acción para un enlace externo (window.open / target=_blank / clic externo). */
export type ExternalLinkAction = "deny" | "open-external";

/**
 * Solo https: general y http: de loopback (previews). Todo lo demás
 * (file:, data:, blob:, javascript:, protocolos a medida) se deniega:
 * jamás se entrega una URL arbitraria al SO sin validarla.
 */
export function decideExternalLink(url: string): ExternalLinkAction {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "deny";
  }
  if (parsed.protocol === "https:") return "open-external";
  if (parsed.protocol === "http:" && LOOPBACK_HTTP_RE.test(url)) return "open-external";
  return "deny";
}

/** Patrones de material secreto en texto plano (asignaciones, tokens, PEM). */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "assigned-api-key", re: /(api[-_ ]?key|apikey)\s*[:=]\s*["'][^"']{8,}["']/i },
  { name: "assigned-secret", re: /(client[-_ ]?secret|app[-_ ]?secret)\s*[:=]\s*["'][^"']{8,}["']/i },
  { name: "assigned-token", re: /(auth[-_ ]?token|access[-_ ]?token|bearer)\s*[:=]\s*["'][^"']{8,}["']/i },
  { name: "assigned-password", re: /(password|passwd|pwd)\s*[:=]\s*["'][^"']{8,}["']/i },
  { name: "bearer-header", re: /Bearer\s+[A-Za-z0-9\-._~+/=]{16,}/ },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { name: "github-token", re: /\b(ghp|gho|github_pat)_[A-Za-z0-9]{16,}/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{16,}/ },
  { name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private-key-block", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "connection-string", re: /(mongodb(\+srv)?|postgres(ql)?|mysql|redis):\/\/[^/\s:]+:[^/\s@]+@/i },
];

/** Rutas que el escaneo jamás recorre (ruido, no código auditado). */
const SCAN_SKIP_DIRS = new Set(["node_modules", ".git", "out", "dist", ".turbo", "coverage"]);

export interface SecretFinding {
  file: string;
  line: number;
  pattern: string;
}

function isSkippedPath(relPath: string): boolean {
  return relPath.split("/").some((part) => SCAN_SKIP_DIRS.has(part));
}

/**
 * Escanea un texto como dato (nunca se ejecuta): devuelve hallazgos de
 * secretos en plano. Los patrones solo describen material secreto real;
 * los identificadores del código (secretRef, secret_ref, redactSecrets)
 * no coinciden porque exigen asignación con valor citado o forma de token.
 */
export function scanTextForSecrets(relPath: string, text: string): SecretFinding[] {
  if (isSkippedPath(relPath)) return [];
  const findings: SecretFinding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(line)) findings.push({ file: relPath, line: i + 1, pattern: name });
    }
  }
  return findings;
}

/**
 * Un valor de secrets.json debe ser un blob cifrado (base64 sin espacios).
 * El texto plano (frases, sk-*, Bearer, PEM) se rechaza: fail-closed.
 */
export function looksLikePlaintextSecretValue(value: string): boolean {
  if (value.length === 0) return true;
  if (/\s/.test(value)) return true;
  if (!/^[A-Za-z0-9+/=]+$/.test(value)) return true;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    if (/^(sk-|ghp_|gho_|xox|Bearer |-----BEGIN |mongodb:\/\/|postgres:\/\/)/.test(decoded)) return true;
    if (decoded.length >= 8 && /^[\x20-\x7e]+$/.test(decoded) && /[a-z]/.test(decoded)) return true;
  } catch {
    return true;
  }
  return false;
}
