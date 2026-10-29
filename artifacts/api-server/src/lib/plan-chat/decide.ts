import { createHash } from "node:crypto";
import { and, eq, max, sql } from "drizzle-orm";
import {
  db,
  analysesTable,
  analysisItemsTable,
  planConversationsTable,
  planProposalsTable,
  type AnalysisItem,
  type PlanProposal,
} from "@workspace/db";

/** Proposta inesistente o di una conversazione di un altro utente (la route risponde 404). */
export class ProposalNotFoundError extends Error {
  constructor() {
    super("Proposta non trovata");
    this.name = "ProposalNotFoundError";
  }
}

/** Proposta già decisa o non più applicabile (messaggio in italiano, la route risponde 409). */
export class ProposalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalConflictError";
  }
}

const STALE_MESSAGE = "La voce è cambiata dopo la proposta: chiedi al bot di riproporla";

/** Segnale interno: la voce di destinazione è cambiata, la transazione va annullata e la proposta marcata `stale`. */
class StaleTarget extends Error {}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/** SHA-256 (hex) di payload e stato della voce, con le chiavi degli oggetti in ordine: serve a scoprire se è cambiata. */
export function itemHash(item: { payload: unknown; status: string }): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical({ payload: item.payload ?? null, status: item.status })))
    .digest("hex");
}

function evidenceOf(payload: unknown): unknown[] {
  const evidence = (payload as { evidence?: unknown } | null)?.evidence;
  return Array.isArray(evidence) ? evidence : [];
}

/**
 * Accetta o rifiuta una proposta della chat. La transizione da `pending` è un UPDATE condizionato: due
 * decisioni concorrenti ne fanno passare una sola. Se la voce di destinazione è cambiata (o non esiste più)
 * la proposta diventa `stale` (scritto fuori dalla transazione annullata) e il chiamante riceve un conflitto.
 */
export async function decideProposal(
  proposalId: number,
  userId: number,
  action: "accept" | "reject",
): Promise<{ proposal: PlanProposal; item: AnalysisItem | null }> {
  try {
    return await db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ analysisId: planConversationsTable.analysisId, appId: planConversationsTable.appId })
        .from(planProposalsTable)
        .innerJoin(planConversationsTable, eq(planConversationsTable.id, planProposalsTable.conversationId))
        .where(and(eq(planProposalsTable.id, proposalId), eq(planConversationsTable.userId, userId)));
      if (!owned) throw new ProposalNotFoundError();

      const now = new Date();
      const [proposal] = await tx
        .update(planProposalsTable)
        .set({ status: action === "accept" ? "accepted" : "rejected", decidedAt: now })
        .where(and(eq(planProposalsTable.id, proposalId), eq(planProposalsTable.status, "pending")))
        .returning();
      if (!proposal) throw new ProposalConflictError("La proposta è già stata decisa");
      if (action === "reject") return { proposal, item: null };

      let item: AnalysisItem;
      if (proposal.kind === "add") {
        // Posizione in coda al capitolo; il riferimento univoco impedisce doppioni
        const [{ last }] = await tx
          .select({ last: max(analysisItemsTable.position) })
          .from(analysisItemsTable)
          .where(and(eq(analysisItemsTable.analysisId, owned.analysisId), eq(analysisItemsTable.chapter, proposal.chapter)));
        [item] = await tx
          .insert(analysisItemsTable)
          .values({
            analysisId: owned.analysisId,
            chapter: proposal.chapter,
            ref: `chat-${proposal.id}`,
            position: (last ?? 0) + 1,
            payload: proposal.payload,
            evidence: evidenceOf(proposal.payload),
            diff: "new",
            status: "approved",
            appliedAt: now,
            origin: "chat",
            conversationId: proposal.conversationId,
          })
          .returning();
      } else {
        // Blocco della riga: due proposte concorrenti sulla stessa voce non si sovrappongono
        const [target] = proposal.targetItemId
          ? await tx
              .select()
              .from(analysisItemsTable)
              .where(eq(analysisItemsTable.id, proposal.targetItemId))
              .for("update")
          : [];
        // Il piano è l'analisi della conversazione più le voci approvate dalla chat di analisi precedenti della stessa app
        let inPlan = false;
        if (target) {
          if (target.analysisId === owned.analysisId) inPlan = true;
          else if (target.origin === "chat") {
            const [targetAnalysis] = await tx
              .select({ appId: analysesTable.appId })
              .from(analysesTable)
              .where(eq(analysesTable.id, target.analysisId));
            inPlan = targetAnalysis?.appId === owned.appId;
          }
        }
        if (!target || !inPlan || itemHash(target) !== proposal.targetHash) throw new StaleTarget();
        [item] = await tx
          .update(analysisItemsTable)
          .set(
            proposal.kind === "update"
              ? { payload: proposal.payload, evidence: evidenceOf(proposal.payload) }
              : { status: "discarded" },
          )
          .where(eq(analysisItemsTable.id, target.id))
          .returning();
      }

      const [done] = await tx
        .update(planProposalsTable)
        .set({ itemId: item!.id })
        .where(eq(planProposalsTable.id, proposal.id))
        .returning();
      return { proposal: done!, item: item! };
    });
  } catch (err) {
    if (!(err instanceof StaleTarget)) throw err;
    // La transazione è annullata: la marcatura `stale` si scrive a parte, così resta
    await db
      .update(planProposalsTable)
      .set({ status: "stale", decidedAt: sql`now()` })
      .where(and(eq(planProposalsTable.id, proposalId), eq(planProposalsTable.status, "pending")));
    throw new ProposalConflictError(STALE_MESSAGE);
  }
}
