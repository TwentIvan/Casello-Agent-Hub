import { getListModelsQueryKey, useListModels } from "@workspace/api-client-react";

export interface ModelOption {
  id: string;
  label: string;
  isDefault: boolean;
}

/**
 * Modelli selezionabili (GET /api/models). Se l'agente usa un modello che non è più nella lista
 * (es. il vecchio openai/gpt-4o-mini) lo si aggiunge, segnalato, per non perderlo dal select.
 */
export function useModelOptions(currentModel?: string) {
  const models = useListModels({ query: { queryKey: getListModelsQueryKey(), staleTime: 10 * 60_000 } });
  const options: ModelOption[] = [...(models.data ?? [])];
  if (currentModel && models.data && !options.some((m) => m.id === currentModel)) {
    options.push({ id: currentModel, label: `${currentModel} (non più disponibile)`, isDefault: false });
  }
  const defaultModel = models.data?.find((m) => m.isDefault)?.id;
  return { options, defaultModel, isLoading: models.isLoading };
}
