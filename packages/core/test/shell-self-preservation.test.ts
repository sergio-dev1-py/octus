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
  test("matar procesos se deniega para agentes (siempre, sin preguntar)", () => {
    expect(denies("taskkill /F /IM node.exe")).toMatch(/forbidden for agents/i);
    expect(denies("TASKKILL /F /IM NODE.EXE")).toMatch(/forbidden for agents/i);
    expect(denies("taskkill /F /IM electron.exe")).toMatch(/forbidden for agents/i);
    expect(denies("taskkill /F /PID 10868")).toMatch(/forbidden for agents/i);
    expect(denies("pkill -f node")).toMatch(/forbidden for agents/i);
    expect(denies("killall node")).toMatch(/forbidden for agents/i);
    expect(denies("powershell -Command Stop-Process -Name node -Force")).toMatch(/forbidden for agents/i);
    expect(denies("start /B node dist/server/entry.mjs")).toMatch(/background processes/i);
    expect(denies("powershell -Command Start-Process node")).toMatch(/detached powershell/i);
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
    expect(denies("taskkill /F /IM notepad.exe")).toMatch(/forbidden for agents/i);
  });

  test("sigue integrado con el gate git (sin regresión)", () => {
    allows("git status");
    assertShellGitAllowed("git status");
  });
});
