import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    // Postgres di prova condiviso (PGlite): i file di test non girano in parallelo
    fileParallelism: false,
  },
});
