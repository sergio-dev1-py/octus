/**
 * @octus/core — generación de imágenes como tool determinista.
 * El modelo de imagen es un proveedor, no un agente: el padre decide cuándo
 * generar y la tool solo hace prompt → API → archivo dentro del workspace.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ImageGenerateResult, ModelSelection } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { ModelRouter } from "../providers/model-router.js";
import type { ConfigStore } from "../config/config-store.js";
import { resolveInScope, scopeRelative } from "../tools/path-scope.js";

export interface ImageToolInput {
  prompt: string;
  n?: number;
  size?: string;
  outputPath?: string;
  model?: ModelSelection;
  runId: string;
}

export interface ImageToolContext {
  directory: string;
  protectedRoots: string[];
  signal: AbortSignal;
}

export interface GeneratedImageFile {
  path: string;
  mimeType: string;
  providerId: string;
  modelId: string;
}

const DEFAULT_IMAGE_MODEL: ModelSelection = { providerId: "meta", modelId: "muse-image-1.0" };
const MAX_IMAGES_PER_RUN = 8;

export class ImageGenerationService {
  private readonly perRun = new Map<string, number>();

  constructor(
    private readonly router: ModelRouter,
    private readonly config: ConfigStore,
  ) {}

  async generate(input: ImageToolInput, ctx: ImageToolContext): Promise<GeneratedImageFile[]> {
    const settings = this.config.get().agentModels;
    const selection = input.model ?? (settings?.enabled ? settings.imageModel : undefined) ?? DEFAULT_IMAGE_MODEL;
    const resolution = this.router.resolve({ instance: selection, globalDefault: selection });
    if (!resolution.model.capabilities.imageGeneration || !resolution.provider.generateImage) {
      throw new OctusError("model_not_supported", `Model ${selection.providerId}/${selection.modelId} does not generate images`);
    }
    const used = this.perRun.get(input.runId) ?? 0;
    const count = Math.min(Math.max(input.n ?? 1, 1), 4);
    if (used + count > MAX_IMAGES_PER_RUN) {
      throw new OctusError("tool_denied", `Image generation limit reached for this run (${MAX_IMAGES_PER_RUN} images)`);
    }
    const result: ImageGenerateResult = await resolution.provider.generateImage(
      { modelId: selection.modelId, prompt: input.prompt, n: count, size: input.size },
      ctx.signal,
    );
    this.perRun.set(input.runId, used + result.images.length);

    const files: GeneratedImageFile[] = [];
    for (let index = 0; index < result.images.length; index++) {
      const image = result.images[index]!;
      const bytes = image.base64 ? Buffer.from(image.base64, "base64") : await this.download(image.url, ctx.signal);
      const relative = this.outputRelative(input, index, result.images.length);
      const absolute = resolveInScope(ctx.directory, relative, { protectedRoots: ctx.protectedRoots });
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, bytes);
      files.push({
        path: scopeRelative(ctx.directory, absolute).replaceAll("\\", "/"),
        mimeType: image.mimeType ?? "image/png",
        providerId: result.providerId,
        modelId: result.modelId,
      });
    }
    return files;
  }

  private async download(url: string | undefined, signal: AbortSignal): Promise<Buffer> {
    if (!url) throw new OctusError("tool_failed", "Image provider returned neither base64 nor a URL");
    const response = await fetch(url, { signal });
    if (!response.ok) throw new OctusError("tool_failed", `Image download failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  private outputRelative(input: ImageToolInput, index: number, total: number): string {
    const explicit = input.outputPath?.trim();
    if (explicit) {
      const normalized = explicit.replaceAll("\\", "/");
      if (total === 1) return normalized;
      const ext = path.posix.extname(normalized);
      const base = ext ? normalized.slice(0, -ext.length) : normalized;
      return `${base}-${index + 1}${ext || ".png"}`;
    }
    const slug =
      input.prompt
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "image";
    return path.posix.join("public", "generated", `${slug}-${Date.now()}-${index + 1}.png`);
  }
}
