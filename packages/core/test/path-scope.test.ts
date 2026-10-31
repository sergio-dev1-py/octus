import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isSecretBasename, isUncPath, resolveInScope } from "../src/tools/path-scope.js";
import { isOctusError } from "../src/errors.js";

describe("path scope", () => {
  test("allows files inside the workspace", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octus-scope-"));
    try {
      mkdirSync(path.join(dir, "sub"), { recursive: true });
      writeFileSync(path.join(dir, "sub", "a.txt"), "x");
      const resolved = resolveInScope(dir, "sub/a.txt");
      expect(resolved.endsWith("a.txt")).toBe(true);
      const nested = resolveInScope(dir, "new/nested/file.txt");
      expect(nested).toContain("nested");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("blocks .. escapes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octus-scope-"));
    try {
      try {
        resolveInScope(dir, "../outside.txt");
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(isOctusError(error, "scope_violation")).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("blocks symlink/junction escapes after realpath resolution", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octus-scope-"));
    try {
      const outside = mkdtempSync(path.join(tmpdir(), "octus-outside-"));
      try {
        writeFileSync(path.join(outside, "secret.txt"), "secret");
        // Junction en Windows (sin privilegios extra), symlink en POSIX.
        const type = process.platform === "win32" ? "junction" : "dir";
        symlinkSync(outside, path.join(dir, "link"), type);
        try {
          resolveInScope(dir, "link/secret.txt");
          expect.unreachable("should have thrown");
        } catch (error) {
          expect(isOctusError(error, "scope_violation")).toBe(true);
        }
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("blocks secret basenames but allows the documented example", () => {
    expect(isSecretBasename(".env")).toBe(true);
    expect(isSecretBasename(".env.local")).toBe(true);
    expect(isSecretBasename(".ENV.PROD")).toBe(true);
    expect(isSecretBasename(".env.example")).toBe(false);
    expect(isSecretBasename("env.txt")).toBe(false);
    const dir = mkdtempSync(path.join(tmpdir(), "octus-scope-"));
    try {
      writeFileSync(path.join(dir, ".env"), "K=x");
      writeFileSync(path.join(dir, ".env.example"), "K=");
      try {
        resolveInScope(dir, ".env");
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(isOctusError(error, "scope_violation")).toBe(true);
      }
      expect(resolveInScope(dir, ".env.example").endsWith(".env.example")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("blocks protected roots even inside the workspace", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octus-scope-"));
    try {
      const protectedDir = path.join(dir, "octus-data");
      mkdirSync(protectedDir, { recursive: true });
      writeFileSync(path.join(protectedDir, "octus.db"), "x");
      writeFileSync(path.join(dir, "ok.txt"), "x");
      try {
        resolveInScope(dir, "octus-data/octus.db", { protectedRoots: [protectedDir] });
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(isOctusError(error, "scope_violation")).toBe(true);
      }
      expect(resolveInScope(dir, "ok.txt", { protectedRoots: [protectedDir] }).endsWith("ok.txt")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("denies UNC paths by default", () => {
    expect(isUncPath("\\\\server\\share\\file.txt")).toBe(true);
    expect(isUncPath("//server/share/file.txt")).toBe(true);
    expect(isUncPath("C:\\win\\file.txt")).toBe(false);
    expect(isUncPath("relative/file.txt")).toBe(false);
    const dir = mkdtempSync(path.join(tmpdir(), "octus-scope-"));
    try {
      try {
        resolveInScope(dir, "\\\\server\\share\\file.txt");
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(isOctusError(error, "scope_violation")).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
