// Build del programma di collaudo: un solo file ESM per Node 24, con la versione del pacchetto.
// `playwright` resta esterno: lo installa il workflow del repository di collaudo.
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: ["playwright"],
  define: { __COLLAUDO_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: "#!/usr/bin/env node" },
  outfile: new URL("../dist/casello-collaudo.mjs", import.meta.url).pathname,
  logLevel: "warning",
});
