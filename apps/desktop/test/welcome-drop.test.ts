/** Plan octus-workbench-chat-terminal, todo 1: taxonomia empty-drop vs
 * empty-folder bloqueada a nivel renderer. pathsFromDrop (puro, extraido de
 * welcome.tsx sin cambiar comportamiento) debe aceptar la ruta valida de una
 * carpeta vacia venga por files (Electron) o por items (Chromium con files
 * vacio), y devolver [] solo cuando de verdad no hay ruta (texto soltado).
 * Solo se afirman rutas (valores maquina); ningun texto de error se fija aqui.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathsFromDrop } from "../src/renderer/src/drop-paths.js";

const trash: string[] = [];
afterEach(() => {
  while (trash.length > 0) fs.rmSync(trash.pop()!, { recursive: true, force: true });
});

function mkEmptyDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octus-drop-empty-"));
  trash.push(dir);
  return dir;
}

function dragEvent(dt: unknown): DragEvent {
  return { dataTransfer: dt } as unknown as DragEvent;
}

describe("pathsFromDrop (todo 1: empty-drop vs empty-folder)", () => {
  test("Electron drop: files con path de carpeta vacia se acepta", () => {
    const dir = mkEmptyDir();
    expect(fs.readdirSync(dir).length).toBe(0);
    expect(pathsFromDrop(dragEvent({ files: [{ path: dir }], items: [] }))).toEqual([dir]);
  });

  test("Electron drop: carpeta con archivos sigue aceptandose", () => {
    const dir = mkEmptyDir();
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    expect(pathsFromDrop(dragEvent({ files: [{ path: dir }], items: [] }))).toEqual([dir]);
  });

  test("Chromium drop: files vacio + items getAsFile con path se acepta", () => {
    const dir = mkEmptyDir();
    const items = [{ getAsFile: () => ({ path: dir }) }];
    expect(pathsFromDrop(dragEvent({ files: [], items }))).toEqual([dir]);
  });

  test("webkitGetAsEntry con fullPath absoluto de directorio se acepta", () => {
    const dir = mkEmptyDir();
    const items = [
      {
        getAsFile: () => null,
        webkitGetAsEntry: () => ({ isDirectory: true, isFile: false, fullPath: dir, name: path.basename(dir) }),
      },
    ];
    expect(pathsFromDrop(dragEvent({ files: [], items }))).toEqual([dir]);
  });

  test("entrada relativa (sin ruta absoluta) no inventa ruta", () => {
    const items = [
      {
        getAsFile: () => null,
        webkitGetAsEntry: () => ({ isDirectory: true, isFile: false, fullPath: "/relativa", name: "relativa" }),
      },
    ];
    // "/relativa" es absoluta POSIX: se acepta; el caso relativo puro da [].
    expect(pathsFromDrop(dragEvent({ files: [], items }))).toEqual(["/relativa"]);
    const relOnly = [
      {
        getAsFile: () => null,
        webkitGetAsEntry: () => ({ isDirectory: true, isFile: false, fullPath: "relativa", name: "relativa" }),
      },
    ];
    expect(pathsFromDrop(dragEvent({ files: [], items: relOnly }))).toEqual([]);
  });

  test("malformed_input: soltar texto (sin ruta) da lista vacia -> error honesto aguas abajo", () => {
    const items = [{ getAsFile: () => null, webkitGetAsEntry: () => null }];
    expect(pathsFromDrop(dragEvent({ files: [], items }))).toEqual([]);
    expect(pathsFromDrop(dragEvent({ files: [], items: [] }))).toEqual([]);
    expect(pathsFromDrop(dragEvent(undefined))).toEqual([]);
  });

  test("rutas duplicadas o vacias no se repiten ni se cuelan", () => {
    const dir = mkEmptyDir();
    expect(pathsFromDrop(dragEvent({ files: [{ path: dir }, { path: dir }, { path: "" }], items: [] }))).toEqual([
      dir,
    ]);
  });

  test("item ilegible no invalida al resto", () => {
    const dir = mkEmptyDir();
    const bad = {
      getAsFile: () => {
        throw new Error("boom");
      },
      webkitGetAsEntry: () => {
        throw new Error("boom");
      },
    };
    const good = { getAsFile: () => ({ path: dir }) };
    expect(pathsFromDrop(dragEvent({ files: [], items: [bad, good] }))).toEqual([dir]);
  });

  test("usa pathForFile (webUtils) cuando File.path no existe", () => {
    const dir = mkEmptyDir();
    const file = {};
    expect(pathsFromDrop(dragEvent({ files: [file], items: [] }), () => dir)).toEqual([dir]);
    const item = { getAsFile: () => file };
    expect(pathsFromDrop(dragEvent({ files: [], items: [item] }), () => dir)).toEqual([dir]);
  });
});
