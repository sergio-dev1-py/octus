/** Plan octus-welcome-settings-theme, todo 4: el modal Ajustes REAL monta,
 * cambia de seccion y se cierra — sin transcripciones ni handlers reimplementados.
 *
 * Monta el SettingsView verdadero: lo compila con el vite + vite-plugin-solid
 * del repo (la misma cadena que produccion, con el CSS real) y lo maneja en
 * Chromium real (playwright-core, dependencia existente) con clicks y teclado
 * de verdad. Limite honesto: el bundle de prueba se sirve con Bun.serve en vez
 * de Electron, pero el codigo del componente, su reactividad y sus estilos son
 * los de produccion byte por byte.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import solidPlugin from "vite-plugin-solid";
import { chromium, type Browser, type Page } from "playwright-core";

const FIXTURE_DIR = join(import.meta.dir, "settings-modal");
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
  outDir = await mkdtemp(join(tmpdir(), "octus-settings-modal-"));
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

describe("SettingsView modal real (todo 4)", () => {
  test("shell: overlay, dialogo Ajustes, X y 2 secciones con Providers", async () => {
    await pg().goto(baseUrl, { waitUntil: "load" });
    expect(await pg().textContent(".oc-settings-title")).toBe("Ajustes");
    expect(await pg().getAttribute("#settings-modal", "role")).toBe("dialog");
    expect(await pg().getAttribute("#settings-modal", "aria-modal")).toBe("true");
    expect(await pg().getAttribute("#settings-modal", "aria-label")).toBe("Ajustes");
    expect(await pg().getAttribute("#settings-close", "aria-label")).toBe("Cerrar ajustes");
    const nav = await pg().evaluate(() =>
      [...document.querySelectorAll(".oc-settings-nav button")].map((el) => el.textContent?.trim())
    );
    expect(nav).toEqual(["Proveedores", "Agentes"]);
    expect(await pg().getAttribute("#settings-nav-providers", "aria-selected")).toBe("true");
    expect(await pg().getAttribute("#settings-nav-agents", "aria-selected")).toBe("false");
    // Panel inicial: el ProviderSettings real con 3 proveedores semilla.
    expect(await pg().textContent("#settings-panel")).toContain("Proveedor 1");
    const shell = await pg().textContent("#settings-overlay");
    expect(shell).not.toContain("Budget");
    expect(shell).not.toContain("Skills");
    expect(shell).not.toContain("Appearance");
  }, STEP_TIMEOUT_MS);

  test("nav alterna Proveedores/Agentes con el componente real", async () => {
    await pg().goto(baseUrl, { waitUntil: "load" });
    await pg().click("#settings-nav-agents");
    expect(await pg().getAttribute("#settings-nav-agents", "aria-selected")).toBe("true");
    expect(await pg().getAttribute("#settings-nav-providers", "aria-selected")).toBe("false");
    // El AgentSettings real: limites de concurrencia, sin rastro de presupuesto.
    const panel = await pg().textContent("#settings-panel");
    expect(panel).toContain("Concurrency limits");
    expect(panel).not.toContain("Proveedor 1");
    await pg().click("#settings-nav-providers");
    expect(await pg().getAttribute("#settings-nav-providers", "aria-selected")).toBe("true");
    expect(await pg().textContent("#settings-panel")).toContain("Proveedor 1");
  }, STEP_TIMEOUT_MS);

  test("X cierra via onClose real y desmonta el overlay", async () => {
    await pg().goto(baseUrl, { waitUntil: "load" });
    await pg().click("#settings-close");
    expect(await pg().evaluate(() => window.__settingsClosed)).toBe(true);
    expect(await pg().evaluate(() => document.getElementById("settings-overlay"))).toBeNull();
  }, STEP_TIMEOUT_MS);

  test("Escape cierra via el handler real", async () => {
    await pg().goto(baseUrl, { waitUntil: "load" });
    await pg().click(".oc-settings-title");
    await pg().keyboard.press("Escape");
    expect(await pg().evaluate(() => window.__settingsClosed)).toBe(true);
    expect(await pg().evaluate(() => document.getElementById("settings-overlay"))).toBeNull();
  }, STEP_TIMEOUT_MS);

  test("click en el backdrop cierra via el handler real", async () => {
    await pg().goto(baseUrl, { waitUntil: "load" });
    // Esquina del overlay, fuera del dialogo centrado.
    await pg().mouse.click(8, 400);
    expect(await pg().evaluate(() => window.__settingsClosed)).toBe(true);
    expect(await pg().evaluate(() => document.getElementById("settings-overlay"))).toBeNull();
  }, STEP_TIMEOUT_MS);

  test("contenido alto: dialogo dentro del viewport, scroll interno del panel", async () => {
    await pg().goto(`${baseUrl}?tall=1`, { waitUntil: "load" });
    const check = await pg().evaluate(() => {
      const dialog = document.getElementById("settings-modal")!;
      const panel = document.getElementById("settings-panel")!;
      const rect = dialog.getBoundingClientRect();
      return {
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
        viewport: { w: window.innerWidth, h: window.innerHeight },
        dialog: { scrollHeight: dialog.scrollHeight, clientHeight: dialog.clientHeight },
        panel: { scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight },
      };
    });
    // Nunca toca los bordes: 8px de margen minimo por lado.
    expect(check.rect.top).toBeGreaterThanOrEqual(8);
    expect(check.rect.left).toBeGreaterThanOrEqual(8);
    expect(check.rect.bottom).toBeLessThanOrEqual(check.viewport.h - 8);
    expect(check.rect.right).toBeLessThanOrEqual(check.viewport.w - 8);
    // Sin overflow del dialogo; el panel absorbe el contenido con scroll.
    expect(check.dialog.scrollHeight).toBeLessThanOrEqual(check.dialog.clientHeight + 1);
    expect(check.panel.scrollHeight).toBeGreaterThan(check.panel.clientHeight);
    await pg().screenshot({ path: join(import.meta.dir, "..", "..", "..", ".omo", "evidence", "octus-welcome-settings-theme", "task-4-real-tall.png") });
  }, STEP_TIMEOUT_MS);
});
