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

  test("comprime archivos grandes a hunks con contexto", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n");
    const after = before.replace("line-20", "line-20-CHANGED");
    const result = diffLines(before, after);
    expect(result.rows.some((row) => row.kind === "hunk")).toBe(true);
    expect(result.rows.length).toBeLessThan(40);
    expect(result.rows.length).toBeLessThanOrEqual(10);
    expect(result.rows[0]!.kind).toBe("hunk");
    expect(result.rows[0]!.header).toContain("@@");
    expect(result.rows.filter((row) => row.kind === "same").length).toBeLessThanOrEqual(6);
  });

  test("un cambio pequeño sin zonas omitidas no añade hunk", () => {
    const result = diffLines("a\nb\nc\n", "a\nB\nc\n");
    expect(result.rows.some((row) => row.kind === "hunk")).toBe(false);
  });
});
