// Schede dei personaggi: registrazione durante il turno (`recordProposal`) e forma pubblica (`toProposalView`).
// La decisione (accettare o rifiutare) arriva con il Task 7.

import { and, eq, sql } from "drizzle-orm";
import { db, characterProposalsTable, type CharacterProposal } from "@workspace/db";
import { CHARACTER_MESSAGES, MAX_PROPOSALS_PER_TURN, RATIONALE_MAX, type ProposalKind, type TurnContext } from "./types";

// Schede create nel turno per ogni contesto creato da `createTurnContext`
const made = new WeakMap<TurnContext, number>();

/** Contesto di un turno con il conteggio delle schede (al massimo 10 per turno). */
export function createTurnContext(base: Omit<TurnContext, "proposalsLeft">): TurnContext {
  const ctx: TurnContext = { ...base, proposalsLeft: () => MAX_PROPOSALS_PER_TURN - (made.get(ctx) ?? 0) };
  made.set(ctx, 0);
  return ctx;
}

/**
 * Salva una scheda `pending` sul messaggio del turno. Oltre 10 schede nel turno (conteggio del contesto e, per
 * sicurezza, delle schede già legate al messaggio) → `{error: «troppe schede in questo turno»}`; motivazione oltre
 * 1 000 caratteri → errore. Il contenuto lo valida chi chiama (lo strumento dell'argomento).
 */
export async function recordProposal(
  ctx: TurnContext,
  kind: ProposalKind,
  payload: unknown,
  rationale: string,
  targetHash: string | null,
): Promise<{ id: number } | { error: string }> {
  if (ctx.proposalsLeft() <= 0) return { error: CHARACTER_MESSAGES.tooManyProposals };
  if (rationale.length > RATIONALE_MAX) return { error: CHARACTER_MESSAGES.rationaleTooLong };
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(characterProposalsTable)
    .where(and(eq(characterProposalsTable.conversationId, ctx.conversationId), eq(characterProposalsTable.messageId, ctx.messageId)));
  if (n >= MAX_PROPOSALS_PER_TURN) return { error: CHARACTER_MESSAGES.tooManyProposals };
  const [row] = await db
    .insert(characterProposalsTable)
    .values({ conversationId: ctx.conversationId, messageId: ctx.messageId, kind, payload: payload ?? {}, rationale, targetHash })
    .returning({ id: characterProposalsTable.id });
  if (made.has(ctx)) made.set(ctx, made.get(ctx)! + 1);
  return { id: row!.id };
}

export type ProposalView = {
  id: number;
  conversationId: number;
  messageId: number;
  kind: ProposalKind;
  payload: unknown;
  rationale: string;
  status: "pending" | "accepted" | "rejected" | "stale";
  decidedAt: Date | null;
  createdAt: Date;
};

export function toProposalView(p: CharacterProposal): ProposalView {
  return {
    id: p.id,
    conversationId: p.conversationId,
    messageId: p.messageId,
    kind: p.kind as ProposalKind,
    payload: p.payload,
    rationale: p.rationale,
    status: p.status,
    decidedAt: p.decidedAt,
    createdAt: p.createdAt,
  };
}
