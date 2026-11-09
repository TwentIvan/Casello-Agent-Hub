// Modelli Claude Code (nodo): si scelgono come gli altri, tranne dove il consumatore gira solo nel cloud (ruoli `cloud`
// delle squadre, analisi dell'architetto, centralino). Lì l'API li rifiuta: la console li toglie dalle tendine.

/** Provider degli account Claude Code (nodo). */
export const NODE_PROVIDER = "claude_code_node";

export const isNodeAccount = (account: { provider: string }): boolean => account.provider === NODE_PROVIDER;

/** Gruppi di modelli per account senza quelli degli account nodo, nello stesso ordine. */
export function withoutNodeModels<G extends { account: { provider: string } }>(groups: G[]): G[] {
  return groups.filter((g) => !isNodeAccount(g.account));
}
