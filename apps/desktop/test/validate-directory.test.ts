import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkDirectoryReadable, directoryErrorMessage } from "../src/main/validate-directory.js";

/** Plan octus-welcome-settings-theme, todo 3: dirs vacíos = workspace normal. */
const trash: string[] = [];
afterEach(() => {
  while (trash.length > 0) fs.rmSync(trash.pop()!, { recursive: true, force: true });
});

function mkTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octus-empty-"));
  trash.push(dir);
  return dir;
}

describe("checkDirectoryReadable (todo 3: vacíos aceptados)", () => {
  test("empty dir is accepted as a normal workspace", () => {
    const dir = mkTempDir();
    expect(fs.readdirSync(dir).length).toBe(0);
    const check = checkDirectoryReadable(dir);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.realPath.length).toBeGreaterThan(0);
  });

  test("dir with files is still accepted", () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    expect(checkDirectoryReadable(dir).ok).toBe(true);
  });

  test("missing path is rejected as not-found", () => {
    const dir = mkTempDir();
    const check = checkDirectoryReadable(path.join(dir, "no-existe-xyz"));
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.error).toBe("not-found");
      expect(directoryErrorMessage(check)).toBe("La carpeta no existe.");
    }
  });

  test("file path is rejected as not-directory", () => {
    const dir = mkTempDir();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "x");
    const check = checkDirectoryReadable(file);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.error).toBe("not-directory");
      expect(directoryErrorMessage(check)).toBe("La ruta no es una carpeta.");
    }
  });

  test("blank drop (text) keeps the honest soltado-vacio error", () => {
    const check = checkDirectoryReadable("   ");
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.error).toBe("empty");
      expect(directoryErrorMessage(check)).toContain("soltado vac");
    }
  });
});
