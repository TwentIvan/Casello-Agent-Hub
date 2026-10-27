import { chmod, mkdir, readdir, rm, stat, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSecureUrl, runClaude, type ItemResult } from "./claude";

// Ciclo del runner: attesa lunga su Casello (`GET /api/runner/next`), esecuzione del compito con Claude Code,
// segnale di vita ogni 15 s durante l'esecuzione, poi `POST /api/runner/items/:id/done`. In ogni "posto" (uno per
// grado di concorrenza) l'ordine è sempre compito → done → nuova attesa: mai un'attesa con un done in sospeso.
// Nei log solo id, durate ed esiti: mai token né prompt.

export type Logger = (message: string, fields?: Record<string, string | number | boolean | null>) => void;

export interface RunnerOptions {
  /** Origine di Casello (https, http solo verso localhost). */
  url: string;
  /** Token di macchina `csl_m_…`. */
  token: string;
  /** Programma `claude`. */
  bin: string;
  /** Compiti eseguiti insieme (default 1). */
  concurrency?: number;
  /** Arresto: il compito in corso viene terminato e riportato con exit error. */
  signal: AbortSignal;
  log?: Logger;
  heartbeatMs?: number;
  killGraceMs?: number;
  /** Cartelle di lavoro dei lavori (default `~/.casello-runner/jobs`). */
  jobsRoot?: string;
}

/** Consegna di un compito (`GET /api/runner/next`). */
interface Delivery {
  jobId: number;
  itemId: string;
  jobToken: string;
  prompt: string;
  resumeSessionId: string | null;
  mcpUrl: string;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Consegna ben formata; altrimenti l'`itemId` se utilizzabile (per riportare il compito come fallito). */
function parseDelivery(body: unknown): { ok: true; delivery: Delivery } | { ok: false; itemId: string | null } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const itemId = nonEmpty(b["itemId"]) && b["itemId"].length <= 100 ? b["itemId"] : null;
  const valid =
    Number.isInteger(b["jobId"]) &&
    (b["jobId"] as number) > 0 &&
    itemId !== null &&
    nonEmpty(b["jobToken"]) &&
    nonEmpty(b["prompt"]) &&
    nonEmpty(b["mcpUrl"]) &&
    (b["resumeSessionId"] === null || nonEmpty(b["resumeSessionId"]));
  return valid ? { ok: true, delivery: b as unknown as Delivery } : { ok: false, itemId };
}

/** Stessa origine (schema, host, porta); false se non è un indirizzo. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Cartelle di lavoro più vecchie di così si cancellano all'avvio. */
const JOB_DIR_MAX_AGE_MS = 24 * 60 * 60_000;

/** Cancella le cartelle dei lavori non usate da più di 24 h (ultimo compito: data di modifica). */
async function cleanupJobDirs(root: string, now = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    const dir = join(root, name);
    try {
      if (now - (await stat(dir)).mtimeMs > JOB_DIR_MAX_AGE_MS) await rm(dir, { recursive: true, force: true });
    } catch {
      // cartella sparita nel frattempo: nulla da fare
    }
  }
}

/**
 * Cartella di lavoro del lavoro, 0700, la stessa per tutti i suoi compiti: Claude Code lega la sessione alla
 * cartella e `--resume` da un'altra cartella non la trova. Data di modifica aggiornata a ogni compito.
 */
async function jobDir(root: string, jobId: number): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = join(root, String(jobId));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const now = new Date();
  await utimes(dir, now, now);
  return dir;
}

const HEARTBEAT_MS = 15_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// Oltre l'attesa lunga del server (~25 s): una connessione appesa non blocca il runner
const NEXT_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
// All'arresto il done ha un solo tentativo breve
const SHUTDOWN_DONE_TIMEOUT_MS = 5_000;

export const MACHINE_TOKEN_REJECTED = "token di macchina non valido o revocato";

/** Configurazione dall'ambiente: `CASELLO_URL`, `CASELLO_RUNNER_TOKEN` (obbligatorie), `CASELLO_CLAUDE_BIN`, `CASELLO_RUNNER_CONCURRENCY`. */
export function readConfig(env: NodeJS.ProcessEnv): Pick<RunnerOptions, "url" | "token" | "bin" | "concurrency"> {
  const url = env["CASELLO_URL"]?.trim() ?? "";
  if (!url) throw new Error("CASELLO_URL mancante (es. https://casello.fantamister.cloud)");
  if (!isSecureUrl(url)) throw new Error("CASELLO_URL deve essere https (http solo verso localhost o 127.0.0.1)");
  const token = env["CASELLO_RUNNER_TOKEN"]?.trim() ?? "";
  if (!token.startsWith("csl_m_")) throw new Error("CASELLO_RUNNER_TOKEN mancante o non è un token di macchina (csl_m_…)");
  const rawConcurrency = env["CASELLO_RUNNER_CONCURRENCY"]?.trim() || "1";
  const concurrency = Number(rawConcurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("CASELLO_RUNNER_CONCURRENCY deve essere un intero tra 1 e 8");
  }
  return { url: new URL(url).origin, token, bin: env["CASELLO_CLAUDE_BIN"]?.trim() || "claude", concurrency };
}

/** Risposta HTTP inattesa da Casello. */
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** Token di macchina rifiutato: il runner si ferma (riprovare non serve). */
class FatalError extends Error {}

/** Errore da riprovare: rete, timeout, 5xx, 429. */
function isTransient(err: unknown): boolean {
  if (err instanceof HttpError) return err.status >= 500 || err.status === 429;
  return !(err instanceof FatalError);
}

/** Per l'attesa dei lavori si riprova ogni errore tranne il token rifiutato (anche un 4xx inatteso). */
const notFatal = (err: unknown) => !(err instanceof FatalError);

/** Descrizione breve di un errore per i log (stato HTTP o codice di rete, mai il testo completo). */
function describe(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  // fetch di Node: il codice di rete sta nella causa (o nella prima causa di un AggregateError)
  const cause = (err as { cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } } | null)?.cause;
  const code = cause?.code ?? cause?.errors?.[0]?.code;
  if (typeof code === "string") return code;
  return err instanceof Error ? err.name : "errore";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

const defaultLog: Logger = (message, fields) => {
  const extra = fields ? Object.entries(fields).map(([k, v]) => ` ${k}=${v}`).join("") : "";
  console.error(`[casello-runner] ${new Date().toISOString()} ${message}${extra}`);
};

/** Avvia il runner; termina all'arresto (`signal`) o con un errore se il token di macchina è rifiutato. */
export async function runRunner(opts: RunnerOptions): Promise<void> {
  const log = opts.log ?? defaultLog;
  const base = opts.url.replace(/\/+$/, "");
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const jobsRoot = opts.jobsRoot ?? join(homedir(), ".casello-runner", "jobs");
  // Arresto chiesto da fuori o errore fatale di un posto (ferma anche gli altri)
  const stopAll = new AbortController();
  const signal = AbortSignal.any([opts.signal, stopAll.signal]);

  async function request(method: string, path: string, timeoutMs: number, abort?: AbortSignal, body?: unknown): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`${base}/api/runner${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abort ? AbortSignal.any([abort, timeout]) : timeout,
    });
    if (res.status === 401) {
      await res.body?.cancel();
      throw new FatalError(MACHINE_TOKEN_REJECTED);
    }
    return res;
  }

  /** Ripete `fn` sugli errori da riprovare con attesa crescente (1 s → 30 s); null all'arresto. */
  async function withRetry<T>(what: string, retryable: (err: unknown) => boolean, fn: () => Promise<T>): Promise<T | null> {
    let delay = BACKOFF_MIN_MS;
    for (;;) {
      if (signal.aborted) return null;
      try {
        return await fn();
      } catch (err) {
        if (signal.aborted) return null;
        if (!retryable(err)) throw err;
        log(`richiesta a Casello non riuscita (${what}), riprovo tra ${delay / 1000} s`, { errore: describe(err) });
        await sleep(delay, signal);
        delay = Math.min(delay * 2, BACKOFF_MAX_MS);
      }
    }
  }

  async function next(): Promise<unknown> {
    const res = await request("GET", "/next", NEXT_TIMEOUT_MS, signal);
    if (res.status === 204) return null;
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new HttpError(res.status);
    }
    return (await res.json()) as unknown;
  }

  /** Segnale di vita: false se il lavoro non c'è più (410/404). */
  async function heartbeat(jobId: number): Promise<boolean> {
    const res = await request("POST", `/jobs/${jobId}/heartbeat`, REQUEST_TIMEOUT_MS);
    await res.body?.cancel();
    if (res.status === 410 || res.status === 404) return false;
    if (res.status !== 204) throw new HttpError(res.status);
    return true;
  }

  async function done(d: { jobId: number | null; itemId: string }, result: ItemResult): Promise<void> {
    const send = async (timeoutMs: number): Promise<true> => {
      const res = await request("POST", `/items/${encodeURIComponent(d.itemId)}/done`, timeoutMs, undefined, result);
      await res.body?.cancel();
      // 404/410: compito o lavoro già chiusi da Casello, nulla da riportare
      if (res.status === 404 || res.status === 410) log("compito già chiuso da Casello", { jobId: d.jobId, itemId: d.itemId, stato: res.status });
      else if (res.status !== 204) throw new HttpError(res.status);
      return true;
    };
    try {
      // Fuori dall'arresto si riprova finché serve; all'arresto (anche a metà dei tentativi) resta un tentativo breve
      const sent = signal.aborted ? null : await withRetry("fine del compito", isTransient, () => send(REQUEST_TIMEOUT_MS));
      if (sent === null) await send(SHUTDOWN_DONE_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof FatalError) throw err;
      log("fine del compito non riportata", { jobId: d.jobId, itemId: d.itemId, errore: describe(err) });
    }
  }

  async function runItem(d: Delivery): Promise<void> {
    const started = Date.now();
    log("compito ricevuto", { jobId: d.jobId, itemId: d.itemId, ripresa: d.resumeSessionId !== null });
    const item = new AbortController();
    const onStop = () => item.abort();
    if (signal.aborted) item.abort();
    else signal.addEventListener("abort", onStop, { once: true });
    let beating = false;
    const timer = setInterval(() => {
      if (beating || item.signal.aborted) return;
      beating = true;
      heartbeat(d.jobId)
        .then((alive) => {
          if (!alive && !item.signal.aborted) {
            log("lavoro non più attivo su Casello: interrompo Claude", { jobId: d.jobId, itemId: d.itemId });
            item.abort();
          }
        })
        .catch((err: unknown) => log("segnale di vita non riuscito", { jobId: d.jobId, errore: describe(err) }))
        .finally(() => (beating = false));
    }, heartbeatMs);
    let result: ItemResult = { sessionId: null, exit: "error", usage: null };
    try {
      // Il token del lavoro va solo al server MCP di Casello: stessa origine di CASELLO_URL
      if (!sameOrigin(d.mcpUrl, base)) {
        log("indirizzo MCP di un'altra origine: compito rifiutato", { jobId: d.jobId, itemId: d.itemId });
      } else {
        const workDir = await jobDir(jobsRoot, d.jobId);
        result = await runClaude(d, { bin: opts.bin, signal: item.signal, killGraceMs: opts.killGraceMs, workDir });
      }
    } catch (err) {
      log("cartella del lavoro non disponibile", { jobId: d.jobId, itemId: d.itemId, errore: describe(err) });
    } finally {
      clearInterval(timer);
      signal.removeEventListener("abort", onStop);
    }
    if (item.signal.aborted) result = { ...result, exit: "error" };
    log("compito terminato", { jobId: d.jobId, itemId: d.itemId, esito: result.exit, durataMs: Date.now() - started });
    await done(d, result);
  }

  async function slot(): Promise<void> {
    while (!signal.aborted) {
      const body = await withRetry("attesa dei lavori", notFatal, next);
      if (!body) continue;
      const parsed = parseDelivery(body);
      if (parsed.ok) {
        await runItem(parsed.delivery);
        continue;
      }
      log("consegna non valida", { itemId: parsed.itemId });
      if (parsed.itemId) await done({ jobId: null, itemId: parsed.itemId }, { sessionId: null, exit: "error", usage: null });
    }
  }

  const concurrency = Math.max(1, opts.concurrency ?? 1);
  log("runner avviato", { casello: base, concorrenza: concurrency });
  await cleanupJobDirs(jobsRoot);
  const results = await Promise.allSettled(
    Array.from({ length: concurrency }, () =>
      slot().catch((err: unknown) => {
        stopAll.abort();
        throw err;
      }),
    ),
  );
  const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  log("runner fermato");
  if (failure) throw failure.reason;
}
