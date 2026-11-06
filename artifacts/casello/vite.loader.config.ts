// Build del caricatore botcave.js (IIFE, nessuna dipendenza). Gira DOPO la build principale,
// che svuota dist/public: qui emptyOutDir è false. Non richiede PORT né BASE_PATH.
import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public/embed/v1"),
    emptyOutDir: false,
    minify: true,
    lib: {
      entry: path.resolve(import.meta.dirname, "src/embed/loader/index.ts"),
      formats: ["iife"],
      name: "BotcaveLoader",
      fileName: () => "botcave.js",
    },
  },
});
