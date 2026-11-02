/** Todo 11: el payload de layout.set debe ser structured-clone-safe (POJO). */
import { describe, expect, test } from "bun:test";
import { DEFAULT_LAYOUT } from "@octus/shared";
import { toCloneableLayout } from "../src/renderer/src/store/prefsLayout.js";

describe("toCloneableLayout (todo 11: structured clone)", () => {
  test("devuelve POJO con solo los campos del layout", () => {
    const out = toCloneableLayout({ ...DEFAULT_LAYOUT, sidebarWidth: 300 });
    expect(out).toEqual({ ...DEFAULT_LAYOUT, sidebarWidth: 300 });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  test("sobrevive a structuredClone (lo que exige contextBridge)", () => {
    const out = toCloneableLayout({ ...DEFAULT_LAYOUT });
    const clone = structuredClone(out);
    expect(clone).toEqual(DEFAULT_LAYOUT);
  });

  test("JSON round-trip conserva el layout tras resize", () => {
    const out = toCloneableLayout({ ...DEFAULT_LAYOUT, bottomHeight: 250 });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});
