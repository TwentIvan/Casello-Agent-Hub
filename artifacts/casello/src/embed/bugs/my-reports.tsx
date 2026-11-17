// «Le mie segnalazioni» del visitatore: stato con il LED e la sua frase, messaggio pubblico, dettaglio con i messaggi e la
// risposta quando serve («Serve una tua risposta»); aprire il dettaglio segna la segnalazione come vista.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  addEmbedBugMessage,
  getEmbedBug,
  getGetEmbedBugQueryKey,
  getListEmbedBugsQueryKey,
  markEmbedBugsSeen,
  useAddEmbedBugMessage,
  useGetEmbedBug,
  useMarkEmbedBugsSeen,
  type EmbedBugMessageViewAuthor,
  type EmbedBugSummary,
} from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api-errors";
import { BUG_STATUS_LABELS, bugStatusLed } from "@/lib/bug-status";
import { formatRelative } from "@/lib/format";
import { useVisitorBugList, useVisitorBugs } from "./visitor-bugs";

const AUTHOR_LABELS: Record<EmbedBugMessageViewAuthor, string> = {
  reporter: "Tu",
  lead: "Botcave",
  owner: "Il team dell'app",
};
const MESSAGE_MAX = 4_000;

function Reply({ id }: { id: number }) {
  const { params, call } = useVisitorBugs();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const send = useAddEmbedBugMessage({
    mutation: {
      mutationFn: ({ id: bugId, data, params: p }) => call((init) => addEmbedBugMessage(bugId, data, p, init)),
      onSuccess: () => {
        setText("");
        void queryClient.invalidateQueries({ queryKey: getGetEmbedBugQueryKey(id, params) });
        void queryClient.invalidateQueries({ queryKey: getListEmbedBugsQueryKey(params) });
      },
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const content = text.trim();
    if (!content || send.isPending) return;
    send.mutate({ id, data: { content }, params });
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <Textarea
        aria-label="La tua risposta"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={MESSAGE_MAX}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={!text.trim() || send.isPending}>
          {send.isPending ? "Invio…" : "Invia la risposta"}
        </Button>
        {send.isError && <Led state="ko" label={apiErrorMessage(send.error)} />}
      </div>
    </form>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <p className="text-caption text-ink-muted">{label}</p>
      <p className="whitespace-pre-wrap break-words text-body-sm">{value}</p>
    </div>
  );
}

function Detail({ summary }: { summary: EmbedBugSummary }) {
  const { params, requester, ready, call } = useVisitorBugs();
  const queryClient = useQueryClient();
  const detail = useGetEmbedBug(summary.id, params, {
    query: {
      queryKey: [...getGetEmbedBugQueryKey(summary.id, params), requester],
      queryFn: ({ signal }) => call((init) => getEmbedBug(summary.id, params, { ...init, signal })),
      enabled: ready,
    },
  });
  const seen = useMarkEmbedBugsSeen({
    mutation: {
      mutationFn: ({ data, params: p }) => call((init) => markEmbedBugsSeen(data, p, init)),
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: getListEmbedBugsQueryKey(params) }),
    },
  });
  // Una volta per apertura: le novità di questa segnalazione sono viste
  const marked = useRef(false);
  const { mutate } = seen;
  useEffect(() => {
    if (!summary.unseen) {
      marked.current = false;
      return;
    }
    if (marked.current) return;
    marked.current = true;
    mutate({ data: { ids: [summary.id] }, params });
  }, [summary.unseen, summary.id, params, mutate]);

  if (detail.isError && !detail.data) {
    return <p className="text-body-sm text-danger">Impossibile caricare la segnalazione: {apiErrorMessage(detail.error)}</p>;
  }
  if (!detail.data) return <Skeleton className="h-16 w-full" />;
  const bug = detail.data;
  return (
    <div className="min-w-0 space-y-3 pt-2">
      <Field label="Cosa è successo" value={bug.description} />
      <Field label="Passi per riprodurlo" value={bug.steps} />
      <Field label="Cosa ti aspettavi" value={bug.expected} />
      {bug.messages.length > 0 && (
        <ul className="space-y-2">
          {bug.messages.map((m, i) => (
            <li key={i} className="min-w-0 rounded-sm border border-border bg-surface-2 p-2">
              <p className="text-caption text-ink-muted">
                {AUTHOR_LABELS[m.author]} · {formatRelative(m.createdAt)}
              </p>
              <p className="whitespace-pre-wrap break-words text-body-sm">{m.content}</p>
            </li>
          ))}
        </ul>
      )}
      {bug.status === "needs_info" && <Reply id={bug.id} />}
    </div>
  );
}

function ReportItem({ bug }: { bug: EmbedBugSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="min-w-0 rounded-sm border border-border p-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 flex-col items-start gap-1 text-left"
      >
        <span className="flex w-full min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-caption text-ink-muted">n. {bug.number}</span>
          <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{bug.title}</span>
          {bug.unseen && <span className="shrink-0 text-caption text-accent-text">Novità</span>}
        </span>
        <span className="flex flex-wrap items-center gap-x-3">
          <Led state={bugStatusLed(bug.status)} label={BUG_STATUS_LABELS[bug.status]} />
          <span className="text-caption text-ink-muted">{formatRelative(bug.createdAt)}</span>
        </span>
      </button>
      {bug.publicMessage && <p className="mt-1 whitespace-pre-wrap break-words text-body-sm">{bug.publicMessage}</p>}
      {open && <Detail summary={bug} />}
    </li>
  );
}

export function MyReports() {
  const list = useVisitorBugList();
  return (
    <section className="min-w-0 space-y-2">
      <h2 className="text-label text-ink-muted">Le mie segnalazioni</h2>
      {list.isError && !list.data ? (
        <p className="text-body-sm text-danger">Impossibile caricare le segnalazioni: {apiErrorMessage(list.error)}</p>
      ) : !list.data ? (
        <Skeleton className="h-12 w-full" />
      ) : list.data.length === 0 ? (
        <Led state="idle" label="Nessuna segnalazione inviata" />
      ) : (
        <ul className="space-y-2">
          {list.data.map((b) => (
            <ReportItem key={b.id} bug={b} />
          ))}
        </ul>
      )}
    </section>
  );
}
