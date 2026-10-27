import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Postgres di prova (PGlite) dei test dell'API, per la prova da capo a fondo con l'API vera
    globalSetup: ["../api-server/test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
