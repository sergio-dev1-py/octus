import { describe, expect, test } from "bun:test";
import { diffLines } from "../src/renderer/src/diff.js";

describe("diffLines (visor de cambios)", () => {
  test("detecta líneas cambiadas y conserva contexto", () => {
    const result = diffLines("a\nb\nc\n", "a\nB\nc\n");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.rows.map((row) => row.kind)).toEqual(["same", "change", "same"]);
    expect(result.rows[1]!.left?.text).toBe("b");
    expect(result.rows[1]!.right?.text).toBe("B");
  });

  test("detecta inserciones y eliminaciones", () => {
    const result = diffLines("a\nc\n", "a\nb\nc\n");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.rows.some((row) => row.kind === "add")).toBe(true);
    const removed = diffLines("a\nb\nc\n", "a\nc\n");
    expect(removed.removed).toBe(1);
    expect(removed.rows.some((row) => row.kind === "del")).toBe(true);
  });
});
