/**
 * Todo 28 — Recursos y prompts MCP con aprobación (contrato C-12).
 *
 * Contra servidores SIMULADOS locales (ningún servidor real, ningún secreto):
 *  - STDIO: `Server` de bajo nivel con capacidades completas
 *    (`resources.subscribe`, `prompts`) sobre `mock-stdio-res.ts`.
 *  - HTTP: `McpServer` de alto nivel SIN `subscribe` (prueba la puerta de lo
 *    no negociado) en 127.0.0.1:puerto-efímero.
 * Afirma: describir primitivas sin anunciar de más; listar recursos y
 * plantillas; leer recurso público y expansión de plantilla; recurso sensible
 * negado sin aprobación y permitido con ella; actualización por suscripción
 * cuando aplica (STDIO) y negada cuando no (HTTP); listar y obtener prompt;
 * prompt sensible con aprobación; contenido como no confiable con banner y
 * blobs omitidos; inyección al contexto solo tras aprobación (vía
 * ContextBuilder real). Limpieza total: clientes, servidores y tmpdir.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  SdkContentBinding,
  describeMcpPrimitives,
  formatMcpPromptForContext,
  formatMcpResourceForContext,
  getMcpPrompt,
  isSensitivePromptName,
  isSensitiveResourceUri,
  listMcpPrompts,
  listMcpResourceTemplates,
  listMcpResources,
  readMcpResource,
  watchMcpResource,
  type McpContentBinding,
} from "../src/mcp/mcp-resources.js";
import { ContextBuilder } from "../src/runtime/context-builder.js";
import { expectRejects, makeTestCore, workspaceOf, type TestCore } from "./helpers.js";

// ---------------------------------------------------------------------------
// Simulados (ciclo de vida del fichero; puertos efímeros; limpieza total)
// ---------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), "octus-mcp-t28-"));
const stdioMockPath = join(work, "mock-stdio-res.ts");

const coreDir = join(import.meta.dir, "..");
const sdkRequire = createRequire(join(coreDir, "package.json"));
const SERVER_URL = pathToFileURL(sdkRequire.resolve("@modelcontextprotocol/sdk/server/index.js")).href;
const STDIO_SERVER_URL = pathToFileURL(sdkRequire.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
const TYPES_URL = pathToFileURL(sdkRequire.resolve("@modelcontextprotocol/sdk/types.js")).href;

writeFileSync(
  stdioMockPath,
  `import { Server } from ${JSON.stringify(SERVER_URL)};
import { StdioServerTransport } from ${JSON.stringify(STDIO_SERVER_URL)};
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from ${JSON.stringify(TYPES_URL)};
const server = new Server({ name: "mcp-qa-res", version: "1.0.0" }, {
  capabilities: { resources: { subscribe: true, listChanged: true }, prompts: { listChanged: true } },
});
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: "doc://notes/qa", name: "qa_notes", title: "QA notes", mimeType: "text/plain" },
    { uri: "secret://vault/qa-token", name: "qa_token", title: "QA token", mimeType: "text/plain" },
    { uri: "doc://assets/logo", name: "qa_logo", title: "QA logo", mimeType: "image/png" },
  ],
}));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [{ name: "qa_note_tpl", uriTemplate: "doc://notes/{id}", title: "QA note by id", mimeType: "text/plain" }],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const uri = req.params.uri;
  if (uri === "doc://notes/qa") return { contents: [{ uri, mimeType: "text/plain", text: "public notes v1" }] };
  if (uri === "secret://vault/qa-token") return { contents: [{ uri, mimeType: "text/plain", text: "qa-dummy-token-0000" }] };
  if (uri === "doc://assets/logo") return { contents: [{ uri, mimeType: "image/png", blob: "aGVsbG8=" }] };
  const m = /^doc:\\/\\/notes\\/([A-Za-z0-9_-]+)$/.exec(uri);
  if (m) return { contents: [{ uri, mimeType: "text/plain", text: "note " + m[1] + " contents" }] };
  throw new Error("unknown resource " + uri);
});
server.setRequestHandler(SubscribeRequestSchema, async (req) => {
  const uri = req.params.uri;
  setTimeout(() => {
    void server.notification({ method: "notifications/resources/updated", params: { uri } });
  }, 80);
  return {};
});
server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    { name: "qa_review", description: "QA review prompt", arguments: [{ name: "topic", description: "review topic", required: true }] },
    { name: "qa_vault_secret", description: "Sensitive QA prompt", arguments: [] },
  ],
}));
server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  if (req.params.name === "qa_review") {
    const topic = req.params.arguments?.topic ?? "?";
    return { description: "QA review prompt", messages: [{ role: "user", content: { type: "text", text: "review topic: " + topic } }] };
  }
  if (req.params.name === "qa_vault_secret") {
    return { description: "Sensitive QA prompt", messages: [{ role: "user", content: { type: "text", text: "vault hint: rotate me" } }] };
  }
  throw new Error("unknown prompt " + req.params.name);
});
const transport = new StdioServerTransport();
await server.connect(transport);
`,
);

const httpMcp = new McpServer({ name: "mcp-qa-res-http", version: "1.0.0" });
httpMcp.resource("qa_http_doc", "doc://http/qa", { title: "HTTP QA doc", description: "doc" }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: "text/plain", text: "http notes v1" }],
}));
httpMcp.prompt("qa_review", "HTTP review prompt", {}, async () => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text: "http review" } }],
}));
const httpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });

let httpServer: HttpServer;
let httpBase = "";
let stdioClient: Client;
let httpClient: Client;
let stdioBinding: SdkContentBinding;
let httpBinding: SdkContentBinding;

let t: TestCore;

const SENSITIVE_URI = "secret://vault/qa-token";
const DUMMY_TOKEN = "qa-dummy-token-0000";

beforeAll(async () => {
  t = await makeTestCore();
  await httpMcp.connect(httpTransport);
  httpServer = createServer(async (req, res) => {
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
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "qa http handler failed" }));
        }
      }
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  httpBase = `http://127.0.0.1:${port}/mcp`;

  stdioClient = new Client({ name: "octus-test", version: "0.0.0" });
  await stdioClient.connect(new StdioClientTransport({ command: process.execPath, args: [stdioMockPath] }));
  stdioBinding = new SdkContentBinding("qa-stdio", stdioClient);

  httpClient = new Client({ name: "octus-test", version: "0.0.0" });
  await httpClient.connect(new StreamableHTTPClientTransport(new URL(httpBase)));
  httpBinding = new SdkContentBinding("qa-http", httpClient);
});

afterAll(async () => {
  try {
    await stdioClient?.close();
  } catch { /* best-effort */ }
  try {
    await httpClient?.close();
  } catch { /* best-effort */ }
  try {
    await httpMcp.close();
  } catch { /* best-effort */ }
  try {
    await httpTransport.close();
  } catch { /* best-effort */ }
  await new Promise<void>((resolve) => {
    try {
      httpServer?.close(() => resolve());
    } catch {
      resolve();
    }
    setTimeout(resolve, 3000).unref?.();
  });
  await t?.cleanup();
  try {
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 } as Record<string, unknown> as { recursive: true; force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY") {
      await new Promise((r) => setTimeout(r, 1500));
      await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 } as Record<string, unknown> as { recursive: true; force: true });
    } else {
      throw error;
    }
  }
});

// ---------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------
describe("mcp resources and prompts (Todo 28)", () => {
  test("negotiated primitives are described without over-announcing", () => {
    const stdio = describeMcpPrimitives(stdioBinding.capabilities());
    expect(stdio.resources).toBe(true);
    expect(stdio.resourceTemplates).toBe(true);
    expect(stdio.prompts).toBe(true);
    expect(stdio.subscriptions).toBe(true);

    const http = describeMcpPrimitives(httpBinding.capabilities());
    expect(http.resources).toBe(true);
    expect(http.resourceTemplates).toBe(true);
    expect(http.prompts).toBe(true);
    // McpServer de alto nivel NO negocia subscribe: jamás se anuncia.
    expect(http.subscriptions).toBe(false);

    expect(describeMcpPrimitives(undefined)).toEqual({
      resources: false,
      resourceTemplates: false,
      prompts: false,
      subscriptions: false,
    });
    expect(describeMcpPrimitives({})).toEqual({
      resources: false,
      resourceTemplates: false,
      prompts: false,
      subscriptions: false,
    });
  });

  test("lists resources and templates over stdio", async () => {
    const resources = await listMcpResources(stdioBinding);
    expect(resources.map((r) => r.uri).sort()).toEqual(["doc://assets/logo", "doc://notes/qa", SENSITIVE_URI].sort());
    const templates = await listMcpResourceTemplates(stdioBinding);
    expect(templates.map((tpl) => tpl.uriTemplate)).toEqual(["doc://notes/{id}"]);
  });

  test("reads a public resource and a template expansion as untrusted content", async () => {
    const contents = await readMcpResource(stdioBinding, "doc://notes/qa");
    expect(contents).toHaveLength(1);
    expect(contents[0]!.text).toBe("public notes v1");

    const expanded = await readMcpResource(stdioBinding, "doc://notes/42");
    expect(expanded[0]!.text).toBe("note 42 contents");
  });

  test("sensitive classifier flags secrets and ignores public uris", () => {
    expect(isSensitiveResourceUri(SENSITIVE_URI)).toBe(true);
    expect(isSensitiveResourceUri("secret://vault/other")).toBe(true);
    expect(isSensitiveResourceUri("doc://notes/qa")).toBe(false);
    expect(isSensitiveResourceUri("doc://notes/42")).toBe(false);
    expect(isSensitivePromptName("qa_vault_secret")).toBe(true);
    expect(isSensitivePromptName("qa_review")).toBe(false);
  });

  test("sensitive resource is denied without approval and allowed with it", async () => {
    expect(isSensitiveResourceUri(SENSITIVE_URI)).toBe(true);

    const denied = await expectRejects(readMcpResource(stdioBinding, SENSITIVE_URI), /approval/);
    expect(denied.name).toBe("OctusError");

    const rejected = await expectRejects(
      readMcpResource(stdioBinding, SENSITIVE_URI, { approve: async () => false }),
      /not approved/,
    );
    expect(rejected.name).toBe("OctusError");

    const seen: string[] = [];
    const contents = await readMcpResource(stdioBinding, SENSITIVE_URI, {
      approve: async (req) => {
        seen.push(`${req.kind}:${req.target}`);
        expect(req.serverId).toBe("qa-stdio");
        return true;
      },
    });
    expect(seen).toEqual([`resource:${SENSITIVE_URI}`]);
    expect(contents[0]!.text).toBe(DUMMY_TOKEN);
  });

  test("FAILURE: sensitive content never reaches context without approval", async () => {
    const builder = new ContextBuilder(t.core.db);
    const def = await t.core.registry.get("coordinator-build");
    if (!def) throw new Error("coordinator-build definition missing in test core");
    const base = await builder.buildInstructions(def, workspaceOf(t), [], {});

    // Sin aprobación: la lectura se niega y no hay bloque que inyectar.
    let injected: string | undefined;
    try {
      const contents = await readMcpResource(stdioBinding, SENSITIVE_URI);
      injected = formatMcpResourceForContext(stdioBinding.serverId, SENSITIVE_URI, contents);
    } catch (error) {
      expect((error as Error).name).toBe("OctusError");
    }
    expect(injected).toBeUndefined();
    expect(base).not.toContain(DUMMY_TOKEN);

    // Con aprobación: el bloque con banner sí se inyecta y marca no confiable.
    const approved = await readMcpResource(stdioBinding, SENSITIVE_URI, { approve: async () => true });
    const block = formatMcpResourceForContext(stdioBinding.serverId, SENSITIVE_URI, approved);
    expect(block).toContain("[untrusted MCP content");
    expect(block).toContain('untrusted="true"');
    const composed = `${base}\n\n${block}`;
    expect(composed).toContain(DUMMY_TOKEN);
  });

  test("subscribes and receives an update when the protocol supports it", async () => {
    let onUpdate!: (uri: string) => void;
    const received = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for resource update")), 5000);
      onUpdate = (uri: string) => {
        clearTimeout(timer);
        resolve(uri);
      };
    });
    const watch = await watchMcpResource(stdioBinding, "doc://notes/qa", (uri) => onUpdate(uri));
    try {
      expect(await received).toBe("doc://notes/qa");
    } finally {
      await watch.unsubscribe();
      await watch.unsubscribe(); // idempotente
    }
  });

  test("subscription is refused when the server did not negotiate it", async () => {
    const err = await expectRejects(
      watchMcpResource(httpBinding, "doc://http/qa", () => undefined),
      /did not negotiate 'subscriptions'/,
    );
    expect(err.name).toBe("OctusError");
  });

  test("unnegotiated primitives are never used", async () => {
    const bare: McpContentBinding = {
      serverId: "qa-bare",
      authorized: true,
      available: true,
      capabilities: () => ({}),
      listResources: async () => {
        throw new Error("must not be called");
      },
      listResourceTemplates: async () => {
        throw new Error("must not be called");
      },
      readResource: async () => {
        throw new Error("must not be called");
      },
      subscribe: async () => {
        throw new Error("must not be called");
      },
      unsubscribe: async () => {},
      listPrompts: async () => {
        throw new Error("must not be called");
      },
      getPrompt: async () => {
        throw new Error("must not be called");
      },
      onResourceUpdated: () => () => undefined,
    };
    await expectRejects(listMcpResources(bare), /did not negotiate 'resources'/);
    await expectRejects(listMcpResourceTemplates(bare), /did not negotiate 'resources'/);
    await expectRejects(readMcpResource(bare, "doc://notes/qa"), /did not negotiate 'resources'/);
    await expectRejects(listMcpPrompts(bare), /did not negotiate 'prompts'/);
    await expectRejects(getMcpPrompt(bare, "qa_review"), /did not negotiate 'prompts'/);
    await expectRejects(watchMcpResource(bare, "doc://notes/qa", () => undefined), /did not negotiate 'subscriptions'/);
  });

  test("unauthorized or unavailable servers are denied before any protocol call", async () => {
    const untrusted = new SdkContentBinding("qa-stdio", stdioClient, { authorized: false, available: true });
    await expectRejects(listMcpResources(untrusted), /not trusted/);
    const offline = new SdkContentBinding("qa-stdio", stdioClient, { authorized: true, available: false });
    await expectRejects(listMcpPrompts(offline), /not connected/);
  });

  test("lists and gets a prompt; sensitive prompt requires approval", async () => {
    const prompts = await listMcpPrompts(stdioBinding);
    expect(prompts.map((p) => p.name).sort()).toEqual(["qa_review", "qa_vault_secret"]);

    const prompt = await getMcpPrompt(stdioBinding, "qa_review", { topic: "budgets" });
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0]!.text).toBe("review topic: budgets");

    await expectRejects(getMcpPrompt(stdioBinding, "qa_vault_secret"), /approval/);
    const secret = await getMcpPrompt(stdioBinding, "qa_vault_secret", undefined, { approve: async () => true });
    expect(secret.messages[0]!.text).toContain("vault hint");

    const block = formatMcpPromptForContext(stdioBinding.serverId, "qa_review", prompt);
    expect(block).toContain("[untrusted MCP content");
    expect(block).toContain('untrusted="true"');
    expect(block).toContain("review topic: budgets");
  });

  test("binary blobs are omitted from context, never inlined", async () => {
    const contents = await readMcpResource(stdioBinding, "doc://assets/logo");
    expect(contents[0]!.blob).toBe("aGVsbG8=");
    const block = formatMcpResourceForContext(stdioBinding.serverId, "doc://assets/logo", contents);
    expect(block).not.toContain("aGVsbG8=");
    expect(block).toContain("omitted from context");
  });

  test("works over http for list, read and prompt", async () => {
    const resources = await listMcpResources(httpBinding);
    expect(resources.map((r) => r.uri)).toEqual(["doc://http/qa"]);
    const contents = await readMcpResource(httpBinding, "doc://http/qa");
    expect(contents[0]!.text).toBe("http notes v1");
    const prompts = await listMcpPrompts(httpBinding);
    expect(prompts.map((p) => p.name)).toEqual(["qa_review"]);
    const prompt = await getMcpPrompt(httpBinding, "qa_review");
    expect(prompt.messages[0]!.text).toBe("http review");
  });
});
