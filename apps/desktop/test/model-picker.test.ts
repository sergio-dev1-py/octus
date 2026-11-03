/** Selector unificado de modelo: un botón abre el popover con buscador,
 * recientes y modelos agrupados por proveedor; el esfuerzo es segmentado y
 * solo aparece si el modelo lo publica. Compila el componente de producción
 * con vite + vite-plugin-solid y lo maneja en Chromium real (playwright-core).
 *
 * Uso: bun test apps/desktop/test/model-picker.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import solidPlugin from "vite-plugin-solid";
import { chromium, type Browser, type Page } from "playwright-core";

const FIXTURE_DIR = join(import.meta.dir, "model-picker");
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
  outDir = await mkdtemp(join(tmpdir(), "octus-model-picker-"));
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

type Call = { channel: string; payload: any };
async function calls(): Promise<Call[]> {
  return pg().evaluate(() => (window as unknown as { __calls: Call[] }).__calls);
}
async function waitCalls(n: number): Promise<Call[]> {
  await pg().waitForFunction((want) => (window as unknown as { __calls: Call[] }).__calls.length >= want, n, {
    timeout: 15000,
  });
  return calls();
}

describe("Selector unificado de modelo", () => {
  test("happy: botón con modelo actual + perfil único + esfuerzo segmentado", async () => {
    await pg().goto(baseUrl, { waitUntil: "load" });
    await pg().waitForSelector("#model-picker", { timeout: 15000 });
    expect(await pg().getAttribute("#model-picker", "aria-label")).toBe("Modelo y esfuerzo");
    expect(await pg().inputValue("#composer-profile")).toBe("plan");
    expect(await pg().textContent("#composer-model-button")).toContain("Modelo con esfuerzo");
    // Esfuerzo: un solo selector con los niveles reales del modelo.
    const chips = await pg().$$eval("#composer-effort option", (els) => els.map((el) => el.textContent?.trim()));
    expect(chips).toEqual(["Default", "low", "high"]);
    console.log("happy: botón + perfil + select único de esfuerzo ok");
  }, STEP_TIMEOUT_MS);

  test("happy: popover con buscador, grupos y selección persiste por sesión", async () => {
    await pg().goto(baseUrl, { waitUntil: "load" });
    await pg().waitForSelector("#model-picker", { timeout: 15000 });
    const before = (await calls()).length;
    await pg().click("#composer-model-button");
    await pg().waitForSelector(".model-popover", { timeout: 15000 });
    expect(await pg().locator(".model-group-label").first().textContent()).toContain("Proveedor 1");
    await pg().fill("#composer-model-search", "simple");
    await pg().waitForSelector('[data-model-item="p1/m-plain"]', { timeout: 15000 });
    expect(await pg().locator(".model-item").count()).toBe(1);
    await pg().click('[data-model-item="p1/m-plain"]');
    const after = await waitCalls(before + 2);
    const setModel = after.slice(before).find((c) => c.channel === "sessions.setModel");
    expect(setModel?.payload).toEqual({
      sessionId: "s1",
      model: { providerId: "p1", modelId: "m-plain", effort: undefined },
    });
    // Sin efforts: el selector desaparece.
    await pg().waitForFunction(() => document.querySelectorAll("#composer-effort").length === 0, undefined, { timeout: 15000 });
    console.log("happy: popover, búsqueda y selección con esfuerzo limpio ok");
  }, STEP_TIMEOUT_MS);

  test("happy: el selector de esfuerzo cambia el esfuerzo (Default lo limpia)", async () => {
    await pg().goto(baseUrl, { waitUntil: "load" });
    await pg().waitForSelector("#model-picker", { timeout: 15000 });
    const before = (await calls()).length;
    await pg().selectOption("#composer-effort", "high");
    const after = await waitCalls(before + 2);
    const setModel = after.slice(before).find((c) => c.channel === "sessions.setModel");
    expect(setModel?.payload).toEqual({
      sessionId: "s1",
      model: { providerId: "p1", modelId: "m-effort", effort: "high" },
    });
    console.log("happy: esfuerzo high persistido por sesión ok");
  }, STEP_TIMEOUT_MS);

  test("happy: el perfil único cambia via setProfile", async () => {
    await pg().goto(baseUrl, { waitUntil: "load" });
    await pg().waitForSelector("#model-picker", { timeout: 15000 });
    const before = (await calls()).length;
    await pg().selectOption("#composer-profile", "build");
    const after = await waitCalls(before + 2);
    expect(after.slice(before).find((c) => c.channel === "sessions.setProfile")?.payload).toEqual({
      sessionId: "s1",
      profile: "build",
    });
    expect(await pg().inputValue("#composer-profile")).toBe("build");
    console.log("happy: perfil build->plan por sesion via sessions.setProfile ok");
  }, STEP_TIMEOUT_MS);
});
