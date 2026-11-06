import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type ListPendingActionsStatus,
  type QueuedAction,
  getListPendingActionsQueryKey,
  useListPendingActions,
} from "@workspace/api-client-react";
import { CharacterButton } from "@/components/characters/character-button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionDialog } from "@/components/actions/action-dialog";
import { PendingActionItem } from "@/components/actions/pending-action-item";
import { ACTION_STATUS_LABELS, ActionStatusBadge } from "@/components/actions/action-status";
import { ACTION_KIND_LABELS } from "@/components/actions/plan-proposal";
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
  // Ordine per numero: è il numero che si legge (anche a voce con Alfred), stabile finché la voce è in coda
  const actions = [...(list.data?.actions ?? [])].sort((a, b) => a.number - b.number);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: getListPendingActionsQueryKey() });
  const selectedAction: QueuedAction | null = actions.find((a) => a.number === selected) ?? null;

  return (
    <div className="mx-auto max-w-screen-2xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-h2">Da confermare</h2>
          <p className="text-sm text-muted-foreground">
            Le azioni che gli agenti hanno messo in coda e i piani proposti dai capi delle squadre: partono solo se li
            approvi.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CharacterButton target={{ kind: "alfred", page: { page: "pending_actions" } }} />
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
      </div>
      {status === "pending" && !list.isError && !list.isLoading && actions.length > 0 ? (
        <div className="space-y-3">
          {actions.map((a) => (
            <PendingActionItem key={a.number} action={a} onOpenDetails={() => setSelected(a.number)} onDecided={refresh} />
          ))}
        </div>
      ) : (
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
                  <TableHead className="w-36">Tipo</TableHead>
                  <TableHead className="w-36">App / squadra</TableHead>
                  <TableHead className="w-40">Strumento</TableHead>
                  <TableHead className="hidden w-40 2xl:table-cell">Destinatario</TableHead>
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
                    <TableCell className="pl-4 font-mono tabular-nums">#{a.number}</TableCell>
                    <TableCell className="truncate">{ACTION_KIND_LABELS[a.kind]}</TableCell>
                    <TableCell className="truncate" title={[a.app?.name, a.team?.name].filter(Boolean).join(" · ")}>
                      {a.app?.name ?? a.team?.name ?? "—"}
                      {a.app && a.team && <div className="truncate text-xs text-muted-foreground">{a.team.name}</div>}
                    </TableCell>
                    <TableCell className="truncate font-mono text-xs" title={a.tool?.name}>
                      {a.tool?.name ?? "—"}
                    </TableCell>
                    <TableCell className="hidden truncate 2xl:table-cell" title={a.recipient}>
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
      )}
      <ActionDialog
        key={selected ?? "none"}
        action={selectedAction}
        onOpenChange={(open) => !open && setSelected(null)}
        onDecided={refresh}
      />
    </div>
  );
}
