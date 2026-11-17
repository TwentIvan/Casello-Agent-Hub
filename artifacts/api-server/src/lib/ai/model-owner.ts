import { eq } from "drizzle-orm";
import { db, aiAccountsTable, aiModelsTable } from "@workspace/db";

/** Utente che possiede l'account AI del modello; null se il modello o l'account non ci sono più. */
export async function aiModelOwner(aiModelId: number): Promise<number | null> {
  const [row] = await db
    .select({ userId: aiAccountsTable.userId })
    .from(aiModelsTable)
    .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
    .where(eq(aiModelsTable.id, aiModelId))
    .limit(1);
  return row?.userId ?? null;
}
