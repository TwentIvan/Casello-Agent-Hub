import type { QueryClient } from "@tanstack/react-query";
import { getListAiModelsQueryKey, useListAiModels } from "@workspace/api-client-react";

/** Modelli selezionabili dall'utente (propri account + sistema), raggruppati per account. */
export function useAiModelGroups() {
  return useListAiModels({ query: { queryKey: getListAiModelsQueryKey(), staleTime: 60_000 } });
}

/**
 * Modello da preselezionare: il primo dell'account predefinito; se nessun account è predefinito (es. solo
 * l'account di sistema) il primo del primo gruppo con account non in errore, poi di qualsiasi gruppo.
 * null finché i modelli non sono arrivati o se non ce ne sono.
 */
export function useDefaultAiModelId(): number | null {
  const groups = useAiModelGroups();
  const data = groups.data ?? [];
  const preferred = data.find((g) => g.account.isDefault && g.models.length > 0);
  // In mancanza del predefinito si preferisce un account non in errore
  const fallback =
    data.find((g) => g.account.status !== "error" && g.models.length > 0) ?? data.find((g) => g.models.length > 0);
  return (preferred ?? fallback)?.models[0]?.id ?? null;
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
