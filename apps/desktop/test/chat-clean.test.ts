/** Plan octus-workbench-chat-terminal, todo 3: el ChatView REAL monta sesion nueva
 * limpia (cero details), agrupa tool calls por subagente colapsable y degrada el
 * run fallido a tono error — sin transcripciones ni handlers reimplementados.
 *
 * Monta el ChatView verdadero: lo compila con el vite + vite-plugin-solid del
 * repo (la misma cadena que produccion, con el CSS real) y lo maneja en Chromium
 * real (playwright-core) con clicks y asserts de verdad.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import solidPlugin from "vite-plugin-solid";
import { chromium, type Browser, type Page } from "playwright-core";

const FIXTURE_DIR = join(import.meta.dir, "chat-clean");
const EVIDENCE_DIR = join(import.meta.dir, "..", "..", "..", ".omo", "evidence", "octus-workbench-chat-terminal");
const BUILD_TIMEOUT_MS = 180000;
const STEP_TIMEOUT_MS = 60000;

let outDir = "";
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let baseUrl = "";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "octus-chat-clean-"));
  await build({
    root: FIXTURE_DIR,
    plugins: [solidPlugin()],
    base: "./",
    build: { outDir, emptyOutDir: true, minify: false, sourcemap: false },
    logLevel: "warn",
  });
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const pathname = new URL(req.url).pathname.replace(/^\/+/, "");
      const file = Bun.file(join(outDir, pathname === "" ? "index.html" : pathname));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      const dot = pathname.lastIndexOf(".");
      const type = dot >= 0 ? (MIME[pathname.slice(dot)] ?? "application/octet-stream") : "application/octet-stream";
      return new Response(file, { headers: { "Content-Type": type } });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}/index.html`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
}, BUILD_TIMEOUT_MS);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  server?.stop(true);
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

function pg(): Page {
  if (!page) throw new Error("browser not ready");
  return page;
}

describe("ChatView real: sesion nueva limpia + subagentes colapsables (todo 3)", () => {
  test("sesion nueva: timeline vacio + composer, cero details", async () => {
    await pg().goto(`${baseUrl}?state=empty`, { waitUntil: "load" });
    // El composer existe y pide crear/sesión; no hay mensajes ni grupos.
    expect(await pg().locator("#composer").count()).toBe(1);
    expect(await pg().evaluate(() => document.querySelectorAll(".message").length)).toBe(0);
    // REGLA DURA: cero cuadros en sesión nueva, ni siquiera los details.
    expect(await pg().evaluate(() => document.querySelectorAll("details").length)).toBe(0);
    expect(await pg().evaluate(() => document.querySelectorAll("[data-subagent-group]").length)).toBe(0);
    await pg().screenshot({ path: join(EVIDENCE_DIR, "task-3-empty.png") });
  }, STEP_TIMEOUT_MS);

  test("con trabajo: burbuja usuario gris + grupo subagente colapsable", async () => {
    await pg().goto(`${baseUrl}?state=working`, { waitUntil: "load" });
    // Dos burbujas; la del usuario en gris claro (token --oc-user-bubble).
    expect(await pg().evaluate(() => document.querySelectorAll(".message").length)).toBe(2);
    const userBg = await pg().evaluate(() => getComputedStyle(document.querySelector(".message.user")!).backgroundColor);
    expect(userBg).toBe("rgb(217, 222, 233)");
    // El asistente del coordinador resume su trabajo en una sola línea.
    expect(await pg().textContent(".message-timeline details.work > summary")).toContain("Working");
    // El grupo existe, colapsado por defecto (depth>=1 anidado también lo estaría).
    expect(await pg().evaluate(() => document.querySelectorAll("[data-subagent-group]").length)).toBe(1);
    expect(await pg().evaluate(() => (document.querySelector("[data-subagent-group]") as HTMLDetailsElement).open)).toBe(false);
    expect(await pg().getAttribute("[data-subagent-group]", "data-subagent-depth")).toBe("1");
    // Línea corta con el rol del subagente.
    const label = await pg().textContent("[data-subagent-group] summary");
    expect(label).toContain("implementer");
    // Click real: expande y muestra la herramienta en línea compacta.
    await pg().click("[data-subagent-group] summary");
    expect(await pg().evaluate(() => (document.querySelector("[data-subagent-group]") as HTMLDetailsElement).open)).toBe(true);
    expect(await pg().evaluate(() => document.querySelectorAll("[data-subagent-group] .activity-tool").length)).toBe(1);
    expect(await pg().textContent("[data-subagent-group] .activity-tool-name")).toBe("read");
    await pg().screenshot({ path: join(EVIDENCE_DIR, "task-3.png") });
  }, STEP_TIMEOUT_MS);

  test("completed: resultado fuera de Working y footer total del run", async () => {
    await pg().goto(`${baseUrl}?state=completed`, { waitUntil: "load" });
    await pg().waitForSelector(".run-footer", { timeout: 15000 });
    const assistant = pg().locator(".message.assistant").first();
    expect(await assistant.locator(":scope > .md").textContent()).toContain("Delego");
    expect(await assistant.locator("details.work .md").count()).toBe(0);
    expect(await assistant.locator(".diff-card").count()).toBe(1);
    expect(await assistant.locator(".diff-card summary").textContent()).toContain("components/Header.tsx");
    const summary = await assistant.locator("details.work > summary").textContent();
    expect(summary).toContain("Worked");
    const footer = await pg().textContent(".run-footer");
    expect(footer).toContain("Build");
    expect(footer).toContain("muse-spark-1.3");
    expect(footer).toContain("tok/s");
    await pg().screenshot({ path: join(EVIDENCE_DIR, "task-3-completed.png") });
  }, STEP_TIMEOUT_MS);

  test("failure: run fallido muestra el grupo en tono error sin romper", async () => {
    await pg().goto(`${baseUrl}?state=failed`, { waitUntil: "load" });
    expect(await pg().evaluate(() => document.querySelectorAll("[data-subagent-group]").length)).toBe(1);
    expect(await pg().getAttribute("[data-subagent-group]", "data-subagent-status")).toBe("failed");
    // La banda de errores aparece (hay actividad) sin romper el timeline.
    expect(await pg().evaluate(() => document.querySelectorAll(".message").length)).toBe(2);
  }, STEP_TIMEOUT_MS);
});
