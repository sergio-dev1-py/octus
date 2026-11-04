import { describe, expect, test } from "bun:test";
import { extractEmbeddedToolCalls } from "../src/runtime/embedded-tool-calls.js";

describe("embedded tool calls (modelos que emiten DSML/XML como texto)", () => {
  test("extrae read de <invoke>/<parameter> y limpia el texto", () => {
    const raw = 'Voy a leer.\n<tool_calls>\n<invoke name="read">\n<parameter name="path">lib/a.ts</parameter>\n</invoke>\n</tool_calls>';
    const out = extractEmbeddedToolCalls(raw);
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]!.name).toBe("read");
    expect(JSON.parse(out.calls[0]!.argumentsJson)).toEqual({ path: "lib/a.ts" });
    expect(out.text).toBe("Voy a leer.");
  });

  test("preserva contenido multilínea de write/edit", () => {
    const raw = '<invoke name="write"><parameter name="path">a.txt</parameter><parameter name="content">line 1\nline 2</parameter></invoke>';
    const out = extractEmbeddedToolCalls(raw);
    expect(JSON.parse(out.calls[0]!.argumentsJson)).toEqual({ path: "a.txt", content: "line 1\nline 2" });
  });

  test("texto normal sin invoke no se toca", () => {
    const raw = "solo una respuesta normal";
    const out = extractEmbeddedToolCalls(raw);
    expect(out.calls).toHaveLength(0);
    expect(out.text).toBe(raw);
  });

  test("soporta el prefijo DSML real del proveedor", () => {
    const tag = String.fromCharCode(0xff5c) + "｜DSML｜";
    const raw = [
      "<", tag, " calls>",
      "<", tag, " invoke name='read'>",
      "<", tag, " parameter name='path'>", "lib/a.ts",
      "</", tag, " parameter>",
      "</", tag, " invoke>",
      "</", tag, " calls>",
    ].join("");
    const out = extractEmbeddedToolCalls(raw);
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]!.name).toBe("read");
    expect(JSON.parse(out.calls[0]!.argumentsJson)).toEqual({ path: "lib/a.ts" });
  });
});
