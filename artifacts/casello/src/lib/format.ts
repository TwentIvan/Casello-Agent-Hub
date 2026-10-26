import { formatDistanceToNow } from "date-fns";
import { it } from "date-fns/locale";

/** Durata leggibile: "850 ms", "4,2 s", "1 min 12 s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toLocaleString("it-IT", { maximumFractionDigits: 1 })} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds % 60)} s`;
}

/** Tempo relativo in italiano: "3 minuti fa". */
export function formatRelative(date: string | Date): string {
  return formatDistanceToNow(new Date(date), { addSuffix: true, locale: it });
}

/** Importo in dollari con al massimo 4 decimali: "0,0017 $"; un importo positivo più piccolo è "< 0,0001 $". */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.0001) return "< 0,0001 $";
  return `${value.toLocaleString("it-IT", { maximumFractionDigits: 4 })} $`;
}

/** Prezzi per milione di token: "0,28 / 0,42 $ per Mtok", o "prezzo sconosciuto" se ne manca uno. */
export function formatModelPrice(priceInput: number | null, priceOutput: number | null): string {
  if (priceInput == null || priceOutput == null) return "prezzo sconosciuto";
  const fmt = (n: number) => n.toLocaleString("it-IT", { maximumFractionDigits: 4 });
  return `${fmt(priceInput)} / ${fmt(priceOutput)} $ per Mtok`;
}

/**
 * Costo di un'analisi o di una run: l'importo se noto; "costo parziale" se manca ma qualche token è stato
 * consumato (prezzo mancante o vecchio gateway); null se non c'è nulla da mostrare.
 */
export function formatCost(costUsd: number | null | undefined, tokens: number): string | null {
  if (costUsd != null) return formatUsd(costUsd);
  return tokens > 0 ? "costo parziale" : null;
}
