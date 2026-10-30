import type { AiModel } from "@workspace/api-client-react";

/** Entro quanti giorni dalla data di dismissione si avvisa. */
export const DEPRECATION_WARNING_DAYS = 30;

export type DeprecationBadge = { tone: "retired" | "soon"; label: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/** "2026-11-15" (o data ISO completa) → 15/11/2026, senza passare dal fuso orario. */
function formatItalianDate(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/**
 * Avviso per il modello di un agente: ritirato (rosso) oppure con dismissione entro
 * `DEPRECATION_WARNING_DAYS` giorni (giallo). null se non serve alcun avviso.
 */
export function deprecationBadge(
  model: Pick<AiModel, "status" | "deprecationDate"> | null | undefined,
  now: Date,
): DeprecationBadge | null {
  if (!model) return null;
  if (model.status === "retired") return { tone: "retired", label: "Ritirato" };
  if (!model.deprecationDate) return null;
  const when = Date.parse(model.deprecationDate);
  if (Number.isNaN(when)) return null;
  const days = (when - now.getTime()) / DAY_MS;
  const label = formatItalianDate(model.deprecationDate);
  if (!label || days < 0 || days > DEPRECATION_WARNING_DAYS) return null;
  return { tone: "soon", label: `In dismissione il ${label}` };
}
