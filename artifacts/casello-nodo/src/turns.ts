import { rm } from "node:fs/promises";
import { HttpError, type CaselloClient, type TurnPackage } from "./client";
import type { Config } from "./config";
import type { Logger } from "./log";
import type { SpawnFn } from "./runner";
import { runTurn } from "./turn-runner";

export interface TurnLoopOptions {
  config: Config;
  client: CaselloClient;
  logger: Logger;
  /** Cartella delle cartelle temporanee dei turni. */
  turnsDir: string;
  spawn?: SpawnFn;
  /** Attesa dopo un errore di rete o 5xx (default 5 s). */
  errorWaitMs?: number;
  /** Attesa con il nodo disattivato, 403 (default 30 s). */
  disabledWaitMs?: number;
  pingIntervalMs?: number;
  killGraceMs?: number;
  /** Chiamata quando cambia l'elenco dei turni in corso. */
  onChange?: () => void;
}

export interface TurnLoop {
  /** Interrompe l'attesa del claim e i turni in corso (report `stopped`) e ne attende la chiusura. */
  stop(): Promise<void>;
  running(): Array<{ turnId: number; startedAt: string }>;
  /**
   * Posti per i turni (impostazioni dalla console; null = `maxConcurrentTurns` della config). Ridurli non interrompe
   * nulla: il ciclo smette di prendere turni finché quelli in corso non scendono sotto il nuovo limite.
   */
  setMaxTurns(n: number | null): void;
  /** Smette di prendere turni (aggiornamento in arrivo); il claim già in attesa si conclude. */
  pause(): void;
  resume(): void;
  /** Nessun turno in corso né claim in attesa. */
  idle(): boolean;
  /** Turni in corso. */
  activeCount(): number;
}

/** Attesa interrompibile dallo stop. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Ciclo dei turni delegati, indipendente da quello dei compiti: all'avvio toglie la cartella dei turni; finché c'è un posto libero (`maxConcurrentTurns`) tiene
 * esattamente un claim in attesa (long-poll); 204 → subito un altro claim; errore di rete o 5xx → attesa di 5 s;
 * 401/403 (token non valido o nodo disattivato) → attesa di 30 s, registrata una volta sola. I posti si cambiano senza
 * riavvio (`setMaxTurns`) e il ciclo si sospende durante un aggiornamento (`pause`).
 */
export function startTurnLoop(opts: TurnLoopOptions): TurnLoop {
  const { config, client, logger } = opts;
  const errorWaitMs = opts.errorWaitMs ?? 5_000;
  const disabledWaitMs = opts.disabledWaitMs ?? 30_000;
  const stopCtl = new AbortController();
  const active = new Map<number, { startedAt: Date; promise: Promise<void> }>();
  let slotWaiter: (() => void) | null = null;
  let maxTurns = config.maxConcurrentTurns;
  let paused = false;
  let claiming = false;
  let disabledLogged = false;
  let lastErrorLogged: string | null = null;

  function freeSlot(): Promise<void> {
    return new Promise((resolve) => {
      if (stopCtl.signal.aborted) return resolve();
      const done = () => {
        slotWaiter = null;
        stopCtl.signal.removeEventListener("abort", done);
        resolve();
      };
      slotWaiter = done;
      stopCtl.signal.addEventListener("abort", done, { once: true });
    });
  }

  function start(pkg: TurnPackage): void {
    const entry = { startedAt: new Date(), promise: Promise.resolve() };
    active.set(pkg.id, entry);
    opts.onChange?.();
    entry.promise = runTurn(pkg, {
      config,
      client,
      logger,
      signal: stopCtl.signal,
      turnsDir: opts.turnsDir,
      spawn: opts.spawn,
      pingIntervalMs: opts.pingIntervalMs,
      killGraceMs: opts.killGraceMs,
    })
      .catch((err: unknown) => logger.error(`turno ${pkg.id}: errore inatteso (${(err as Error).message})`))
      .finally(() => {
        active.delete(pkg.id);
        opts.onChange?.();
        slotWaiter?.();
      });
  }

  async function main(): Promise<void> {
    // Cartelle rimaste da un arresto improvviso (mcp.json con il token di un turno ormai chiuso): via prima del primo claim
    await rm(opts.turnsDir, { recursive: true, force: true }).catch((err: unknown) =>
      logger.warn(`turni: cartella dei turni non pulita (${(err as Error).message})`),
    );
    while (!stopCtl.signal.aborted) {
      if (paused || active.size >= maxTurns) {
        await freeSlot();
        continue;
      }
      let pkg: TurnPackage | null;
      claiming = true;
      try {
        pkg = await client.claimTurn(stopCtl.signal);
        claiming = false;
        disabledLogged = false;
        lastErrorLogged = null;
      } catch (err) {
        claiming = false;
        if (stopCtl.signal.aborted) break;
        if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
          if (!disabledLogged) {
            const why = err.status === 403 ? "nodo disattivato (403)" : "token del nodo non valido (401)";
            logger.warn(`turni: ${why}, riprovo ogni 30 secondi`);
          }
          disabledLogged = true;
          await wait(disabledWaitMs, stopCtl.signal);
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        // Un errore che dura non riempie il log: una riga per messaggio diverso
        if (message !== lastErrorLogged) logger.warn(`turni: claim non riuscito (${message})`);
        lastErrorLogged = message;
        await wait(errorWaitMs, stopCtl.signal);
        continue;
      }
      if (!pkg) continue;
      logger.info(`turno ${pkg.id} preso in carico`);
      start(pkg);
    }
  }

  const mainDone = main();

  return {
    async stop() {
      stopCtl.abort();
      await mainDone;
      await Promise.all([...active.values()].map((t) => t.promise));
    },
    running: () => [...active].map(([turnId, t]) => ({ turnId, startedAt: t.startedAt.toISOString() })),
    setMaxTurns(n) {
      maxTurns = n ?? config.maxConcurrentTurns;
      slotWaiter?.();
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      slotWaiter?.();
    },
    idle: () => active.size === 0 && !claiming,
    activeCount: () => active.size,
  };
}
