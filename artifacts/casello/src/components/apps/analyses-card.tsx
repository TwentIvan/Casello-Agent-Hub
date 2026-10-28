import { useState } from "react";
import { Link } from "wouter";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type Analysis,
  type App,
  getEstimateAnalysisCostQueryKey,
  getListAnalysesQueryKey,
  useEstimateAnalysisCost,
  useListAnalyses,
  useStartAnalysis,
  useStartZipAnalysis,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDefaultAiModelId } from "@/components/ai/ai-queries";
import { ModelPicker } from "@/components/ai/model-picker";
import { phaseLabel } from "@/components/analysis/payload";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatCost, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

const POLL_MS = 2000;
const DEFAULT_MAX_TOKENS = 1_000_000;
const MIN_TOKENS = 50_000;
const MAX_TOKENS = 2_000_000;
const MAX_ZIP_BYTES = 50 * 1024 * 1024;

export const ANALYSIS_STATUS_LABELS: Record<Analysis["status"], string> = {
  queued: "In coda",
  running: "In corso",
  completed: "Completata",
  failed: "Fallita",
  interrupted: "Interrotta",
};

export const ANALYSIS_STATUS_STYLES: Record<Analysis["status"], string> = {
  queued: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  interrupted: "bg-muted text-muted-foreground",
};

const isActive = (a: Analysis) => a.status === "queued" || a.status === "running";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
}

/** Avvio dell'analisi dell'architetto e storico delle analisi dell'app. */
export function AnalysesCard({ app }: { app: App }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const defaultModelId = useDefaultAiModelId();
  const [chosenModelId, setChosenModelId] = useState<number | null>(null);
  const [maxTokensText, setMaxTokensText] = useState(String(DEFAULT_MAX_TOKENS));
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const isZip = app.sourceType === "zip";
  const aiModelId = chosenModelId ?? defaultModelId;

  const analyses = useListAnalyses(app.id, {
    query: {
      queryKey: getListAnalysesQueryKey(app.id),
      refetchInterval: (query) => (query.state.data?.some(isActive) ? POLL_MS : false),
    },
  });

  const onStarted = () => {
    void queryClient.invalidateQueries({ queryKey: getListAnalysesQueryKey(app.id) });
    setFile(null);
    setFileInputKey((k) => k + 1);
    toast({ title: "Analisi avviata" });
  };
  const onError = (error: unknown) => {
    const status = error instanceof ApiError ? error.status : null;
    toast({
      variant: "destructive",
      title: status === 409 ? "c'è già un'analisi in corso" : "Avvio non riuscito",
      // Il 413 può arrivare anche da nginx con una pagina HTML: messaggio fisso
      description:
        status === 409
          ? undefined
          : status === 413
            ? "L'archivio supera il limite di 50 MB."
            : status === 403
              ? // Installazione GitHub dell'app non collegata dall'utente che avvia
                `${apiErrorMessage(error)}: collega GitHub dalla pagina Account o usa un token manuale.`
              : apiErrorMessage(error),
    });
  };
  const startAnalysis = useStartAnalysis({ mutation: { onSuccess: onStarted, onError } });
  const startZip = useStartZipAnalysis({ mutation: { onSuccess: onStarted, onError } });
  const starting = startAnalysis.isPending || startZip.isPending;

  const maxTokens = Number(maxTokensText);
  const tokensValid = Number.isInteger(maxTokens) && maxTokens >= MIN_TOKENS && maxTokens <= MAX_TOKENS;
  const hasActive = analyses.data?.some(isActive) ?? false;

  const estimateParams = { aiModelId: aiModelId ?? 0, maxTokens };
  const estimate = useEstimateAnalysisCost(estimateParams, {
    query: {
      queryKey: getEstimateAnalysisCostQueryKey(estimateParams),
      enabled: aiModelId !== null && tokensValid,
      // Mentre si digita il tetto resta la stima precedente invece di sparire, ma solo per lo stesso modello:
      // cambiando modello la stima del precedente non si mostra
      placeholderData: (previous, previousQuery) => {
        const previousParams = previousQuery?.queryKey[1] as { aiModelId?: number } | undefined;
        return previousParams?.aiModelId === aiModelId ? keepPreviousData(previous) : undefined;
      },
      staleTime: 60_000,
    },
  });

  const onFileChange = (picked: File | null) => {
    if (picked && !picked.name.toLowerCase().endsWith(".zip")) {
      toast({ variant: "destructive", title: "File non valido", description: "Carica un archivio con estensione .zip." });
      setFile(null);
      setFileInputKey((k) => k + 1);
      return;
    }
    if (picked && picked.size > MAX_ZIP_BYTES) {
      toast({ variant: "destructive", title: "File non valido", description: "L'archivio supera il limite di 50 MB." });
      setFile(null);
      setFileInputKey((k) => k + 1);
      return;
    }
    setFile(picked);
  };

  const start = () => {
    if (aiModelId === null || !tokensValid) return;
    if (isZip) {
      if (!file) return;
      startZip.mutate({ id: app.id, data: file, params: { aiModelId, maxTokens } });
    } else {
      startAnalysis.mutate({ id: app.id, data: { aiModelId, maxTokens } });
    }
  };

  const canStart = aiModelId !== null && tokensValid && (!isZip || file !== null) && !starting;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Analisi</CardTitle>
        <CardDescription>
          L'architetto studia le sorgenti e propone tool, agenti e skill: nulla diventa attivo senza la tua approvazione.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="analysis-model">Modello</Label>
            <ModelPicker id="analysis-model" value={aiModelId} onChange={setChosenModelId} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="analysis-max-tokens">Tetto di token</Label>
            <Input
              id="analysis-max-tokens"
              type="number"
              min={MIN_TOKENS}
              max={MAX_TOKENS}
              step={10_000}
              value={maxTokensText}
              onChange={(e) => setMaxTokensText(e.target.value)}
              aria-invalid={!tokensValid}
            />
            {!tokensValid && (
              <p className="text-xs text-destructive">
                Inserisci un numero tra {MIN_TOKENS.toLocaleString("it-IT")} e {MAX_TOKENS.toLocaleString("it-IT")}.
              </p>
            )}
          </div>
        </div>
        {isZip && (
          <div className="space-y-2">
            <Label htmlFor="analysis-zip">Archivio zip del codice</Label>
            <Input
              key={fileInputKey}
              id="analysis-zip"
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted-foreground">Massimo 50 MB. Il codice resta in memoria solo per la durata dell'analisi.</p>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {hasActive && <span className="text-xs text-muted-foreground">Un'analisi è già in corso.</span>}
          {aiModelId !== null && tokensValid && estimate.data && (
            <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
              {estimate.data.typicalUsd != null && estimate.data.maxUsd != null
                ? `stima senza cache: circa ${formatUsd(estimate.data.typicalUsd)} (massimo ${formatUsd(estimate.data.maxUsd)}); con provider che la supportano il costo reale è inferiore`
                : "costo non stimabile: prezzi del modello sconosciuti"}
            </span>
          )}
          <Button onClick={start} disabled={!canStart}>
            {starting ? "Avvio…" : "Avvia analisi"}
          </Button>
        </div>

        <div className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-medium">Analisi precedenti</h3>
          {analyses.isError ? (
            <p className="text-sm text-destructive">Impossibile caricare le analisi: {apiErrorMessage(analyses.error)}</p>
          ) : !analyses.data ? (
            <p className="text-sm text-muted-foreground">Caricamento…</p>
          ) : analyses.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nessuna analisi ancora.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {analyses.data.map((a) => (
                <li key={a.id} className="space-y-1 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Link href={`/analyses/${a.id}`} className="font-medium underline-offset-2 hover:underline">
                      Analisi #{a.id}
                    </Link>
                    <Badge variant="outline" className={cn("border-transparent", ANALYSIS_STATUS_STYLES[a.status])}>
                      {ANALYSIS_STATUS_LABELS[a.status]}
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground">{a.model}</span>
                    <span className="text-xs text-muted-foreground">
                      {a.tokensUsed.toLocaleString("it-IT")} / {a.maxTokens.toLocaleString("it-IT")} token
                    </span>
                    {formatCost(a.costUsd, a.tokensUsed) && (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatCost(a.costUsd, a.tokensUsed)}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">{formatDateTime(a.createdAt)}</span>
                  </div>
                  {isActive(a) && a.phase && <p className="text-xs text-muted-foreground">Fase: {phaseLabel(a.phase)}</p>}
                  {a.error && <p className="text-xs text-destructive">{a.error}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
