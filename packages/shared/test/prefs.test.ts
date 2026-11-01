import { describe, expect, test } from "bun:test";
import {
  DEFAULT_UI_PREFS,
  UI_PREFS_KEY,
  isUiDensity,
  isUiFontSize,
  isUiPrefs,
  isUiTheme,
  parseStoredUiPrefs,
  parseUiPrefs,
} from "../src/prefs.js";

describe("ui prefs (Todo 6)", () => {
  test("clave kv aprobada por el contrato C-01", () => {
    expect(UI_PREFS_KEY).toBe("ui.prefs.v1");
  });

  test("defecto: tema sistema, 14px, densidad normal", () => {
    expect(DEFAULT_UI_PREFS).toEqual({ theme: "system", fontSize: 14, density: "normal" });
  });

  test("acepta las tres temas, tamanos 12-18 y tres densidades", () => {
    for (const theme of ["light", "dark", "system"]) expect(isUiTheme(theme)).toBe(true);
    for (const density of ["compact", "normal", "comfortable"]) expect(isUiDensity(density)).toBe(true);
    for (let size = 12; size <= 18; size++) expect(isUiFontSize(size)).toBe(true);
    expect(isUiPrefs({ theme: "dark", fontSize: 18, density: "compact" })).toBe(true);
  });

  test("rechaza valores fuera del sistema de diseno", () => {
    expect(isUiTheme("midnight")).toBe(false);
    expect(isUiDensity("cozy")).toBe(false);
    expect(isUiFontSize(11)).toBe(false);
    expect(isUiFontSize(19)).toBe(false);
    expect(isUiFontSize(14.5)).toBe(false);
    expect(isUiFontSize("14")).toBe(false);
    expect(isUiPrefs({ theme: "dark", fontSize: 18 })).toBe(false);
    expect(isUiPrefs(null)).toBe(false);
  });

  test("ida y vuelta: serializar, cambiar los tres ejes y reafirmar", () => {
    const changed = parseUiPrefs({ theme: "dark", fontSize: 12, density: "comfortable" });
    const stored = JSON.stringify(changed);
    const back = parseStoredUiPrefs(stored);
    expect(back).toEqual({ theme: "dark", fontSize: 12, density: "comfortable" });
  });

  test("failure: preferencia corrupta en disco degrada al defecto sin lanzar", () => {
    for (const corrupt of ["{no-json", "", undefined, null, "42", "[1,2]", JSON.stringify({ theme: "neon", fontSize: 99, density: "x" })]) {
      expect(parseStoredUiPrefs(corrupt as string)).toEqual({ ...DEFAULT_UI_PREFS });
    }
    // Degradación por campo: lo válido sobrevive, lo corrupto cae al defecto.
    expect(parseUiPrefs({ theme: "dark", fontSize: "grande", density: "compact" })).toEqual({
      theme: "dark",
      fontSize: 14,
      density: "compact",
    });
  });
});
