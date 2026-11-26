import { useQueryClient } from "@tanstack/react-query";
import { getGetCollaudoSetupQueryKey, useGetCollaudoSetup, useVerifyCollaudoSetup } from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

/** Configurazione guidata del collaudo: repository, App GitHub e workflow, con «Verifica». */
export function CollaudoSetupCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const setup = useGetCollaudoSetup({ query: { queryKey: getGetCollaudoSetupQueryKey() } });
  const verify = useVerifyCollaudoSetup({
    mutation: {
      onSuccess: (data) => queryClient.setQueryData(getGetCollaudoSetupQueryKey(), data),
      onError: (e) => toast({ variant: "destructive", title: "Verifica non riuscita", description: apiErrorMessage(e) }),
    },
  });
  const data = verify.data ?? setup.data;
  const repoReady = !!data?.repo;
  const steps = [
    {
      ok: repoReady && data.installed,
      label: "Repository di collaudo con l'App GitHub di Botcave installata",
      hint: data?.repo
        ? `Repository ${data.repo}: installa l'App GitHub di Botcave anche su questo repository.`
        : "Crea un repository privato per i collaudi e indicalo nella configurazione di Botcave.",
    },
    {
      ok: !!data?.workflow,
      label: "Workflow del collaudo nel repository",
      hint: "Aggiungi al repository di collaudo il file del workflow che avvia il programma di collaudo.",
    },
    {
      ok: !!data?.actionsWrite,
      label: "Permesso «Actions» in scrittura per l'App GitHub",
      hint: "Nelle impostazioni dell'App GitHub concedi Actions in lettura e scrittura e accetta il nuovo permesso nell'installazione.",
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Collaudo dei lavori</CardTitle>
        <CardDescription>Tre passi, una sola volta: dopo, ogni lavoro finito si prova prima di «Porta in produzione».</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {setup.isLoading && <p className="text-sm text-ink-muted">Caricamento…</p>}
        {setup.isError && <p className="text-sm text-danger">{apiErrorMessage(setup.error)}</p>}
        {data && (
          <ol className="space-y-2">
            {steps.map((s, i) => (
              <li key={i} className="space-y-0.5 text-sm">
                <Led state={s.ok ? "ok" : "ko"} label={`${i + 1}. ${s.label}`} />
                {!s.ok && <p className="pl-4 text-xs text-ink-muted">{s.hint}</p>}
              </li>
            ))}
          </ol>
        )}
        <Button variant="secondary" size="sm" onClick={() => verify.mutate()} disabled={verify.isPending}>
          {verify.isPending ? "Verifica…" : "Verifica"}
        </Button>
      </CardContent>
    </Card>
  );
}
