import { eq } from "drizzle-orm";
import { db, aiModelsTable } from "@workspace/db";
import { logger } from "../logger";

/**
 * Stato effettivo di un modello di un account, dalla sua disponibilità (vista da Casello) e dal
 * catalogo; selezionabilità e preselezione nella tendina dei modelli.
 */

export type EffectiveStatus = "available" | "unavailable" | "retired";

/** Ritirato (catalogo `retired` o dismissione passata) prima di non disponibile; altrimenti disponibile. */
export function effectiveStatus(
  m: {
    availability: "available" | "unavailable" | "unknown";
    catalogStatus: "available" | "deprecated" | "retired" | null;
    deprecationDate: Date | null;
  },
  now: Date,
): EffectiveStatus {
  if (m.catalogStatus === "retired") return "retired";
  if (m.deprecationDate !== null && m.deprecationDate.getTime() <= now.getTime()) return "retired";
  if (m.availability === "unavailable") return "unavailable";
  return "available";
}

const PREVIEW_RE = /(^|[-_./:])(preview|exp|experimental)([-_./:]|$)/i;

/** Modello in anteprima: id con la parola preview, exp o experimental. */
export function isPreviewModel(modelId: string): boolean {
  return PREVIEW_RE.test(modelId);
}

const AUDIO_ONLY_RE = /(^|[-_./:])(live|audio|tts|transcribe|realtime)([-_./:]|$)/i;

/**
 * Modello solo vocale o audio (Gemini Live, audio nativo, trascrizione, sintesi vocale, realtime): non risponde alle
 * chiamate di chat (il provider le rifiuta con un 400), quindi non si propone per agenti, squadre e personaggi. Il
 * modello vocale di Alfred ha la sua scelta (`lib/alfred/settings.ts`).
 */
export function isAudioOnlyModel(modelId: string): boolean {
  return AUDIO_ONLY_RE.test(modelId);
}

/** Selezionabile: disponibile, senza strumenti esclusi (null = non noto, ammesso) e non solo audio. */
export function isSelectable(status: EffectiveStatus, supportsTools: boolean | null, modelId: string): boolean {
  return status === "available" && supportsTools !== false && !isAudioOnlyModel(modelId);
}

/**
 * Modello da preselezionare in un gruppo: tra i selezionabili con strumenti e non in anteprima, il
 * prezzo noto (input + output) più basso, o il primo se nessuno ha prezzo; se non ce ne sono, lo stesso
 * criterio sui selezionabili non in anteprima, poi su tutti i selezionabili; altrimenti null.
 */
export function pickRecommended<
  M extends {
    id: number;
    modelId: string;
    status: EffectiveStatus;
    supportsTools: boolean | null;
    priceInput: number | null;
    priceOutput: number | null;
  },
>(models: M[]): number | null {
  const selectable = models.filter((m) => isSelectable(m.status, m.supportsTools, m.modelId));
  const notPreview = selectable.filter((m) => !isPreviewModel(m.modelId));
  const withTools = notPreview.filter((m) => m.supportsTools === true);
  const pool = [withTools, notPreview, selectable].find((p) => p.length > 0);
  if (!pool) return null;
  let best: M | null = null;
  for (const m of pool) {
    if (m.priceInput === null || m.priceOutput === null) continue;
    if (best === null || m.priceInput + m.priceOutput < best.priceInput! + best.priceOutput!) best = m;
  }
  return (best ?? pool[0]!).id;
}

/**
 * Segna il modello come non disponibile (una chiamata reale ha ricevuto 404 o "modello inesistente").
 * Non lancia mai: un errore del DB finisce solo nel log, con il nome dell'errore.
 */
export async function markModelUnavailable(aiModelId: number): Promise<void> {
  try {
    await db
      .update(aiModelsTable)
      .set({ availability: "unavailable", updatedAt: new Date() })
      .where(eq(aiModelsTable.id, aiModelId));
  } catch (err) {
    logger.error({ aiModelId, errName: err instanceof Error ? err.name : "unknown" }, "Modello non segnato come non disponibile");
  }
}

/**
 * Segna il modello come disponibile (una chiamata reale è riuscita, es. un turno delegato al nodo).
 * Non lancia mai: un errore del DB finisce solo nel log, con il nome dell'errore.
 */
export async function markModelAvailable(aiModelId: number): Promise<void> {
  try {
    await db
      .update(aiModelsTable)
      .set({ availability: "available", updatedAt: new Date() })
      .where(eq(aiModelsTable.id, aiModelId));
  } catch (err) {
    logger.error({ aiModelId, errName: err instanceof Error ? err.name : "unknown" }, "Modello non segnato come disponibile");
  }
}
