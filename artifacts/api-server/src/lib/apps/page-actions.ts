// Azioni della pagina di un'App ospite (`apps.page_actions`): richieste configurate in Botcave per un tipo di pagina.

import type { PageAction } from "@workspace/db";

/** Azione con quella pagina e quell'etichetta (confronto esatto), altrimenti null. */
export function findPageAction(actions: readonly PageAction[], page: string, label: string): PageAction | null {
  return actions.find((a) => a.page === page && a.label === label) ?? null;
}
