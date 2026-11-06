import { and, asc, eq, sql } from "drizzle-orm";
import { db, characterNotesTable, usersTable } from "@workspace/db";
import { looksLikeCredential } from "./credentials";
import { MEMORY_MESSAGES, MemoryError, NOTES_MAX, NOTE_MAX_CHARS, type Character } from "./types";

export interface NoteView {
  id: number;
  content: string;
  ref: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type NoteRow = typeof characterNotesTable.$inferSelect;

const view = (r: NoteRow): NoteView => ({
  id: r.id,
  content: r.content,
  ref: r.ref,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

function cleanContent(content: string): string {
  const text = content.trim();
  if (!text) throw new MemoryError(400, MEMORY_MESSAGES.empty);
  if (text.length > NOTE_MAX_CHARS) throw new MemoryError(400, MEMORY_MESSAGES.tooLong);
  if (looksLikeCredential(text)) throw new MemoryError(400, MEMORY_MESSAGES.credential);
  return text;
}

export async function listNotes(userId: number, character: Character): Promise<NoteView[]> {
  const rows = await db
    .select()
    .from(characterNotesTable)
    .where(and(eq(characterNotesTable.userId, userId), eq(characterNotesTable.character, character)))
    .orderBy(asc(characterNotesTable.createdAt), asc(characterNotesTable.id));
  return rows.map(view);
}

export async function addNote(userId: number, character: Character, content: string, ref?: string | null): Promise<NoteView> {
  const text = cleanContent(content);
  return db.transaction(async (tx) => {
    // Riga utente bloccata: due aggiunte concorrenti non superano il tetto
    await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).for("update");
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(characterNotesTable)
      .where(and(eq(characterNotesTable.userId, userId), eq(characterNotesTable.character, character)))) as [{ n: number }];
    if (n >= NOTES_MAX) throw new MemoryError(409, MEMORY_MESSAGES.full);
    const [row] = await tx
      .insert(characterNotesTable)
      .values({ userId, character, content: text, ref: ref ?? null })
      .returning();
    return view(row!);
  });
}

export async function updateNote(userId: number, character: Character, id: number, content: string): Promise<NoteView> {
  const text = cleanContent(content);
  const [row] = await db
    .update(characterNotesTable)
    .set({ content: text, updatedAt: new Date() })
    .where(
      and(eq(characterNotesTable.id, id), eq(characterNotesTable.userId, userId), eq(characterNotesTable.character, character)),
    )
    .returning();
  if (!row) throw new MemoryError(404, MEMORY_MESSAGES.notFound);
  return view(row);
}

export async function deleteNote(userId: number, character: Character, id: number): Promise<void> {
  const rows = await db
    .delete(characterNotesTable)
    .where(
      and(eq(characterNotesTable.id, id), eq(characterNotesTable.userId, userId), eq(characterNotesTable.character, character)),
    )
    .returning({ id: characterNotesTable.id });
  if (rows.length === 0) throw new MemoryError(404, MEMORY_MESSAGES.notFound);
}
