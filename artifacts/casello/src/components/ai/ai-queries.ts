import type { QueryClient } from "@tanstack/react-query";
import { getListAiModelsQueryKey, useListAiModels } from "@workspace/api-client-react";

/** Modelli selezionabili dall'utente (propri account + sistema), raggruppati per account. */
export function useAiModelGroups() {
  return useListAiModels({ query: { queryKey: getListAiModelsQueryKey(), staleTime: 60_000 } });
}

/** Modello di un gruppo da preselezionare: il più economico tra quelli con prezzi noti, altrimenti il primo. */
function cheapestModel<M extends { priceInput: number | null; priceOutput: number | null }>(models: M[]): M | undefined {
  let best: M | undefined;
  let bestPrice = Infinity;
  for (const m of models) {
    if (m.priceInput == null || m.priceOutput == null) continue;
    const price = m.priceInput + m.priceOutput;
    if (price < bestPrice) {
      best = m;
      bestPrice = price;
    }
  }
  return best ?? models[0];
}

/**
 * Modello da preselezionare: il più economico (prezzo di input + output, tra quelli noti) dell'account
 * predefinito, o il primo se nessun prezzo è noto; se nessun account è predefinito (es. solo l'account di
 * sistema) lo stesso criterio sul primo gruppo con account non in errore, poi su qualsiasi gruppo.
 * null finché i modelli non sono arrivati o se non ce ne sono.
 */
export function useDefaultAiModelId(): number | null {
  const groups = useAiModelGroups();
  const data = groups.data ?? [];
  const preferred = data.find((g) => g.account.isDefault && g.models.length > 0);
  // In mancanza del predefinito si preferisce un account non in errore
  const fallback =
    data.find((g) => g.account.status !== "error" && g.models.length > 0) ?? data.find((g) => g.models.length > 0);
  const group = preferred ?? fallback;
  return group ? (cheapestModel(group.models)?.id ?? null) : null;
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
