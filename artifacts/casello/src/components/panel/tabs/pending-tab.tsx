// Scheda «Da confermare» del pannello: le voci `pending` con la stessa voce della pagina «Da confermare» (PendingActionItem).
// Nella console «Apri i dettagli» apre la scheda della voce (ActionDialog), anche per approvare i piani; nell'iframe le voci
// che vanno lette per intero (piani) o che chiedono il token dell'utente si aprono nella console («Apri in Botcave»), le
// proposte (passi con caselle) si decidono qui.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { type QueuedAction, getListPendingActionsQueryKey, useListPendingActions } from "@workspace/api-client-react";
import { ActionDialog } from "@/components/actions/action-dialog";
import { PendingActionItem } from "@/components/actions/pending-action-item";
import { Led } from "@/components/brand/led";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api-errors";
import { consoleUrl } from "@/embed/panel-helpers";
import { usePanel } from "../panel-context";

const PARAMS = { status: "pending" } as const;
const REFRESH_MS = 15_000;

export function PendingTab() {
  const { env } = usePanel();
  const queryClient = useQueryClient();
  // Si tiene il numero, non la voce: dopo una decisione la scheda mostra i dati riletti
  const [selected, setSelected] = useState<number | null>(null);
  const list = useListPendingActions(PARAMS, {
    query: { queryKey: getListPendingActionsQueryKey(PARAMS), refetchInterval: REFRESH_MS },
  });
  // Ordine per numero, come nella console: è il numero che Alfred legge a voce
  const actions = [...(list.data?.actions ?? [])].sort((a, b) => a.number - b.number);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: getListPendingActionsQueryKey() });
  const href = consoleUrl(window.location.origin, "/pending-actions");
  const selectedAction: QueuedAction | null = actions.find((a) => a.number === selected) ?? null;
  const dialog =
    env.surface === "console" ? (
      <ActionDialog
        key={selected ?? "none"}
        action={selectedAction}
        onOpenChange={(open) => !open && setSelected(null)}
        onDecided={refresh}
      />
    ) : null;

  if (list.isError) {
    return <p className="p-4 text-body-sm text-danger">Impossibile caricare le voci: {apiErrorMessage(list.error)}</p>;
  }
  if (list.isLoading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }
  if (actions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Led state="ok" label="Nessuna voce da confermare" />
        {dialog}
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-3 p-3">
      {actions.map((a) =>
        env.surface === "console" ? (
          <PendingActionItem key={a.number} action={a} onOpenDetails={() => setSelected(a.number)} onDecided={refresh} />
        ) : (
          <PendingActionItem key={a.number} action={a} onDecided={refresh} consoleHref={href} />
        ),
      )}
      {dialog}
    </div>
  );
}
