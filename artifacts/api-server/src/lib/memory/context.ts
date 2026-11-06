import { recentHistoryTitles } from "./history";
import { listNotes } from "./notes";
import type { Character } from "./types";

// Blocco di dati per il modello (messaggio user, mai prompt di sistema): appunti e titoli delle ultime conversazioni
export async function memoryContextBlock(userId: number, character: Character): Promise<string> {
  const [notes, titles] = await Promise.all([listNotes(userId, character), recentHistoryTitles(userId, character)]);
  const parts: string[] = [];
  if (notes.length > 0) parts.push(`Appunti (id · testo)\n${notes.map((n) => `${n.id} · ${n.content}`).join("\n")}`);
  if (titles.length > 0) parts.push(`Conversazioni recenti (titoli)\n${titles.map((t) => t.title).join("\n")}`);
  return parts.join("\n\n");
}
