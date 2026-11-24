// Allegati delle chat (issue #120): il modello della conversazione li può leggere? Controllo unico lato server, all'invio
// del messaggio e di nuovo nel turno (`runChatTurn`). Claude Code (nodo) non riceve allegati (il turno sul Mac ha solo
// testo) e non si ripiega sul modello cloud; le immagini vogliono la visione dell'offerta effettiva del modello (non
// quella fusa del catalogo); i PDF solo i provider che accettano la parte `file` dell'API compatibile OpenAI.

import { eq } from "drizzle-orm";
import { db, aiAccountsTable, aiModelsTable, modelOffersTable } from "@workspace/db";
import { isImage } from "./formats";

export const CHAT_ATTACHMENT_MESSAGES = {
  invalid: "allegato non valido",
  format: "formato non ammesso: allega immagini PNG, JPEG o WebP oppure PDF",
  tooLarge: "allegato troppo grande: al massimo 10 MB",
  quota: "spazio allegati della conversazione esaurito: al massimo 50 MB",
  notFound: "allegato non trovato",
  conversationNotFound: "conversazione non trovata",
  readOnly: "conversazione in sola lettura",
  alreadySent: "allegato già mandato: non si elimina",
  tooMany: "al massimo 5 allegati per messaggio",
  repeated: "allegati ripetuti",
  unavailable: "allegati non più disponibili: caricali di nuovo",
  busy: "gli allegati si mandano a risposta finita: aspetta la fine del turno",
  noModel: "scegli un modello per la conversazione prima di mandare allegati",
  node: "Claude Code (nodo) non legge gli allegati: scegli un modello cloud per questa conversazione",
  noVision: "il modello della conversazione non legge le immagini: scegli un modello con la visione",
  noPdf: "il modello della conversazione non legge i PDF: usa un modello di OpenAI o di OpenRouter che li accetta",
} as const;

/** Provider la cui API compatibile OpenAI accetta la parte `file` con un PDF in base64. */
export const PDF_PROVIDERS: ReadonlySet<string> = new Set(["openai", "openrouter"]);
/** OpenRouter legge i PDF con ogni modello (li converte in testo se il modello non li accetta). */
const PDF_ANY_MODEL_PROVIDERS: ReadonlySet<string> = new Set(["openrouter"]);

export interface ModelCapabilities {
  provider: string;
  node: boolean;
  /** Dall'offerta collegata al modello; null = non nota (o nessuna offerta). */
  supportsVision: boolean | null;
  supportsPdf: boolean | null;
}

/**
 * Motivo per cui il modello non legge gli allegati dei tipi dati, o null. Una capacità non nota non blocca: decide il
 * provider (errore del modello nel turno). Pura.
 */
export function attachmentSupportError(model: ModelCapabilities, contentTypes: string[]): string | null {
  if (contentTypes.length === 0) return null;
  if (model.node) return CHAT_ATTACHMENT_MESSAGES.node;
  if (contentTypes.some(isImage) && model.supportsVision === false) return CHAT_ATTACHMENT_MESSAGES.noVision;
  if (contentTypes.some((t) => !isImage(t))) {
    if (!PDF_PROVIDERS.has(model.provider)) return CHAT_ATTACHMENT_MESSAGES.noPdf;
    if (!PDF_ANY_MODEL_PROVIDERS.has(model.provider) && model.supportsPdf === false) return CHAT_ATTACHMENT_MESSAGES.noPdf;
  }
  return null;
}

/** Capacità del modello dall'account e dall'offerta collegata; null se il modello non esiste. */
export async function loadModelCapabilities(aiModelId: number): Promise<ModelCapabilities | null> {
  const [row] = await db
    .select({
      provider: aiAccountsTable.provider,
      nodeId: aiAccountsTable.nodeId,
      supportsVision: modelOffersTable.supportsVision,
      supportsPdf: modelOffersTable.supportsPdf,
    })
    .from(aiModelsTable)
    .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
    .leftJoin(modelOffersTable, eq(aiModelsTable.offerId, modelOffersTable.id))
    .where(eq(aiModelsTable.id, aiModelId))
    .limit(1);
  if (!row) return null;
  return {
    provider: row.provider,
    node: row.provider === "claude_code_node" || row.nodeId !== null,
    supportsVision: row.supportsVision ?? null,
    supportsPdf: row.supportsPdf ?? null,
  };
}
