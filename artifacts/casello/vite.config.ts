import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "fs";
import type { Plugin } from "vite";

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

// In dev le fetch relative a /api vanno inoltrate all'API locale (in produzione lo fa nginx).
const apiPort = Number(process.env.API_PORT ?? 3000);

if (Number.isNaN(apiPort) || apiPort <= 0) {
  throw new Error(`Invalid API_PORT value: "${process.env.API_PORT}"`);
}

// Identità Botcave: design/ alla radice del repository è la fonte di verità (token, logo, icone)
const designDir = path.resolve(import.meta.dirname, "..", "..", "design");
const designIconsDir = path.join(designDir, "icons");
const ICON_TYPES: Record<string, string> = { ".png": "image/png", ".svg": "image/svg+xml" };

/** Serve le icone di design/icons alla radice del sito (favicon, apple-touch-icon, manifest), senza copiarle in public/. */
function botcaveIcons(): Plugin {
  const names = () => fs.readdirSync(designIconsDir).filter((f) => path.extname(f) in ICON_TYPES);
  return {
    name: "botcave-icons",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = (req.url ?? "").split("?")[0]!.replace(base, "");
        if (!names().includes(name)) return next();
        res.setHeader("Content-Type", ICON_TYPES[path.extname(name)]!);
        res.end(fs.readFileSync(path.join(designIconsDir, name)));
      });
    },
    generateBundle() {
      for (const name of names()) {
        this.emitFile({ type: "asset", fileName: name, source: fs.readFileSync(path.join(designIconsDir, name)) });
      }
    },
  };
}
const base = basePath.endsWith("/") ? basePath : `${basePath}/`;

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    botcaveIcons(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@design": designDir,
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
    },
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
