import { describe, expect, test } from "bun:test";
import { createId } from "../src/domain.js";

describe("shared", () => {
  test("createId prefixes and uniquifies", () => {
    const a = createId("ses");
    const b = createId("ses");
    expect(a.startsWith("ses_")).toBe(true);
    expect(a).not.toBe(b);
  });
});
