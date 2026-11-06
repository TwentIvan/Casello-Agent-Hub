import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db, characterHistoryTable } from "@workspace/db";
import { redactCredentials } from "./credentials";
import {
  HISTORY_LIST_MAX,
  HISTORY_MAX,
  HISTORY_SEARCH_MAX,
  HISTORY_SUMMARY_MAX,
  HISTORY_TITLE_MAX,
  MEMORY_MESSAGES,
  MemoryError,
  RECENT_TITLES,
  type Character,
} from "./types";

export type HistoryKind = typeof characterHistoryTable.$inferSelect["kind"];

export interface HistoryView {
  id: number;
  kind: HistoryKind;
  refId: number;
  title: string;
  summary: string;
  createdAt: Date;
}

export interface HistoryEntryInput {
  userId: number;
  character: Character;
  kind: HistoryKind;
  refId: number;
  title: string;
  summary: string;
  aiModelId: number | null;
  tokensUsed: number;
  costUsd: number | string | null;
}

type HistoryRow = typeof characterHistoryTable.$inferSelect;

const view = (r: HistoryRow): HistoryView => ({
  id: r.id,
  kind: r.kind,
  refId: r.refId,
  title: r.title,
  summary: r.summary,
  createdAt: r.createdAt,
});

const scope = (userId: number, character: Character) =>
  and(eq(characterHistoryTable.userId, userId), eq(characterHistoryTable.character, character));

// Voci visibili: quelle eliminate (deleted_at) restano solo per la spesa
const visible = (userId: number, character: Character) => and(scope(userId, character), isNull(characterHistoryTable.deletedAt));

// Salva il riassunto di una conversazione: lo stesso riferimento si sostituisce; oltre 500 voci si tolgono le più vecchie
export async function addHistory(entry: HistoryEntryInput): Promise<void> {
  const values = {
    userId: entry.userId,
    character: entry.character,
    kind: entry.kind,
    refId: entry.refId,
    title: redactCredentials(entry.title.trim()).slice(0, HISTORY_TITLE_MAX),
    summary: redactCredentials(entry.summary.trim()).slice(0, HISTORY_SUMMARY_MAX),
    aiModelId: entry.aiModelId,
    tokensUsed: entry.tokensUsed,
    costUsd: entry.costUsd === null ? null : String(entry.costUsd),
  };
  await db.transaction(async (tx) => {
    await tx
      .insert(characterHistoryTable)
      .values(values)
      .onConflictDoUpdate({
        target: [
          characterHistoryTable.userId,
          characterHistoryTable.character,
          characterHistoryTable.kind,
          characterHistoryTable.refId,
        ],
        set: {
          title: values.title,
          summary: values.summary,
          aiModelId: values.aiModelId,
          // Ogni riassunto costa: token e costo si accumulano (la spesa somma questa tabella).
          // Costo nullo = prezzo mancante: resta nullo se c'erano token già spesi senza prezzo
          tokensUsed: sql`${characterHistoryTable.tokensUsed} + ${values.tokensUsed}`,
          costUsd:
            values.costUsd === null
              ? sql`null`
              : sql`case when ${characterHistoryTable.costUsd} is not null then ${characterHistoryTable.costUsd} + ${values.costUsd}::numeric when ${characterHistoryTable.tokensUsed} = 0 then ${values.costUsd}::numeric else null end`,
          createdAt: new Date(),
          deletedAt: null,
        },
      });
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(characterHistoryTable)
      .where(visible(entry.userId, entry.character))) as [{ n: number }];
    if (n > HISTORY_MAX) {
      const old = await tx
        .select({ id: characterHistoryTable.id })
        .from(characterHistoryTable)
        .where(visible(entry.userId, entry.character))
        .orderBy(characterHistoryTable.createdAt, characterHistoryTable.id)
        .limit(n - HISTORY_MAX);
      // Eliminazione logica: il costo dei riassunti resta nella spesa
      await tx
        .update(characterHistoryTable)
        .set({ deletedAt: new Date(), title: "", summary: "" })
        .where(
          inArray(
            characterHistoryTable.id,
            old.map((o) => o.id),
          ),
        );
    }
  });
}

export async function recentHistoryTitles(
  userId: number,
  character: Character,
): Promise<{ id: number; title: string; createdAt: Date }[]> {
  return db
    .select({ id: characterHistoryTable.id, title: characterHistoryTable.title, createdAt: characterHistoryTable.createdAt })
    .from(characterHistoryTable)
    .where(visible(userId, character))
    .orderBy(desc(characterHistoryTable.createdAt), desc(characterHistoryTable.id))
    .limit(RECENT_TITLES);
}

async function query(userId: number, character: Character, q: string | undefined, limit: number): Promise<HistoryView[]> {
  const text = (q ?? "").trim();
  // Le wildcard di LIKE scritte dall'utente si cercano come testo
  const pattern = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db
    .select()
    .from(characterHistoryTable)
    .where(
      text
        ? and(visible(userId, character), or(ilike(characterHistoryTable.title, pattern), ilike(characterHistoryTable.summary, pattern)))
        : visible(userId, character),
    )
    .orderBy(desc(characterHistoryTable.createdAt), desc(characterHistoryTable.id))
    .limit(limit);
  return rows.map(view);
}

export const searchHistory = (userId: number, character: Character, q: string) =>
  query(userId, character, q, HISTORY_SEARCH_MAX);

export const listHistory = (userId: number, character: Character, q?: string) =>
  query(userId, character, q, HISTORY_LIST_MAX);

export async function deleteHistory(userId: number, character: Character, id: number): Promise<void> {
  const rows = await db
    .update(characterHistoryTable)
    .set({ deletedAt: new Date(), title: "", summary: "" })
    .where(and(eq(characterHistoryTable.id, id), visible(userId, character)))
    .returning({ id: characterHistoryTable.id });
  if (rows.length === 0) throw new MemoryError(404, MEMORY_MESSAGES.notFound);
}
