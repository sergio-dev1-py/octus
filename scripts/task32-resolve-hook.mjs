/** Hook de resolución solo para QA bajo node puro (Todo 32): mapea workspaces TS y el fallback .js -> .ts. */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = "C:/Users/UserPy/Documents/octus-wt-octus-ux-skills-mcp-w14";

export async function resolve(specifier, context, next) {
  if (specifier === "@octus/shared") {
    return { url: pathToFileURL(`${ROOT}/packages/shared/src/index.ts`).href, shortCircuit: true };
  }
  if (specifier === "@octus/core") {
    return { url: pathToFileURL(`${ROOT}/packages/core/src/index.ts`).href, shortCircuit: true };
  }
  try {
    return await next(specifier, context);
  } catch (error) {
    if (
      typeof specifier === "string" &&
      specifier.endsWith(".js") &&
      typeof context?.parentURL === "string" &&
      context.parentURL.startsWith("file:")
    ) {
      try {
        const candidate = fileURLToPath(new URL(specifier, context.parentURL));
        const ts = candidate.slice(0, -3) + ".ts";
        if (existsSync(ts)) return { url: pathToFileURL(ts).href, shortCircuit: true };
      } catch {
        // cae al error original
      }
    }
    throw error;
  }
}
