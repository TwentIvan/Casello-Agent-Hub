import { useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type AiProvider,
  type CatalogRunView,
  getGetCatalogStatusQueryKey,
  useGetCatalogStatus,
  useRefreshCatalog,
} from "@workspace/api-client-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { invalidateAiQueries } from "@/components/ai/ai-queries";
import { useProviderLabel } from "@/components/account/ai-account-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatModelPrice, formatRelative } from "@/lib/format";

const MAX_ITEMS = 10;
const POLL_MS = 3000;

const STATUS_BADGE: Record<
  CatalogRunView["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  running: { label: "In corso", variant: "secondary" },
  completed: { label: "Completato", variant: "default" },
  partial: { label: "Parziale", variant: "outline" },
  failed: { label: "Fallito", variant: "destructive" },
};

/** Data e ora assolute, es. "26/10/2026, 19:10". */
function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function modelName(
  item: { provider: AiProvider; modelId: string; version: string },
  providerLabel: (provider: AiProvider) => string,
): string {
  return `${providerLabel(item.provider)} · ${item.modelId} (${item.version})`;
}

/** Elenco con al massimo MAX_ITEMS voci e "e altri N"; non mostra nulla se è vuoto. */
function NewsList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-medium">{title}</h4>
      <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
        {items.slice(0, MAX_ITEMS).map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
      {items.length > MAX_ITEMS && (
        <p className="pl-5 text-sm text-muted-foreground">e altri {items.length - MAX_ITEMS}</p>
      )}
    </div>
  );
}

/** Esito dell'ultimo aggiornamento del catalogo, novità e pulsante per rilanciarlo. */
export function CatalogNews() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const status = useGetCatalogStatus({
    query: {
      queryKey: getGetCatalogStatusQueryKey(),
      refetchInterval: (query) => (query.state.data?.running ? POLL_MS : false),
    },
  });
  const refresh = useRefreshCatalog();
  const running = status.data?.running ?? false;
  const providerLabel = useProviderLabel();
  const nameOf = (item: Parameters<typeof modelName>[0]) => modelName(item, providerLabel);

  // Alla fine di un aggiornamento catalogo e modelli degli account sono cambiati
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      void queryClient.invalidateQueries({ queryKey: ["/api/catalog/models"] });
      void invalidateAiQueries(queryClient);
    }
    wasRunning.current = running;
  }, [running, queryClient]);

  const onRefresh = () => {
    refresh.mutate(undefined, {
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: getGetCatalogStatusQueryKey() }),
      onError: (error) => {
        toast({ variant: "destructive", title: apiErrorMessage(error) });
        // Un 409 vuol dire che sta già girando: si riallinea lo stato per far partire il polling
        void queryClient.invalidateQueries({ queryKey: getGetCatalogStatusQueryKey() });
      },
    });
  };

  // Esito ed errore dall'ultima esecuzione; le novità dall'ultima riuscita (anche durante un aggiornamento)
  const latest = status.data?.latest ?? null;
  const lastCompleted = status.data?.lastCompleted ?? null;
  const summary = lastCompleted?.summary ?? null;
  const olderNews = lastCompleted !== null && lastCompleted.id !== latest?.id;
  const badge = latest ? STATUS_BADGE[latest.status] : null;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">Novità del catalogo</CardTitle>
          {latest && badge && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Badge variant={badge.variant}>{badge.label}</Badge>
              <span>
                Ultimo aggiornamento {formatRelative(latest.startedAt)} ({formatDateTime(latest.startedAt)})
              </span>
            </div>
          )}
        </div>
        <Button onClick={onRefresh} disabled={running || refresh.isPending}>
          <RefreshCw className={running ? "animate-spin" : undefined} />
          Aggiorna catalogo
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : status.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{apiErrorMessage(status.error)}</AlertDescription>
          </Alert>
        ) : !latest ? (
          <p className="text-sm text-muted-foreground">Catalogo non ancora aggiornato</p>
        ) : (
          <>
            {latest.error && (
              <Alert variant="destructive">
                <AlertDescription>{latest.error}</AlertDescription>
              </Alert>
            )}
            {summary && olderNews && lastCompleted && (
              <p className="text-sm text-muted-foreground">
                Novità dell'aggiornamento del {formatDateTime(lastCompleted.startedAt)}
              </p>
            )}
            {summary?.firstRun && (
              <p className="text-sm text-muted-foreground">Primo aggiornamento: catalogo creato</p>
            )}
            {summary && (
              <>
                <NewsList title="Nuovi" items={summary.added.map(nameOf)} />
                <NewsList title="Ritirati" items={summary.retired.map(nameOf)} />
                <NewsList
                  title="In dismissione"
                  items={summary.deprecating.map(
                    (d) => `${nameOf(d)}, dal ${new Date(d.deprecationDate).toLocaleDateString("it-IT")}`,
                  )}
                />
                <NewsList
                  title="Prezzi cambiati"
                  items={summary.priceChanged.map(
                    (p) =>
                      `${nameOf(p)}: ${formatModelPrice(p.oldInput, p.oldOutput)} → ${formatModelPrice(p.newInput, p.newOutput)}`,
                  )}
                />
                <NewsList
                  title="Spariti dai tuoi account"
                  items={summary.accounts.map((a) => `${a.accountName}: ${a.missing.join(", ")}`)}
                />
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
