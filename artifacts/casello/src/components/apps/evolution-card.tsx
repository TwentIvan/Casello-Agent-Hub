import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  type App,
  getGetAppEvolutionQueryKey,
  getGetDashboardStatsQueryKey,
  getListAppEvolutionRoundsQueryKey,
  useGetAppEvolution,
  useListAppEvolutionRounds,
  useResumeAppEvolution,
  useRunAppEvolutionNow,
  useStopAppEvolution,
} from "@workspace/api-client-react";
import { Led, type LedState } from "@/components/brand/led";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { FREQUENCY_LABELS, ROUND_STATUS_LABELS, roundStatusLed } from "@/lib/evolution-consent";
import { formatRelative, formatUsd } from "@/lib/format";
import { EvolutionConsentDialog } from "./evolution-consent-dialog";

/** Ciclo di evoluzione automatica dell'app: stato, spesa, ultimi giri e comandi. */
export function EvolutionCard({ app }: { app: App }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<"activate" | "settings" | null>(null);

  const evo = useGetAppEvolution(app.id, {
    query: {
      queryKey: getGetAppEvolutionQueryKey(app.id),
      refetchInterval: (query) => (query.state.data?.openRound ? 5000 : false),
    },
  });
  const rounds = useListAppEvolutionRounds(app.id, { query: { queryKey: getListAppEvolutionRoundsQueryKey(app.id) } });
  const cycle = evo.data ?? null;
  const canUseGithub = app.sourceInstallationId != null && !!app.sourceRepo;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getGetAppEvolutionQueryKey(app.id) });
    void queryClient.invalidateQueries({ queryKey: getListAppEvolutionRoundsQueryKey(app.id) });
    void queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
  };
  const onError = (error: unknown) =>
    toast({ variant: "destructive", title: "Operazione non riuscita", description: apiErrorMessage(error) });
  const stop = useStopAppEvolution({ mutation: { onSuccess: refresh, onError } });
  const resume = useResumeAppEvolution({ mutation: { onSuccess: refresh, onError } });
  const runNow = useRunAppEvolutionNow({
    mutation: {
      onSuccess: () => {
        refresh();
        toast({ title: "Giro avviato" });
      },
      onError,
    },
  });

  let led: LedState = "idle";
  let ledLabel = "Non attivo";
  if (cycle) {
    if (cycle.openRound) {
      led = "work";
      ledLabel = "Giro in corso";
    } else if (cycle.status === "active") {
      led = "ok";
      ledLabel = "Attivo, in attesa del prossimo giro";
    } else if (cycle.pausedReason) {
      led = "ko";
      ledLabel = "In pausa";
    } else {
      led = "idle";
      ledLabel = "In pausa";
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Evoluzione automatica</CardTitle>
        <CardDescription>
          Botcave analizza l'app a intervalli, sceglie alcune voci del piano e le fa implementare alla squadra.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {evo.isLoading && <p className="text-sm text-ink-muted">Caricamento…</p>}
        {evo.isError && <p className="text-sm text-danger">{apiErrorMessage(evo.error)}</p>}
        {!evo.isLoading && !evo.isError && !cycle && !canUseGithub && (
          <p className="text-sm text-ink-muted">
            Per attivare il ciclo serve il codice collegato tramite l'App GitHub: collega il repository nelle sorgenti dell'app.
          </p>
        )}
        {!evo.isLoading && !evo.isError && !cycle && canUseGithub && (
          <div className="flex items-center gap-3">
            <Led state="idle" label="Non attivo" />
            <Button onClick={() => setDialog("activate")}>Attiva…</Button>
          </div>
        )}
        {cycle && (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <Led state={led} label={ledLabel} />
              <span className="text-ink-muted">{FREQUENCY_LABELS[cycle.frequency]}</span>
              <span className="font-mono text-xs">{cycle.itemsPerRound} voci per giro</span>
              <span className="font-mono text-xs">
                {formatUsd(cycle.spentUsd)} / {formatUsd(cycle.monthlyBudgetUsd)}
              </span>
              {cycle.analysisModelName && <span className="text-ink-muted break-all">{cycle.analysisModelName}</span>}
              {cycle.status === "active" && cycle.nextRoundAt && !cycle.openRound && (
                <span className="text-ink-muted">prossimo giro {formatRelative(cycle.nextRoundAt)}</span>
              )}
            </div>
            {cycle.unpricedCount > 0 && (
              <p className="text-xs text-ink-muted">
                {cycle.unpricedCount} esecuzioni senza prezzo: la spesa è parziale.
              </p>
            )}
            {cycle.status === "paused" && cycle.pausedReason && (
              <p className="text-sm text-danger break-words">{cycle.pausedReason}</p>
            )}
            {cycle.lastError && <p className="text-sm text-danger break-words">{cycle.lastError}</p>}
            {!cycle.consentValid && (
              <p className="text-sm text-ink-muted">Il consenso non è più valido: riattiva il ciclo per confermarlo di nuovo.</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {cycle.status === "active" ? (
                <Button variant="secondary" onClick={() => stop.mutate({ id: app.id })} disabled={stop.isPending}>
                  Ferma
                </Button>
              ) : cycle.consentValid ? (
                <Button variant="secondary" onClick={() => resume.mutate({ id: app.id })} disabled={resume.isPending}>
                  Riprendi
                </Button>
              ) : (
                <Button onClick={() => setDialog("activate")}>Attiva…</Button>
              )}
              <Button
                variant="secondary"
                onClick={() => runNow.mutate({ id: app.id })}
                disabled={runNow.isPending || cycle.status !== "active" || !!cycle.openRound}
              >
                Esegui ora
              </Button>
              <Button variant="ghost" onClick={() => setDialog("settings")}>
                Impostazioni…
              </Button>
            </div>
          </>
        )}
        {rounds.data && rounds.data.length > 0 && (
          <ul className="min-w-0 divide-y divide-border rounded-md border border-border text-sm">
            {rounds.data.slice(0, 5).map((round) => (
              <li key={round.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="font-mono text-xs">#{round.number}</span>
                <Led state={roundStatusLed(round.status)} label={ROUND_STATUS_LABELS[round.status]} />
                <span className="font-mono text-xs">{round.itemIds.length} voci</span>
                <span className="text-ink-muted">{formatRelative(round.startedAt)}</span>
                {round.analysisId != null && (
                  <Link href={`/analyses/${round.analysisId}`} className="underline underline-offset-2">
                    Analisi
                  </Link>
                )}
                {round.outcome && <span className="min-w-0 break-words text-ink-muted">{round.outcome}</span>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {dialog && (
        <EvolutionConsentDialog
          app={app}
          cycle={cycle}
          activating={dialog === "activate"}
          onClose={() => setDialog(null)}
        />
      )}
    </Card>
  );
}
