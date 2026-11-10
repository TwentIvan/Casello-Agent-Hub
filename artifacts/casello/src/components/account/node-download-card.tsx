import { Download } from "lucide-react";
import { getGetNodeDownloadQueryKey, useGetNodeDownload } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function formatSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toLocaleString("it-IT", { maximumFractionDigits: 1 })} MB`;
}

/** Carta «Botcave Nodo per Mac»: scarico dell'app e passi del primo avvio. */
export function NodeDownloadCard() {
  const download = useGetNodeDownload({ query: { queryKey: getGetNodeDownloadQueryKey() } });
  const info = download.data;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Botcave Nodo per Mac</CardTitle>
          <CardDescription>
            L'app che fa eseguire ai tuoi compiti «nodo» Claude Code sul Mac, con aggiornamenti automatici.
          </CardDescription>
        </div>
        {download.isLoading ? (
          <Skeleton className="h-9 w-40" />
        ) : info?.available && info.url ? (
          <Button asChild size="sm">
            <a href={info.url}>
              <Download />
              Scarica per Mac
            </a>
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {info?.available ? (
          <p className="font-mono text-xs text-muted-foreground">
            versione {info.version}
            {info.size != null ? ` · ${formatSize(info.size)}` : ""}
          </p>
        ) : (
          !download.isLoading && (
            <p className="text-muted-foreground">
              Il pacchetto per Mac non è ancora disponibile: usa l'installazione da terminale.
            </p>
          )
        )}
        <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
          <li>Apri il file scaricato e trascina Botcave Nodo in Applicazioni.</li>
          <li>Aprilo. Se macOS lo blocca, vai in Impostazioni di Sistema → Privacy e sicurezza e premi «Apri comunque».</li>
          <li>Premi «Collega questo Mac»: si apre questa console e confermi il collegamento.</li>
        </ol>
      </CardContent>
    </Card>
  );
}
