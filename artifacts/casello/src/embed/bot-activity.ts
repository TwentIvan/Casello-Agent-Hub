// Attività dei bot nel pannello incorporato, letta dalle conversazioni già in cache (React Query): chi sta rispondendo e
// l'ultima risposta arrivata. Funzioni pure, provate con Vitest; l'osservazione della cache è in use-bot-activity.ts.
import type { LeadConversationDetail } from "@workspace/api-client-react";
import { mapLeadDetail } from "../components/characters/lead-detail";

export type Bot = "alfred" | "lucius" | "lead";
export const BOTS: readonly Bot[] = ["alfred", "lucius", "lead"];

export interface BotState {
  running: boolean;
  /** Id dell'ultima risposta del bot tra le conversazioni in cache, null se nessuna. */
  lastReplyId: number | null;
}

export type BotActivity = Record<Bot, BotState>;

export const IDLE_ACTIVITY: BotActivity = {
  alfred: { running: false, lastReplyId: null },
  lucius: { running: false, lastReplyId: null },
  lead: { running: false, lastReplyId: null },
};

/**
 * Bot di una conversazione dalla chiave della query: filo di Alfred, chat del piano e conversazioni dei personaggi
 * (Lucius, anche dopo un passaggio di consegne), conversazioni con il Responsabile. Gli elenchi non contano.
 */
export function botOfQueryKey(key: readonly unknown[]): Bot | null {
  const path = key[0];
  if (typeof path !== "string") return null;
  if (path === "/api/characters/alfred/thread") return "alfred";
  if (/^\/api\/(plan-conversations|character-conversations)\/\d+$/.test(path)) return "lucius";
  if (/^\/api\/lead-conversations\/\d+$/.test(path)) return "lead";
  return null;
}

type RoleMessages = { turnStatus?: unknown; messages?: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Stato di una conversazione in cache; null se i dati non hanno la forma attesa. */
export function conversationState(bot: Bot, data: unknown): BotState | null {
  if (!isRecord(data) || !Array.isArray((data as RoleMessages).messages)) return null;
  const running = data.turnStatus === "running";
  let lastReplyId: number | null = null;
  if (bot === "lead") {
    // Le risposte del Responsabile sono le run concluse dei messaggi (id 2·id+1)
    for (const m of mapLeadDetail(data as unknown as LeadConversationDetail).messages) {
      if (m.role === "assistant" && (lastReplyId === null || m.id > lastReplyId)) lastReplyId = m.id;
    }
  } else {
    for (const m of data.messages as unknown[]) {
      if (!isRecord(m) || m.role !== "assistant" || typeof m.id !== "number") continue;
      // Il segnaposto vuoto del turno in corso non è ancora una risposta
      if (m.content === "") continue;
      if (lastReplyId === null || m.id > lastReplyId) lastReplyId = m.id;
    }
  }
  return { running, lastReplyId };
}

/** Attività per bot dalle query in cache: in corso se una conversazione lo è, ultima risposta = id più alto. */
export function activityFromQueries(queries: readonly { key: readonly unknown[]; data: unknown }[]): BotActivity {
  const out: BotActivity = {
    alfred: { running: false, lastReplyId: null },
    lucius: { running: false, lastReplyId: null },
    lead: { running: false, lastReplyId: null },
  };
  for (const q of queries) {
    const bot = botOfQueryKey(q.key);
    if (!bot) continue;
    const s = conversationState(bot, q.data);
    if (!s) continue;
    const cur = out[bot];
    cur.running = cur.running || s.running;
    if (s.lastReplyId !== null && (cur.lastReplyId === null || s.lastReplyId > cur.lastReplyId)) cur.lastReplyId = s.lastReplyId;
  }
  return out;
}

export function sameActivity(a: BotActivity, b: BotActivity): boolean {
  return BOTS.every((bot) => a[bot].running === b[bot].running && a[bot].lastReplyId === b[bot].lastReplyId);
}
