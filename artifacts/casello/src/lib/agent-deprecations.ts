import type { AgentModelDeprecation } from "@workspace/api-client-react";
import { formatModelPrice } from "./format";

// Agenti con il modello ritirato o in dismissione entro 30 giorni (issue #114): testi del riepilogo del catalogo e
// dell'avviso nella pagina Agenti, con il sostituto proposto dal server.

/** "2026-11-15" → 15/11/2026, senza passare dal fuso orario; null se non è una data. */
function italianDay(date: string | null): string | null {
  const m = date ? /^(\d{4})-(\d{2})-(\d{2})/.exec(date) : null;
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/** Stato del modello in breve: «Ritirato» oppure «In dismissione il gg/mm/aaaa». */
export function deprecationLabel(item: Pick<AgentModelDeprecation, "retired" | "deprecationDate">): string {
  const day = italianDay(item.deprecationDate);
  if (item.retired) return day ? `Ritirato il ${day}` : "Ritirato";
  return day ? `In dismissione il ${day}` : "In dismissione";
}

/** Sostituto proposto, o il motivo per cui manca. */
export function replacementText(item: Pick<AgentModelDeprecation, "replacement">): string {
  const r = item.replacement;
  if (!r) return "nessun sostituto con strumenti tra i tuoi modelli";
  return `sostituto proposto: ${r.name} (${r.accountName}, ${formatModelPrice(r.priceInput, r.priceOutput)})`;
}

/** Riga del riepilogo del catalogo: agente, App, modello, stato e sostituto. */
export function agentDeprecationLine(item: AgentModelDeprecation): string {
  return `${item.agentName} (${item.appName}) · ${item.modelName}: ${deprecationLabel(item).toLowerCase()}, ${replacementText(item)}`;
}
