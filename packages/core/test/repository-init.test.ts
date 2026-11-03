import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeTestCore, workspaceOf } from "./helpers.js";

describe("preparación automática del repositorio git", () => {
  test("inicializa git, crea .gitignore y deja un HEAD para worktrees", async () => {
    const t = await makeTestCore();
    try {
      const project = await t.core.createProject("P", workspaceOf(t));
      const first = await t.core.repositories.ensureInitialized(project.id);
      expect(first.initialized).toBe(true);
      expect(existsSync(path.join(workspaceOf(t), ".git"))).toBe(true);
      expect(readFileSync(path.join(workspaceOf(t), ".gitignore"), "utf8")).toContain("node_modules/");
      expect(first.head).toMatch(/^[0-9a-f]{40}$/);
      const second = await t.core.repositories.ensureInitialized(project.id);
      expect(second.initialized).toBe(false);
      expect(second.head).toBe(first.head);
    } finally {
      await t.cleanup();
    }
  }, 20_000);
});
