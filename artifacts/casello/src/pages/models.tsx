import { getListCatalogModelsQueryKey, useListCatalogModels, useListCatalogProviders } from "@workspace/api-client-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CatalogByModel } from "@/components/catalog/catalog-by-model";
import { CatalogByProvider } from "@/components/catalog/catalog-by-provider";
import { CatalogFilters } from "@/components/catalog/catalog-filters";
import { CatalogNews } from "@/components/catalog/catalog-news";
import { UnmanagedProviders } from "@/components/catalog/unmanaged-providers";
import { apiErrorMessage } from "@/lib/api-errors";
import { type CatalogView, toModelParams, useCatalogQueryState } from "@/lib/catalog-query";

const PAGE_SIZE = 50;

export default function ModelsPage() {
  const { state, update, reset, textInput, setTextInput } = useCatalogQueryState();
  const modelView = state.view === "model";

  const params = toModelParams(state, PAGE_SIZE);
  const catalog = useListCatalogModels(params, {
    query: { queryKey: getListCatalogModelsQueryKey(params), enabled: modelView },
  });
  const providers = useListCatalogProviders();
  const providerOptions = (providers.data ?? [])
    .filter((p) => p.modelCount > 0)
    .map((p) => ({ value: p.slug, label: p.name }));
  const authors = (catalog.data?.items ?? []).map((m) => m.author);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Modelli</h2>
        <p className="text-sm text-muted-foreground">Il catalogo dei modelli dei provider e le sue novità.</p>
      </div>
      <CatalogNews />
      <UnmanagedProviders />

      <Tabs value={state.view} onValueChange={(view) => update({ view: view as CatalogView, page: 1 })}>
        <TabsList>
          <TabsTrigger value="model">Per modello</TabsTrigger>
          <TabsTrigger value="provider">Per provider</TabsTrigger>
        </TabsList>
      </Tabs>

      {modelView ? (
        <div className="space-y-4">
          <CatalogFilters
            state={state}
            update={update}
            reset={reset}
            textInput={textInput}
            setTextInput={setTextInput}
            authors={authors}
            providers={providerOptions}
          />
          {catalog.isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : catalog.isError ? (
            <Alert variant="destructive">
              <AlertDescription>{apiErrorMessage(catalog.error)}</AlertDescription>
            </Alert>
          ) : catalog.data ? (
            <CatalogByModel
              items={catalog.data.items}
              total={catalog.data.total}
              page={catalog.data.page}
              pageSize={catalog.data.pageSize}
              onPage={(page) => update({ page })}
            />
          ) : null}
        </div>
      ) : (
        <CatalogByProvider
          q={state.q}
          textInput={textInput}
          setTextInput={setTextInput}
          status={state.status}
          onStatus={(status) => update({ status })}
          onOpen={(slug) => update({ view: "model", providers: [slug], q: "" })}
        />
      )}
    </div>
  );
}
