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

/** Selezionabile: disponibile e senza strumenti esclusi (null = non noto, ammesso). */
export function isSelectable(status: EffectiveStatus, supportsTools: boolean | null): boolean {
  return status === "available" && supportsTools !== false;
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
  const selectable = models.filter((m) => isSelectable(m.status, m.supportsTools));
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
