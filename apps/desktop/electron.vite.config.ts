import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  main: {
    plugins: [
      // Solo electron queda externo: el core, shared y los SDK puros se empaquetan
      // para no depender de la resolución de node_modules en tiempo de ejecución.
      externalizeDepsPlugin({ exclude: ["@octus/core", "@octus/shared", "openai", "zod"] }),
    ],
    build: {
      outDir: "out/main",
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@octus/shared"] })],
    build: {
      outDir: "out/preload",
      rollupOptions: {
        // El preload de Electron se carga como CommonJS.
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [solid()],
    build: {
      outDir: "out/renderer",
    },
  },
});
