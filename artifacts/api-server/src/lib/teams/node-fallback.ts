import { eq } from "drizzle-orm";
import { aiModelsTable, db } from "@workspace/db";
import { resolveModel, type ResolvedModel } from "../ai/executor";
import { logger } from "../logger";
import { teamBudgetBlock } from "./team-budget";

// Ripiego cloud di un modello Claude Code (nodo) usato da una squadra: lo usano i turni del capo e il collaudo dei lavori.

/**
 * Modello di ripiego dell'account nodo, se usabile: dello stesso proprietario, cloud, risolvibile e senza tetti
 * raggiunti (della squadra, del modello, dell'account e dell'utente). Null altrimenti.
 */
export async function usableNodeFallback(instanceId: number, node: ResolvedModel): Promise<{ resolved: ResolvedModel; name: string } | null> {
  const id = node.fallbackAiModelId;
  if (id === null) return null;
  let fallback: ResolvedModel;
  try {
    fallback = await resolveModel(id, { userId: node.ownerUserId, mustOwn: true });
  } catch (err) {
    logger.warn({ fallbackAiModelId: id, errName: err instanceof Error ? err.name : typeof err }, "Modello di ripiego del nodo non usabile");
    return null;
  }
  if (fallback.kind !== "openai_compatible") return null;
  if ((await teamBudgetBlock(instanceId, id)) !== null) return null;
  const [row] = await db.select({ displayName: aiModelsTable.displayName }).from(aiModelsTable).where(eq(aiModelsTable.id, id)).limit(1);
  return { resolved: fallback, name: row?.displayName || fallback.modelId };
}
