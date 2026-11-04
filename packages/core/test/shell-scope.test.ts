import { describe, expect, test } from "bun:test";
import { assertShellScope } from "../src/tools/shell-guard.js";

const cwd = process.platform === "win32" ? "C:\\work\\project" : "/work/project";

describe("shell scope guard", () => {
  test("permite comandos y rutas dentro del workspace", () => {
    expect(() => assertShellScope("npm run typecheck", cwd)).not.toThrow();
    expect(() => assertShellScope("bun test packages/core/test", cwd)).not.toThrow();
    expect(() => assertShellScope('node -e "console.log(1)"', cwd)).not.toThrow();
    expect(() => assertShellScope(`type ${cwd}\\src\\a.ts`, cwd)).not.toThrow();
    expect(() => assertShellScope("cd src", cwd)).not.toThrow();
  });

  test("deniega rutas absolutas fuera del workspace", () => {
    expect(() => assertShellScope("type C:\\Users\\UserPy\\Desktop\\tr\\package.json", cwd)).toThrow(/escapes|denied/i);
    expect(() => assertShellScope("cd ..", cwd)).toThrow(/escapes|denied/i);
    expect(() => assertShellScope("type ..\\secret.txt", cwd)).toThrow(/escapes|denied/i);
    expect(() => assertShellScope("type \\\\server\\share\\x", cwd)).toThrow(/escapes|denied/i);
    expect(() => assertShellScope("cat /etc/passwd", cwd)).toThrow(/escapes|denied/i);
  });

  test("deniega el árbol del harness, incluso vía variables de entorno", () => {
    expect(() => assertShellScope("type C:\\Users\\UserPy\\AppData\\Roaming\\@octus\\desktop\\data\\octus.db", cwd)).toThrow(/harness|denied/i);
    expect(() => assertShellScope("type %APPDATA%\\@octus\\desktop\\data\\secrets.json", cwd)).toThrow(/harness|denied/i);
    expect(() => assertShellScope("type $env:APPDATA\\@octus\\desktop\\data\\config.json", cwd)).toThrow(/harness|denied/i);
  });

  test("detecta rutas dentro de código citado y raíces protegidas", () => {
    expect(() => assertShellScope('python -c "open(\'C:/tmp/out.txt\',\'w\')"', cwd)).toThrow(/escapes|denied/i);
    expect(() =>
      assertShellScope('powershell -Command "Get-Content C:\\Users\\UserPy\\secret.txt"', cwd),
    ).toThrow(/escapes|denied/i);
    expect(() => assertShellScope("type C:\\secret\\x", "C:\\work\\project", ["C:\\secret"])).toThrow(/protected|denied/i);
  });

  test("deniega los worktrees de otros workers desde la raíz del proyecto", () => {
    const project = process.platform === "win32" ? "C:\\work\\project" : "/work/project";
    const other = process.platform === "win32" ? `${project}\\.octus\\worktrees\\prj_x\\tsk_y` : `${project}/.octus/worktrees/prj_x/tsk_y`;
    expect(() => assertShellScope(`type ${other}\\src\\a.ts`, project)).toThrow(/worker|denied/i);
  });
});
