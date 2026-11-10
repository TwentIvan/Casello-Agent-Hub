import { createHash } from "node:crypto";
import { createReadStream, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chmod, copyFile, link, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Aggiornamento proposto dall'heartbeat (spec §5). */
export interface UpdateInfo {
  version: string;
  sha256: string;
  size: number;
  required: boolean;
}

/** File dell'aggiornamento automatico, tutti nella cartella del programma dell'app o accanto alla config. */
export interface UpdatePaths {
  /** Programma installato dell'app (`~/.casello-nodo/bin/casello-nodo`): lo lancia il LaunchAgent. */
  programPath: string;
  /** Versione precedente, per il ritorno indietro. */
  prevPath: string;
  /** Download in corso (mai eseguito: si rinomina sul programma solo dopo la verifica). */
  downloadPath: string;
  /** `{from, to, startedAt, starts}` durante un aggiornamento; `{failedVersion, …}` dopo un ritorno indietro. */
  updateJsonPath: string;
}

export const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** Attesa massima dei compiti e dei turni in corso prima di sostituire il programma. */
export const DRAIN_MAX_MS = 30 * 60_000;
/** Dopo un errore (download, verifica, lavoro ancora in corso) si riprova al più una volta all'ora. */
export const UPDATE_RETRY_MS = 60 * 60_000;
const ROLLBACK_WINDOW_MS = 2 * 60_000;
const ROLLBACK_STARTS = 3;

/** Versione semver-like: entra in un percorso e in un indirizzo, quindi nient'altro che cifre, punti e un suffisso semplice. */
const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z]{1,20}(?:\.[0-9A-Za-z]{1,20}){0,3})?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export function isValidVersion(v: string): boolean {
  return v.length <= 40 && VERSION_PATTERN.test(v);
}

export function updatePaths(home = homedir()): UpdatePaths {
  const dir = path.join(home, ".casello-nodo");
  const programPath = path.join(dir, "bin", "casello-nodo");
  return {
    programPath,
    prevPath: `${programPath}.prev`,
    downloadPath: `${programPath}.download`,
    updateJsonPath: path.join(dir, "update.json"),
  };
}

/** Indirizzo del binario: sempre dalla config, mai dalla risposta dell'heartbeat. */
export function downloadUrl(caselloUrl: string, version: string): string {
  return `${caselloUrl.replace(/\/+$/, "")}/downloads/nodo/casello-nodo-${version}`;
}

export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateError";
  }
}

/** Scarica `url` in `dest`; errore se la risposta supera `maxBytes`. */
export type Downloader = (url: string, dest: string, maxBytes: number) => Promise<void>;

/**
 * Download con `fetch`: nessun redirect, 10 minuti in tutto, interrotto appena il corpo supera `maxBytes`. Nessun header
 * di autenticazione: il file è pubblico, il token del nodo non esce.
 */
export function fetchDownloader(fetchImpl: typeof fetch = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS): Downloader {
  return async (url, dest, maxBytes) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    let res: Response;
    try {
      res = await fetchImpl(url, { redirect: "error", signal });
    } catch {
      throw new UpdateError("download dell'aggiornamento non riuscito");
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw new UpdateError(`download dell'aggiornamento non riuscito (HTTP ${res.status})`);
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body.cancel().catch(() => {});
      throw new UpdateError("aggiornamento più grande del previsto");
    }
    const file = await open(dest, "w", 0o700);
    let bytes = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          controller.abort();
          throw new UpdateError("aggiornamento più grande del previsto");
        }
        await file.write(chunk);
      }
    } catch (err) {
      if (err instanceof UpdateError) throw err;
      throw new UpdateError("download dell'aggiornamento interrotto");
    } finally {
      await file.close();
    }
  };
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface ApplyUpdateDeps {
  /** Indirizzo di Botcave della config. */
  caselloUrl: string;
  currentVersion: string;
  paths: UpdatePaths;
  download: Downloader;
  /** Smette di prendere lavoro e aspetta quello in corso; false se scade. */
  drain(maxMs: number): Promise<boolean>;
  /** Interrompe il lavoro in corso come uno stop (solo per un aggiornamento obbligatorio). */
  interrupt(): Promise<void>;
  /** Riprende a prendere lavoro (aggiornamento rinviato). */
  resume(): void;
  exit(code: number): void;
  now?: () => Date;
}

/** Scrittura atomica (temporaneo e rename) con permessi 600. */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * Sostituzione: `.prev` nasce come collegamento fisico al programma installato (che quindi non manca mai), poi il
 * nuovo si rinomina sopra il programma. Ogni passo è un rename atomico: se il processo muore in mezzo, al percorso
 * del programma c'è sempre un file intero (il vecchio o il nuovo).
 */
async function replaceProgram(paths: UpdatePaths): Promise<void> {
  const prevTmp = `${paths.prevPath}.${process.pid}.tmp`;
  await rm(prevTmp, { force: true });
  try {
    await link(paths.programPath, prevTmp);
  } catch {
    await copyFile(paths.programPath, prevTmp);
  }
  await rename(prevTmp, paths.prevPath);
  await rename(paths.downloadPath, paths.programPath);
}

/**
 * Aggiornamento automatico (spec §5): scarica `<caselloUrl>/downloads/nodo/casello-nodo-<version>` in
 * `casello-nodo.download`, ne verifica dimensione e sha256, aspetta il lavoro in corso (al più 30 minuti; obbligatorio:
 * poi lo interrompe, altrimenti rinvia), sostituisce il programma tenendo `.prev`, scrive `update.json` ed esce con 0
 * (launchd lo riavvia). Ogni errore lascia intatto il programma installato e lancia `UpdateError`.
 */
export async function applyUpdate(update: UpdateInfo, deps: ApplyUpdateDeps): Promise<void> {
  const { paths } = deps;
  if (!isValidVersion(update.version)) throw new UpdateError("versione dell'aggiornamento non valida");
  if (!SHA256_PATTERN.test(update.sha256)) throw new UpdateError("impronta dell'aggiornamento non valida");
  if (!Number.isInteger(update.size) || update.size <= 0 || update.size > MAX_DOWNLOAD_BYTES) {
    throw new UpdateError("dimensione dell'aggiornamento non valida");
  }

  await rm(paths.downloadPath, { force: true });
  try {
    await deps.download(downloadUrl(deps.caselloUrl, update.version), paths.downloadPath, update.size);
    const { size } = await stat(paths.downloadPath);
    if (size !== update.size) throw new UpdateError("dimensione dell'aggiornamento diversa dal previsto");
    if ((await sha256File(paths.downloadPath)).toLowerCase() !== update.sha256.toLowerCase()) {
      throw new UpdateError("l'impronta dell'aggiornamento non corrisponde");
    }
    await chmod(paths.downloadPath, 0o755);
  } catch (err) {
    await rm(paths.downloadPath, { force: true }).catch(() => {});
    throw err instanceof UpdateError ? err : new UpdateError("download dell'aggiornamento non riuscito");
  }

  let interrupted = false;
  try {
    if (!(await deps.drain(DRAIN_MAX_MS))) {
      if (!update.required) throw new UpdateError("lavoro ancora in corso: aggiornamento rinviato");
      await deps.interrupt();
      interrupted = true;
    }
    const now = deps.now?.() ?? new Date();
    // Prima update.json, poi il rename: un nuovo programma senza update.json non avrebbe il ritorno indietro
    await writeJsonAtomic(paths.updateJsonPath, {
      from: deps.currentVersion,
      to: update.version,
      startedAt: now.toISOString(),
      starts: 0,
    });
    await replaceProgram(paths);
  } catch (err) {
    await rm(paths.downloadPath, { force: true }).catch(() => {});
    if (interrupted) {
      // Il lavoro è già fermo: si riparte con il programma di prima
      deps.exit(1);
      return;
    }
    deps.resume();
    throw err instanceof UpdateError ? err : new UpdateError("sostituzione del programma non riuscita");
  }
  deps.exit(0);
}

interface OpenUpdate {
  from: string;
  to: string;
  startedAt: string;
  starts: number;
}

function readUpdateJson(paths: UpdatePaths): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(paths.updateJsonPath, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asOpen(rec: Record<string, unknown> | null): OpenUpdate | null {
  if (!rec || typeof rec.failedVersion === "string") return null;
  const { from, to, startedAt, starts } = rec;
  if (typeof from !== "string" || typeof to !== "string" || typeof startedAt !== "string" || typeof starts !== "number") {
    return null;
  }
  return { from, to, startedAt, starts };
}

function writeJsonSync(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * All'avvio del servizio (prima del ciclo): con un aggiornamento aperto conta gli avvii; al terzo entro 2 minuti
 * dall'aggiornamento, senza un heartbeat riuscito in mezzo, ripristina `casello-nodo.prev` e registra la versione
 * fallita. "rolled_back" = chi chiama deve uscire (launchd riavvia la versione ripristinata).
 */
export function checkUpdateOnStart(paths: UpdatePaths, now: Date = new Date()): "ok" | "rolled_back" {
  const open = asOpen(readUpdateJson(paths));
  if (!open) return "ok";
  const starts = open.starts + 1;
  const elapsed = now.getTime() - Date.parse(open.startedAt);
  try {
    if (starts >= ROLLBACK_STARTS && elapsed >= 0 && elapsed <= ROLLBACK_WINDOW_MS) {
      try {
        renameSync(paths.prevPath, paths.programPath);
      } catch {
        // Nessuna versione precedente da ripristinare: si continua con quella installata
        writeJsonSync(paths.updateJsonPath, { ...open, starts });
        return "ok";
      }
      writeJsonSync(paths.updateJsonPath, {
        failedVersion: open.to,
        from: open.from,
        to: open.to,
        failedAt: now.toISOString(),
      });
      return "rolled_back";
    }
    writeJsonSync(paths.updateJsonPath, { ...open, starts });
  } catch {
    // update.json non scrivibile: il nodo parte comunque
  }
  return "ok";
}

/** Primo heartbeat riuscito della nuova versione: l'aggiornamento è andato a buon fine. */
export function markUpdateHealthy(paths: UpdatePaths): void {
  if (!asOpen(readUpdateJson(paths))) return;
  try {
    rmSync(paths.updateJsonPath, { force: true });
  } catch {
    // al prossimo heartbeat riuscito
  }
}

/** Versione il cui aggiornamento è stato annullato con il ritorno indietro (riferita nell'heartbeat). */
export function readFailedVersion(paths: UpdatePaths): string | undefined {
  const v = readUpdateJson(paths)?.failedVersion;
  return typeof v === "string" && isValidVersion(v) ? v : undefined;
}
