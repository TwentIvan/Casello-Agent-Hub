// Conversazioni dei personaggi: creazione su un argomento verificato e lettura con il controllo del proprietario.

import { and, eq } from "drizzle-orm";
import { db, characterConversationsTable, type CharacterConversation } from "@workspace/db";
import { getSubject } from "./registry";
import { characterModelFor } from "./settings";
import { CHARACTER_MESSAGES, CharacterError, type Character, type SubjectType } from "./types";

/**
 * Crea una conversazione di `character` sull'argomento. Argomento sconosciuto, di un altro personaggio o non
 * risolvibile per l'utente → `CharacterError` 404 «argomento non trovato». Modello iniziale: `characterModelFor`.
 */
export async function createConversation(
  userId: number,
  character: Character,
  subjectType: SubjectType,
  subjectId: string | null,
): Promise<CharacterConversation> {
  const handler = getSubject(subjectType);
  if (handler.character !== character) throw new CharacterError(404, CHARACTER_MESSAGES.subjectNotFound);
  const resolved = await handler.resolve(userId, subjectId);
  if (!resolved) throw new CharacterError(404, CHARACTER_MESSAGES.subjectNotFound);
  const aiModelId = await characterModelFor(userId, character);
  const [conv] = await db
    .insert(characterConversationsTable)
    .values({ userId, character, subjectType, subjectId, subjectTitle: resolved.title, aiModelId, title: "" })
    .returning();
  return conv!;
}

/** Conversazione dell'utente; altrui o inesistente → `CharacterError` 404 «conversazione non trovata». */
export async function getConversation(userId: number, conversationId: number): Promise<CharacterConversation> {
  const [conv] = await db
    .select()
    .from(characterConversationsTable)
    .where(and(eq(characterConversationsTable.id, conversationId), eq(characterConversationsTable.userId, userId)));
  if (!conv) throw new CharacterError(404, CHARACTER_MESSAGES.notFound);
  return conv;
}
