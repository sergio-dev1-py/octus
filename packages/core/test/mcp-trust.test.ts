/**
 * Todo 26 — MCP Client Manager con confianza por workspace.
 * Sin servidores reales, sin secretos: mocks STDIO en tmpdir, secretos de
 * juguete en MemorySecretStore. La puerta de confianza precede a todo.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { PersistenceService } from "../src/persistence/persistence-service.js";
import { MemorySecretStore } from "../src/secrets/secret-store.js";
import { McpClientManager, mcpSecretRef, type McpServerConfig } from "../src/mcp/mcp-client-manager.js";
import { expectRejects } from "./helpers.js";

const coreDir = path.join(import.meta.dir, "..");
const sdkRequire = createRequire(path.join(coreDir, "package.json"));
const SERVER_URL = pathToFileURL(sdkRequire.resolve("@modelcontextprotocol/sdk/server/index.js")).href;
const STDIO_SERVER_URL = pathToFileURL(sdkRequire.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
const TYPES_URL = pathToFileURL(sdkRequire.resolve("@modelcontextprotocol/sdk/types.js")).href;

function mockServerSource(markerEnv?: string): string {
  return `import { Server } from ${JSON.stringify(SERVER_URL)};
import { StdioServerTransport } from ${JSON.stringify(STDIO_SERVER_URL)};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(TYPES_URL)};
${markerEnv ? `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env[${JSON.stringify(markerEnv)}], "booted");\n` : ""}
const server = new Server({ name: "mcp-qa-stdio", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "qa_echo", description: "Echo probe", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const text = req.params.arguments?.text ?? "";
  return { content: [{ type: "text", text: "echo:" + text }] };
});
const transport = new StdioServerTransport();
await server.connect(transport);
`;
}

const SLOW_MOCK = `await new Promise(() => {});\n`;

interface Fixture {
  dir: string;
  db: PersistenceService;
  secrets: MemorySecretStore;
  manager: McpClientManager;
  mockPath: string;
  slowPath: string;
  cleanup: () => Promise<void>;
}

async function makeFixture(managerOpts: Record<string, unknown> = {}): Promise<Fixture> {
  const dir = mkdtempSync(path.join(tmpdir(), "octus-mcp26-"));
  const mockPath = path.join(dir, "mock-stdio-server.ts");
  writeFileSync(mockPath, mockServerSource());
  const slowPath = path.join(dir, "mock-slow-server.ts");
  writeFileSync(slowPath, SLOW_MOCK);
  const db = await PersistenceService.open({ dbPath: path.join(dir, "test.db") });
  const secrets = new MemorySecretStore();
  const manager = new McpClientManager(db, secrets, { reconnectBaseMs: 20, ...managerOpts });
  return {
    dir,
    db,
    secrets,
    manager,
    mockPath,
    slowPath,
    cleanup: async () => {
      await manager.close();
      await db.close();
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 } as Record<string, unknown> as { recursive: true; force: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY") {
          await new Promise((r) => setTimeout(r, 1500));
          await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 } as Record<string, unknown> as { recursive: true; force: true });
        } else {
          throw error;
        }
      }
    },
  };
}

async function addStdioServer(fx: Fixture, id: string, command?: string, args?: string[]): Promise<McpServerConfig> {
  return fx.manager.addServer({
    id,
    name: `qa-${id}`,
    transport: "stdio",
    command: command ?? process.execPath,
    args: args ?? [fx.mockPath],
  });
}

describe("mcp trust gate (Todo 26)", () => {
  test("untrusted server refuses to connect and project open denies without executing", async () => {
    const fx = await makeFixture();
    try {
      await addStdioServer(fx, "qa1");
      // Estado inicial: registrado pero desconectado, sin confianza.
      expect(fx.manager.status("qa1").status).toBe("disconnected");
      expect(await fx.manager.isTrusted("qa1", "projA")).toBe(false);

      // Conexión directa: la puerta niega antes de crear transporte alguno.
      const err = await expectRejects(fx.manager.connect("qa1", { projectId: "projA" }), /not trusted/);
      expect(err.name).toBe("OctusError");
      expect(fx.manager.status("qa1").status).toBe("disconnected");

      // Apertura de workspace: negado y auditado.
      const report = await fx.manager.openWorkspace("projA");
      expect(report.connected).toEqual([]);
      expect(report.denied.map((d) => d.serverId)).toEqual(["qa1"]);
      expect(report.failed).toEqual([]);
      expect(fx.manager.status("qa1").status).toBe("disconnected");

      const log = await fx.manager.auditLog("qa1");
      const actions = log.map((e) => e.action);
      expect(actions).toContain("connect.denied");
      expect(actions).toContain("workspace.open.denied");
      // La denegación de arranque quedó registrada con proyecto y motivo.
      const denied = log.find((e) => e.action === "workspace.open.denied")!;
      expect(denied.projectId).toBe("projA");
      expect(denied.reason ?? "").toMatch(/not trusted/);
      // Persistida en la tabla mcp_audit (no solo en memoria).
      const rows = await fx.db.query("SELECT action FROM mcp_audit WHERE server_id = ?", ["qa1"]);
      expect(rows.map((r) => (r as { action: string }).action)).toContain("workspace.open.denied");
    } finally {
      await fx.cleanup();
    }
  });

  test("untrusted server is never executed on workspace open", async () => {
    const fx = await makeFixture();
    try {
      const marker = path.join(fx.dir, "boot-marker.txt");
      const spyPath = path.join(fx.dir, "mock-spy-server.ts");
      writeFileSync(spyPath, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "booted");\nawait new Promise(() => {});\n`);
      await addStdioServer(fx, "spy", process.execPath, [spyPath]);
      const report = await fx.manager.openWorkspace("projS");
      expect(report.denied.map((d) => d.serverId)).toEqual(["spy"]);
      // Ventana de gracia: si la puerta fallara, el spy habría arrancado ya.
      await new Promise((r) => setTimeout(r, 300));
      expect(existsSync(marker)).toBe(false);
      expect(fx.manager.status("spy").status).toBe("disconnected");
    } finally {
      await fx.cleanup();
    }
  });

  test("explicit workspace trust allows connect with handshake and capabilities", async () => {
    const fx = await makeFixture();
    try {
      await addStdioServer(fx, "qa2");
      await fx.manager.setTrust("qa2", { scope: "workspace", projectId: "projA" }, true);
      expect(await fx.manager.isTrusted("qa2", "projA")).toBe(true);
      // La confianza es por workspace: otro proyecto sigue negado.
      expect(await fx.manager.isTrusted("qa2", "projB")).toBe(false);

      const info = await fx.manager.connect("qa2", { projectId: "projA" });
      expect(info.status).toBe("connected");
      expect(info.serverName).toBe("mcp-qa-stdio");
      expect(info.serverVersion).toBe("1.0.0");
      expect(info.tools).toEqual(["qa_echo"]);
      expect(info.connectedAt).toBeGreaterThan(0);

      const log = await fx.manager.auditLog("qa2");
      expect(log.map((e) => e.action)).toContain("connect.ok");

      // Conectar de nuevo es idempotente (no duplica el subproceso).
      const again = await fx.manager.connect("qa2", { projectId: "projA" });
      expect(again.status).toBe("connected");

      await fx.manager.disconnect("qa2", "projA");
      expect(fx.manager.status("qa2").status).toBe("disconnected");
    } finally {
      await fx.cleanup();
    }
  });

  test("global trust works across workspaces and revoke denies again", async () => {
    const fx = await makeFixture();
    try {
      await addStdioServer(fx, "qa3");
      await fx.manager.setTrust("qa3", { scope: "global" }, true);
      const report = await fx.manager.openWorkspace("projB");
      expect(report.connected).toEqual(["qa3"]);
      expect(report.denied).toEqual([]);
      expect(fx.manager.status("qa3").status).toBe("connected");

      await fx.manager.setTrust("qa3", { scope: "global" }, false);
      expect(await fx.manager.isTrusted("qa3", "projB")).toBe(false);
      // Revocar corta la conexión viva.
      expect(fx.manager.status("qa3").status).toBe("disconnected");
      const err = await expectRejects(fx.manager.connect("qa3", { projectId: "projB" }), /not trusted/);
      expect(err.name).toBe("OctusError");
      const log = await fx.manager.auditLog("qa3");
      expect(log.map((e) => e.action)).toContain("trust.revoked");
    } finally {
      await fx.cleanup();
    }
  });

  test("reconnect after disconnect succeeds; retry loop is bounded with backoff", async () => {
    const delays: number[] = [];
    const fx = await makeFixture({
      sleep: async (ms: number, signal?: AbortSignal) => {
        delays.push(ms);
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      },
    });
    try {
      await addStdioServer(fx, "qa4");
      await fx.manager.setTrust("qa4", { scope: "workspace", projectId: "projA" }, true);
      await fx.manager.connect("qa4", { projectId: "projA" });
      await fx.manager.disconnect("qa4", "projA");

      // Reconexión limpia tras desconexión: intento 1 conecta, sin esperas.
      delays.length = 0;
      const info = await fx.manager.reconnect("qa4", { projectId: "projA" });
      expect(info.status).toBe("connected");
      expect(info.tools).toEqual(["qa_echo"]);

      // Servidor roto: reintentos acotados con backoff creciente, luego falla.
      const brokenId = "broken";
      await fx.manager.addServer({
        id: brokenId,
        name: "qa-broken",
        transport: "stdio",
        command: path.join(fx.dir, "no-existe-qa.exe"),
        args: [],
      });
      await fx.manager.setTrust(brokenId, { scope: "workspace", projectId: "projA" }, true);
      delays.length = 0;
      const err = await expectRejects(fx.manager.reconnect(brokenId, { projectId: "projA", maxAttempts: 3, baseMs: 20 }), /failed|timed out|ENOENT|spawn/i);
      expect(err.name).toBe("OctusError");
      expect(fx.manager.status(brokenId).attempts).toBe(3);
      expect(fx.manager.status(brokenId).status).toBe("failed");
      // Dos esperas entre tres intentos, backoff no decreciente.
      expect(delays.length).toBe(2);
      expect(delays[1]!).toBeGreaterThanOrEqual(delays[0]!);
      const log = await fx.manager.auditLog(brokenId);
      expect(log.map((e) => e.action)).toContain("reconnect.failed");
    } finally {
      await fx.cleanup();
    }
  });

  test("cancelled connect aborts and the manager resumes cleanly (cancel_resume)", async () => {
    const fx = await makeFixture();
    try {
      await addStdioServer(fx, "qa5");
      await fx.manager.setTrust("qa5", { scope: "workspace", projectId: "projA" }, true);
      const controller = new AbortController();
      controller.abort();
      const err = await expectRejects(fx.manager.connect("qa5", { projectId: "projA", signal: controller.signal }), /abort/i);
      expect(err.name).toBe("OctusError");
      expect(fx.manager.status("qa5").status).not.toBe("connected");
      // Reanudar tras cancelar: el manager sigue operativo.
      const info = await fx.manager.connect("qa5", { projectId: "projA" });
      expect(info.status).toBe("connected");
      expect(info.tools).toEqual(["qa_echo"]);
    } finally {
      await fx.cleanup();
    }
  });

  test("slow handshake hits the connect timeout and the child is reaped", async () => {
    const fx = await makeFixture();
    try {
      await addStdioServer(fx, "slow", process.execPath, [fx.slowPath]);
      await fx.manager.setTrust("slow", { scope: "workspace", projectId: "projA" }, true);
      const err = await expectRejects(fx.manager.connect("slow", { projectId: "projA", timeoutMs: 500 }), /timed out/);
      expect(err.name).toBe("OctusError");
      expect(fx.manager.status("slow").status).toBe("failed");
      expect(fx.manager.status("slow").lastError ?? "").toMatch(/timed out/);
      // El manager sigue operativo tras el timeout.
      await fx.manager.setTrust("slow", { scope: "workspace", projectId: "projA" }, false);
      expect(await fx.manager.isTrusted("slow", "projA")).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });

  test("malformed inputs are rejected before any side effect", async () => {
    const fx = await makeFixture();
    try {
      await expectRejects(fx.manager.addServer({ name: "", transport: "stdio", command: "x" }), /name is required/);
      await expectRejects(fx.manager.addServer({ name: "bad", transport: "sse" as never, command: "x" }), /transport must be/);
      await expectRejects(fx.manager.addServer({ name: "bad", transport: "stdio", command: "node; rm -rf /" }), /shell metacharacters/);
      await expectRejects(fx.manager.addServer({ name: "bad", transport: "stdio", command: "node `evil`" }), /shell metacharacters/);
      await expectRejects(fx.manager.addServer({ name: "bad", transport: "stdio", command: "node", args: "x" as never }), /array of strings/);
      await expectRejects(fx.manager.addServer({ name: "bad", transport: "http", url: "ftp://example.com/x" }), /http\(s\)/);
      await expectRejects(fx.manager.addServer({ name: "bad", transport: "http", url: "https://user:pass@example.com/x" }), /must not embed credentials/);
      await expectRejects(fx.manager.addServer({ name: "bad", transport: "http", url: "no-es-url" }), /Invalid MCP server URL/);
      await expectRejects(fx.manager.addServer({ name: "bad", transport: "stdio", command: "node", connectTimeoutMs: -5 }), /positive integer/);
      await addStdioServer(fx, "dup");
      await expectRejects(fx.manager.addServer({ id: "dup", name: "dup2", transport: "stdio", command: "node" }), /already exists/);
      await expectRejects(fx.manager.connect("fantasma", { projectId: "projA" }), /Unknown MCP server/);
      await expectRejects(fx.manager.setTrust("fantasma", { scope: "global" }, true), /Unknown MCP server/);
      await expectRejects(fx.manager.removeServer("fantasma"), /Unknown MCP server/);
      await expectRejects(fx.manager.setTrust("dup", { scope: "workspace", projectId: "a/b" }, true), /Invalid projectId/);
      await expectRejects(fx.manager.connect("dup", { projectId: "" }), /Invalid projectId/);
      await expectRejects(fx.manager.openWorkspace(".."), /Invalid projectId/);
      await expectRejects(fx.manager.setServerSecret("dup", {}), /must include/);
      await expectRejects(fx.manager.setServerSecret("fantasma", { token: "x" }), /Unknown MCP server/);
      // Secreto corrupto en el almacén: se informa, no se conecta a ciegas.
      await fx.manager.setTrust("dup", { scope: "workspace", projectId: "projA" }, true);
      await fx.secrets.set(mcpSecretRef("dup"), "{no-json");
      await expectRejects(fx.manager.connect("dup", { projectId: "projA" }), /corrupt/);
    } finally {
      await fx.cleanup();
    }
  });

  test("secrets live only in the secret store, never in sqlite rows", async () => {
    const fx = await makeFixture();
    try {
      await addStdioServer(fx, "sec");
      await fx.manager.setServerSecret("sec", { token: "tok-juguete-123", env: { QA_VAR: "1" } });
      const rows = await fx.db.query<Record<string, unknown>>("SELECT * FROM mcp_servers WHERE id = ?", ["sec"]);
      expect(rows.length).toBe(1);
      expect(JSON.stringify(rows[0])).not.toContain("tok-juguete-123");
      const stored = await fx.secrets.get(mcpSecretRef("sec"));
      expect(stored ?? "").toContain("tok-juguete-123");
      // Borrado limpia configuración, secreto y confianza.
      await fx.manager.setTrust("sec", { scope: "workspace", projectId: "projA" }, true);
      await fx.manager.removeServer("sec");
      expect(await fx.manager.getServer("sec")).toBeNull();
      expect(await fx.secrets.get(mcpSecretRef("sec"))).toBeUndefined();
      expect(await fx.manager.isTrusted("sec", "projA")).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });

  test("disabled server never connects even when trusted", async () => {
    const fx = await makeFixture();
    try {
      await fx.manager.addServer({ id: "off", name: "qa-off", transport: "stdio", command: process.execPath, args: [fx.mockPath], enabled: false });
      await fx.manager.setTrust("off", { scope: "global" }, true);
      await expectRejects(fx.manager.connect("off", { projectId: "projA" }), /disabled/);
      const report = await fx.manager.openWorkspace("projA");
      expect(report.connected).not.toContain("off");
      expect(report.denied.map((d) => d.serverId)).not.toContain("off");
    } finally {
      await fx.cleanup();
    }
  });

  test("production code never exposes Octus as a server", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = path.join(coreDir, "src", "mcp");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(path.join(dir, file), "utf8");
      // La única superficie SDK permitida en producción es la de CLIENTE.
      const sdkImports = [...content.matchAll(/from\s+["'](@modelcontextprotocol\/sdk\/[^"']+)["']/g)].map((m) => m[1]!);
      expect(sdkImports.length).toBeGreaterThan(0);
      for (const spec of sdkImports) {
        expect(spec.startsWith("@modelcontextprotocol/sdk/client/")).toBe(true);
      }
      expect(content).not.toContain("sdk/server");
    }
  });

  test("migration 8 creates mcp_servers and mcp_audit", async () => {
    const fx = await makeFixture();
    try {
      const tables = await fx.db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
      const names = tables.map((t) => t.name);
      expect(names).toContain("mcp_servers");
      expect(names).toContain("mcp_audit");
      const cols = await fx.db.query<{ name: string }>("PRAGMA table_info(mcp_servers)");
      for (const col of ["id", "name", "transport", "command", "args", "cwd", "url", "enabled", "connect_timeout_ms", "created_at", "updated_at"]) {
        expect(cols.map((c) => c.name)).toContain(col);
      }
    } finally {
      await fx.cleanup();
    }
  });
});
