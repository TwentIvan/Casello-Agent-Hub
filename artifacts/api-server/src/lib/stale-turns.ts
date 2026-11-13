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

interface LiveTurn {
  controller: AbortController;
  /** Id del messaggio dell'assistente del turno, se noto: «Ferma» di un invio accodato colpisce solo quel turno. */
  turnId: number | null;
}

const live: Record<ChatTurnKind, Map<number, LiveTurn>> = { plan: new Map(), character: new Map(), team: new Map() };

/**
 * Segna il turno della conversazione come in corso in questo processo fino alla fine di `run`, che riceve il segnale di
 * interruzione. `turnId` è l'id del messaggio dell'assistente del turno.
 */
export async function trackTurn<T>(
  kind: ChatTurnKind,
  conversationId: number,
  run: (signal: AbortSignal) => Promise<T>,
  turnId: number | null = null,
): Promise<T> {
  const entry: LiveTurn = { controller: new AbortController(), turnId };
  live[kind].set(conversationId, entry);
  try {
    return await run(entry.controller.signal);
  } finally {
    // Solo se la voce è ancora la nostra (un turno nuovo della stessa conversazione non va cancellato)
    if (live[kind].get(conversationId) === entry) live[kind].delete(conversationId);
  }
}

/** Annulla il turno in corso in questo processo; true se c'era. */
export function abortTurn(kind: ChatTurnKind, conversationId: number): boolean {
  const entry = live[kind].get(conversationId);
  if (!entry) return false;
  entry.controller.abort();
  return true;
}

/** Id del messaggio dell'assistente del turno vivo in questo processo: undefined senza turno vivo, null se non noto. */
export function liveTurnId(kind: ChatTurnKind, conversationId: number): number | null | undefined {
  const entry = live[kind].get(conversationId);
  return entry === undefined ? undefined : entry.turnId;
}

/** Il turno della conversazione gira in questo processo. */
export function isLiveTurn(kind: ChatTurnKind, conversationId: number): boolean {
  return live[kind].has(conversationId);
}

/** Conversazioni con un turno in corso in questo processo. */
export function liveTurns(kind: ChatTurnKind): number[] {
  return [...live[kind].keys()];
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
