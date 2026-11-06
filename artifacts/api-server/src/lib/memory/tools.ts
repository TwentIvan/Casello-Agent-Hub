// Strumenti di memoria dei personaggi (Lucius, Alfred): appunti brevi e ricerca nello storico.
// Risultati `ok: false` con messaggio fisso, mai eccezioni.

import { z } from "zod";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { MemoryError, type Character } from "./types";
import { addNote, deleteNote, updateNote } from "./notes";
import { searchHistory } from "./history";

export const MEMORY_TOOL_NAMES = ["ricorda", "aggiorna_appunto", "dimentica", "cerca_nello_storico"] as const;
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

export type MemoryToolResult = { ok: true; result: unknown } | { ok: false; error: string };

const INVALID_ARGS = "argomenti non validi";
const UNKNOWN_TOOL = "strumento sconosciuto";

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ChatCompletionFunctionTool => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});

const NOTE_RULES =
  "Un appunto è un fatto o una preferenza stabile sull'utente, breve (al massimo 300 caratteri). Mai credenziali, chiavi, password o token.";

export const MEMORY_TOOLS: ChatCompletionFunctionTool[] = [
  tool("ricorda", `Salva un appunto sull'utente per le conversazioni future. ${NOTE_RULES}`, { testo: { type: "string", description: "L'appunto, breve e stabile" } }, ["testo"]),
  tool(
    "aggiorna_appunto",
    `Sostituisce il testo di un appunto esistente. ${NOTE_RULES}`,
    { id: { type: "integer", description: "Id dell'appunto" }, testo: { type: "string", description: "Il nuovo testo" } },
    ["id", "testo"],
  ),
  tool("dimentica", "Elimina un appunto che non vale più.", { id: { type: "integer", description: "Id dell'appunto" } }, ["id"]),
  tool(
    "cerca_nello_storico",
    "Cerca nei riassunti delle conversazioni passate con l'utente (titolo e riassunto). Restituisce al massimo 5 risultati.",
    { testo: { type: "string", description: "Parole da cercare" } },
    ["testo"],
  ),
];

const remember = z.object({ testo: z.string() }).strict();
const update = z.object({ id: z.number().int().positive(), testo: z.string() }).strict();
const forget = z.object({ id: z.number().int().positive() }).strict();
const search = z.object({ testo: z.string().max(200) }).strict();

export async function runMemoryTool(userId: number, character: Character, name: string, args: unknown): Promise<MemoryToolResult> {
  try {
    switch (name) {
      case "ricorda": {
        const a = remember.safeParse(args);
        if (!a.success) return { ok: false, error: INVALID_ARGS };
        const note = await addNote(userId, character, a.data.testo);
        return { ok: true, result: { id: note.id } };
      }
      case "aggiorna_appunto": {
        const a = update.safeParse(args);
        if (!a.success) return { ok: false, error: INVALID_ARGS };
        await updateNote(userId, character, a.data.id, a.data.testo);
        return { ok: true, result: { updated: a.data.id } };
      }
      case "dimentica": {
        const a = forget.safeParse(args);
        if (!a.success) return { ok: false, error: INVALID_ARGS };
        await deleteNote(userId, character, a.data.id);
        return { ok: true, result: { deleted: a.data.id } };
      }
      case "cerca_nello_storico": {
        const a = search.safeParse(args);
        if (!a.success) return { ok: false, error: INVALID_ARGS };
        const rows = await searchHistory(userId, character, a.data.testo);
        return { ok: true, result: rows.map((r) => ({ title: r.title, summary: r.summary, createdAt: r.createdAt })) };
      }
      default:
        return { ok: false, error: UNKNOWN_TOOL };
    }
  } catch (err) {
    if (err instanceof MemoryError) return { ok: false, error: err.message };
    throw err;
  }
}
