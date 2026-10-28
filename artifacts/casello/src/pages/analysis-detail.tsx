import { useEffect, useRef, type ReactNode } from "react";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowLeft } from "lucide-react";
import {
  ApiError,
  type AnalysisDetail,
  type AnalysisLogEntry,
  getGetAnalysisQueryKey,
  getGetAppQueryKey,
  getListAnalysesQueryKey,
  useGetAnalysis,
  useGetApp,
} from "@workspace/api-client-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ChapterTabs } from "@/components/analysis/chapter-tabs";
import { isRecord, list, phaseLabel, rec, str, strList } from "@/components/analysis/payload";
import { ANALYSIS_STATUS_LABELS, ANALYSIS_STATUS_STYLES } from "@/components/apps/analyses-card";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatCost, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

const POLL_MS = 2000;

const SOURCE_TYPE_LABELS: Record<string, string> = {
  github: "codice da GitHub",
  zip: "codice da zip",
  none: "nessun codice",
};

const isActive = (a: AnalysisDetail) => a.status === "queued" || a.status === "running";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "medium" });
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// --- Log ---

/** Log dell'analisi in un riquadro scorrevole; resta in fondo a meno che l'utente non sia risalito. */
function AnalysisLog({ log }: { log: AnalysisLogEntry[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // Il log ha un tetto di voci: la lunghezza smette di cambiare, l'ultima voce no
  const last = log.at(-1);

  useEffect(() => {
    const box = boxRef.current;
    if (box && stickToBottom.current) box.scrollTop = box.scrollHeight;
  }, [log.length, last?.at, last?.message]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">Log</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          ref={boxRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="max-h-72 overflow-y-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed"
        >
          {log.length === 0 ? (
            <p className="text-muted-foreground">Nessuna voce ancora.</p>
          ) : (
            log.map((entry, i) => (
              <div key={i} className="whitespace-pre-wrap break-words">
                <span className="text-muted-foreground">{formatTime(entry.at)}</span>{" "}
                <span className="text-muted-foreground">[{phaseLabel(entry.phase)}]</span> {entry.message}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// --- Mappa ---

function MapSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold">{title}</h4>
      {children}
    </section>
  );
}

function Collapsible({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group rounded-md border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold select-none">{summary}</summary>
      <div className="border-t p-3">{children}</div>
    </details>
  );
}

/** Mappa dell'architettura in sezioni leggibili; ogni campo è letto in modo difensivo. */
function ArchitectureMap({ map }: { map: Record<string, unknown> }) {
  const stack = strList(map, "stack");
  const summary = str(map, "summary");
  const structure = str(map, "structure");
  const auth = rec(map, "auth");
  const uiAreas = list(map, "uiAreas").filter(isRecord);
  const routes = list(map, "routes").filter(isRecord);
  const dataModels = list(map, "dataModels").filter(isRecord);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Mappa</CardTitle>
        <CardDescription>Come l'architetto ha letto l'app: stack, struttura, autenticazione, aree, rotte e dati.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {summary?.trim() && <p className="text-sm whitespace-pre-wrap break-words">{summary}</p>}
        {stack.length > 0 && (
          <MapSection title="Stack">
            <div className="flex flex-wrap gap-1">
              {stack.map((s, i) => (
                <Badge key={`${s}-${i}`} variant="outline" className="font-normal">
                  {s}
                </Badge>
              ))}
            </div>
          </MapSection>
        )}
        {structure?.trim() && (
          <MapSection title="Struttura">
            <p className="text-sm whitespace-pre-wrap break-words">{structure}</p>
          </MapSection>
        )}
        {auth && (
          <MapSection title="Autenticazione">
            <dl className="space-y-2 text-sm">
              {str(auth, "mechanism")?.trim() && (
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Meccanismo</dt>
                  <dd className="whitespace-pre-wrap break-words">{str(auth, "mechanism")}</dd>
                </div>
              )}
              {str(auth, "userToken")?.trim() && (
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Token dell'utente</dt>
                  <dd className="whitespace-pre-wrap break-words">{str(auth, "userToken")}</dd>
                </div>
              )}
              {str(auth, "notes")?.trim() && (
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Note</dt>
                  <dd className="whitespace-pre-wrap break-words">{str(auth, "notes")}</dd>
                </div>
              )}
            </dl>
          </MapSection>
        )}
        {uiAreas.length > 0 && (
          <MapSection title="Aree della UI">
            <ul className="space-y-2">
              {uiAreas.map((area, i) => {
                const pages = strList(area, "pages");
                return (
                  <li key={i} className="text-sm">
                    <span className="font-medium">{str(area, "name") ?? "—"}</span>
                    {str(area, "description") ? (
                      <span className="text-muted-foreground">: {str(area, "description")}</span>
                    ) : null}
                    {pages.length > 0 && (
                      <div className="mt-0.5 font-mono text-xs break-all text-muted-foreground">{pages.join(", ")}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </MapSection>
        )}
        {routes.length > 0 && (
          <Collapsible summary={`Rotte (${routes.length})`}>
            <ul className="space-y-1 font-mono text-xs">
              {routes.map((route, i) => (
                <li key={i} className="break-all">
                  <span className="font-semibold">{str(route, "method") ?? "?"}</span> {str(route, "path") ?? "?"}
                  {str(route, "file") ? <span className="text-muted-foreground"> — {str(route, "file")}</span> : null}
                </li>
              ))}
            </ul>
          </Collapsible>
        )}
        {dataModels.length > 0 && (
          <Collapsible summary={`Modelli dei dati (${dataModels.length})`}>
            <ul className="space-y-2 text-sm">
              {dataModels.map((model, i) => {
                const fields = strList(model, "fields");
                return (
                  <li key={i}>
                    <span className="font-medium">{str(model, "name") ?? "—"}</span>
                    {str(model, "file") ? (
                      <span className="font-mono text-xs text-muted-foreground"> — {str(model, "file")}</span>
                    ) : null}
                    {fields.length > 0 && (
                      <div className="mt-0.5 font-mono text-xs break-all text-muted-foreground">{fields.join(", ")}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}

// --- Pagina ---

export default function AnalysisDetailPage() {
  const params = useParams<{ id: string }>();
  const analysisId = Number(params.id);
  const queryClient = useQueryClient();

  const analysis = useGetAnalysis(analysisId, {
    query: {
      queryKey: getGetAnalysisQueryKey(analysisId),
      enabled: Number.isInteger(analysisId),
      // Polling solo finché l'analisi è in coda o in corso.
      refetchInterval: (query) => (query.state.data && isActive(query.state.data) ? POLL_MS : false),
    },
  });
  const appId = analysis.data?.appId ?? 0;
  const app = useGetApp(appId, { query: { queryKey: getGetAppQueryKey(appId), enabled: appId > 0 } });

  // A fine analisi lo storico nella scheda dell'app va aggiornato.
  const wasActive = useRef(false);
  const active = analysis.data ? isActive(analysis.data) : false;
  useEffect(() => {
    if (wasActive.current && !active && appId > 0) {
      void queryClient.invalidateQueries({ queryKey: getListAnalysesQueryKey(appId) });
    }
    wasActive.current = active;
  }, [active, appId, queryClient]);

  const backLink = (
    <Link
      href={appId > 0 ? `/apps/${appId}` : "/apps"}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      {app.data?.name ?? "App"}
    </Link>
  );

  if (!Number.isInteger(analysisId) || (analysis.error instanceof ApiError && analysis.error.status === 404)) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        {backLink}
        <p className="text-sm text-muted-foreground">Analisi non trovata: potrebbe essere stata eliminata con la sua app.</p>
      </div>
    );
  }
  if (analysis.isError && !analysis.data) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        {backLink}
        <p className="text-sm text-destructive">Impossibile caricare l'analisi: {apiErrorMessage(analysis.error)}</p>
      </div>
    );
  }
  if (!analysis.data) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        {backLink}
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const a = analysis.data;
  const endMs = a.finishedAt ? new Date(a.finishedAt).getTime() : active ? Date.now() : null;
  const durationMs = endMs !== null ? endMs - new Date(a.createdAt).getTime() : null;
  const sources = [
    SOURCE_TYPE_LABELS[a.sources.code] ?? a.sources.code,
    ...(a.sources.openapi ? ["OpenAPI"] : []),
    ...(a.sources.description ? ["descrizione"] : []),
  ].join(", ");
  // Dalla partenza l'architectureMap contiene solo { repoMap }: la mappa c'è quando ha riassunto o stack
  const map =
    isRecord(a.architectureMap) && (str(a.architectureMap, "summary")?.trim() || strList(a.architectureMap, "stack").length > 0)
      ? a.architectureMap
      : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="space-y-3">
        {backLink}
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-semibold tracking-tight">Analisi #{a.id}</h2>
          <Badge variant="outline" className={cn("border-transparent", ANALYSIS_STATUS_STYLES[a.status])}>
            {ANALYSIS_STATUS_LABELS[a.status]}
          </Badge>
          {active && <Spinner className="size-4" />}
        </div>
        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">App</dt>
            <dd>
              <Link href={`/apps/${a.appId}`} className="font-medium hover:underline">
                {app.data?.name ?? `App #${a.appId}`}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Modello</dt>
            <dd className="font-mono text-xs break-all">{a.model}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Fase</dt>
            <dd>{active ? phaseLabel(a.phase) : a.phase ? `${phaseLabel(a.phase)} (ultima)` : "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Token</dt>
            <dd className="tabular-nums">
              {a.tokensUsed.toLocaleString("it-IT")} / {a.maxTokens.toLocaleString("it-IT")}
              {a.cachedTokens > 0 && (
                <span className="text-muted-foreground">
                  {" "}
                  · {a.cachedTokens.toLocaleString("it-IT")} letti dalla cache (contano al 10%)
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Costo</dt>
            <dd className="tabular-nums">{formatCost(a.costUsd, a.tokensUsed) ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Avviata</dt>
            <dd>{formatDateTime(a.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Durata</dt>
            <dd className="tabular-nums">{formatDuration(durationMs)}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">Fonti</dt>
            <dd>{sources}</dd>
          </div>
        </dl>
      </div>

      {a.status === "failed" && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Analisi fallita</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap break-words">
            {a.error || "Errore sconosciuto."}
            {a.items.length > 0 ? "\nGli elementi delle fasi concluse restano rivedibili qui sotto." : ""}
          </AlertDescription>
        </Alert>
      )}
      {a.status === "interrupted" && (
        <Alert>
          <AlertCircle className="size-4" />
          <AlertTitle>Analisi interrotta</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap break-words">
            {a.error || "L'analisi si è fermata prima della fine (ad esempio per un riavvio del server)."}
          </AlertDescription>
        </Alert>
      )}

      <AnalysisLog log={a.log} />

      {map ? (
        <ArchitectureMap map={map} />
      ) : active ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
            <Spinner className="size-5" />
            L'architetto sta studiando le sorgenti…
          </CardContent>
        </Card>
      ) : null}

      <section className="space-y-3">
        <div>
          <h3 className="text-lg font-semibold tracking-tight">Proposta</h3>
          <p className="text-sm text-muted-foreground">
            Nulla diventa attivo senza approvazione. Approvare un tool, un agente o una skill li applica subito.
          </p>
        </div>
        <ChapterTabs analysisId={a.id} appId={a.appId} items={a.items} />
      </section>
    </div>
  );
}
