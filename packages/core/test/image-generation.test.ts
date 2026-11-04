import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ModelProvider } from "@octus/shared";
import { ImageGenerationService } from "../src/images/image-service.js";
import { makeTestCore, workspaceOf } from "./helpers.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl6kAAAAASUVORK5CYII=";

function fakeImageProvider(): ModelProvider {
  return {
    id: "image-fake",
    displayName: "Image Fake",
    billable: false,
    models: () => [
      {
        providerId: "image-fake",
        modelId: "fake-image",
        displayName: "Fake Image",
        capabilities: {
          toolCall: false,
          reasoningEfforts: [],
          maxContextTokens: 8192,
          maxOutputTokens: 1024,
          supportsImages: true,
          imageGeneration: true,
        },
      },
    ],
    capabilitiesOf: () => undefined,
    generateStream: async function* () {
      yield { type: "error", error: { code: "bad_request", message: "not a chat model", retryable: false } };
    },
    generateImage: async () => ({
      providerId: "image-fake",
      modelId: "fake-image",
      images: [{ base64: PNG, mimeType: "image/png" }],
    }),
  };
}

describe("image_generate tool", () => {
  test("usa el modelo de imagen configurado y guarda dentro del workspace", async () => {
    const t = await makeTestCore();
    try {
      t.core.router.register(fakeImageProvider());
      const service = new ImageGenerationService(t.core.router, t.core.config);
      const files = await service.generate(
        { prompt: "hero image for a premium store", n: 1, model: { providerId: "image-fake", modelId: "fake-image" }, runId: "run_img" },
        { directory: workspaceOf(t), protectedRoots: [], signal: AbortSignal.timeout(10_000) },
      );
      expect(files).toHaveLength(1);
      expect(files[0]!.path.startsWith("public/generated/")).toBe(true);
      const absolute = path.join(workspaceOf(t), files[0]!.path);
      expect(existsSync(absolute)).toBe(true);
      expect(readFileSync(absolute).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    } finally {
      await t.cleanup();
    }
  });

  test("persiste la selección de modelo de imagen en ajustes", async () => {
    const t = await makeTestCore();
    try {
      t.core.router.register(fakeImageProvider());
      const initial = await t.core.agentModelSettings();
      expect(initial.imageModel).toEqual({ providerId: "meta", modelId: "muse-image-1.0" });
      await t.core.setAgentModelAssignments(false, [], { providerId: "image-fake", modelId: "fake-image" });
      expect((await t.core.agentModelSettings()).imageModel).toEqual({ providerId: "image-fake", modelId: "fake-image" });
    } finally {
      await t.cleanup();
    }
  });
});
