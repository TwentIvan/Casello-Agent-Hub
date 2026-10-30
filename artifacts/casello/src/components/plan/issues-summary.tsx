import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import {
  getGetAppPlanQueryKey,
  useRefreshPlanIssues,
  type PlanIssuesSummary,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";

/** Oltre questa età lo stato delle issue si rilegge da solo all'apertura della pagina. */
const STALE_MS = 10 * 60 * 1000;

/** Riepilogo delle issue del piano, con l'aggiornamento dello stato da GitHub. */
export function IssuesSummary({ appId, summary }: { appId: number; summary: PlanIssuesSummary }) {
  const queryClient = useQueryClient();
  const refresh = useRefreshPlanIssues({
    mutation: {
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: getGetAppPlanQueryKey(appId) }),
    },
  });

  const linked = summary.open + summary.closed;
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    const stale = summary.checkedAt === null || Date.now() - new Date(summary.checkedAt).getTime() > STALE_MS;
    if (summary.available && linked > 0 && stale) refresh.mutate({ id: appId });
    // Una sola volta per montaggio, con il riepilogo letto all'apertura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
      <div className="space-y-0.5">
        <p>
          Issue: {summary.open} aperte, {summary.closed} chiuse, {summary.approvedWithoutIssue} voci approvate senza issue
        </p>
        {summary.checkedAt && (
          <p className="text-xs text-muted-foreground">aggiornato {formatRelative(summary.checkedAt)}</p>
        )}
        {refresh.isError && (
          <p className="text-xs text-destructive">Aggiornamento non riuscito: {apiErrorMessage(refresh.error)}</p>
        )}
      </div>
      {summary.available && linked > 0 && (
        <Button variant="outline" size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate({ id: appId })}>
          <RefreshCw className={refresh.isPending ? "animate-spin" : undefined} />
          Aggiorna stato
        </Button>
      )}
    </div>
  );
}
