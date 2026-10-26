import { and, eq, isNull, sql } from "drizzle-orm";
import { db, agentsTable, aiAccountsTable, aiModelsTable, analysesTable } from "@workspace/db";
import { AVAILABLE_MODELS } from "../models";
import { findSeedPrice } from "./price-seed";

export const SYSTEM_ACCOUNT_NAME = "Gateway Casello";

/** Il DB o la transazione in corso (dentro una transazione si legge con la stessa connessione). */
type Executor = Pick<typeof db, "select">;

/** L'account di sistema è utilizzabile solo finché le variabili del gateway sono impostate. */
export function systemAccountConfigured(): boolean {
  return !!process.env["AI_GATEWAY_BASE_URL"] && !!process.env["AI_GATEWAY_API_KEY"];
}

/**
 * Crea o aggiorna l'account di sistema (gateway di Casello) dalle variabili `AI_GATEWAY_*` e collega
 * agenti e analisi esistenti al modello corrispondente. Idempotente, in una sola transazione.
 * Senza le due variabili non fa nulla e restituisce null.
 */
export async function ensureSystemAccount(): Promise<{ accountId: number } | null> {
  const baseUrl = process.env["AI_GATEWAY_BASE_URL"];
  if (!baseUrl || !systemAccountConfigured()) return null;

  return db.transaction(async (tx) => {
    // L'account di sistema è l'unico con provider system_gateway e user_id nullo
    const [existing] = await tx
      .select({ id: aiAccountsTable.id })
      .from(aiAccountsTable)
      .where(and(eq(aiAccountsTable.provider, "system_gateway"), isNull(aiAccountsTable.userId)))
      .limit(1);

    let accountId: number;
    if (existing) {
      accountId = existing.id;
      await tx
        .update(aiAccountsTable)
        .set({ baseUrl, status: "ok", lastError: null, updatedAt: new Date() })
        .where(eq(aiAccountsTable.id, accountId));
    } else {
      const [created] = await tx
        .insert(aiAccountsTable)
        .values({
          userId: null,
          name: SYSTEM_ACCOUNT_NAME,
          provider: "system_gateway",
          baseUrl,
          apiKeyEnc: null,
          // Mai predefinito: l'indice univoco parziale non protegge dagli user_id nulli
          isDefault: false,
          status: "ok",
        })
        .returning({ id: aiAccountsTable.id });
      accountId = created!.id;
    }

    // Un modello per voce dell'elenco; quelli non più in elenco restano (gli agenti possono usarli)
    for (const m of AVAILABLE_MODELS) {
      const seed = findSeedPrice("system_gateway", m.id);
      await tx
        .insert(aiModelsTable)
        .values({
          accountId,
          modelId: m.id,
          displayName: m.label,
          discovered: false,
          priceInputPerMtok: seed ? String(seed.input) : null,
          priceOutputPerMtok: seed ? String(seed.output) : null,
          priceSource: seed ? "seed" : null,
        })
        // I prezzi e il resto dei modelli già presenti (anche modificati a mano) non si toccano
        .onConflictDoNothing({ target: [aiModelsTable.accountId, aiModelsTable.modelId] });
    }

    // Collegamento dei riferimenti esistenti ancora senza modello
    await tx.execute(sql`
      UPDATE ${agentsTable} AS t SET ai_model_id = m.id
      FROM ${aiModelsTable} AS m
      WHERE t.ai_model_id IS NULL AND m.account_id = ${accountId} AND m.model_id = t.model
    `);
    await tx.execute(sql`
      UPDATE ${analysesTable} AS t SET ai_model_id = m.id
      FROM ${aiModelsTable} AS m
      WHERE t.ai_model_id IS NULL AND m.account_id = ${accountId} AND m.model_id = t.model
    `);

    return { accountId };
  });
}

/**
 * Modello dell'account di sistema con questo `model_id` (es. "openrouter/auto"), o null se non c'è.
 * Serve alla transizione: chi sceglie ancora il modello per nome (console precedente) viene collegato
 * al modello equivalente del gateway, sempre utilizzabile da tutti gli utenti ammessi.
 */
export async function findSystemModelId(modelId: string, executor: Executor = db): Promise<number | null> {
  const [row] = await executor
    .select({ id: aiModelsTable.id })
    .from(aiModelsTable)
    .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
    .where(
      and(
        eq(aiAccountsTable.provider, "system_gateway"),
        isNull(aiAccountsTable.userId),
        eq(aiModelsTable.modelId, modelId),
      ),
    )
    .orderBy(aiModelsTable.id)
    .limit(1);
  return row?.id ?? null;
}

/**
 * Come `findSystemModelId`, ma null se l'account di sistema non è configurato (variabili del gateway
 * assenti): un collegamento nuovo non deve puntare a un modello che nessuno può usare.
 */
export async function findUsableSystemModelId(modelId: string, executor: Executor = db): Promise<number | null> {
  if (!systemAccountConfigured()) return null;
  return findSystemModelId(modelId, executor);
}
