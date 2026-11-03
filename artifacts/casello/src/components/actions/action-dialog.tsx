import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  type QueuedAction,
  getGetDashboardStatsQueryKey,
  getGetPendingActionQueryKey,
  useApprovePendingAction,
  useRejectPendingAction,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";
import { ActionStatusBadge } from "./action-status";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "medium" });
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

/** Scheda di una voce della coda: dettagli, esito e, se in attesa, «Approva» / «Rifiuta». */
export function ActionDialog({
  action,
  onOpenChange,
  onDecided,
}: {
  action: QueuedAction | null;
  onOpenChange: (open: boolean) => void;
  /** Chiamata dopo una decisione riuscita (o un errore che rende la voce obsoleta): rilegge elenco e contatore. */
  onDecided: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [userToken, setUserToken] = useState("");
  const [note, setNote] = useState("");

  const afterDecision = (saved: QueuedAction | null) => {
    if (saved) queryClient.setQueryData(getGetPendingActionQueryKey(saved.number), saved);
    void queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
    onDecided();
  };
  const approve = useApprovePendingAction({
    mutation: {
      // Il token dell'utente passa nelle variabili: non deve restare nella cache delle mutazioni
      gcTime: 0,
      onSuccess: (saved) => {
        toast({ title: `Azione n. ${saved.number} approvata`, description: saved.result ?? undefined });
        afterDecision(saved);
        onOpenChange(false);
      },
      onError: (error) => {
        toast({ variant: "destructive", title: "Approvazione non riuscita", description: apiErrorMessage(error) });
        // Un 409 vuol dire che la voce è già stata decisa o non è più eseguibile: si riallinea l'elenco.
        afterDecision(null);
      },
    },
  });
  const reject = useRejectPendingAction({
    mutation: {
      onSuccess: (saved) => {
        toast({ title: `Azione n. ${saved.number} rifiutata` });
        afterDecision(saved);
        onOpenChange(false);
      },
      onError: (error) => {
        toast({ variant: "destructive", title: "Rifiuto non riuscito", description: apiErrorMessage(error) });
        afterDecision(null);
      },
    },
  });
  const busy = approve.isPending || reject.isPending;
  const needsToken = action?.tool.identity === "user";

  return (
    <Dialog open={action !== null} onOpenChange={(open) => {
        if (busy) return;
        if (!open) {
          setUserToken("");
          setNote("");
        }
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {action && (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                Azione n. {action.number}
                <ActionStatusBadge status={action.status} />
              </DialogTitle>
              <DialogDescription className="break-words">{action.summary}</DialogDescription>
            </DialogHeader>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Row label="App">
                <Link href={`/apps/${action.app.id}`} className="hover:underline">
                  {action.app.name}
                </Link>
              </Row>
              <Row label="Strumento">
                <span className="font-mono text-xs">{action.tool.name}</span>
              </Row>
              <Row label="Destinatario">{action.recipient}</Row>
              <Row label="Accodata">
                <span title={formatDateTime(action.createdAt)}>{formatRelative(action.createdAt)}</span>
              </Row>
              {action.runId != null && (
                <Row label="Run d'origine">
                  <Link href={`/runs/${action.runId}`} className="hover:underline">
                    Run #{action.runId}
                  </Link>
                </Row>
              )}
              {action.agentId != null && (
                <Row label="Agente">
                  <Link href={`/agents/${action.agentId}`} className="hover:underline">
                    Agente #{action.agentId}
                  </Link>
                </Row>
              )}
              {action.decidedAt && <Row label="Decisa">{formatDateTime(action.decidedAt)}</Row>}
              {action.finishedAt && <Row label="Conclusa">{formatDateTime(action.finishedAt)}</Row>}
            </dl>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">Argomenti (i valori sensibili sono oscurati)</div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">
                {JSON.stringify(action.args, null, 2)}
              </pre>
            </div>
            {action.result && (
              <div>
                <div className="mb-1 text-xs text-muted-foreground">Risultato</div>
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">
                  {action.result}
                </pre>
              </div>
            )}
            {action.errorMessage && <p className="break-words text-sm text-destructive">{action.errorMessage}</p>}
            {action.decisionNote && (
              <Row label="Nota del rifiuto">
                <span className="whitespace-pre-wrap">{action.decisionNote}</span>
              </Row>
            )}
            {action.status === "pending" && (
              <div className="space-y-3 border-t pt-4">
                {needsToken && (
                  <div className="space-y-1.5">
                    <Label htmlFor="action-user-token">Token dell'utente dell'app</Label>
                    <Input
                      id="action-user-token"
                      type="password"
                      autoComplete="off"
                      value={userToken}
                      onChange={(e) => setUserToken(e.target.value)}
                      placeholder="Serve per eseguire l'azione a nome tuo"
                    />
                    <p className="text-xs text-muted-foreground">Resta in memoria per questa esecuzione: non viene salvato.</p>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="action-note">Nota del rifiuto (facoltativa)</Label>
                  <Textarea
                    id="action-note"
                    rows={2}
                    maxLength={500}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => reject.mutate({ number: action.number, data: note.trim() ? { note: note.trim() } : {} })}
                  >
                    {reject.isPending ? "Rifiuto…" : "Rifiuta"}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      approve.mutate({
                        number: action.number,
                        data: needsToken && userToken ? { userToken } : {},
                      });
                      // Il token non resta nello stato dopo l'invio (nemmeno se l'approvazione fallisce).
                      setUserToken("");
                    }}
                  >
                    {approve.isPending ? "Esecuzione…" : "Approva ed esegui"}
                  </Button>
                </DialogFooter>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
