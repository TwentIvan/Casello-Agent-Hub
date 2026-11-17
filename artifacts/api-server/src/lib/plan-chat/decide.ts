import { createHash } from "node:crypto";
import { and, eq, max, sql } from "drizzle-orm";
import {
  db,
  analysesTable,
  analysisItemsTable,
  appsTable,
  planConversationsTable,
  planProposalsTable,
  type AnalysisItem,
  type PlanProposal,
} from "@workspace/db";
import { pageActionsHash, validatePageActions } from "../apps/page-actions";

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

const STALE_ACTIONS_MESSAGE = "le azioni sono cambiate: chiedi a Lucius una proposta aggiornata";

/** Segnale interno: la voce di destinazione è cambiata, la transazione va annullata e la proposta marcata `stale`. */
class StaleTarget extends Error {
  constructor(readonly userMessage: string = STALE_MESSAGE) {
    super(userMessage);
  }
}

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

      if (proposal.kind === "page_actions") {
        await applyPageActions(tx, owned.appId, proposal);
        return { proposal, item: null };
      }
      const chapter = proposal.chapter;
      if (proposal.kind === "add" && chapter === null) throw new ProposalConflictError("La proposta non si può accettare da qui");

      let item: AnalysisItem;
      if (proposal.kind === "add") {
        // Posizione in coda al capitolo; il riferimento univoco impedisce doppioni
        const [{ last }] = await tx
          .select({ last: max(analysisItemsTable.position) })
          .from(analysisItemsTable)
          .where(and(eq(analysisItemsTable.analysisId, owned.analysisId), eq(analysisItemsTable.chapter, chapter!)));
        [item] = await tx
          .insert(analysisItemsTable)
          .values({
            analysisId: owned.analysisId,
            chapter: chapter!,
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
        // Il piano (`loadPlanItems`) è l'analisi della conversazione più, della stessa app, le voci delle analisi del ciclo
        // di evoluzione e quelle nate in chat, con un'issue o approvate dal ciclo di altre analisi; l'impronta copre il resto
        let inPlan = false;
        if (target) {
          if (target.analysisId === owned.analysisId) inPlan = true;
          else {
            const [targetAnalysis] = await tx
              .select({ appId: analysesTable.appId, mode: analysesTable.mode })
              .from(analysesTable)
              .where(eq(analysesTable.id, target.analysisId));
            const planned =
              targetAnalysis?.mode === "evolution" ||
              target.origin === "chat" ||
              target.issueNumber !== null ||
              target.approvedByCycle === true;
            inPlan = targetAnalysis?.appId === owned.appId && planned;
          }
        }
        if (!target || !inPlan || itemHash(target) !== proposal.targetHash) throw new StaleTarget();
        [item] = await tx
          .update(analysisItemsTable)
          .set(
            proposal.kind === "update"
              ? { payload: proposal.payload, evidence: evidenceOf(proposal.payload), conversationId: proposal.conversationId }
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
    throw new ProposalConflictError(err.userMessage);
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Applica una proposta `page_actions` con la riga dell'App bloccata: se le azioni di quel tipo di pagina non sono più
 * quelle su cui è nata la proposta → `StaleTarget`; altrimenti sostituisce solo quelle (le altre restano) e rivalida l'elenco.
 */
async function applyPageActions(tx: Tx, appId: number, proposal: PlanProposal): Promise<void> {
  const [app] = await tx.select({ pageActions: appsTable.pageActions }).from(appsTable).where(eq(appsTable.id, appId)).for("update");
  const payload = (proposal.payload ?? {}) as { page?: unknown; actions?: unknown };
  const page = typeof payload.page === "string" ? payload.page : "";
  if (!app || pageActionsHash(app.pageActions, page) !== proposal.targetHash) throw new StaleTarget(STALE_ACTIONS_MESSAGE);
  const proposed = Array.isArray(payload.actions) ? payload.actions : [];
  const checked = validatePageActions([
    ...app.pageActions.filter((a) => a.page !== page),
    ...proposed.map((a) => ({ ...(a as object), page })),
  ]);
  if (!checked.ok) throw new ProposalConflictError(checked.error);
  await tx.update(appsTable).set({ pageActions: checked.actions }).where(eq(appsTable.id, appId));
}
