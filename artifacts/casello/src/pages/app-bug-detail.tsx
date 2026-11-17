import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import {
  AdminBugCloseStatus,
  ApiError,
  getGetAppBugQueryKey,
  getGetAppQueryKey,
  getListAppBugsQueryKey,
  useAddAppBugMessage,
  useCloseAppBug,
  useGetApp,
  useGetAppBug,
} from "@workspace/api-client-react";
import { usePanelSubject } from "@/components/panel/panel-context";
import { Led } from "@/components/brand/led";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { BUG_STATUS_LABELS, bugStatusLed } from "@/lib/bug-status";
import { formatRelative } from "@/lib/format";

const FINAL = new Set(["fixed", "not_a_bug", "duplicate", "rejected"]);
const AUTHORS = { reporter: "Utente", lead: "Responsabile", owner: "Tu" } as const;

function Block({ title, text }: { title: string; text: string | null }) {
  if (!text) return null;
  return (
    <div className="space-y-1">
      <h3 className="text-label">{title}</h3>
      <p className="whitespace-pre-wrap break-words text-sm">{text}</p>
    </div>
  );
}

/** Dettaglio di una segnalazione: testo, contesto, vaglio, conversazione e chiusura. */
export default function AppBugDetailPage() {
  const params = useParams<{ id: string; number: string }>();
  const appId = Number(params.id);
  const number = Number(params.number);
  const valid = Number.isInteger(appId) && appId > 0 && Number.isInteger(number) && number > 0;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [closeText, setCloseText] = useState("");

  const app = useGetApp(appId, { query: { queryKey: getGetAppQueryKey(appId), enabled: valid } });
  const bug = useGetAppBug(appId, number, { query: { queryKey: getGetAppBugQueryKey(appId, number), enabled: valid } });
  usePanelSubject({ lucius: app.data ? { kind: "plan", appId } : null });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getGetAppBugQueryKey(appId, number) });
    void queryClient.invalidateQueries({ queryKey: getListAppBugsQueryKey(appId) });
  };
  const send = useAddAppBugMessage({
    mutation: {
      onSuccess: () => { setText(""); refresh(); },
      onError: (e) => toast({ variant: "destructive", title: "Messaggio non inviato", description: apiErrorMessage(e) }),
    },
  });
  const close = useCloseAppBug({
    mutation: {
      onSuccess: () => { setCloseText(""); refresh(); toast({ title: "Segnalazione chiusa" }); },
      // Il messaggio del server (es. «approvazione in corso: riprova tra poco») si mostra così com'è.
      onError: (e) => toast({ variant: "destructive", title: "Chiusura non riuscita", description: apiErrorMessage(e) }),
    },
  });

  const notFound = !valid || (bug.error instanceof ApiError && bug.error.status === 404);
  const d = bug.data;
  const final = d ? FINAL.has(d.status) : false;

  return (
    <div className="mx-auto max-w-screen-xl space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href={valid ? `/apps/${appId}` : "/apps"}>
          <ArrowLeft />
          {app.data ? app.data.name : "Tutte le app"}
        </Link>
      </Button>
      {notFound ? (
        <p className="text-sm text-ink-muted">Segnalazione non trovata.</p>
      ) : bug.isError ? (
        <p className="text-sm text-danger">{apiErrorMessage(bug.error)}</p>
      ) : !d ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <>
          <div className="space-y-2">
            <h2 className="text-h2 break-words">#{d.number} · {d.title}</h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <Led state={bugStatusLed(d.status)} label={BUG_STATUS_LABELS[d.status]} />
              <span className="font-mono text-xs text-ink-muted">{d.status}</span>
              <span className="text-ink-muted">{formatRelative(d.createdAt)}</span>
              <span className="text-ink-muted">{d.reporterLabel}</span>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              {d.pendingActionNumber != null && (
                <Link href="/pending-actions" className="underline underline-offset-2">Voce #{d.pendingActionNumber} in «Da confermare»</Link>
              )}
              {d.teamInstanceId != null && (
                <Link href={`/teams/${d.teamInstanceId}`} className="underline underline-offset-2">Squadra</Link>
              )}
              {d.issueUrl && (
                <a href={d.issueUrl} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
                  Issue{d.issueNumber != null ? ` #${d.issueNumber}` : ""}
                </a>
              )}
              {d.prUrl && <a href={d.prUrl} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">Pull request</a>}
            </div>
            {d.status === "pending_approval" && d.pendingActionNumber == null && (
              <p className="text-sm text-ink-muted">
                Nessuna voce in coda: nessuno può approvare. Designa una squadra per i bug o un modello per il Responsabile; Botcave riprova ogni minuto.
              </p>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="min-w-0">
              <CardHeader><CardTitle>Segnalazione</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <Block title="Descrizione" text={d.description} />
                <Block title="Passi per riprodurre" text={d.steps} />
                <Block title="Comportamento atteso" text={d.expected} />
                <div className="space-y-1">
                  <h3 className="text-label">Utente</h3>
                  <p className="break-words text-sm">
                    {d.reporterKind === "identity" ? "Identità dell'app" : "Chiave del browser"}
                    {d.reporterName ? ` · ${d.reporterName}` : ""}
                    {d.reporterEmail ? ` · ${d.reporterEmail}` : ""}
                  </p>
                </div>
                {d.pageContext && (
                  <div className="space-y-1">
                    <h3 className="text-label">Pagina</h3>
                    <p className="break-all font-mono text-xs">
                      {[d.pageContext.page, d.pageContext.id, d.pageContext.title, d.pageContext.url].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardHeader><CardTitle>Vaglio del Responsabile</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {d.triage ? (
                  <>
                    <p><span className="text-ink-muted">Esito:</span> <span className="font-mono">{d.triage.verdict}</span></p>
                    <p className="whitespace-pre-wrap break-words">{d.triage.summary}</p>
                    {d.triage.question && <p className="break-words"><span className="text-ink-muted">Domanda:</span> {d.triage.question}</p>}
                    {d.triage.duplicateOf != null && <p><span className="text-ink-muted">Doppione di</span> <span className="font-mono">#{d.triage.duplicateOf}</span></p>}
                    {d.triage.userMessage && <p className="break-words"><span className="text-ink-muted">Messaggio per l'utente:</span> {d.triage.userMessage}</p>}
                  </>
                ) : (
                  <p className="text-ink-muted">Vaglio non ancora eseguito.</p>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle>Messaggi</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {d.messages.length === 0 && <p className="text-sm text-ink-muted">Nessun messaggio.</p>}
              <ul className="space-y-3">
                {d.messages.map((m) => (
                  <li key={m.id} className="text-sm">
                    <p className="text-xs text-ink-muted">{AUTHORS[m.author]} · {formatRelative(m.createdAt)}</p>
                    <p className="whitespace-pre-wrap break-words">{m.content}</p>
                  </li>
                ))}
              </ul>
              {!final && (
                <div className="space-y-2">
                  <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={4000} placeholder="Scrivi all'utente" aria-label="Messaggio all'utente" />
                  <Button disabled={!text.trim() || send.isPending} onClick={() => send.mutate({ id: appId, number, data: { content: text.trim() } })}>
                    {send.isPending ? "Invio…" : "Scrivi all'utente"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {!final && (
            <Card>
              <CardHeader><CardTitle>Chiusura</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  value={closeText}
                  onChange={(e) => setCloseText(e.target.value)}
                  rows={2}
                  maxLength={500}
                  placeholder="Testo per l'utente (facoltativo)"
                  aria-label="Testo per l'utente alla chiusura"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    disabled={close.isPending}
                    onClick={() => close.mutate({ id: appId, number, data: { status: AdminBugCloseStatus.fixed, ...(closeText.trim() ? { message: closeText.trim() } : {}) } })}
                  >
                    Segna come corretta
                  </Button>
                  <Button
                    variant="outline"
                    disabled={close.isPending}
                    onClick={() => close.mutate({ id: appId, number, data: { status: AdminBugCloseStatus.not_a_bug, ...(closeText.trim() ? { message: closeText.trim() } : {}) } })}
                  >
                    Chiudi come non bug
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
