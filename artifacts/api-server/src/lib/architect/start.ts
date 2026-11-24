import { db, analysesTable, type App } from "@workspace/db";
import type { ModelChoice } from "../ai/choice";
import { isUniqueViolation } from "../pg-errors";
import { LOCAL_MODEL } from "./local-executor";
import { ANALYSIS_DEFAULT_MAX_TOKENS, startAnalysis } from "./run-analysis";

/** L'app ha già un'analisi `queued`/`running` (indice unico parziale `analyses_one_active_per_app`). */
export class AnalysisBusyError extends Error {}

/** Inserisce l'analisi `queued`; un'altra analisi aperta per l'app → AnalysisBusyError. */
export async function insertAnalysis(values: typeof analysesTable.$inferInsert) {
  try {
    const [row] = await db.insert(analysesTable).values(values).returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err, "analyses_one_active_per_app")) throw new AnalysisBusyError();
    throw err;
  }
}

/**
 * Crea l'analisi cloud `queued` e la avvia in background. `startAnalysis` non lancia mai: registra da sé
 * ogni errore sulla riga dell'analisi. Lo zip resta solo in memoria (mai su disco né nei log).
 */
export async function createAndStartAnalysis(
  app: App,
  choice: ModelChoice,
  maxTokens: number | undefined,
  bestPractice: boolean,
  zip?: Uint8Array,
) {
  const row = await insertAnalysis({
    appId: app.id,
    model: choice.model,
    aiModelId: choice.aiModelId,
    maxTokens: maxTokens ?? ANALYSIS_DEFAULT_MAX_TOKENS,
    bestPractice,
    // Valore iniziale: l'orchestratore lo sovrascrive con le sorgenti usate davvero
    sources: { code: zip ? "zip" : app.sourceType, openapi: false, mcp: false, description: !!app.functionalDescription?.trim() },
  });
  void startAnalysis(row.id, zip ? { zip } : undefined);
  return row;
}

/**
 * Crea l'analisi `queued` per l'agente locale: il codice lo legge l'agente sul proprio clone, nessun modello di Botcave.
 * `triggerCommit` = SHA del branch base che ha avviato la rianalisi automatica (assente = avviata a mano).
 * Un'altra analisi aperta per l'app → AnalysisBusyError.
 */
export function insertLocalAnalysis(app: App, opts: { maxTokens?: number; bestPractice: boolean; triggerCommit?: string }) {
  return insertAnalysis({
    appId: app.id,
    model: LOCAL_MODEL,
    aiModelId: null,
    executor: "local",
    maxTokens: opts.maxTokens ?? ANALYSIS_DEFAULT_MAX_TOKENS,
    bestPractice: opts.bestPractice,
    triggerCommit: opts.triggerCommit ?? null,
    sources: { code: app.sourceType, openapi: false, mcp: false, description: !!app.functionalDescription?.trim() },
  });
}
