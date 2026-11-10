// Turni di chat rimasti appesi (chat del piano, conversazioni dei personaggi, chat di squadra). All'avvio i turni
// `running` si chiudono tutti (`failInterrupted*`), ma durante un deploy il container nuovo parte prima che il vecchio
// si fermi: un turno avviato nel vecchio dopo la pulizia del nuovo resterebbe `running` per sempre e la conversazione
// non accetterebbe più messaggi. Ogni processo ricorda i turni che sta eseguendo; il controllo periodico chiude quelli
// `running` da oltre `STALE_TURN_MS` che non girano in questo processo, con il messaggio del riavvio.

import { logger } from "./logger";

export type ChatTurnKind = "plan" | "character" | "team";

/** Ben oltre il tempo attivo massimo di un turno (240 s), ma un turno in corso in questo processo non si chiude mai. */
export const STALE_TURN_MS = 5 * 60_000;
const SWEEP_EVERY_MS = 60_000;

const live: Record<ChatTurnKind, Set<number>> = { plan: new Set(), character: new Set(), team: new Set() };

/** Segna il turno della conversazione come in corso in questo processo fino alla fine di `run`. */
export async function trackTurn<T>(kind: ChatTurnKind, conversationId: number, run: () => Promise<T>): Promise<T> {
  live[kind].add(conversationId);
  try {
    return await run();
  } finally {
    live[kind].delete(conversationId);
  }
}

/** Conversazioni con un turno in corso in questo processo. */
export function liveTurns(kind: ChatTurnKind): number[] {
  return [...live[kind]];
}

export interface StaleTurnFilter {
  /** Solo i turni `running` con `updated_at` precedente. */
  olderThan: Date;
  /** Conversazioni da non toccare (turni vivi in questo processo). */
  exclude: number[];
}

export type StaleTurnCloser = (filter: StaleTurnFilter) => Promise<number>;

/** Un giro: chiude i turni appesi delle tre chat. Non lancia mai. */
export async function sweepStaleTurns(closers: Record<ChatTurnKind, StaleTurnCloser>, now: number = Date.now()): Promise<number> {
  let total = 0;
  for (const kind of Object.keys(closers) as ChatTurnKind[]) {
    try {
      const count = await closers[kind]({ olderThan: new Date(now - STALE_TURN_MS), exclude: liveTurns(kind) });
      if (count > 0) logger.warn({ kind, count }, "Turni di chat rimasti appesi chiusi");
      total += count;
    } catch (err) {
      logger.error({ kind, errName: err instanceof Error ? err.name : "unknown" }, "Chiusura dei turni di chat appesi non riuscita");
    }
  }
  return total;
}

export function startStaleTurnSweeper(closers: Record<ChatTurnKind, StaleTurnCloser>): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sweepStaleTurns(closers).finally(() => {
      running = false;
    });
  }, SWEEP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
