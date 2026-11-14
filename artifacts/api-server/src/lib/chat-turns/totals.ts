// Totali di una conversazione (token e costo cumulati) aggiornati alla fine di un turno: le stesse espressioni per le
// tre chat, sia quando il turno chiude la conversazione sia quando il turno è stato chiuso altrove (Ferma da un altro
// processo, turni appesi): in quel caso chi l'ha chiuso non somma nulla, quindi qui non si conta due volte.

import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Espressioni per `tokens_used` e `cost_usd`: costo parziale (null) se manca il prezzo di un turno con token; una
 * conversazione senza token parte da 0; un turno senza token lascia il costo com'è.
 */
export function turnTotals(
  tokensUsed: AnyPgColumn,
  costUsdColumn: AnyPgColumn,
  tokens: number,
  costUsd: string | null,
): { tokensUsed: SQL; costUsd: SQL } {
  return {
    tokensUsed: sql`${tokensUsed} + ${tokens}`,
    costUsd:
      tokens === 0
        ? sql`${costUsdColumn}`
        : costUsd === null
          ? sql`null`
          : sql`case when ${tokensUsed} = 0 then 0 else ${costUsdColumn} end + ${costUsd}::numeric`,
  };
}
