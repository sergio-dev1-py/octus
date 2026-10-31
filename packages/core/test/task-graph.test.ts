/** Etapa 3 — TaskGraph puro + validación de propuestas (sin DB). */
import { describe, expect, test } from "bun:test";
import { cascadeCancelSet, detectCycle, isDependencySatisfied, orderTasks, transitiveDependents, transitiveDeps, unsatisfiedDeps } from "../src/tasks/task-graph.js";

import type { Task } from "@octus/shared";

const t = (id: string, status: Task["status"] = "draft", needsReview = false) => ({ id, status, needsReview });
const d = (taskId: string, dependsOn: string) => ({ taskId, dependsOn, kind: "requires" as const });

describe("task graph", () => {
  test("detecta ciclos con camino explícito y auto-dependencias", () => {
    expect(detectCycle({ tasks: [t("a"), t("b"), t("c")], deps: [d("b", "a"), d("c", "b"), d("a", "c")] })).toEqual(["a", "c", "b", "a"]);
    expect(detectCycle({ tasks: [t("a")], deps: [d("a", "a")] })).toEqual(["a", "a"]);
    expect(detectCycle({ tasks: [t("a"), t("b")], deps: [d("b", "a")] })).toBeNull();
  });

  test("clausuras transitivas en ambas direcciones", () => {
    const g = { tasks: [t("a"), t("b"), t("c"), t("d")], deps: [d("b", "a"), d("c", "b"), d("d", "a")] };
    expect([...transitiveDeps(g, "c")].sort()).toEqual(["a", "b"]);
    expect([...transitiveDependents(g, "a")].sort()).toEqual(["b", "c", "d"]);
  });

  test("ready-gate exige reviewed cuando la dependencia lo requiere", () => {
    expect(isDependencySatisfied("completed", false)).toBe(true);
    expect(isDependencySatisfied("reviewed", true)).toBe(true);
    expect(isDependencySatisfied("completed", true)).toBe(false);
    expect(isDependencySatisfied("failed", false)).toBe(false);
    const g = { tasks: [t("impl", "completed", true), t("c", "draft")], deps: [d("c", "impl")] };
    expect(unsatisfiedDeps(g).get("c")).toEqual(["impl"]);
  });

  test("cascada conserva completed/reviewed y corta la propagación", () => {
    const g = {
      tasks: [t("root", "running"), t("done", "completed"), t("child", "ready"), t("indep", "ready"), t("grand", "ready")],
      deps: [d("child", "root"), d("done", "root"), d("grand", "child")],
    };
    const out = cascadeCancelSet(g, "root");
    expect([...out].sort()).toEqual(["child", "grand", "root"]);
  });

  test("orden determinista: prioridad, creación, id", () => {
    const tasks = [
      { id: "b", priority: 1, createdAt: 2 },
      { id: "a", priority: 1, createdAt: 2 },
      { id: "c", priority: 5, createdAt: 9 },
      { id: "d", priority: 1, createdAt: 1 },
    ];
    expect(orderTasks(tasks).map((x) => x.id)).toEqual(["c", "d", "a", "b"]);
  });
});
