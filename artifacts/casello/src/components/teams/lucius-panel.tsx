import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Send, Trash2 } from "lucide-react";
import {
  getGetTeamChatConversationQueryKey,
  getGetTeamInstanceQueryKey,
  getListTeamChatConversationsQueryKey,
  useCreateTeamChatConversation,
  useDecideTeamChatProposal,
  useDeleteTeamChatConversation,
  useGetTeamChatConversation,
  useGetTeamInstance,
  useListTeamChatConversations,
  useSendTeamChatMessage,
} from "@workspace/api-client-react";
import { useDefaultAiModelId } from "@/components/ai/ai-queries";
import { ModelPicker } from "@/components/ai/model-picker";
import { LuciusMark } from "@/components/brand/marks";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Markdown } from "@/components/plan/markdown";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatCost } from "@/lib/format";
import { cn } from "@/lib/utils";
import { RoleInstructionsCard } from "./role-instructions-card";

const POLL_MS = 1500;
const MAX_CHARS = 8000;

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
}

interface LuciusPanelProps {
  instanceId: number;
  /** Squadra chiusa: si leggono le conversazioni ma non si scrive né si decide. */
  closed: boolean;
}

/** Lucius sulla squadra: conversazioni sull'identità e sulle istruzioni dei ruoli, con schede da accettare. */
export function LuciusPanel({ instanceId, closed }: LuciusPanelProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [chosenModelId, setChosenModelId] = useState<number | null>(null);
  const defaultModelId = useDefaultAiModelId();
  const aiModelId = chosenModelId ?? defaultModelId;

  const conversations = useListTeamChatConversations(instanceId, {
    query: { queryKey: getListTeamChatConversationsQueryKey(instanceId) },
  });

  const create = useCreateTeamChatConversation({
    mutation: {
      onSuccess: (created) => {
        void queryClient.invalidateQueries({ queryKey: getListTeamChatConversationsQueryKey(instanceId) });
        setDialogOpen(false);
        setSelectedId(created.id);
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Conversazione non creata", description: apiErrorMessage(error) }),
    },
  });

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <LuciusMark size={18} />
          Lucius
        </CardTitle>
        {!closed && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setChosenModelId(null);
              setDialogOpen(true);
            }}
          >
            <Plus />
            Nuova conversazione
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Lucius discute con te l'identità e le istruzioni dei ruoli e le propone come schede: cambiano solo quelle che accetti.
        </p>
        {conversations.isError ? (
          <p className="text-sm text-destructive">Impossibile caricare le conversazioni: {apiErrorMessage(conversations.error)}</p>
        ) : !conversations.data ? (
          <Skeleton className="h-16 w-full" />
        ) : conversations.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {closed ? "Nessuna conversazione." : "Nessuna conversazione: aprine una per lavorare sui ruoli."}
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {conversations.data.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(c.id === selectedId ? null : c.id)}
                  aria-current={c.id === selectedId ? "true" : undefined}
                  className={cn("block w-full min-w-0 space-y-0.5 p-3 text-left text-sm hover:bg-muted/50", c.id === selectedId && "bg-muted")}
                >
                  <span className="block truncate font-medium">{c.title || "Nuova conversazione"}</span>
                  <span className="block font-mono text-xs tabular-nums text-muted-foreground">
                    {formatDateTime(c.updatedAt)}
                    {formatCost(c.costUsd, c.tokensUsed) ? ` · ${formatCost(c.costUsd, c.tokensUsed)}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {selectedId !== null && (
          <TeamChat
            key={selectedId}
            conversationId={selectedId}
            instanceId={instanceId}
            closed={closed}
            onDeleted={() => setSelectedId(null)}
          />
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nuova conversazione con Lucius</DialogTitle>
            <DialogDescription>Scegli il modello che risponderà: il costo dei suoi turni è a carico del tuo account.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="lucius-model">Modello</Label>
            <ModelPicker id="lucius-model" value={aiModelId} onChange={setChosenModelId} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={create.isPending}>
              Annulla
            </Button>
            <Button
              disabled={aiModelId === null || create.isPending}
              onClick={() => aiModelId !== null && create.mutate({ id: instanceId, data: { aiModelId } })}
            >
              {create.isPending ? "Creazione…" : "Crea"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function TeamChat({
  conversationId,
  instanceId,
  closed,
  onDeleted,
}: {
  conversationId: number;
  instanceId: number;
  closed: boolean;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const conversation = useGetTeamChatConversation(conversationId, {
    query: {
      queryKey: getGetTeamChatConversationQueryKey(conversationId),
      // Il turno gira in background: si rilegge finché è in corso
      refetchInterval: (query) => (query.state.data?.turnStatus === "running" ? POLL_MS : false),
    },
  });
  const team = useGetTeamInstance(instanceId, { query: { queryKey: getGetTeamInstanceQueryKey(instanceId) } });
  const roleNames = new Map((team.data?.roles ?? []).map((r) => [r.key, r.name]));

  const data = conversation.data;
  const running = data?.turnStatus === "running";

  const refetchAll = () => {
    void queryClient.invalidateQueries({ queryKey: getGetTeamChatConversationQueryKey(conversationId) });
    void queryClient.invalidateQueries({ queryKey: getListTeamChatConversationsQueryKey(instanceId) });
  };

  // A fine turno cambiano costi e titolo; con le schede accettate cambia anche la squadra
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      void queryClient.invalidateQueries({ queryKey: getListTeamChatConversationsQueryKey(instanceId) });
    }
    wasRunning.current = running;
  }, [running, queryClient, instanceId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [data?.messages.length, data?.proposals.length, running]);

  const send = useSendTeamChatMessage({
    mutation: {
      onSuccess: () => {
        setText("");
        void queryClient.invalidateQueries({ queryKey: getGetTeamChatConversationQueryKey(conversationId) });
      },
      onError: (error) => {
        toast({ variant: "destructive", title: "Messaggio non inviato", description: apiErrorMessage(error) });
        void queryClient.invalidateQueries({ queryKey: getGetTeamChatConversationQueryKey(conversationId) });
      },
    },
  });

  const decide = useDecideTeamChatProposal({
    mutation: {
      onSuccess: (_result, { data: body }) => {
        toast({ title: body.action === "accept" ? "Proposta accettata" : "Proposta rifiutata" });
        refetchAll();
        // Accettare cambia ruoli e skill della squadra
        void queryClient.invalidateQueries({ queryKey: getGetTeamInstanceQueryKey(instanceId) });
      },
      onError: (error) => {
        // 409: scheda superata o squadra cambiata; si rilegge per mostrare lo stato vero
        toast({ variant: "destructive", title: "Operazione non riuscita", description: apiErrorMessage(error) });
        refetchAll();
      },
    },
  });

  const remove = useDeleteTeamChatConversation({
    mutation: {
      onSuccess: () => {
        setConfirmDelete(false);
        void queryClient.invalidateQueries({ queryKey: getListTeamChatConversationsQueryKey(instanceId) });
        onDeleted();
        toast({ title: "Conversazione eliminata", description: "Le schede già accettate restano nella squadra." });
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
  const canSend = !closed && trimmed.length > 0 && text.length <= MAX_CHARS && !running && !send.isPending;
  const submit = () => {
    if (canSend) send.mutate({ id: conversationId, data: { content: trimmed } });
  };
  const cost = formatCost(data.costUsd, data.tokensUsed);

  return (
    <div className="min-w-0 space-y-3 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-medium">{data.title || "Nuova conversazione"}</h3>
          <p className="font-mono text-xs tabular-nums text-muted-foreground">
            {data.tokensUsed.toLocaleString("it-IT")} token{cost ? ` · ${cost}` : ""}
          </p>
        </div>
        {!closed && (
          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)} disabled={running}>
            <Trash2 />
            Elimina
          </Button>
        )}
      </div>

      <div className="max-h-[32rem] min-w-0 space-y-3 overflow-y-auto rounded-md border p-3">
        {data.messages.length === 0 && (
          <p className="text-sm text-muted-foreground">Scrivi a Lucius per chiedere un'identità o istruzioni migliori per un ruolo.</p>
        )}
        {data.messages.map((m) => {
          const proposals = data.proposals.filter((p) => p.messageId === m.id);
          const empty = m.role === "assistant" && m.content === "";
          if (empty && proposals.length === 0) return null;
          return (
            <div key={m.id} className={cn("space-y-2", m.role === "user" && "flex flex-col items-end")}>
              {!empty && (
                <div
                  className={cn(
                    "min-w-0 max-w-[90%] rounded-lg px-3 py-2",
                    m.role === "user" ? "bg-surface-2 text-ink" : "bg-muted",
                    m.error && "border border-destructive bg-destructive/10 text-destructive",
                  )}
                >
                  {m.role === "user" ? (
                    <p className="whitespace-pre-wrap break-words text-sm">{m.content}</p>
                  ) : (
                    <>
                      <p className="mb-1 flex items-center gap-2 text-label text-ink-muted">
                        <LuciusMark size={12} />
                        Lucius
                      </p>
                      <Markdown>{m.content}</Markdown>
                    </>
                  )}
                </div>
              )}
              {proposals.length > 0 && (
                <div className="w-full min-w-0 space-y-2">
                  {proposals.map((p) => (
                    <RoleInstructionsCard
                      key={p.id}
                      proposal={p}
                      roleName={roleNames.get(p.roleKey)}
                      deciding={decide.isPending || closed}
                      onDecide={(action) => decide.mutate({ id: p.id, data: { action } })}
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

      {!closed && (
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
            placeholder="Chiedi a Lucius di scrivere o rivedere un ruolo…"
            aria-label="Messaggio per Lucius"
            disabled={running}
          />
          <div className="flex items-center justify-between gap-2">
            <span className={cn("font-mono text-xs tabular-nums text-muted-foreground", text.length > MAX_CHARS && "text-destructive")}>
              {text.length.toLocaleString("it-IT")} / {MAX_CHARS.toLocaleString("it-IT")}
            </span>
            <Button type="submit" size="sm" disabled={!canSend}>
              <Send />
              {send.isPending ? "Invio…" : "Scrivi a Lucius"}
            </Button>
          </div>
        </form>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Eliminare la conversazione?"
        description="I messaggi e le schede non decise vanno persi; quelle già accettate restano nella squadra."
        pending={remove.isPending}
        onConfirm={() => remove.mutate({ id: conversationId })}
      />
    </div>
  );
}
