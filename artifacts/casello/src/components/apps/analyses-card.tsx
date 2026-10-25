import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type Analysis,
  type App,
  getListAnalysesQueryKey,
  useListAnalyses,
  useStartAnalysis,
  useStartZipAnalysis,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useModelOptions } from "@/components/agents/model-options";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { cn } from "@/lib/utils";

const POLL_MS = 2000;
const DEFAULT_MAX_TOKENS = 400_000;
const MIN_TOKENS = 50_000;
const MAX_TOKENS = 2_000_000;
const MAX_ZIP_BYTES = 50 * 1024 * 1024;

const STATUS_LABELS: Record<Analysis["status"], string> = {
  queued: "In coda",
  running: "In corso",
  completed: "Completata",
  failed: "Fallita",
  interrupted: "Interrotta",
};

const STATUS_STYLES: Record<Analysis["status"], string> = {
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
  const { options, defaultModel } = useModelOptions();
  const [model, setModel] = useState<string>("");
  const [maxTokensText, setMaxTokensText] = useState(String(DEFAULT_MAX_TOKENS));
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const isZip = app.sourceType === "zip";
  const effectiveModel = model || defaultModel || "";

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
  const onError = (error: unknown) =>
    toast({
      variant: "destructive",
      title: error instanceof ApiError && error.status === 409 ? "c'è già un'analisi in corso" : "Avvio non riuscito",
      description: error instanceof ApiError && error.status === 409 ? undefined : apiErrorMessage(error),
    });
  const startAnalysis = useStartAnalysis({ mutation: { onSuccess: onStarted, onError } });
  const startZip = useStartZipAnalysis({ mutation: { onSuccess: onStarted, onError } });
  const starting = startAnalysis.isPending || startZip.isPending;

  const maxTokens = Number(maxTokensText);
  const tokensValid = Number.isInteger(maxTokens) && maxTokens >= MIN_TOKENS && maxTokens <= MAX_TOKENS;
  const hasActive = analyses.data?.some(isActive) ?? false;

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
    if (!effectiveModel || !tokensValid) return;
    if (isZip) {
      if (!file) return;
      startZip.mutate({ id: app.id, data: file, params: { model: effectiveModel, maxTokens } });
    } else {
      startAnalysis.mutate({ id: app.id, data: { model: effectiveModel, maxTokens } });
    }
  };

  const canStart = Boolean(effectiveModel) && tokensValid && (!isZip || file !== null) && !starting;

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
            <Select value={effectiveModel} onValueChange={setModel}>
              <SelectTrigger id="analysis-model">
                <SelectValue placeholder="Seleziona un modello" />
              </SelectTrigger>
              <SelectContent>
                {options.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
        <div className="flex items-center justify-end gap-3">
          {hasActive && <span className="text-xs text-muted-foreground">Un'analisi è già in corso.</span>}
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
                    <Badge variant="outline" className={cn("border-transparent", STATUS_STYLES[a.status])}>
                      {STATUS_LABELS[a.status]}
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground">{a.model}</span>
                    <span className="text-xs text-muted-foreground">
                      {a.tokensUsed.toLocaleString("it-IT")} / {a.maxTokens.toLocaleString("it-IT")} token
                    </span>
                    <span className="text-xs text-muted-foreground">{formatDateTime(a.createdAt)}</span>
                  </div>
                  {isActive(a) && a.phase && <p className="text-xs text-muted-foreground">Fase: {a.phase}</p>}
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
