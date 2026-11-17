// Voci del piano di un'app (solo DB, nessun modello): analisi base, voci del ciclo di evoluzione e voci approvate
// delle analisi precedenti, più i riferimenti univoci con cui la chat del piano le mostra a Lucius.

import { and, asc, desc, eq, gt, inArray, isNotNull, ne, or } from "drizzle-orm";
import { db, analysesTable, analysisItemsTable, type AnalysisItem } from "@workspace/db";
import { PLAN_CHAPTERS } from "./context";

/**
 * Id dell'analisi base del piano dell'app: l'ultima analisi completa (`mode = full`) completata; solo se non ce n'è
 * nessuna, l'ultima completata del ciclo di evoluzione. Un'analisi ridotta del ciclo non sostituisce mai l'analisi
 * completa: le sue voci entrano nel piano con `loadPlanItems`.
 */
export async function latestCompletedAnalysisId(appId: number): Promise<number | null> {
  const [full] = await db
    .select({ id: analysesTable.id })
    .from(analysesTable)
    .where(and(eq(analysesTable.appId, appId), eq(analysesTable.status, "completed"), eq(analysesTable.mode, "full")))
    .orderBy(desc(analysesTable.id))
    .limit(1);
  if (full) return full.id;
  const [any] = await db
    .select({ id: analysesTable.id })
    .from(analysesTable)
    .where(and(eq(analysesTable.appId, appId), eq(analysesTable.status, "completed")))
    .orderBy(desc(analysesTable.id))
    .limit(1);
  return any?.id ?? null;
}

/**
 * Voci del piano: i capitoli endpoint/completion/evolution dell'analisi della conversazione (la base), le voci approvate o
 * in attesa delle analisi del ciclo di evoluzione completate dopo la base (con una base del ciclo, cioè senza analisi
 * completa, quelle di tutte le analisi del ciclo completate), più le voci approvate delle altre analisi della stessa app
 * nate in chat, già collegate a un'issue GitHub o approvate dal ciclo (ogni voce una volta sola).
 */
export async function loadPlanItems(analysisId: number, appId: number): Promise<AnalysisItem[]> {
  const chapters = PLAN_CHAPTERS as string[];
  const current = await db
    .select()
    .from(analysisItemsTable)
    .where(and(eq(analysisItemsTable.analysisId, analysisId), inArray(analysisItemsTable.chapter, chapters as never[])))
    .orderBy(asc(analysisItemsTable.position), asc(analysisItemsTable.id));
  const [base] = await db.select({ mode: analysesTable.mode }).from(analysesTable).where(eq(analysesTable.id, analysisId)).limit(1);
  // Con un'analisi completa come base contano solo i giri successivi; senza, tutti i giri del ciclo
  const afterBase = base?.mode === "evolution" ? [] : [gt(analysesTable.id, analysisId)];
  const cycle = await db
    .select({ item: analysisItemsTable })
    .from(analysisItemsTable)
    .innerJoin(analysesTable, eq(analysesTable.id, analysisItemsTable.analysisId))
    .where(
      and(
        eq(analysesTable.appId, appId),
        eq(analysesTable.mode, "evolution"),
        eq(analysesTable.status, "completed"),
        ...afterBase,
        inArray(analysisItemsTable.status, ["approved", "pending"]),
        inArray(analysisItemsTable.chapter, chapters as never[]),
      ),
    )
    .orderBy(asc(analysisItemsTable.analysisId), asc(analysisItemsTable.position), asc(analysisItemsTable.id));
  const earlier = await db
    .select({ item: analysisItemsTable })
    .from(analysisItemsTable)
    .innerJoin(analysesTable, eq(analysesTable.id, analysisItemsTable.analysisId))
    .where(
      and(
        eq(analysesTable.appId, appId),
        ne(analysisItemsTable.analysisId, analysisId),
        or(
          eq(analysisItemsTable.origin, "chat"),
          isNotNull(analysisItemsTable.issueNumber),
          eq(analysisItemsTable.approvedByCycle, true),
        ),
        eq(analysisItemsTable.status, "approved"),
        inArray(analysisItemsTable.chapter, chapters as never[]),
      ),
    )
    .orderBy(asc(analysisItemsTable.id));
  const seen = new Set(current.map((i) => i.id));
  const out = [...current];
  for (const { item } of [...cycle, ...earlier]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * Riferimento di una voce nella chat del piano. I ref dell'architetto sono posizionali (`evolution:1`…) e si ripetono tra
 * analisi: le voci dell'analisi della conversazione tengono il ref di sempre (conversazioni e proposte esistenti restano
 * valide), quelle di altre analisi ricevono il prefisso `a<idAnalisi>:` (es. `a12:evolution:1`), stabile tra i turni. Le
 * voci nate in chat (`chat-<id proposta>`) sono già univoche e non cambiano.
 */
export function planItemRef(item: Pick<AnalysisItem, "analysisId" | "ref">, conversationAnalysisId: number): string {
  if (item.analysisId === conversationAnalysisId || item.ref.startsWith("chat-")) return item.ref;
  return `a${item.analysisId}:${item.ref}`;
}
