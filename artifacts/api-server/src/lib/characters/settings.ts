import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { budgetColumn } from "../budget";
import { getDefaultModel, ownModel } from "../ai/default-model";
import type { Character } from "../memory/types";
import { CHARACTER_MESSAGES, CharacterError } from "./types";

export interface CharacterSettings {
  alfredChatAiModelId: number | null;
  luciusAiModelId: number | null;
  alfredMonthlyBudgetUsd: number | null;
  luciusMonthlyBudgetUsd: number | null;
}

const num = (v: string | null) => (v === null ? null : Number(v));

export async function getCharacterSettings(userId: number): Promise<CharacterSettings> {
  const [row] = await db
    .select({
      alfredChatAiModelId: usersTable.alfredChatAiModelId,
      luciusAiModelId: usersTable.luciusAiModelId,
      alfredMonthlyBudgetUsd: usersTable.alfredMonthlyBudgetUsd,
      luciusMonthlyBudgetUsd: usersTable.luciusMonthlyBudgetUsd,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return {
    alfredChatAiModelId: row?.alfredChatAiModelId ?? null,
    luciusAiModelId: row?.luciusAiModelId ?? null,
    alfredMonthlyBudgetUsd: num(row?.alfredMonthlyBudgetUsd ?? null),
    luciusMonthlyBudgetUsd: num(row?.luciusMonthlyBudgetUsd ?? null),
  };
}

/** Salva i campi presenti nel patch; un modello che non è di un proprio account → 400 «modello non disponibile». */
export async function setCharacterSettings(userId: number, patch: Partial<CharacterSettings>): Promise<void> {
  for (const id of [patch.alfredChatAiModelId, patch.luciusAiModelId]) {
    if (id == null) continue;
    if (!Number.isSafeInteger(id) || id <= 0 || !(await ownModel(userId, id, db))) {
      throw new CharacterError(400, CHARACTER_MESSAGES.modelUnavailable);
    }
  }
  const set: Partial<typeof usersTable.$inferInsert> = {};
  if (patch.alfredChatAiModelId !== undefined) set.alfredChatAiModelId = patch.alfredChatAiModelId;
  if (patch.luciusAiModelId !== undefined) set.luciusAiModelId = patch.luciusAiModelId;
  if (patch.alfredMonthlyBudgetUsd !== undefined) set.alfredMonthlyBudgetUsd = budgetColumn(patch.alfredMonthlyBudgetUsd);
  if (patch.luciusMonthlyBudgetUsd !== undefined) set.luciusMonthlyBudgetUsd = budgetColumn(patch.luciusMonthlyBudgetUsd);
  if (Object.keys(set).length === 0) return;
  await db.update(usersTable).set(set).where(eq(usersTable.id, userId));
}

/** Modello del personaggio se ancora di un account dell'utente, altrimenti il predefinito (se ancora suo), altrimenti null. */
export async function characterModelFor(userId: number, character: Character): Promise<number | null> {
  const s = await getCharacterSettings(userId);
  const own = character === "alfred" ? s.alfredChatAiModelId : s.luciusAiModelId;
  for (const id of [own, await getDefaultModel(userId)]) {
    if (id !== null && (await ownModel(userId, id, db))) return id;
  }
  return null;
}
