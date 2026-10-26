import { useState } from "react";
import { type AiProvider, useListCatalogModels, useListCatalogProviders } from "@workspace/api-client-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAiModelGroups } from "@/components/ai/ai-queries";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatModelPrice } from "@/lib/format";

const ALL = "__all__";

/** Catalogo universale: prima pagina dei modelli (chat), filtrabile per provider; la vista completa arriva dopo. */
export function CatalogTable() {
  const groups = useAiModelGroups();
  const providers = useListCatalogProviders();
  const [chosen, setChosen] = useState<AiProvider | null>(null);
  const [showRetired, setShowRetired] = useState(false);

  // Preselezione: il provider del primo account personale, altrimenti tutti
  const withModels = (providers.data ?? []).filter((p) => p.modelCount > 0);
  const ownProvider = groups.data?.find((g) => !g.account.isSystem)?.account.provider;
  const preferred = ownProvider && withModels.some((p) => p.slug === ownProvider) ? ownProvider : ALL;
  const provider = chosen ?? preferred;

  const catalog = useListCatalogModels({
    provider: provider === ALL ? undefined : [provider],
    includeRetired: showRetired || undefined,
  });

  if (catalog.isLoading || providers.isLoading) return <Skeleton className="h-48 w-full" />;
  if (catalog.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{apiErrorMessage(catalog.error)}</AlertDescription>
      </Alert>
    );
  }
  const page = catalog.data;
  if (withModels.length === 0) {
    return <p className="text-sm text-muted-foreground">Il catalogo è vuoto: aggiornalo per popolarlo.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <Select value={provider} onValueChange={(value) => setChosen(value)}>
          <SelectTrigger className="w-56" aria-label="Provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tutti i provider</SelectItem>
            {withModels.map((p) => (
              <SelectItem key={p.slug} value={p.slug}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Checkbox id="show-retired" checked={showRetired} onCheckedChange={(v) => setShowRetired(v === true)} />
          <Label htmlFor="show-retired">Mostra ritirati</Label>
        </div>
        {page && (
          <span className="text-sm text-muted-foreground">
            {page.items.length} di {page.total} modelli
          </span>
        )}
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Autore</TableHead>
              <TableHead>Modello</TableHead>
              <TableHead>Rilascio</TableHead>
              <TableHead>Prezzo più basso</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Strumenti</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(page?.items.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  Nessun modello da mostrare.
                </TableCell>
              </TableRow>
            )}
            {page?.items.map((m) => (
              <TableRow key={m.id}>
                <TableCell>{m.author}</TableCell>
                <TableCell>
                  {m.family} {m.version}
                  {m.inMyAccounts && (
                    <Badge variant="secondary" className="ml-2">
                      nei tuoi account
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{m.releasedAt ? new Date(m.releasedAt).toLocaleDateString("it-IT") : "—"}</TableCell>
                <TableCell>
                  {m.cheapestOffer ? formatModelPrice(m.cheapestOffer.priceInput, m.cheapestOffer.priceOutput) : "prezzo sconosciuto"}
                </TableCell>
                <TableCell>{m.offerCount}</TableCell>
                <TableCell>{m.supportsTools == null ? "—" : m.supportsTools ? "Sì" : "No"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
