// Build del programma di collaudo: un solo file ESM per Node 24, con la versione del pacchetto.
// `playwright` resta esterno: lo installa il workflow del repository di collaudo.
import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
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

// Distribuzione: copia con la versione nel nome (cache immutable) e manifest { version, file, sha256, size }.
const dist = new URL("../dist/", import.meta.url).pathname;
const file = `casello-collaudo-${pkg.version}.mjs`;
await copyFile(`${dist}casello-collaudo.mjs`, `${dist}${file}`);
const bytes = await readFile(`${dist}${file}`);
const manifest = {
  version: pkg.version,
  file,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
};
await writeFile(`${dist}collaudo-manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
