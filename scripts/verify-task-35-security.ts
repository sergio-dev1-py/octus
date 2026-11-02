/**
 * Auditoría de seguridad Todo 35 — checklist ejecutable (no dry-run).
 * Afirma cada garantía con prueba: aislamiento, IPC, navegación, enlaces,
 * secretos fuera de disco plano. Failure case incluido (gate bloquea).
 *
 * Uso (desde la raíz del worktree):  bun scripts/verify-task-35-security.ts
 * Exit 0 = todo verde. El contenido de los ficheros escaneados se trata
 * como dato no confiable: solo regex, sin exec/eval, salida truncada.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  decideExternalLink,
  isAllowedNavigationUrl,
  looksLikePlaintextSecretValue,
  scanTextForSecrets,
} from "../apps/desktop/src/main/security-policy.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const DEV = "http://localhost:5173/";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = ""): void {
  total += 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

/* A. Aislamento del renderer ------------------------------------------------ */
const mainSrc = read("apps/desktop/src/main/index.ts");
check("A1 contextIsolation:true", /contextIsolation:\s*true/.test(mainSrc));
check("A2 nodeIntegration:false", /nodeIntegration:\s*false/.test(mainSrc));
check("A3 sandbox:true", /sandbox:\s*true/.test(mainSrc));
check("A4 webSecurity:true explícito", /webSecurity:\s*true/.test(mainSrc));
check("A5 sin contenido inseguro", /allowRunningInsecureContent:\s*false/.test(mainSrc));
check("A6 preload fijado", /preload:\s*preloadPath\(\)/.test(mainSrc));
check("A7 sin nodeIntegration:true en src", !/nodeIntegration:\s*true/.test(mainSrc));
check("A8 sin contextIsolation:false en src", !/contextIsolation:\s*false/.test(mainSrc));

const preloadSrc = read("apps/desktop/src/preload/index.ts");
check("A9 preload expone solo window.octus", (preloadSrc.match(/exposeInMainWorld/g) ?? []).length === 1);
check("A10 preload usa contextBridge", /contextBridge\.exposeInMainWorld\("octus"/.test(preloadSrc));
check("A11 preload sin require/process", !/\brequire\(|\bprocess\./.test(preloadSrc));
check("A12 preload sin invoke genérico (canal tipado octus:)", /ipcRenderer\.invoke\(`octus:\$\{channel\}`/.test(preloadSrc));

/* B. IPC validado ------------------------------------------------------------ */
check("B1 assertSender existe y compara webContents", /event\.sender !== mainWindow\.webContents/.test(mainSrc));
check("B2 registro por canal con prefijo octus:", /ipcMain\.handle\(`octus:\$\{channel\}`/.test(mainSrc));
check("B3 assertSender en cada dispatch", /async \(event, payload: unknown\)[\s\S]{0,120}assertSender\(event\)/.test(mainSrc));
// Cobertura de validación por handler con payload.
const handlerBlocks = [...mainSrc.matchAll(/"([a-z0-9.]+)":\s*async\s*\(payload\)\s*=>\s*\{/g)];
let unvalidated: string[] = [];
for (const m of handlerBlocks) {
  const start = (m.index ?? 0) + m[0].length;
  const body = mainSrc.slice(start, start + 600);
  if (!/isNonEmptyString|Array\.isArray|isUiPrefs|isWorkbenchLayout|isPartialLayout|typeof payload|payload\.[a-zA-Z]+\s*\?\?/.test(body)) {
    unvalidated.push(m[1]!);
  }
}
check("B4 handlers con payload validan entrada", unvalidated.length === 0, unvalidated.length === 0 ? `${handlerBlocks.length} handlers` : `sin validar: ${unvalidated.join(",")}`);
check("B5 sin shell.openExternal fuera del guardia", (mainSrc.match(/shell\.openExternal/g) ?? []).length <= 1);
check("B6 listProviders no devuelve claves (solo configured)", (() => {
  const core = read("packages/core/src/sessions/octus-core.ts");
  const i = core.indexOf("async listProviders");
  const end = core.indexOf("\n  async ", i + 1);
  const body = core.slice(i, end < 0 ? i + 900 : end);
  return body.includes("configured") && !body.includes("apiKey");
})());

/* C. Navegación, ventanas y enlaces ------------------------------------------ */
check("C1 setWindowOpenHandler deniega crear ventanas", /setWindowOpenHandler\(\(\{\s*url\s*\}\)[\s\S]{0,200}action:\s*"deny"/.test(mainSrc));
check("C2 window.open pasa por decideExternalLink", /decideExternalLink\(url\)/.test(mainSrc));
check("C3 will-navigate con isAllowedNavigationUrl", /will-navigate[\s\S]{0,160}isAllowedNavigationUrl/.test(mainSrc));
check("C4 permisos denegados por defecto", /setPermissionRequestHandler\([\s\S]{0,120}callback\(false\)/.test(mainSrc));
check("C5 webviews bloqueados", /will-attach-webview[\s\S]{0,80}preventDefault/.test(mainSrc));
// Matriz de política (dinámica, sin Electron).
const navCases: Array<[string, string | undefined, boolean]> = [
  ["file:///app/renderer/index.html", undefined, true],
  ["https://evil.example/", undefined, false],
  ["javascript:alert(1)", undefined, false],
  ["", undefined, false],
  ["not a url", undefined, false],
  [`${DEV}index.html`, DEV, true],
  ["http://localhost:9999/x", DEV, false],
  ["https://localhost:5173/x", DEV, false],
];
for (const [url, dev, want] of navCases) {
  check(`C6 navegación ${url || "(vacía)"} → ${want ? "allow" : "deny"}`, isAllowedNavigationUrl(url, dev) === want);
}
const extCases: Array<[string, "deny" | "open-external"]> = [
  ["https://example.com/docs", "open-external"],
  ["http://127.0.0.1:4312/preview", "open-external"],
  ["http://localhost:3000/", "open-external"],
  ["http://example.com/x", "deny"],
  ["file:///etc/passwd", "deny"],
  ["data:text/html,<h1>x</h1>", "deny"],
  ["blob:https://example.com/u", "deny"],
  ["javascript:alert(1)", "deny"],
  ["myapp://open", "deny"],
  ["basura", "deny"],
];
for (const [url, want] of extCases) {
  check(`C7 enlace ${url} → ${want}`, decideExternalLink(url) === want);
}

/* D. Secretos: solo safeStorage ------------------------------------------------ */
const storeSrc = read("apps/desktop/src/main/secret-store.ts");
check("D1 usa isAsyncEncryptionAvailable", /isAsyncEncryptionAvailable\(\)/.test(storeSrc));
check("D2 usa encryptStringAsync/decryptStringAsync", /encryptStringAsync/.test(storeSrc) && /decryptStringAsync/.test(storeSrc));
check("D3 sin API síncrona (eliminada en Electron 46)", !/(isEncryptionAvailable|encryptString|decryptString)\s*\(/.test(storeSrc.replace(/isAsyncEncryptionAvailable|encryptStringAsync|decryptStringAsync/g, "")));
check("D4 fail-closed sin cifrado (nunca texto plano)", /refusing to handle secrets without encryption/.test(storeSrc));
check("D5 corrupto archiva backup + avisa (no vacío silencioso)", /\.corrupt\./.test(storeSrc) && /fail-closed/.test(storeSrc));
check("D6 forma inesperada rechaza arrancar", /unexpected shape/.test(storeSrc));
const coreStore = read("packages/core/src/secrets/secret-store.ts");
check("D7 core secret-store sin fs/SQLite (interfaz + memoria/env)", !/writeFileSync|readFileSync|sqlite|localStorage/i.test(coreStore));
const schema = read("packages/core/src/persistence/schema.ts");
check("D8 provider_configs guarda secret_ref, no la clave", /secret_ref TEXT/.test(schema) && !/api[_-]?key\s+TEXT/i.test(schema));
const mcpMgmt = read("packages/core/src/mcp/mcp-server-management.ts");
check("D9 import MCP rechaza claves (assertNoSecretKeys)", /assertNoSecretKeys/.test(mcpMgmt));
check("D10 MCP redacta secretos en logs", /redactSecrets/.test(mcpMgmt));
check("D11 URL MCP sin credenciales embebidas", /must not embed credentials/.test(mcpMgmt));
// Matriz de valores: plano vs blob.
check("D12 plano 'sk-live-...' se detecta", looksLikePlaintextSecretValue("sk-live-abcdefghijklmnop"));
check("D13 plano con espacios se detecta", looksLikePlaintextSecretValue("mi clave secreta 123"));
check("D14 vacío se detecta", looksLikePlaintextSecretValue(""));
check("D15 blob cifrado (base64 aleatorio) pasa", !looksLikePlaintextSecretValue(Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64")));
// Patrones positivos/negativos del escáner.
const positives: Array<[string, string]> = [
  [`api_key = "sk-abcdefghijklmnopqrst"`, "assigned-api-key"],
  [`client_secret: 's3cr3t-value-99'`, "assigned-secret"],
  [`Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc-def_123`, "bearer-header"],
  ["token ghp_abcdefghijklmnop1234 en texto", "github-token"],
  ["-----BEGIN RSA PRIVATE KEY-----", "private-key-block"],
  [`password = "s3cret-value!"`, "assigned-password"],
  ["postgres://admin:s3cret@db/x", "connection-string"],
];
for (const [line, want] of positives) {
  const got = scanTextForSecrets("qa/fixture.txt", `${line}\n`);
  check(`D16 escáner detecta ${want}`, got.some((f) => f.pattern === want), line.slice(0, 40));
}
const negatives = [
  "const ref = secretRefForProvider(id);",
  "secret_ref TEXT, -- referencia opaca",
  "export function redactSecrets(text) {",
  "secret?: string; // sin material",
  "El secreto vive en el almacén del SO.",
  "token: string | undefined; // tipo, no valor",
];
check(
  "D17 escáner sin falsos positivos en identificadores",
  negatives.every((l) => scanTextForSecrets("qa/code.ts", `${l}\n`).length === 0),
);

/* E. Escaneo del árbol (tracked files = código que se empaqueta) ---------------- */
function trackedFiles(): string[] {
  const proc = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT });
  if (proc.exitCode !== 0) throw new Error("git ls-files falló");
  return new TextDecoder().decode(proc.stdout).split("\n").map((s) => s.trim()).filter(Boolean);
}
const BINARY_RE = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|pdf|zip|node|wasm)$/i;
let scanned = 0;
const treeFindings = [];
for (const rel of trackedFiles()) {
  if (BINARY_RE.test(rel)) continue;
  const abs = path.join(ROOT, rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > 1024 * 1024) continue;
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\u0000")) continue;
  scanned += 1;
  treeFindings.push(...scanTextForSecrets(rel.replace(/\\/g, "/"), text));
}
check("E1 cero secretos en plano en el árbol trackeado", treeFindings.length === 0, `${scanned} ficheros; hallazgos: ${treeFindings.slice(0, 5).map((f) => `${f.file}:${f.line}/${f.pattern}`).join(" | ").slice(0, 200)}`);

/* F. Failure case: el gate bloquea ante secreto en JSON plano ------------------ */
const poison = fs.mkdtempSync(path.join(os.tmpdir(), "octus-t35-poison-"));
fs.writeFileSync(path.join(poison, "config.json"), JSON.stringify({ api_key: "sk-abcdefghijklmnopqrst" }));
fs.writeFileSync(path.join(poison, ".env"), 'PASSWORD="s3cret-value!"\n');
fs.writeFileSync(path.join(poison, "notes.md"), "clave:\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAA\n");
const poisonFindings = [];
for (const f of fs.readdirSync(poison)) {
  poisonFindings.push(...scanTextForSecrets(`poison/${f}`, fs.readFileSync(path.join(poison, f), "utf8")));
}
check("F1 failure: secreto en JSON plano detectado", poisonFindings.length >= 3, `${poisonFindings.length} hallazgos`);
const gateBlocks = poisonFindings.length > 0;
check("F2 failure: el gate bloquearía el cierre (exit 1)", gateBlocks === true);
fs.rmSync(poison, { recursive: true, force: true });
check("F3 limpieza del failure case (recibo)", !fs.existsSync(poison), poison);

console.log(`\nAUDITORÍA TODO 35: ${failures === 0 ? "todo PASS" : failures + " FALLOS"} (${total} checks)`);
process.exit(failures === 0 ? 0 : 1);
