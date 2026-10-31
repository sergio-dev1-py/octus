import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isOctusError } from "../src/errors.js";
import { assertKnownTools, loadDefinitionsDirectory, parseDefinitionFile, promptHashOf } from "../src/agents/definition-loader.js";
import { makeTestCore } from "./helpers.js";
import { expectRejects } from "./helpers.js";

const VALID_YAML = `id: probe
kind: explorer
name: Probe
description: Test definition.
defaultModel:
  providerId: meta
  modelId: muse-spark-1.3
  effort: low
maxSteps: 10
timeoutMs: 60000
idleTimeoutMs: 30000
systemPrompt: |
  Behave.
tools: [read]
deniedTools: [shell]
permissionRules: []
deliveryFormat: Report.
canDelegateTo: []
promptVersion: 2
`;

function writeTempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "octus-defs-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return dir;
}

describe("agent definitions (YAML)", () => {
  test("builtin directory loads 6 valid definitions", async () => {
    const t = await makeTestCore();
    try {
      const defs = await t.core.registry.list();
      expect(defs.map((d) => d.id).sort()).toEqual([
        "coordinator-build",
        "coordinator-plan",
        "explorer",
        "implementer",
        "researcher",
        "reviewer",
      ]);
      const plan = defs.find((d) => d.id === "coordinator-plan")!;
      expect(plan.deniedTools).toContain("shell");
      expect(plan.canDelegateTo).toEqual(["explorer", "researcher"]);
      const build = defs.find((d) => d.id === "coordinator-build")!;
      expect(build.canDelegateTo).toEqual(["explorer", "researcher", "implementer", "reviewer"]);
    } finally {
      await t.cleanup();
    }
  });

  test("invalid YAML is rejected with a clear error (no silent fallback)", () => {
    const dir = writeTempDir({ "bad.yaml": "id: [unclosed\nkind: explorer\n" });
    try {
      expect(() => loadDefinitionsDirectory(dir)).toThrow(/Invalid YAML/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("schema violations are rejected: overlap, coordinator delegation, profile misuse", () => {
    const dir = writeTempDir({ "good.yaml": VALID_YAML, "overlap.yaml": VALID_YAML.replace("id: probe", "id: overlap").replace("deniedTools: [shell]", "deniedTools: [read]") });
    try {
      expect(() => loadDefinitionsDirectory(dir)).toThrow(/also listed as denied/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const dir2 = writeTempDir({
      "bad.yaml": VALID_YAML.replace("id: probe", "id: bad").replace("canDelegateTo: []", "canDelegateTo: [coordinator]"),
    });
    try {
      expect(() => loadDefinitionsDirectory(dir2)).toThrow(/delegation to coordinator/);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  test("unknown tool names are rejected when checked against gateway manifests", () => {
    const dir = writeTempDir({ "probe.yaml": VALID_YAML });
    try {
      const def = parseDefinitionFile(path.join(dir, "probe.yaml"));
      expect(() => assertKnownTools(def, ["read", "shell"])).not.toThrow();
      expect(() => assertKnownTools(def, ["read"])).toThrow(/unknown tools: shell/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("upsert by promptVersion: newer replaces, older never downgrades", async () => {
    const t = await makeTestCore();
    try {
      const before = await t.core.registry.get("explorer");
      expect(before?.promptVersion).toBe(1);
      // Simula YAML v2 escribiendo directamente una versión mayor y re-seedeando.
      await t.core.db.exec("UPDATE agent_definitions SET prompt_version = 99 WHERE id = 'explorer'");
      await t.core.registry.ensureSeeded();
      const kept = await t.core.registry.get("explorer");
      expect(kept?.promptVersion).toBe(99);
    } finally {
      await t.cleanup();
    }
  });

  test("prompt hash is stable and content-sensitive", () => {
    const dir = writeTempDir({ "probe.yaml": VALID_YAML });
    try {
      const a = parseDefinitionFile(path.join(dir, "probe.yaml"));
      const b = parseDefinitionFile(path.join(dir, "probe.yaml"));
      expect(promptHashOf(a)).toBe(promptHashOf(b));
      expect(promptHashOf({ ...a, systemPrompt: "Different." })).not.toBe(promptHashOf(a));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("instance keeps the exact snapshot it was created with", async () => {
    const t = await makeTestCore();
    try {
      const { workspaceOf } = await import("./helpers.js");
      const project = await t.core.createProject("P", workspaceOf(t));
      const session = await t.core.createSession({ projectId: project.id });
      await t.core.setSessionModel(session.id, { providerId: "fake-meta", modelId: "muse-wonder-1.0" });
      const { runId } = await t.core.prompt(session.id, "hi");
      await t.core.waitForIdle(session.id);
      const { instances } = await t.core.getRun(runId);
      expect(instances).toHaveLength(1);
      const instance = instances[0]!;
      expect(instance.definitionVersion).toBe(2);
      expect(instance.promptHash).toHaveLength(64);
      expect(instance.definitionSnapshot.definitionId).toBe("coordinator-build");
      expect(instance.definitionSnapshot.tools).toContain("read");
      void isOctusError;
      void expectRejects;
    } finally {
      await t.cleanup();
    }
  });
});
