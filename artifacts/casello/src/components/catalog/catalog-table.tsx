import { Fragment, useMemo, useState } from "react";
import { type AiProvider, useListCatalogModels } from "@workspace/api-client-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAiModelGroups } from "@/components/ai/ai-queries";
import { useProviderLabel } from "@/components/account/ai-account-dialog";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatModelPrice } from "@/lib/format";

const STATUS_LABELS = { available: "Disponibile", deprecated: "In dismissione", retired: "Ritirato" } as const;

/** Catalogo dei modelli per provider, raggruppato per famiglia. */
export function CatalogTable() {
  const catalog = useListCatalogModels();
  const groups = useAiModelGroups();
  const [chosen, setChosen] = useState<AiProvider | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const providerLabel = useProviderLabel();

  const models = catalog.data ?? [];
  const providers = useMemo(() => [...new Set(models.map((m) => m.provider))], [models]);

  // Preselezione: il provider del primo account personale, altrimenti il primo del catalogo
  const ownProvider = groups.data?.find((g) => !g.account.isSystem)?.account.provider;
  const preferred = ownProvider && providers.includes(ownProvider) ? ownProvider : providers[0];
  const provider = chosen && providers.includes(chosen) ? chosen : preferred;

  const families = useMemo(() => {
    const byFamily = new Map<string, typeof models>();
    for (const m of models) {
      if (m.provider !== provider || (m.status === "retired" && !showRetired)) continue;
      byFamily.set(m.family, [...(byFamily.get(m.family) ?? []), m]);
    }
    return [...byFamily.entries()];
  }, [models, provider, showRetired]);

  if (catalog.isLoading) return <Skeleton className="h-48 w-full" />;
  if (catalog.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{apiErrorMessage(catalog.error)}</AlertDescription>
      </Alert>
    );
  }
  if (models.length === 0) {
    return <p className="text-sm text-muted-foreground">Il catalogo è vuoto: aggiornalo per popolarlo.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <Select value={provider} onValueChange={(value) => setChosen(value as AiProvider)}>
          <SelectTrigger className="w-56" aria-label="Provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p} value={p}>
                {providerLabel(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Checkbox id="show-retired" checked={showRetired} onCheckedChange={(v) => setShowRetired(v === true)} />
          <Label htmlFor="show-retired">Mostra ritirati</Label>
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Versione</TableHead>
              <TableHead>Modello</TableHead>
              <TableHead>Rilascio</TableHead>
              <TableHead>Prezzo</TableHead>
              <TableHead>Contesto</TableHead>
              <TableHead>Strumenti</TableHead>
              <TableHead>Stato</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {families.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  Nessun modello da mostrare.
                </TableCell>
              </TableRow>
            )}
            {families.map(([family, items]) => (
              <Fragment key={family}>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableCell colSpan={7} className="font-medium">
                    {family}
                  </TableCell>
                </TableRow>
                {items.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>{m.version}</TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{m.modelId}</span>
                      {m.inMyAccounts && (
                        <Badge variant="secondary" className="ml-2">
                          nei tuoi account
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{m.releasedAt ? new Date(m.releasedAt).toLocaleDateString("it-IT") : "—"}</TableCell>
                    <TableCell>{formatModelPrice(m.priceInput, m.priceOutput)}</TableCell>
                    <TableCell>{m.contextTokens != null ? m.contextTokens.toLocaleString("it-IT") : "—"}</TableCell>
                    <TableCell>{m.supportsTools == null ? "—" : m.supportsTools ? "Sì" : "No"}</TableCell>
                    <TableCell>
                      <Badge variant={m.status === "available" ? "outline" : "secondary"}>
                        {STATUS_LABELS[m.status]}
                        {m.status === "deprecated" && m.deprecationDate
                          ? ` dal ${new Date(m.deprecationDate).toLocaleDateString("it-IT")}`
                          : ""}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
