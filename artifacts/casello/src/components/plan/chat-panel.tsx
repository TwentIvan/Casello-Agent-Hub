import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Send, Trash2 } from "lucide-react";
import {
  getGetPlanConversationQueryKey,
  getListPlanConversationsQueryKey,
  useDeletePlanConversation,
  useGetAppPlan,
  useGetPlanConversation,
  useSendPlanMessage,
  useUpdatePlanConversation,
  getGetAppPlanQueryKey,
} from "@workspace/api-client-react";
import { ModelPicker } from "@/components/ai/model-picker";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/plan/markdown";
import { ProposalCard } from "@/components/plan/proposal-card";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatCost } from "@/lib/format";
import { cn } from "@/lib/utils";

const POLL_MS = 1500;
const MAX_CHARS = 8000;

interface ChatPanelProps {
  conversationId: number;
  appId: number;
  /** Chiamato dopo l'eliminazione, perché la pagina deselezioni la conversazione. */
  onDeleted?: () => void;
}

/** Chat con il bot del piano: messaggi, proposte da accettare e invio; il turno gira in background (polling). */
export function ChatPanel({ conversationId, appId, onDeleted }: ChatPanelProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const conversation = useGetPlanConversation(conversationId, {
    query: {
      queryKey: getGetPlanConversationQueryKey(conversationId),
      // Il turno gira in background: si rilegge finché è in corso (riprende anche dopo un ricaricamento)
      refetchInterval: (query) => (query.state.data?.turnStatus === "running" ? POLL_MS : false),
    },
  });
  const plan = useGetAppPlan(appId, { query: { queryKey: getGetAppPlanQueryKey(appId) } });

  const data = conversation.data;
  const running = data?.turnStatus === "running";

  // A fine turno cambiano costi, titolo e (con le proposte) il contesto: si rileggono elenco e piano
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      void queryClient.invalidateQueries({ queryKey: getListPlanConversationsQueryKey(appId) });
      void queryClient.invalidateQueries({ queryKey: getGetAppPlanQueryKey(appId) });
    }
    wasRunning.current = running;
  }, [running, queryClient, appId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [data?.messages.length, data?.proposals.length, running]);

  const send = useSendPlanMessage({
    mutation: {
      onSuccess: () => {
        setText("");
        void queryClient.invalidateQueries({ queryKey: getGetPlanConversationQueryKey(conversationId) });
      },
      onError: (error) => {
        toast({ variant: "destructive", title: "Messaggio non inviato", description: apiErrorMessage(error) });
        // 409: il turno è già in corso o il modello non c'è più, la conversazione si rilegge
        void queryClient.invalidateQueries({ queryKey: getGetPlanConversationQueryKey(conversationId) });
      },
    },
  });

  const changeModel = useUpdatePlanConversation({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetPlanConversationQueryKey(conversationId) });
        void queryClient.invalidateQueries({ queryKey: getListPlanConversationsQueryKey(appId) });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Modello non cambiato", description: apiErrorMessage(error) }),
    },
  });

  const remove = useDeletePlanConversation({
    mutation: {
      onSuccess: () => {
        setConfirmDelete(false);
        void queryClient.invalidateQueries({ queryKey: getListPlanConversationsQueryKey(appId) });
        onDeleted?.();
        toast({ title: "Conversazione eliminata", description: "Le voci accettate restano nel piano." });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Eliminazione non riuscita", description: apiErrorMessage(error) }),
    },
  });

  if (conversation.isError) {
    return <p className="text-sm text-destructive">Impossibile caricare la conversazione: {apiErrorMessage(conversation.error)}</p>;
  }
  if (!data) return <Skeleton className="h-64 w-full" />;

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && text.length <= MAX_CHARS && !running && !send.isPending;
  const submit = () => {
    if (canSend) send.mutate({ id: conversationId, data: { content: trimmed } });
  };
  const items = plan.data?.items ?? [];
  const cost = formatCost(data.costUsd, data.tokensUsed);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium">{data.title}</h3>
          <p className="text-xs text-muted-foreground tabular-nums">
            {data.tokensUsed.toLocaleString("it-IT")} token{cost ? ` · ${cost}` : ""}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)} disabled={running}>
          <Trash2 />
          Elimina
        </Button>
      </div>
      <div className="max-w-xs space-y-1">
        <p className="text-xs text-muted-foreground">Modello</p>
        <ModelPicker
          value={data.aiModelId}
          onChange={(id) => id !== null && changeModel.mutate({ id: conversationId, data: { aiModelId: id } })}
          disabled={running || changeModel.isPending}
        />
      </div>

      {data.newerAnalysisId !== null && (
        <Alert>
          <AlertTitle>C'è un piano più recente</AlertTitle>
          <AlertDescription>
            Questa conversazione è basata su un'analisi precedente.{" "}
            <Link href={`/analyses/${data.newerAnalysisId}`} className="font-medium underline underline-offset-2">
              Apri l'analisi #{data.newerAnalysisId}
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}

      <div className="max-h-[32rem] space-y-3 overflow-y-auto rounded-md border p-3">
        {data.messages.length === 0 && (
          <p className="text-sm text-muted-foreground">Scrivi al bot per chiedere integrazioni, correzioni o nuove idee per il piano.</p>
        )}
        {data.messages.map((m) => {
          const proposals = data.proposals.filter((p) => p.messageId === m.id);
          return (
            <div key={m.id} className={cn("space-y-2", m.role === "user" && "flex flex-col items-end")}>
              <div
                className={cn(
                  "max-w-[90%] rounded-lg px-3 py-2",
                  m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted",
                  m.error && "border border-destructive bg-destructive/10 text-destructive",
                )}
              >
                {m.role === "user" ? (
                  <p className="text-sm break-words whitespace-pre-wrap">{m.content}</p>
                ) : (
                  <Markdown>{m.content}</Markdown>
                )}
              </div>
              {proposals.length > 0 && (
                <div className="w-full space-y-2">
                  {proposals.map((p) => (
                    <ProposalCard
                      key={p.id}
                      proposal={p}
                      appId={appId}
                      currentItem={p.targetItemId !== null ? items.find((i) => i.id === p.targetItemId) : undefined}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {running && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <Spinner className="size-4" />
            sta pensando…
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
          placeholder="Chiedi un'integrazione al piano…"
          aria-label="Messaggio"
          disabled={running}
        />
        <div className="flex items-center justify-between gap-2">
          <span className={cn("text-xs tabular-nums text-muted-foreground", text.length > MAX_CHARS && "text-destructive")}>
            {text.length.toLocaleString("it-IT")} / {MAX_CHARS.toLocaleString("it-IT")}
          </span>
          <Button type="submit" size="sm" disabled={!canSend}>
            <Send />
            {send.isPending ? "Invio…" : "Invia"}
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Eliminare la conversazione?"
        description="I messaggi e le proposte non decise vanno persi; le voci già accettate restano nel piano."
        pending={remove.isPending}
        onConfirm={() => remove.mutate({ id: conversationId })}
      />
    </div>
  );
}
