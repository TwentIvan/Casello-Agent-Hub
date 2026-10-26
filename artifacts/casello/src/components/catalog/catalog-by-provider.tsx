import { keepPreviousData } from "@tanstack/react-query";
import { type AiProviderStatus, getListCatalogProvidersQueryKey, useListCatalogProviders } from "@workspace/api-client-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProviderStatusBadge } from "@/components/catalog/catalog-by-model";
import { apiErrorMessage } from "@/lib/api-errors";

const ALL = "__all__";

interface CatalogByProviderProps {
  q: string;
  textInput: string;
  setTextInput: (value: string) => void;
  status: AiProviderStatus | "";
  onStatus: (status: AiProviderStatus | "") => void;
  /** Apre la vista per modello filtrata su questo provider. */
  onOpen: (slug: string) => void;
}

/** Elenco dei provider con ricerca e filtro di stato. */
export function CatalogByProvider({ q, textInput, setTextInput, status, onStatus, onOpen }: CatalogByProviderProps) {
  const providers = useListCatalogProviders(
    { q: q || undefined, status: status || undefined },
    { query: { queryKey: getListCatalogProvidersQueryKey({ q: q || undefined, status: status || undefined }), placeholderData: keepPreviousData } },
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="Cerca provider"
          placeholder="Cerca provider"
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          className="w-72"
        />
        <Select value={status || ALL} onValueChange={(v) => onStatus(v === ALL ? "" : (v as AiProviderStatus))}>
          <SelectTrigger className="w-48" aria-label="Stato">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tutti gli stati</SelectItem>
            <SelectItem value="managed">Gestiti</SelectItem>
            <SelectItem value="coming">In arrivo</SelectItem>
            <SelectItem value="unmanaged">Non gestiti</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {providers.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : providers.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{apiErrorMessage(providers.error)}</AlertDescription>
        </Alert>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Stato</TableHead>
                <TableHead>Modelli</TableHead>
                <TableHead>Account</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(providers.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    Nessun provider da mostrare.
                  </TableCell>
                </TableRow>
              )}
              {(providers.data ?? []).map((p) => (
                <TableRow key={p.slug}>
                  <TableCell>{p.name}</TableCell>
                  <TableCell>
                    <ProviderStatusBadge status={p.status} />
                  </TableCell>
                  <TableCell>{p.modelCount}</TableCell>
                  <TableCell>{p.hasMyAccount ? <Badge variant="secondary">hai un account</Badge> : "—"}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => onOpen(p.slug)} disabled={p.modelCount === 0}>
                      Vedi modelli
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
