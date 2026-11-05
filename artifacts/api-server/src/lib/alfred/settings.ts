import { and, eq } from "drizzle-orm";
import { db, aiAccountsTable, aiModelsTable, modelOffersTable, usersTable } from "@workspace/db";
import { ModelAccessError, resolveModel } from "../ai/executor";
import { ProviderError } from "../ai/discovery";
import { ModelChoiceError, MODEL_UNAVAILABLE } from "../ai/choice";
import { effectiveStatus } from "../ai/model-status";
import { ALFRED_MESSAGES, ALFRED_VOICES, DEFAULT_ALFRED_VOICE, bareModelName, isAlfredModelName } from "./config";
import { AlfredError, checkLiveSupport } from "./gemini";

export interface AlfredSettings {
  aiModelId: number | null;
  voice: string;
  models: { id: number; name: string; accountName: string }[];
}

/** Idoneo ad Alfred: nome Live e stato effettivo disponibile (né ritirato né segnalato non disponibile). */
function isEligibleModel(
  model: { modelId: string; availability: "available" | "unavailable" | "unknown" },
  offer: { status: "available" | "deprecated" | "retired"; deprecationDate: Date | null } | null,
): boolean {
  if (!isAlfredModelName(model.modelId)) return false;
  const status = effectiveStatus(
    { availability: model.availability, catalogStatus: offer?.status ?? null, deprecationDate: offer?.deprecationDate ?? null },
    new Date(),
  );
  return status === "available";
}

/** Modello e voce salvati, più i modelli idonei dell'utente (per nome, senza chiamare Gemini). */
export async function getAlfredSettings(userId: number): Promise<AlfredSettings> {
  const [user] = await db
    .select({ aiModelId: usersTable.alfredAiModelId, voice: usersTable.alfredVoice })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const rows = await db
    .select({ model: aiModelsTable, accountName: aiAccountsTable.name, offer: modelOffersTable })
    .from(aiModelsTable)
    .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
    .leftJoin(modelOffersTable, eq(aiModelsTable.offerId, modelOffersTable.id))
    .where(and(eq(aiAccountsTable.userId, userId), eq(aiAccountsTable.provider, "gemini")));
  const models = rows
    .filter((r) => isEligibleModel(r.model, r.offer))
    .map((r) => ({ id: r.model.id, name: bareModelName(r.model.modelId), accountName: r.accountName }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  const voice = user?.voice && ALFRED_VOICES.includes(user.voice) ? user.voice : DEFAULT_ALFRED_VOICE;
  return { aiModelId: user?.aiModelId ?? null, voice, models };
}

/**
 * Imposta modello (di un proprio account Gemini, adatto a Live) e voce; `aiModelId` null toglie il modello senza
 * chiamare Gemini. Voce assente = invariata. Errori: `ModelChoiceError`/`AlfredError` con messaggio fisso.
 */
export async function setAlfredSettings(userId: number, input: { aiModelId: number | null; voice?: string }): Promise<void> {
  if (input.voice !== undefined && !ALFRED_VOICES.includes(input.voice)) {
    throw new AlfredError(ALFRED_MESSAGES.voiceUnavailable, 400);
  }
  if (input.aiModelId !== null) {
    if (!Number.isSafeInteger(input.aiModelId) || input.aiModelId <= 0) throw new ModelChoiceError(MODEL_UNAVAILABLE);
    let resolved;
    try {
      resolved = await resolveModel(input.aiModelId, { userId, mustOwn: true });
    } catch (err) {
      if (err instanceof ModelAccessError || err instanceof ProviderError) throw new ModelChoiceError(MODEL_UNAVAILABLE);
      throw err;
    }
    if (resolved.provider !== "gemini") throw new AlfredError(ALFRED_MESSAGES.modelUnsuitable, 400);
    const [row] = await db
      .select({ model: aiModelsTable, offer: modelOffersTable })
      .from(aiModelsTable)
      .leftJoin(modelOffersTable, eq(aiModelsTable.offerId, modelOffersTable.id))
      .where(eq(aiModelsTable.id, resolved.aiModelId))
      .limit(1);
    if (!row || !isEligibleModel(row.model, row.offer)) throw new AlfredError(ALFRED_MESSAGES.modelUnsuitable, 400);
    await checkLiveSupport(resolved);
  }
  await db
    .update(usersTable)
    .set({ alfredAiModelId: input.aiModelId, ...(input.voice !== undefined ? { alfredVoice: input.voice } : {}) })
    .where(eq(usersTable.id, userId));
}
