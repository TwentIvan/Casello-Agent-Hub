import { useState } from "react";
import { type AuditEvent, getListAuditEventsQueryKey, useListAuditEvents } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api-errors";
import { auditActionLabel, auditDetailText, auditObjectLabel, auditViaLabel } from "@/lib/audit-events";
import { formatRelative } from "@/lib/format";

const PAGE = 50;

function EventRow({ event }: { event: AuditEvent }) {
  const object = auditObjectLabel(event.objectType, event.objectId);
  const detail = auditDetailText(event.detail as Record<string, unknown> | null);
  const when = new Date(event.createdAt);
  return (
    <li className="space-y-1 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-medium">{auditActionLabel(event.action)}</span>
        {object && <span className="font-mono text-xs text-muted-foreground">{object}</span>}
      </div>
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span title={when.toLocaleString("it-IT")}>{formatRelative(event.createdAt)}</span>
        <span>{auditViaLabel(event.via, event.tokenId)}</span>
        {event.ip && <span className="break-all font-mono">{event.ip}</span>}
        {detail && <span>{detail}</span>}
      </div>
    </li>
  );
}

/** Una pagina del registro; l'ultima mostra «Mostra altri» se ce ne sono. */
function EventsPage({ before, last, onMore }: { before: number | undefined; last: boolean; onMore: (next: number) => void }) {
  const params = { limit: PAGE, ...(before !== undefined ? { before } : {}) };
  const page = useListAuditEvents(params, { query: { queryKey: getListAuditEventsQueryKey(params) } });
  if (page.isError) return <p className="p-3 text-sm text-destructive">Impossibile caricare il registro: {apiErrorMessage(page.error)}</p>;
  if (!page.data) return <Skeleton className="m-3 h-12" />;
  const next = page.data.nextBefore;
  return (
    <>
      {page.data.events.map((event) => (
        <EventRow key={event.id} event={event} />
      ))}
      {last && next !== null && (
        <li className="p-3">
          <Button variant="outline" size="sm" onClick={() => onMore(next)}>
            Mostra altri {PAGE}
          </Button>
        </li>
      )}
    </>
  );
}

/** Sezione «Registro delle azioni»: approvazioni, conferme, token, segreti e accessi dell'utente, dal più recente. */
export function AuditEventsSection() {
  const [cursors, setCursors] = useState<(number | undefined)[]>([undefined]);
  const first = useListAuditEvents({ limit: PAGE }, { query: { queryKey: getListAuditEventsQueryKey({ limit: PAGE }) } });
  const empty = first.data !== undefined && first.data.events.length === 0;

  return (
    <Card>
      <CardHeader className="space-y-1.5">
        <CardTitle>Registro delle azioni</CardTitle>
        <CardDescription>
          Chi ha fatto cosa e quando: approvazioni, conferme, token, segreti, account AI, nodi e accessi. Senza segreti né
          contenuti; si conserva per 365 giorni.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {empty ? (
          <p className="text-sm text-muted-foreground">Ancora nessuna azione registrata.</p>
        ) : (
          <ul className="max-h-[32rem] divide-y overflow-y-auto rounded-md border">
            {cursors.map((before, i) => (
              <EventsPage
                key={before ?? "first"}
                before={before}
                last={i === cursors.length - 1}
                onMore={(next) => setCursors((prev) => [...prev, next])}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
