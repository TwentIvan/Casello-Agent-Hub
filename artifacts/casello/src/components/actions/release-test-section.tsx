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
import { autoFixCounter, releaseTestLabel, releaseTestLed, releaseTestOpen, tunnelRemaining } from "@/lib/release-test";

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

function ActivityLine({ detail }: { detail: ReleaseTestDetail }) {
  const last = detail.activity?.items[detail.activity.items.length - 1];
  if (!last) return null;
  return <p className="text-xs text-ink-muted">{last.kind === "tool" ? `Esegue ${last.toolName ?? "uno strumento"}` : "Ragiona"}</p>;
}

/** Sezione «Collaudo» della voce «Porta in produzione» (console). */
export function ReleaseTestSection({ testId, decisionPending }: { testId: number; decisionPending: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmSendBack, setConfirmSendBack] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const query = useGetReleaseTest(testId, {
    query: {
      queryKey: getGetReleaseTestQueryKey(testId),
      refetchInterval: (q) => (q.state.data && releaseTestOpen(q.state.data.status) ? POLL_MS : false),
    },
  });
  const test = query.data;
  const app = useGetApp(test?.appId ?? 0, { query: { enabled: !!test, queryKey: getGetAppQueryKey(test?.appId ?? 0) } });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getGetReleaseTestQueryKey(testId) });
    void queryClient.invalidateQueries({ queryKey: getListPendingActionsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: ["/api/release-tests"] });
  };
  const fail = (title: string) => (error: unknown) =>
    toast({ variant: "destructive", title, description: apiErrorMessage(error) });
  const relight = useRelightReleaseTest({
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

  const open = releaseTestOpen(test.status);
  const video = test.files.find((f) => f.kind === "video");
  const remaining = test.tunnelUrl && test.tunnelUntil ? tunnelRemaining(test.tunnelUntil, now) : null;

  return (
    <div className="space-y-2 rounded-md border border-border p-2 text-sm">
      <p className="text-xs text-ink-muted">Collaudo</p>
      <Led state={releaseTestLed(test)} label={releaseTestLabel(test)} />
      {open && <ActivityLine detail={test} />}
      {app.data?.testAutoFix && <p className="text-xs text-ink-muted">{autoFixCounter(test.autoRejects)}</p>}
      {test.report && <Markdown>{test.report}</Markdown>}
      {test.problems && test.problems.length > 0 && (
        <ul className="space-y-2">
          {test.problems.map((p, i) => {
            const shot = p.screenshot ? test.files.find((f) => f.kind === "screenshot" && f.name === p.screenshot) : undefined;
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
      {test.tunnelUrl && remaining && (
        <p className="break-words">
          <a href={test.tunnelUrl} target="_blank" rel="noopener" className="font-medium hover:underline">
            Prova dal vivo
          </a>
          <span className="text-ink-muted"> · ancora {remaining} · link pubblico temporaneo, dati di prova</span>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!open && (
          <Button variant="secondary" size="sm" onClick={() => relight.mutate({ id: test.id })} disabled={relight.isPending}>
            Riaccendi
          </Button>
        )}
        {!open && decisionPending && (
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
