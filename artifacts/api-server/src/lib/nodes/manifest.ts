// Manifest di Botcave Nodo (`nodo-manifest.json`, scritto dalla build e messo nell'immagine dell'API): versione
// corrente, versione minima compatibile con il protocollo e i file scaricabili. Senza manifest (sviluppo) nessun
// aggiornamento è proposto e nessun nodo è «sotto la versione minima». Letto una volta per percorso e tenuto in memoria.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { logger } from "../logger";

const FileSchema = z.object({ file: z.string().min(1), sha256: z.string().min(1), size: z.number().int().nonnegative() });

const ManifestSchema = z.object({
  version: z.string().min(1),
  minVersion: z.string().min(1),
  binary: FileSchema,
  app: FileSchema,
});

export type NodeManifest = z.infer<typeof ManifestSchema>;

export interface NodeUpdate {
  version: string;
  sha256: string;
  size: number;
  required: boolean;
}

const DEFAULT_PATH = "/app/nodo/nodo-manifest.json";
const cache = new Map<string, NodeManifest | null>();

/** Percorso del manifest (variabile `NODO_MANIFEST_PATH`, letta a ogni chiamata). */
export function manifestPath(): string {
  return process.env["NODO_MANIFEST_PATH"] ?? DEFAULT_PATH;
}

/** Manifest del nodo; null se il file manca o non è valido (una riga di log, solo la prima volta). */
export function loadNodeManifest(path: string = manifestPath()): NodeManifest | null {
  if (cache.has(path)) return cache.get(path) ?? null;
  let manifest: NodeManifest | null = null;
  try {
    manifest = ManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    logger.info({ reason: missing ? "assente" : "non valido" }, "Manifest di Botcave Nodo non disponibile: nessun aggiornamento proposto");
  }
  cache.set(path, manifest);
  return manifest;
}

/** Dimentica i manifest letti (per le prove). */
export function resetNodeManifestCache(): void {
  cache.clear();
}

/** Parti numeriche di una versione `x.y.z` (anche con prefisso `v` o suffisso `-…`); null se non è riconoscibile. */
function parts(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0, 1 come `a <=> b`; null se una delle due non è una versione `x.y.z`. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parts(a);
  const pb = parts(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! < pb[i]! ? -1 : 1;
  }
  return 0;
}

/** Il nodo ha una versione sotto la minima del manifest: il server non gli consegna lavoro (ogni `kind`). */
export function isBelowMinVersion(nodeVersion: string | null, manifest: NodeManifest | null): boolean {
  if (!manifest || nodeVersion === null) return false;
  return compareVersions(nodeVersion, manifest.minVersion) === -1;
}

/**
 * Aggiornamento proposto a un nodo installato con l'app (`kind === "app"`): versione più vecchia di quella del
 * manifest e diversa da quella che ha già fallito; sha256 e dimensione sono del binario (`casello-nodo-<versione>`). `required` se è sotto la versione minima.
 */
export function updateFor(
  nodeVersion: string | null,
  kind: string | null,
  manifest: NodeManifest | null,
  failedVersion: string | null = null,
): NodeUpdate | null {
  if (!manifest || kind !== "app" || nodeVersion === null) return null;
  if (compareVersions(nodeVersion, manifest.version) !== -1) return null;
  if (failedVersion !== null && failedVersion === manifest.version) return null;
  return { version: manifest.version, sha256: manifest.binary.sha256, size: manifest.binary.size, required: isBelowMinVersion(nodeVersion, manifest) };
}
