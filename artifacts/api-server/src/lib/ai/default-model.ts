import { and, eq } from "drizzle-orm";
import { db, aiAccountsTable, aiModelsTable, usersTable } from "@workspace/db";
import { MODEL_UNAVAILABLE, ModelChoiceError, NO_MODEL, chooseOwnModel, type ModelChoice } from "./choice";
import type { Tx } from "../architect/apply";

/**
 * Modello predefinito dell'utente e ripiego unico per gli agenti che Casello crea (agente generale di
 * un'app nuova, agenti approvati dall'architetto, `POST /agents`): modello scelto → predefinito
 * dell'utente (solo se è ancora un modello di un suo account) → nessuno.
 */

type Executor = Tx | typeof db;

/** Modello di un account dell'utente (non di altri), oppure undefined. */
async function ownModel(userId: number, aiModelId: number, executor: Executor): Promise<ModelChoice | undefined> {
  const [row] = await executor
    .select({ id: aiModelsTable.id, modelId: aiModelsTable.modelId })
    .from(aiModelsTable)
    .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
    .where(and(eq(aiModelsTable.id, aiModelId), eq(aiAccountsTable.userId, userId)))
    .limit(1);
  return row ? { aiModelId: row.id, model: row.modelId } : undefined;
}

/** Predefinito salvato (null se non impostato o se il modello è stato eliminato). */
export async function getDefaultModel(userId: number, executor: Executor = db): Promise<number | null> {
  const [row] = await executor
    .select({ defaultAiModelId: usersTable.defaultAiModelId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return row?.defaultAiModelId ?? null;
}

/** Imposta (modello di un proprio account, altrimenti `ModelChoiceError`) o toglie (null) il predefinito. */
export async function setDefaultModel(userId: number, aiModelId: number | null): Promise<void> {
  if (aiModelId !== null) {
    if (!Number.isSafeInteger(aiModelId) || aiModelId <= 0 || !(await ownModel(userId, aiModelId, db))) {
      throw new ModelChoiceError(MODEL_UNAVAILABLE);
    }
  }
  await db.update(usersTable).set({ defaultAiModelId: aiModelId }).where(eq(usersTable.id, userId));
}

/**
 * Modello di un agente creato da Casello. `chosen` definito (non null) → deve essere scelto dall'utente
 * (`chooseOwnModel`, altrimenti `ModelChoiceError`); altrimenti il predefinito se è ancora dell'utente;
 * altrimenti nessun modello.
 */
export async function resolveAgentModel(
  userId: number,
  chosen: number | null | undefined,
  executor: Executor = db,
): Promise<ModelChoice> {
  if (chosen != null) return chooseOwnModel(chosen, userId);
  const defaultId = await getDefaultModel(userId, executor);
  if (defaultId === null) return NO_MODEL;
  return (await ownModel(userId, defaultId, executor)) ?? NO_MODEL;
}
