import type { TeamEvent, TeamTurn } from "@workspace/api-client-react";
import { TEAM_ACTIVITY_LIMITS } from "./team-activity";

/**
 * Thread utente-capo della scheda Messaggi, ricavato senza filtrare sul testo (decisione A, opzione 1):
 * - i messaggi dell'utente sono i motivi `request` con `source: "user"` dei turni del capo (i testi generati da Botcave hanno
 *   `source: "system"`; i turni salvati prima non hanno `source` e restano fuori, perché non si sa chi li ha scritti);
 * - le risposte del capo sono gli eventi `risposta_capo`, legati al loro turno da `turnId`.
 * Più messaggi accodati allo stesso turno ricevono una sola risposta: stanno nello stesso gruppo.
 */
export type ThreadItem =
  | { kind: "user"; key: string; at: string; text: string }
  | { kind: "lead"; key: string; at: string; text: string; unread: boolean }
  /** Turno con messaggi dell'utente ancora in coda o in corso. */
  | { kind: "pending"; key: string; at: string; status: "queued" | "running" }
  /** Turno con messaggi dell'utente fallito prima di rispondere. */
  | { kind: "failed"; key: string; at: string; error: string | null }
  /** Turno concluso senza una risposta scritta (il capo ha solo agito, o la risposta era vuota). */
  | { kind: "no_reply"; key: string; at: string };

/** Testo intero della risposta: il dettaglio c'è solo quando il bollettino è stato accorciato. */
function replyText(e: TeamEvent): string {
  return e.detail ?? e.bulletin;
}

function userTexts(turn: TeamTurn): string[] {
  return turn.reasons
    .filter((r) => r.type === "request" && r.source === "user" && typeof r.text === "string" && r.text.trim() !== "")
    .map((r) => r.text as string);
}

const byTime = (a: { at: string; order: number }, b: { at: string; order: number }) =>
  a.at.localeCompare(b.at) || a.order - b.order;

/** Voci del thread dalla più vecchia alla più recente. */
export function buildLeadThread(turns: readonly TeamTurn[], events: readonly TeamEvent[]): ThreadItem[] {
  const replies = events.filter((e) => e.type === "risposta_capo");
  const repliesByTurn = new Map<number, TeamEvent[]>();
  for (const e of replies) {
    if (e.turnId === null) continue;
    const list = repliesByTurn.get(e.turnId) ?? [];
    list.push(e);
    repliesByTurn.set(e.turnId, list);
  }
  const groups: { at: string; order: number; items: ThreadItem[] }[] = [];
  const placed = new Set<number>();

  for (const turn of turns) {
    const texts = userTexts(turn);
    if (texts.length === 0) continue;
    const items: ThreadItem[] = texts.map((text, i) => ({ kind: "user", key: `u-${turn.id}-${i}`, at: turn.createdAt, text }));
    const own = (repliesByTurn.get(turn.id) ?? []).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
    for (const e of own) {
      placed.add(e.id);
      items.push({ kind: "lead", key: `e-${e.id}`, at: e.createdAt, text: replyText(e), unread: e.readAt === null });
    }
    if (own.length === 0) {
      const at = turn.finishedAt ?? turn.startedAt ?? turn.createdAt;
      if (turn.status === "queued" || turn.status === "running") {
        items.push({ kind: "pending", key: `p-${turn.id}`, at, status: turn.status });
      } else if (turn.status === "failed") {
        items.push({ kind: "failed", key: `f-${turn.id}`, at, error: turn.error });
      } else {
        items.push({ kind: "no_reply", key: `n-${turn.id}`, at });
      }
    }
    groups.push({ at: turn.createdAt, order: turn.id, items });
  }

  // Risposte senza un turno con messaggi dell'utente tra quelli letti (eventi più vecchi senza `turnId`, turni oltre il limite)
  for (const e of replies) {
    if (placed.has(e.id)) continue;
    groups.push({
      at: e.createdAt,
      order: e.id,
      items: [{ kind: "lead", key: `e-${e.id}`, at: e.createdAt, text: replyText(e), unread: e.readAt === null }],
    });
  }

  return groups.sort(byTime).flatMap((g) => g.items);
}

/** Avviso quando i turni letti hanno raggiunto il limite del server: i messaggi più vecchi non compaiono. */
export function leadThreadLimitNotice(turnCount: number): string | null {
  return turnCount >= TEAM_ACTIVITY_LIMITS.turns
    ? `Il thread mostra i messaggi degli ultimi ${TEAM_ACTIVITY_LIMITS.turns} turni del capo: quelli più vecchi non sono qui.`
    : null;
}
