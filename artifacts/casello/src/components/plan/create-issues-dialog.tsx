import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleDot, ExternalLink } from "lucide-react";
import {
  getGetAppPlanQueryKey,
  useCreatePlanIssues,
  type PlanIssuesPreview,
  type PlanIssuesResult,
  type PlanIssuesResultResultsItem,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiErrorMessage } from "@/lib/api-errors";

interface CreateIssuesDialogProps {
  appId: number;
  itemIds: number[];
  /** Repository delle issue (`owner/repo`), dal riepilogo del piano. */
  repo: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** La risposta della creazione è un'anteprima (`issues`) o un esito (`results`). */
function isResult(data: PlanIssuesPreview | PlanIssuesResult): data is PlanIssuesResult {
  return "results" in data;
}

/**
 * Creazione delle issue GitHub dalle voci selezionate: all'apertura un'anteprima senza chiamare GitHub
 * (titolo, etichette, corpo), poi «Crea su owner/repo» e l'esito per voce.
 */
export function CreateIssuesDialog({ appId, itemIds, repo, open, onOpenChange }: CreateIssuesDialogProps) {
  const queryClient = useQueryClient();
  const preview = useCreatePlanIssues();
  const create = useCreatePlanIssues({
    mutation: {
      // Anche un esito parziale collega qualche voce: il piano va riletto comunque.
      onSettled: () => void queryClient.invalidateQueries({ queryKey: getGetAppPlanQueryKey(appId) }),
    },
  });

  useEffect(() => {
    if (!open) return;
    create.reset();
    preview.mutate({ id: appId, data: { itemIds, dryRun: true } });
    // L'anteprima si chiede a ogni apertura, con le voci selezionate in quel momento.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const previewData = preview.data && !isResult(preview.data) ? preview.data : null;
  const resultData = create.data && isResult(create.data) ? create.data : null;
  const targetRepo = resultData?.repo ?? previewData?.repo ?? repo ?? "";
  const titles = new Map((previewData?.issues ?? []).map((i) => [i.itemId, i.title]));
  const toCreate = (previewData?.issues ?? []).filter((i) => !i.skipped).length;

  const submit = () => create.mutate({ id: appId, data: { itemIds } });

  return (
    <Dialog open={open} onOpenChange={(next) => !create.isPending && onOpenChange(next)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{resultData ? "Esito della creazione" : "Crea issue su GitHub"}</DialogTitle>
          <DialogDescription>
            {resultData
              ? `Issue su ${targetRepo}.`
              : `Anteprima delle issue che verranno aperte su ${targetRepo || "GitHub"}, una per voce.`}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] space-y-2 overflow-auto">
          {resultData ? (
            <ul className="space-y-2">
              {resultData.results.map((r) => (
                <ResultRow key={r.itemId} result={r} title={titles.get(r.itemId) ?? `Voce ${r.itemId}`} />
              ))}
            </ul>
          ) : preview.isError ? (
            <p className="text-sm text-destructive">Anteprima non riuscita: {apiErrorMessage(preview.error)}</p>
          ) : !previewData ? (
            <p className="text-sm text-muted-foreground">Preparazione dell'anteprima…</p>
          ) : (
            <ul className="space-y-2">
              {previewData.issues.map((issue) => (
                <li key={issue.itemId} className="space-y-1.5 rounded-md border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="text-sm font-medium break-words">{issue.title}</p>
                    {issue.skipped && (
                      <Badge variant="secondary" className="font-normal">
                        Saltata: già collegata o non ammessa
                      </Badge>
                    )}
                  </div>
                  {issue.labels.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {issue.labels.map((label) => (
                        <Badge key={label} variant="outline" className="font-mono text-[11px] font-normal">
                          {label}
                        </Badge>
                      ))}
                    </div>
                  )}
                  <details>
                    <summary className="cursor-pointer text-xs text-muted-foreground">Corpo della issue</summary>
                    <pre className="mt-2 rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                      {issue.body}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
          {create.isError && (
            <p className="text-sm text-destructive">Creazione non riuscita: {apiErrorMessage(create.error)}</p>
          )}
        </div>

        <DialogFooter className="gap-2">
          {previewData && !resultData && (
            <span className="mr-auto self-center text-xs text-muted-foreground">
              {toCreate} da creare su {previewData.issues.length}
            </span>
          )}
          <Button variant="outline" disabled={create.isPending} onClick={() => onOpenChange(false)}>
            Chiudi
          </Button>
          {!resultData && (
            <Button onClick={submit} disabled={!previewData || toCreate === 0 || create.isPending}>
              <CircleDot />
              {create.isPending ? "Creazione in corso…" : `Crea su ${targetRepo}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResultRow({ result, title }: { result: PlanIssuesResultResultsItem; title: string }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-3 text-sm">
      <span className="min-w-0 break-words">{title}</span>
      {result.outcome === "created" ? (
        <a
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-emerald-700 hover:underline dark:text-emerald-400"
        >
          Creata #{result.number}
          <ExternalLink className="size-3.5" />
        </a>
      ) : result.outcome === "skipped" ? (
        <span className="text-muted-foreground">Saltata: già collegata o non ammessa</span>
      ) : (
        <span className="text-destructive">Errore: {result.error ?? "creazione non riuscita"}</span>
      )}
    </li>
  );
}
