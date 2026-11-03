import { describe, expect, test } from "bun:test";
import { isOctusError } from "../src/errors.js";
import { assertShellGitAllowed, assertShellSelfPreservation } from "../src/tools/shell-guard.js";

function denies(command: string): string {
  try {
    assertShellSelfPreservation(command);
  } catch (error) {
    if (isOctusError(error, "scope_violation")) return error.message;
    throw new Error(`wrong error for ${command}: ${String(error)}`);
  }
  throw new Error(`did not deny: ${command}`);
}

function allows(command: string): void {
  assertShellSelfPreservation(command);
}

describe("shell self-preservation (nunca matar al harness ni tocar sistema)", () => {
  test("taskkill/pkill contra node/electron/bun se deniega", () => {
    expect(denies("taskkill /F /IM node.exe")).toMatch(/own processes/i);
    expect(denies("TASKKILL /F /IM NODE.EXE")).toMatch(/own processes/i);
    expect(denies("taskkill /F /IM electron.exe")).toMatch(/own processes/i);
    expect(denies("pkill -f node")).toMatch(/own processes/i);
    expect(denies("killall node")).toMatch(/own processes/i);
    expect(denies("powershell -Command Stop-Process -Name node -Force")).toMatch(/own processes/i);
  });

  test("formatear o particionar se deniega", () => {
    expect(denies("format D: /FS:NTFS /Q")).toMatch(/forbidden/i);
    expect(denies("diskpart")).toMatch(/forbidden/i);
  });

  test("borrar raíces del sistema se deniega", () => {
    expect(denies("del C:\\Windows\\Temp\\x.txt")).toMatch(/protected system/i);
    expect(denies("rd /s /q C:\\")).toMatch(/protected system/i);
    expect(denies("rm -rf /")).toMatch(/protected system/i);
  });

  test("operaciones normales y relativas siguen pasando", () => {
    allows("dir");
    allows("node -v");
    allows("npm test");
    allows("del build\\out.txt");
    allows("rm -rf dist");
    allows("Remove-Item .\\temp\\*.log");
    allows("taskkill /F /IM notepad.exe");
  });

  test("sigue integrado con el gate git (sin regresión)", () => {
    allows("git status");
    assertShellGitAllowed("git status");
  });
});
