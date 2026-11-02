/**
 * Todo 25 — Matriz de conformidad MCP (spec 2026-07-28).
 *
 * SDK fijado: @modelcontextprotocol/sdk@1.32.2 (oficial, TypeScript puro).
 * Transportes verificados contra servidores simulados LOCALES (mocks creados
 * en tmpdir en tiempo de ejecucion, ningun servidor real, ningun secreto):
 *   - STDIO (client launches subprocess, newline-delimited JSON-RPC)
 *   - Streamable HTTP (single POST MCP endpoint, JSON or per-request SSE stream)
 * Transporte prohibido: HTTP+SSE legado (SSEClientTransport/SSEServerTransport
 * obsoletos en el SDK; no se importan ni se exponen).
 *
 * Uso: bun scripts/mcp-conformance.ts
 * Exit 0 si todas las aserciones PASS; exit 1 en caso contrario.
 */
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

type Row = { id: string; area: string; ok: boolean; detail: string };
const rows: Row[] = [];
function check(id: string, area: string, ok: boolean, detail: string): void {
  rows.push({ id, area, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${id}] ${area}: ${detail}`);
}

const SDK_PIN = "1.32.2";

// ---------------------------------------------------------------------------
// A0. SDK fijado + entorno compatible (Bun, Electron/Node, Windows)
// ---------------------------------------------------------------------------
const corePkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const sdkRange: string = corePkg.dependencies?.["@modelcontextprotocol/sdk"] ?? "MISSING";
const sdkInstalled: string = JSON.parse(
  readFileSync(new URL("../node_modules/@modelcontextprotocol/sdk/package.json", import.meta.url), "utf8"),
).version;
check("A0-sdk-pin", "SDK", sdkRange === SDK_PIN && sdkInstalled === SDK_PIN, `package.json pin=${sdkRange} installed=${sdkInstalled} (esperado ${SDK_PIN})`);
check(
  "A0-runtime",
  "Compat",
  typeof process.versions.bun === "string" || Number(process.versions.node?.split(".")[0]) >= 22,
  `bun=${process.versions.bun ?? "n/a"} node=${process.versions.node} platform=${process.platform}`,
);
check("A0-platform", "Compat", process.platform === "win32", `platform=${process.platform} (target Windows)`);
check("A0-fetch", "Compat", typeof fetch === "function", "fetch global disponible (Streamable HTTP; Bun/Node22/Electron-main)");
let crossSpawnOk = false;
let crossDetail = "no encontrado";
try {
  const sdkPkg = JSON.parse(
    readFileSync(new URL("../node_modules/@modelcontextprotocol/sdk/package.json", import.meta.url), "utf8"),
  );
  const declared: string = sdkPkg.dependencies?.["cross-spawn"] ?? "no declarado";
  // Layout aislado de Bun: root node_modules/.bun/cross-spawn@*/ (+ fallback clasico).
  const rootBunDir = new URL("../../../node_modules/.bun", import.meta.url);
  let onDisk = "";
  try {
    for (const e of readdirSync(rootBunDir)) {
      if (e === "cross-spawn" || e.startsWith("cross-spawn@")) { onDisk = e; break; }
    }
  } catch { /* sin layout .bun */ }
  if (!onDisk) {
    try { statSync(new URL("../../../node_modules/cross-spawn", import.meta.url)); onDisk = "cross-spawn (top-level)"; } catch { /* no */ }
  }
  const stdioJs = readFileSync(
    new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js", import.meta.url), "utf8");
  const usesIt = stdioJs.includes("cross-spawn");
  crossSpawnOk = declared !== "no declarado" && onDisk !== "" && usesIt;
  crossDetail = `sdk-declara=${declared} disco=${onDisk || "ausente"} stdio.js-lo-usa=${usesIt}`;
} catch (err) {
  crossDetail = `excepcion: ${String(err).slice(0, 200)}`;
}
check("A0-spawn", "Compat", crossSpawnOk, `${crossDetail} (spawn Windows-safe usado por StdioClientTransport)`);

// ---------------------------------------------------------------------------
// Mock STDIO server (fichero temporal, borrado al final)
// ---------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), "octus-mcp-conf-"));
const stdioMockPath = join(work, "mock-stdio-server.ts");
writeFileSync(
  stdioMockPath,
  `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "mcp-qa-stdio", version: "1.0.0" });
server.tool("qa_echo", "Echo probe", { text: z.string() }, async ({ text }: { text: string }) => ({
  content: [{ type: "text" as const, text: "echo:" + text }],
}));
const transport = new StdioServerTransport();
await server.connect(transport);
`,
);

// ---------------------------------------------------------------------------
// A1. STDIO via SDK (connect + tools/list + tools/call)
// ---------------------------------------------------------------------------
let stdioTools: string[] = [];
try {
  const client = new Client({ name: "octus-conformance", version: "0.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [stdioMockPath] });
  await client.connect(transport);
  const listed = await client.listTools();
  stdioTools = (listed.tools ?? []).map((t) => t.name);
  const called = await client.callTool({ name: "qa_echo", arguments: { text: "hola" } });
  const text = (called.content as Array<{ type: string; text?: string }>)?.[0]?.text;
  check("A1-stdio-tools", "STDIO", stdioTools.includes("qa_echo"), `tools=[${stdioTools.join(",")}]`);
  check("A1-stdio-call", "STDIO", text === "echo:hola", `qa_echo("hola") -> ${JSON.stringify(text)}`);
  check("A1-stdio-proto", "STDIO", typeof client.getServerVersion() === "object", `serverVersion=${JSON.stringify(client.getServerVersion())}`);
  await client.close();
} catch (err) {
  check("A1-stdio-tools", "STDIO", false, `excepcion: ${String(err).slice(0, 300)}`);
  check("A1-stdio-call", "STDIO", false, "no alcanzado (fallo previo)");
  check("A1-stdio-proto", "STDIO", false, "no alcanzado (fallo previo)");
}

// ---------------------------------------------------------------------------
// A2. STDIO framing a nivel de cable (raw JSON-RPC, sin SDK en el cliente)
// ---------------------------------------------------------------------------
try {
  const child = spawn(process.execPath, [stdioMockPath], { stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  let buf = "";
  const firstLine = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout esperando linea stdout")), 15000);
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        clearTimeout(timer);
        resolve(buf.slice(0, idx));
      }
    });
    child.on("error", reject);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw-probe", version: "0" } },
      }) + "\n",
    );
  });
  let parsed: { result?: { serverInfo?: { name?: string } }; id?: unknown } | null = null;
  let parses = false;
  try {
    parsed = JSON.parse(firstLine);
    parses = true;
  } catch { /* no */ }
  lines.push(firstLine);
  const noEmbeddedNewlines = !firstLine.includes("\r") && firstLine.trim().length > 0;
  check("A2-framing", "STDIO", parses && noEmbeddedNewlines, `primera linea stdout es 1 mensaje JSON-RPC (${firstLine.slice(0, 120)}...)`);
  check("A2-init", "STDIO", parsed?.result?.serverInfo?.name === "mcp-qa-stdio" && parsed?.id === 1, `initialize responde serverInfo.name=mcp-qa-stdio id=1`);
  child.kill();
  await new Promise((r) => child.on("exit", r));
  void lines;
} catch (err) {
  check("A2-framing", "STDIO", false, `excepcion: ${String(err).slice(0, 300)}`);
  check("A2-init", "STDIO", false, "no alcanzado (fallo previo)");
}

// ---------------------------------------------------------------------------
// A3/A4. Mock Streamable HTTP server (127.0.0.1, puerto efimero) + cliente SDK
// ---------------------------------------------------------------------------
const httpMcp = new McpServer({ name: "mcp-qa-http", version: "1.0.0" });
httpMcp.tool("qa_echo", "Echo probe", { text: z.string() }, async ({ text }: { text: string }) => ({
  content: [{ type: "text" as const, text: "echo:" + text }],
}));
const httpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await httpMcp.connect(httpTransport);
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/mcp") {
    try {
      let body: unknown = undefined;
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      await httpTransport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(400).end("bad request");
    }
    return;
  }
  res.writeHead(404).end("not found"); // sin endpoint SSE legado ni nada mas
});
await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const port = (httpServer.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

try {
  const client = new Client({ name: "octus-conformance", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  await client.connect(transport);
  const listed = await client.listTools();
  const names = (listed.tools ?? []).map((t) => t.name);
  const called = await client.callTool({ name: "qa_echo", arguments: { text: "mundo" } });
  const text = (called.content as Array<{ type: string; text?: string }>)?.[0]?.text;
  check("A3-http-tools", "StreamableHTTP", names.includes("qa_echo"), `POST /mcp tools=[${names.join(",")}]`);
  check("A3-http-call", "StreamableHTTP", text === "echo:mundo", `qa_echo("mundo") -> ${JSON.stringify(text)}`);
  await client.close();
} catch (err) {
  check("A3-http-tools", "StreamableHTTP", false, `excepcion: ${String(err).slice(0, 300)}`);
  check("A3-http-call", "StreamableHTTP", false, "no alcanzado (fallo previo)");
}

// A4: sin stream GET por request (revision 2026-07-28: GET stream endpoint eliminado)
try {
  const getRes = await fetch(`${base}/mcp`, { headers: { Accept: "application/json, text/event-stream" } });
  const ctype = getRes.headers.get("content-type") ?? "";
  check("A4-no-get-stream", "StreamableHTTP", !(getRes.status === 200 && ctype.includes("text/event-stream")), `GET /mcp -> ${getRes.status} content-type=${ctype || "n/a"} (no stream 200/SSE)`);
  await getRes.arrayBuffer().catch(() => undefined);
} catch (err) {
  check("A4-no-get-stream", "StreamableHTTP", false, `excepcion: ${String(err).slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// A5. SSE legado ausente (servidor + codigo propio)
// ---------------------------------------------------------------------------
try {
  const legacy = await fetch(`${base}/sse`, { headers: { Accept: "text/event-stream" } });
  check("A5-no-legacy-endpoint", "NoSSE", legacy.status === 404, `GET /sse -> ${legacy.status} (endpoint legado inexistente)`);
  await legacy.arrayBuffer().catch(() => undefined);
} catch (err) {
  check("A5-no-legacy-endpoint", "NoSSE", false, `excepcion: ${String(err).slice(0, 200)}`);
}

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === "node_modules") continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e)) out.push(p);
  }
}
const ownFiles: string[] = [];
for (const d of [join(import.meta.dirname, "..", "src"), import.meta.dirname]) {
  try { walk(d, ownFiles); } catch { /* inexistente */ }
}
const SELF = import.meta.path ?? "mcp-conformance.ts";
const sseHits = ownFiles.filter((f) => f !== SELF && /SSE(Client|Server)Transport|simpleSseServer|HTTP\+SSE/i.test(readFileSync(f, "utf8")));
check("A5-no-sse-import", "NoSSE", sseHits.length === 0, sseHits.length === 0 ? `${ownFiles.length} ficheros propios sin referencias SSE legado (verificador excluido)` : `referencias SSE en: ${sseHits.join(", ")}`);

// ---------------------------------------------------------------------------
// Cierre + resumen
// ---------------------------------------------------------------------------
await new Promise<void>((resolve) => httpServer.close(() => resolve()));
await import("node:fs/promises").then((m) => m.rm(work, { recursive: true, force: true }));

const pass = rows.filter((r) => r.ok).length;
const fail = rows.filter((r) => !r.ok);
console.log(`\nMATRIZ: ${pass}/${rows.length} PASS`);
for (const f of fail) console.log(`  FALLO: [${f.id}] ${f.detail}`);
process.exit(fail.length === 0 ? 0 : 1);
