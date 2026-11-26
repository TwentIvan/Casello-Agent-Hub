import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type QueuedReleaseTest,
  type ReleaseTestDetail,
  getGetAppQueryKey,
  getGetReleaseTestQueryKey,
  getListPendingActionsQueryKey,
  useGetApp,
  useGetReleaseTest,
  useRelightReleaseTest,
  useSendBackReleaseTest,
} from "@workspace/api-client-react";
import { Markdown } from "@/components/plan/markdown";
import { Led } from "@/components/brand/led";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  autoFixCounter,
  relightLabel,
  releaseTestElapsed,
  releaseTestLabel,
  releaseTestLed,
  releaseTestOpen,
  releaseTestProgress,
  tunnelRemaining,
} from "@/lib/release-test";

const POLL_MS = 5_000;

const fileUrl = (testId: number, fileId: number) => `/api/release-tests/${testId}/files/${fileId}`;

/** Nel pannello incorporato (senza cookie) basta l'esito e il rimando alla console. */
export function ReleaseTestSummary({ test, consoleHref }: { test: QueuedReleaseTest; consoleHref: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Led state={releaseTestLed(test)} label={releaseTestLabel(test)} />
      <a href={consoleHref} target="_blank" rel="noopener" className="text-sm hover:underline">
        Apri in Botcave
      </a>
    </div>
  );
}

/** Avanzamento dal vivo: tempo trascorso e ultimi passi del collaudatore. */
function ProgressLines({ detail, now }: { detail: ReleaseTestDetail; now: Date }) {
  const elapsed = releaseTestElapsed(detail.startedAt, now);
  const lines = releaseTestProgress(detail.steps);
  if (!elapsed && lines.length === 0) return null;
  return (
    <div className="space-y-0.5 text-xs text-ink-muted">
      {elapsed && <p className="font-mono">Da {elapsed}</p>}
      {lines.length > 0 && (
        <ul className="space-y-0.5">
          {lines.map((line, i) => (
            <li key={i} className={i === lines.length - 1 ? "text-ink" : undefined}>
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Sezione «Collaudo» della voce «Porta in produzione» (console): l'ultimo collaudo completo del lavoro (resoconto, problemi,
 * video), con a parte lo stato e il link dal vivo del «Riaccendi» più recente.
 */
export function ReleaseTestSection({ test: brief, decisionPending }: { test: QueuedReleaseTest; decisionPending: boolean }) {
  const testId = brief.id;
  const relightBrief = brief.relight ?? null;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmSendBack, setConfirmSendBack] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const query = useGetReleaseTest(testId, {
    query: {
      queryKey: getGetReleaseTestQueryKey(testId),
      refetchInterval: (q) => (q.state.data && releaseTestOpen(q.state.data.status) ? POLL_MS : false),
    },
  });
  const test = query.data;
  const open = test ? releaseTestOpen(test.status) : false;
  // Il relight si segue dal vivo (stato e link) finché è aperto
  const relightQuery = useGetReleaseTest(relightBrief?.id ?? 0, {
    query: {
      enabled: relightBrief !== null,
      queryKey: getGetReleaseTestQueryKey(relightBrief?.id ?? 0),
      refetchInterval: (q) => (q.state.data && releaseTestOpen(q.state.data.status) ? POLL_MS : false),
    },
  });
  const relight = relightQuery.data ?? relightBrief;
  const relightOpen = relight ? releaseTestOpen(relight.status) : false;
  // Orologio: ogni secondo mentre il collaudo è aperto (tempo trascorso), altrimenti ogni 30 s (scadenza del link)
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), open ? 1_000 : 30_000);
    return () => clearInterval(t);
  }, [open]);
  const app = useGetApp(test?.appId ?? 0, { query: { enabled: !!test, queryKey: getGetAppQueryKey(test?.appId ?? 0) } });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getGetReleaseTestQueryKey(testId) });
    if (relightBrief) void queryClient.invalidateQueries({ queryKey: getGetReleaseTestQueryKey(relightBrief.id) });
    void queryClient.invalidateQueries({ queryKey: getListPendingActionsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: ["/api/release-tests"] });
  };
  const fail = (title: string) => (error: unknown) =>
    toast({ variant: "destructive", title, description: apiErrorMessage(error) });
  const relightMutation = useRelightReleaseTest({
    mutation: { onSuccess: () => { refresh(); toast({ title: "Collaudo riacceso" }); }, onError: fail("Riaccensione non riuscita") },
  });
  const sendBack = useSendBackReleaseTest({
    mutation: {
      onSuccess: () => {
        setConfirmSendBack(false);
        refresh();
        toast({ title: "Lavoro rimandato alla squadra" });
      },
      onError: (error) => {
        setConfirmSendBack(false);
        fail("Rinvio non riuscito")(error);
      },
    },
  });

  if (query.isLoading) return <p className="text-sm text-ink-muted">Caricamento del collaudo…</p>;
  if (query.isError || !test) return <p className="text-sm text-danger">{apiErrorMessage(query.error)}</p>;

  const video = test.files.find((f) => f.kind === "video");
  // Link dal vivo: quello del relight più recente, altrimenti quello del collaudo completo
  const live =
    relight?.tunnelUrl && relight.tunnelUntil
      ? { url: relight.tunnelUrl, until: relight.tunnelUntil }
      : test.tunnelUrl && test.tunnelUntil
        ? { url: test.tunnelUrl, until: test.tunnelUntil }
        : null;
  const remaining = live ? tunnelRemaining(live.until, now) : null;

  return (
    <div className="space-y-2 rounded-md border border-border p-2 text-sm">
      <p className="text-xs text-ink-muted">Collaudo</p>
      <Led state={releaseTestLed(test)} label={releaseTestLabel(test)} />
      {open && <ProgressLines detail={test} now={now} />}
      {app.data?.testAutoFix && <p className="text-xs text-ink-muted">{autoFixCounter(test.autoRejects)}</p>}
      {test.report && <Markdown>{test.report}</Markdown>}
      {test.problems && test.problems.length > 0 && (
        <ul className="space-y-2">
          {test.problems.map((p, i) => {
            const shot = p.screenshot != null ? test.files.find((f) => f.kind === "screenshot" && f.id === p.screenshot) : undefined;
            return (
              <li key={i} className="space-y-1 break-words border-l-2 border-danger pl-2">
                <p className="font-medium">
                  {p.task && <span className="font-mono">{p.task} · </span>}
                  {p.title}
                </p>
                <p className="whitespace-pre-wrap text-xs text-ink-muted">Passi: {p.steps}</p>
                <p className="text-xs">Atteso: {p.expected}</p>
                <p className="text-xs">Trovato: {p.actual}</p>
                {shot && (
                  <a href={fileUrl(test.id, shot.id)} target="_blank" rel="noopener">
                    <img src={fileUrl(test.id, shot.id)} alt={p.title} loading="lazy" className="max-h-32 max-w-full border border-border" />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {test.notTestable && test.notTestable.length > 0 && (
        <div>
          <p className="text-xs text-ink-muted">Non collaudabile</p>
          <ul className="list-disc pl-5 text-xs">
            {test.notTestable.map((n, i) => (
              <li key={i} className="break-words">
                {n}
              </li>
            ))}
          </ul>
        </div>
      )}
      {video && <video controls preload="metadata" src={fileUrl(test.id, video.id)} className="max-w-full border border-border" />}
      {relight && <Led state={releaseTestLed({ status: relight.status, outcome: null, error: relight.error })} label={relightLabel(relight)} />}
      {live && remaining && (
        <p className="break-words">
          <a href={live.url} target="_blank" rel="noopener" className="font-medium hover:underline">
            Prova dal vivo
          </a>
          <span className="text-ink-muted"> · ancora {remaining} · link pubblico temporaneo, dati di prova</span>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {test.status === "done" && decisionPending && !relightOpen && (
          <Button variant="secondary" size="sm" onClick={() => relightMutation.mutate({ id: test.id })} disabled={relightMutation.isPending}>
            Riaccendi
          </Button>
        )}
        {(test.status === "done" || test.status === "failed") && decisionPending && (
          <Button variant="outline" size="sm" onClick={() => setConfirmSendBack(true)} disabled={sendBack.isPending}>
            Rimanda alla squadra
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirmSendBack}
        onOpenChange={setConfirmSendBack}
        title="Rimandare il lavoro alla squadra?"
        description="Botcave rifiuta «Porta in produzione» con il resoconto del collaudo come nota: il lavoro torna aperto e il capo lo riceve."
        confirmLabel="Rimanda alla squadra"
        pendingLabel="Invio…"
        pending={sendBack.isPending}
        onConfirm={() => sendBack.mutate({ id: test.id })}
      />
    </div>
  );
}
