// Risposte dei bot non viste (per il LED `ask` del pulsante della pagina ospite) e messaggio `status`. Funzioni pure.
// Una risposta è non vista se è arrivata a pannello chiuso; si azzera aprendo la scheda di quel bot. L'ultima risposta vista
// per bot si tiene in memoria e in sessionStorage, così resta attraverso la navigazione della pagina ospite.
import type { EmbedStatus } from "@workspace/api-client-react";
import { BOTS, type Bot, type BotActivity } from "./bot-activity";
import { MAX_PAGE_ACTIONS, type StatusPayload } from "./protocol";

export type SeenReplies = Partial<Record<Bot, number>>;

export interface UnreadState {
  seen: SeenReplies;
  unread: Partial<Record<Bot, true>>;
}

export const EMPTY_UNREAD: UnreadState = { seen: {}, unread: {} };

/** Nuovo stato delle risposte non viste dopo un cambio di attività, di pannello o di scheda. */
export function nextUnread(state: UnreadState, activity: BotActivity, view: { open: boolean; tab: string }): UnreadState {
  const seen: SeenReplies = { ...state.seen };
  const unread: Partial<Record<Bot, true>> = { ...state.unread };
  for (const bot of BOTS) {
    const looking = view.open && view.tab === bot;
    const id = activity[bot].lastReplyId;
    if (id !== null) {
      const last = seen[bot];
      // La prima risposta che si vede in questa sessione è storia, non una novità
      if (last === undefined) seen[bot] = id;
      else if (id > last) {
        if (!view.open) unread[bot] = true;
        else seen[bot] = id;
      }
    }
    if (looking) delete unread[bot];
  }
  return { seen, unread };
}

export function hasUnread(state: UnreadState): boolean {
  return BOTS.some((bot) => state.unread[bot] === true);
}

export function sameUnread(a: UnreadState, b: UnreadState): boolean {
  return BOTS.every((bot) => a.seen[bot] === b.seen[bot] && a.unread[bot] === b.unread[bot]);
}

/** Ultime risposte viste lette da sessionStorage: solo interi ≥ 0 dei tre bot, il resto si scarta. */
export function parseSeen(raw: string | null): SeenReplies {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return {};
    const out: SeenReplies = {};
    for (const bot of BOTS) {
      const n = (v as Record<string, unknown>)[bot];
      if (typeof n === "number" && Number.isInteger(n) && n >= 0) out[bot] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/** Messaggio `status` per il pulsante: dallo stato del server (o, senza, dal solo contatore della coda) e dai bot. */
export function statusPayload(
  status: EmbedStatus | null,
  pendingFallback: number,
  bots: { working: boolean; unread: boolean },
): StatusPayload {
  return {
    pending: status ? status.pending : pendingFallback,
    bugs: status ? status.bugs : 0,
    working: bots.working || status?.leadWorking === true,
    unread: bots.unread,
    actions: Math.min(status?.actions.length ?? 0, MAX_PAGE_ACTIONS),
  };
}
