import type { QueryClient } from "@tanstack/react-query";
import { getListAiModelsQueryKey, useListAiModels } from "@workspace/api-client-react";
import { withoutNodeModels } from "@/lib/node-models";

/** Modelli selezionabili dall'utente (dei suoi account), raggruppati per account. */
export function useAiModelGroups() {
  return useListAiModels({ query: { queryKey: getListAiModelsQueryKey(), staleTime: 60_000 } });
}

/**
 * Modello da preselezionare: quello consigliato (`recommended`) dell'account predefinito; se nessun account
 * è predefinito del primo gruppo con account non in errore, poi di qualsiasi
 * gruppo. null finché i modelli non sono arrivati o se non ce ne sono. `cloudOnly`: senza i modelli Claude Code (nodo).
 */
export function useDefaultAiModelId(opts: { cloudOnly?: boolean } = {}): number | null {
  const groups = useAiModelGroups();
  const all = groups.data ?? [];
  // Consumatori solo cloud: mai preselezionare un modello Claude Code (nodo)
  const data = opts.cloudOnly ? withoutNodeModels(all) : all;
  const hasSelectable = (g: (typeof data)[number]) => g.models.some((m) => m.selectable);
  const preferred = data.find((g) => g.account.isDefault && hasSelectable(g));
  // In mancanza del predefinito si preferisce un account non in errore
  const fallback = data.find((g) => g.account.status !== "error" && hasSelectable(g)) ?? data.find(hasSelectable);
  const group = preferred ?? fallback;
  if (!group) return null;
  return (group.models.find((m) => m.recommended) ?? group.models.find((m) => m.selectable))?.id ?? null;
}

/**
 * Dopo ogni modifica ad account o modelli: elenco degli account, gruppi del picker, modelli per account e
 * stime (dipendono dai prezzi). Tutte le chiavi stanno sotto /api/ai/.
 */
export function invalidateAiQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({
    predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/ai/"),
  });
}
