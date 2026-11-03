import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type ListPendingActionsStatus,
  type QueuedAction,
  getListPendingActionsQueryKey,
  useListPendingActions,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionDialog } from "@/components/actions/action-dialog";
import { ACTION_STATUS_LABELS, ActionStatusBadge } from "@/components/actions/action-status";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";

const REFRESH_MS = 15_000;
const FILTERS: { value: ListPendingActionsStatus; label: string }[] = [
  { value: "pending", label: `In attesa` },
  { value: "executing", label: ACTION_STATUS_LABELS.executing },
  { value: "done", label: ACTION_STATUS_LABELS.done },
  { value: "failed", label: ACTION_STATUS_LABELS.failed },
  { value: "rejected", label: ACTION_STATUS_LABELS.rejected },
  { value: "all", label: "Tutte" },
];

export default function PendingActionsPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ListPendingActionsStatus>("pending");
  // Si tiene il numero, non la voce: dopo una decisione la scheda mostra i dati riletti.
  const [selected, setSelected] = useState<number | null>(null);
  const params = { status };
  const list = useListPendingActions(params, {
    query: { queryKey: getListPendingActionsQueryKey(params), refetchInterval: REFRESH_MS },
  });
  const actions = list.data?.actions ?? [];
  const selectedAction: QueuedAction | null = actions.find((a) => a.number === selected) ?? null;

  return (
    <div className="mx-auto max-w-screen-2xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Da confermare</h2>
          <p className="text-sm text-muted-foreground">
            Le azioni che gli agenti hanno messo in coda: partono solo se le approvi.
          </p>
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as ListPendingActionsStatus)}>
          <SelectTrigger className="w-44" aria-label="Filtra per stato">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Card>
        <CardContent className="p-0">
          {list.isError ? (
            <p className="p-6 text-sm text-destructive">Impossibile caricare le azioni: {apiErrorMessage(list.error)}</p>
          ) : list.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : actions.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">
              {status === "pending" ? "Nessuna azione in attesa." : "Nessuna azione con questo stato."}
            </p>
          ) : (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16 pl-4">N.</TableHead>
                  <TableHead className="w-32">App</TableHead>
                  <TableHead className="w-40">Strumento</TableHead>
                  <TableHead className="hidden w-40 lg:table-cell">Destinatario</TableHead>
                  <TableHead>Sintesi</TableHead>
                  <TableHead className="w-28">Stato</TableHead>
                  <TableHead className="hidden w-32 pr-4 md:table-cell">Accodata</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {actions.map((a) => (
                  <TableRow
                    key={a.number}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => setSelected(a.number)}
                    onKeyDown={(e) => e.key === "Enter" && setSelected(a.number)}
                  >
                    <TableCell className="pl-4 tabular-nums">{a.number}</TableCell>
                    <TableCell className="truncate" title={a.app.name}>
                      {a.app.name}
                    </TableCell>
                    <TableCell className="truncate font-mono text-xs" title={a.tool.name}>
                      {a.tool.name}
                    </TableCell>
                    <TableCell className="hidden truncate lg:table-cell" title={a.recipient}>
                      {a.recipient}
                    </TableCell>
                    <TableCell className="truncate" title={a.summary}>
                      {a.summary}
                    </TableCell>
                    <TableCell>
                      <ActionStatusBadge status={a.status} />
                    </TableCell>
                    <TableCell className="hidden pr-4 text-muted-foreground md:table-cell">
                      {formatRelative(a.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <ActionDialog
        action={selectedAction}
        onOpenChange={(open) => !open && setSelected(null)}
        onDecided={() => void queryClient.invalidateQueries({ queryKey: getListPendingActionsQueryKey() })}
      />
    </div>
  );
}
