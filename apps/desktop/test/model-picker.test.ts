/** Todo workbench-chat-terminal/5: el ModelPicker REAL bajo el input — chips de
 * perfil plan/build, provider, modelo y select de esfuerzo SOLO si el modelo
 * publica reasoningEfforts no vacios. Compila el componente de produccion con
 * el vite + vite-plugin-solid del repo y lo maneja en Chromium real
 * (playwright-core). El puente window.octus simula persistencia por sesion.
 *
 * Uso: bun test apps/desktop/test/model-picker.test.ts
 * Evidencia: .omo/evidence/octus-workbench-chat-terminal/task-5.png + task-5.log
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import solidPlugin from "vite-plugin-solid";
import { chromium, type Browser, type Page } from "playwright-core";

const FIXTURE_DIR = join(import.meta.dir, "model-picker");
const EVIDENCE = join(import.meta.dir, "..", "..", "..", ".omo", "evidence", "octus-workbench-chat-terminal");
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

describe("ModelPicker real bajo el input (todo 5)", () => {
  test("happy: chips plan/build + provider + modelo + esfuerzo visible", async () => {
    await pg().goto(baseUrl, { waitUntil: "load" });
    await pg().waitForSelector("#model-picker", { timeout: 15000 });
    expect(await pg().getAttribute("#model-picker", "aria-label")).toBe("Modelo y esfuerzo");
    expect(await pg().getAttribute('[data-profile="plan"]', "data-active")).toBe("true");
    expect(await pg().getAttribute('[data-profile="build"]', "data-active")).toBe("false");
    expect(await pg().textContent("#composer-provider")).toContain("Proveedor 1");
    expect(await pg().inputValue("#composer-model")).toBe("m-effort");
    // El modelo publica reasoningEfforts: el select de esfuerzo existe.
    expect(await pg().locator("#composer-effort").count()).toBe(1);
    const opts = await pg().evaluate(() =>
      [...document.querySelectorAll("#composer-effort option")].map((o) => (o as HTMLOptionElement).value),
    );
    expect(opts).toEqual(["", "low", "high"]);
    console.log("happy: picker con plan activo, provider, modelo y esfuerzo (low/high) ok");
  }, STEP_TIMEOUT_MS);

  test("happy: cambiar esfuerzo persiste por sesion (setModel + refresh)", async () => {
    await pg().goto(baseUrl, { waitUntil: "load" });
    await pg().waitForSelector("#model-picker", { timeout: 15000 });
    const before = (await calls()).length;
    await pg().selectOption("#composer-effort", "high");
    const after = await waitCalls(before + 2);
    const setModel = after.find((c) => c.channel === "sessions.setModel");
    expect(setModel?.payload).toEqual({
      sessionId: "s1",
      model: { providerId: "p1", modelId: "m-effort", effort: "high" },
    });
    // refreshSessions tras setModel: el valor renderizado viene del servidor.
    expect(after.some((c) => c.channel === "sessions.list")).toBe(true);
    expect(await pg().inputValue("#composer-effort")).toBe("high");
    console.log("happy: esfuerzo high persistido por sesion via sessions.setModel ok");
  }, STEP_TIMEOUT_MS);

  test("failure: modelo sin efforts oculta el select y limpia el esfuerzo", async () => {
    await pg().goto(baseUrl, { waitUntil: "load" });
    await pg().waitForSelector("#model-picker", { timeout: 15000 });
    const before = (await calls()).length;
    await pg().selectOption("#composer-model", "m-plain");
    const after = await waitCalls(before + 2);
    const setModel = after.slice(before).find((c) => c.channel === "sessions.setModel");
    expect(setModel?.payload.model).toEqual({ providerId: "p1", modelId: "m-plain", effort: undefined });
    expect(await pg().locator("#composer-effort").count()).toBe(0);
    console.log("failure: modelo simple sin efforts -> sin select y esfuerzo limpio ok");
  }, STEP_TIMEOUT_MS);

  test("happy: chips cambian perfil por sesion via setProfile", async () => {
    await pg().goto(baseUrl, { waitUntil: "load" });
    await pg().waitForSelector("#model-picker", { timeout: 15000 });
    const before = (await calls()).length;
    await pg().click('[data-profile="build"]');
    const after = await waitCalls(before + 2);
    expect(after.slice(before).find((c) => c.channel === "sessions.setProfile")?.payload).toEqual({
      sessionId: "s1",
      profile: "build",
    });
    expect(await pg().getAttribute('[data-profile="build"]', "data-active")).toBe("true");
    expect(await pg().getAttribute('[data-profile="plan"]', "data-active")).toBe("false");
    await pg().click('[data-profile="plan"]');
    await pg().waitForFunction(
      () => document.querySelector('[data-profile="plan"]')?.getAttribute("data-active") === "true",
      undefined,
      { timeout: 15000 },
    );
    console.log("happy: perfil build->plan por sesion via sessions.setProfile ok");
  }, STEP_TIMEOUT_MS);

  test("stale_state: sin caché precargada recarga providers.models y puebla", async () => {
    await pg().goto(`${baseUrl}?nocache=1`, { waitUntil: "load" });
    await pg().waitForSelector("#model-picker", { timeout: 15000 });
    await pg().waitForFunction(
      () => (window as unknown as { __calls: Call[] }).__calls.some((c) => c.channel === "providers.models"),
      undefined,
      { timeout: 15000 },
    );
    await pg().waitForFunction(() => document.querySelectorAll("#composer-model option").length >= 2, undefined, {
      timeout: 15000,
    });
    expect(await pg().inputValue("#composer-model")).toBe("m-effort");
    expect(await pg().locator("#composer-effort").count()).toBe(1);
    console.log("stale_state: refetch providers.models ante caché ausente ok");
  }, STEP_TIMEOUT_MS);

  test("evidencia: captura del picker real", async () => {
    await pg().goto(baseUrl, { waitUntil: "load" });
    await pg().waitForSelector("#model-picker", { timeout: 15000 });
    const box = await pg().evaluate(() => {
      const el = document.getElementById("model-picker")!;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    expect(box.width).toBeGreaterThan(100);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(EVIDENCE, { recursive: true });
    await pg().screenshot({ path: join(EVIDENCE, "task-5.png") });
    console.log(`screenshot task-5.png ok (picker ${Math.round(box.width)}x${Math.round(box.height)})`);
  }, STEP_TIMEOUT_MS);
});
