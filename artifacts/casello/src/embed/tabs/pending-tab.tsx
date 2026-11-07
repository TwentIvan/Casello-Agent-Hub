// Scheda «Da confermare» del pannello: le voci `pending` con la stessa voce della console (PendingActionItem).
// Le voci che vanno lette per intero (piani) o che chiedono il token dell'utente si aprono nella console.
import { useQueryClient } from "@tanstack/react-query";
import { getListPendingActionsQueryKey, useListPendingActions } from "@workspace/api-client-react";
import { PendingActionItem } from "@/components/actions/pending-action-item";
import { Led } from "@/components/brand/led";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api-errors";
import { consoleUrl } from "../panel-helpers";

const PARAMS = { status: "pending" } as const;
const REFRESH_MS = 15_000;

export function PendingTab() {
  const queryClient = useQueryClient();
  const list = useListPendingActions(PARAMS, {
    query: { queryKey: getListPendingActionsQueryKey(PARAMS), refetchInterval: REFRESH_MS },
  });
  // Ordine per numero, come nella console: è il numero che Alfred legge a voce
  const actions = [...(list.data?.actions ?? [])].sort((a, b) => a.number - b.number);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: getListPendingActionsQueryKey() });
  const href = consoleUrl(window.location.origin, "/pending-actions");

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
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-3 p-3">
      {actions.map((a) => (
        <PendingActionItem key={a.number} action={a} onDecided={refresh} consoleHref={href} />
      ))}
    </div>
  );
}
