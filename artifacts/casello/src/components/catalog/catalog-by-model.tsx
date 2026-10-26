import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  type AiProviderStatus,
  type CatalogModelSummary,
  useListCatalogModelOffers,
} from "@workspace/api-client-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useProviderLabel } from "@/components/account/ai-account-dialog";
import { MODE_LABEL } from "@/components/catalog/catalog-filters";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatModelPrice } from "@/lib/format";

const STATUS_LABEL: Record<AiProviderStatus, string> = {
  managed: "gestito",
  coming: "in arrivo",
  unmanaged: "non gestito",
};

export function ProviderStatusBadge({ status }: { status: AiProviderStatus }) {
  return <Badge variant={status === "managed" ? "default" : "outline"}>{STATUS_LABEL[status]}</Badge>;
}

const OFFER_STATUS_LABEL = { available: "disponibile", deprecated: "in dismissione", retired: "ritirata" } as const;

const yesNo = (v: boolean | null) => (v == null ? "—" : v ? "Sì" : "No");
const formatDate = (v: string | null) => (v ? new Date(v).toLocaleDateString("it-IT") : "—");

function Offers({ modelId }: { modelId: number }) {
  const offers = useListCatalogModelOffers(modelId);
  if (offers.isLoading) return <Skeleton className="h-16 w-full" />;
  if (offers.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{apiErrorMessage(offers.error)}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Provider</TableHead>
          <TableHead>Id</TableHead>
          <TableHead>Prezzo</TableHead>
          <TableHead>Contesto</TableHead>
          <TableHead>Strumenti</TableHead>
          <TableHead>Stato</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {(offers.data ?? []).map((o) => (
          <TableRow key={o.id}>
            <TableCell>
              <span className="mr-2">{o.providerName}</span>
              <ProviderStatusBadge status={o.providerStatus} />
              {o.inMyAccounts && (
                <Badge variant="secondary" className="ml-2">
                  nei tuoi account
                </Badge>
              )}
            </TableCell>
            <TableCell className="font-mono text-xs">{o.providerModelId}</TableCell>
            <TableCell>{formatModelPrice(o.priceInput, o.priceOutput)}</TableCell>
            <TableCell>{o.contextTokens == null ? "—" : o.contextTokens.toLocaleString("it-IT")}</TableCell>
            <TableCell>{yesNo(o.supportsTools)}</TableCell>
            <TableCell>
              {OFFER_STATUS_LABEL[o.status]}
              {o.deprecationDate ? ` dal ${formatDate(o.deprecationDate)}` : ""}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Capabilities({ m }: { m: CatalogModelSummary }) {
  const caps = [
    m.supportsTools && "strumenti",
    m.supportsVision && "visione",
    m.supportsReasoning && "ragionamento",
  ].filter(Boolean) as string[];
  if (caps.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {caps.map((c) => (
        <Badge key={c} variant="secondary">
          {c}
        </Badge>
      ))}
    </div>
  );
}

interface CatalogByModelProps {
  items: CatalogModelSummary[];
  total: number;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
}

/** Tabella paginata dei modelli; ogni riga si espande nelle offerte dei provider. */
export function CatalogByModel({ items, total, page, pageSize, onPage }: CatalogByModelProps) {
  const [open, setOpen] = useState<number | null>(null);
  const providerLabel = useProviderLabel();
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-3">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Autore</TableHead>
              <TableHead>Modello</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Capacità</TableHead>
              <TableHead>Rilascio</TableHead>
              <TableHead>Prezzo più basso</TableHead>
              <TableHead>Provider</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">
                  Nessun modello da mostrare.
                </TableCell>
              </TableRow>
            )}
            {items.map((m) => {
              const expanded = open === m.id;
              return (
                <Fragment key={m.id}>
                  <TableRow>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={expanded ? "Nascondi le offerte" : "Mostra le offerte"}
                        aria-expanded={expanded}
                        onClick={() => setOpen(expanded ? null : m.id)}
                      >
                        {expanded ? <ChevronDown /> : <ChevronRight />}
                      </Button>
                    </TableCell>
                    <TableCell>{m.author}</TableCell>
                    <TableCell>
                      {m.family} {m.version}
                      {m.inMyAccounts && (
                        <Badge variant="secondary" className="ml-2">
                          nei tuoi account
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{MODE_LABEL[m.mode] ?? m.mode}</TableCell>
                    <TableCell>
                      <Capabilities m={m} />
                    </TableCell>
                    <TableCell>{formatDate(m.releasedAt)}</TableCell>
                    <TableCell>
                      {m.cheapestOffer ? (
                        <>
                          {formatModelPrice(m.cheapestOffer.priceInput, m.cheapestOffer.priceOutput)}
                          <span className="text-muted-foreground"> · {providerLabel(m.cheapestOffer.provider)}</span>
                        </>
                      ) : (
                        "prezzo sconosciuto"
                      )}
                    </TableCell>
                    <TableCell>{m.offerCount}</TableCell>
                  </TableRow>
                  {expanded && (
                    <TableRow>
                      <TableCell colSpan={8} className="bg-muted/30">
                        <Offers modelId={m.id} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">
          {total.toLocaleString("it-IT")} modelli · pagina {page} di {pages}
        </span>
        <Pagination className="mx-0 w-auto">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                aria-disabled={page <= 1}
                className={page <= 1 ? "pointer-events-none opacity-50" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  if (page > 1) onPage(page - 1);
                }}
              />
            </PaginationItem>
            <PaginationItem>
              <PaginationNext
                href="#"
                aria-disabled={page >= pages}
                className={page >= pages ? "pointer-events-none opacity-50" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  if (page < pages) onPage(page + 1);
                }}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  );
}
