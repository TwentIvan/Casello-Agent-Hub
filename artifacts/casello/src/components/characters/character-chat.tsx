import { useEffect, useId, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Send } from "lucide-react";
import { ModelPicker } from "@/components/ai/model-picker";
import { Led } from "@/components/brand/led";
import { AlfredMark, LuciusMark } from "@/components/brand/marks";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatCost } from "@/lib/format";
import { cn } from "@/lib/utils";
import { MAX_CHARS, targetKey, useCharacterAdapter, type ChatTarget, type ProposalLike } from "./adapters";
import { handoffTarget, pageFromPath, useHandoff } from "./handoff-context";
import { ChatMessages } from "./chat-messages";
import { ChatToolbar } from "./chat-toolbar";

interface CharacterChatProps {
  target: ChatTarget;
  /** Testo iniziale del campo (passaggio di consegne): si scrive, non si invia. */
  draft?: string;
  /** Modifiche non salvate nella pagina: prima di accettare una scheda compare l'avviso. */
  hasUnsavedChanges?: () => boolean;
  layout?: "sheet" | "page";
}

// Errori che rendono la conversazione di sola lettura (oltre a quanto dice già il dettaglio)
const LOCK_MESSAGES: Record<string, string> = {
  "conversazione archiviata": "Conversazione archiviata: si può solo leggere.",
  "argomento eliminato": "L'argomento è stato eliminato: la conversazione si può solo leggere.",
  "squadra chiusa": "Squadra chiusa: la conversazione si può solo leggere.",
};

// Le schede che non toccano la pagina sotto il pannello non chiedono dell'editor
const NO_PAGE_EFFECT = new Set(["decision", "handoff"]);

/** Pannello comune delle conversazioni con Alfred e Lucius, su qualunque backend (vedi `adapters.ts`). */
export function CharacterChat(props: CharacterChatProps) {
  return <CharacterChatInner key={targetKey(props.target)} {...props} />;
}

function CharacterChatInner({ target, draft, hasUnsavedChanges, layout = "sheet" }: CharacterChatProps) {
  const adapter = useCharacterAdapter(target);
  const list = adapter.useConversations();
  const { toast } = useToast();
  const handoff = useHandoff();
  const [location] = useLocation();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const effectiveId = list ? (selectedId ?? list.items[0]?.id ?? null) : null;
  const conv = adapter.useConversation(effectiveId);
  const data = conv.data;

  const [text, setText] = useState(draft ?? "");
  useEffect(() => {
    if (draft !== undefined) setText(draft);
  }, [draft]);
  const [busy, setBusy] = useState<null | "send" | "create" | "delete" | "restart" | "model">(null);
  const [decidingId, setDecidingId] = useState<number | null>(null);
  const [lock, setLock] = useState<{ id: number; reason: string } | null>(null);
  const [confirmAccept, setConfirmAccept] = useState<ProposalLike | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const modelFieldId = useId();

  const running = data?.turnStatus === "running";
  const readOnlyReason =
    data?.readOnlyReason ?? (lock && data && lock.id === data.id ? lock.reason : null) ?? adapter.closedReason ?? null;
  const readOnly = readOnlyReason !== null;
  const name = adapter.character === "alfred" ? "Alfred" : "Lucius";
  const Mark = adapter.character === "alfred" ? AlfredMark : LuciusMark;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [data?.messages.length, data?.proposals.length, running]);

  const fail = (title: string, error: unknown) => {
    const message = apiErrorMessage(error);
    toast({ variant: "destructive", title, description: message });
    const reason = LOCK_MESSAGES[message];
    if (reason && data) setLock({ id: data.id, reason });
  };

  const run = async (kind: NonNullable<typeof busy>, title: string, action: () => Promise<void>) => {
    setBusy(kind);
    try {
      await action();
    } catch (error) {
      fail(title, error);
    } finally {
      setBusy(null);
    }
  };

  // Dopo un invio, finché la conversazione non torna riletta con il messaggio (o con il turno in corso), l'invio resta
  // bloccato: tra la risposta 202 e la lettura successiva `turnStatus` è ancora `idle`. Rete di sicurezza: 10 s.
  const [awaitingRead, setAwaitingRead] = useState<{ messages: number } | null>(null);
  const messageCount = data?.messages.length ?? 0;
  useEffect(() => {
    if (awaitingRead && (running || messageCount > awaitingRead.messages)) setAwaitingRead(null);
  }, [awaitingRead, running, messageCount]);
  useEffect(() => {
    if (!awaitingRead) return;
    const timer = setTimeout(() => setAwaitingRead(null), 10_000);
    return () => clearTimeout(timer);
  }, [awaitingRead]);

  // Con un elenco, la conversazione è quella selezionata anche se il dettaglio non è ancora arrivato (passaggio di
  // consegne con la domanda già scritta): se ne crea una nuova solo quando l'elenco è vuoto
  const sendTargetId = list ? effectiveId : (data?.id ?? null);
  const trimmed = text.trim();
  const canSend =
    !readOnly &&
    !running &&
    busy === null &&
    awaitingRead === null &&
    !(list?.isLoading ?? false) &&
    trimmed.length > 0 &&
    text.length <= MAX_CHARS &&
    (sendTargetId !== null || list !== null);
  const submit = () => {
    if (!canSend) return;
    void run("send", "Messaggio non inviato", async () => {
      let id = sendTargetId;
      // Senza conversazioni la prima si crea con il primo messaggio (modello del personaggio)
      if (id === null) {
        id = await adapter.create(null);
        setSelectedId(id);
      }
      const before = id === data?.id ? data.messages.length : 0;
      await adapter.send(id, trimmed);
      setAwaitingRead({ messages: before });
      setText("");
    });
  };

  const doDecide = async (p: ProposalLike, decision: "accept" | "reject") => {
    setDecidingId(p.id);
    try {
      await adapter.decide(p.id, decision);
      const n = p.payload?.number;
      const approve = p.payload?.decision === "approva";
      const title =
        p.kind === "decision"
          ? decision === "accept"
            ? `Voce #${typeof n === "number" ? n : "?"} ${approve ? "approvata" : "rifiutata"}`
            : "Scheda scartata"
          : decision === "accept"
            ? "Scheda accettata"
            : "Scheda rifiutata";
      toast({ title });
    } catch (error) {
      // 409: scheda superata o voce cambiata; l'adattatore rilegge lo stato vero
      fail("Operazione non riuscita", error);
    } finally {
      setDecidingId(null);
    }
  };
  const requestDecide = (p: ProposalLike, decision: "accept" | "reject") => {
    if (decision === "accept" && !NO_PAGE_EFFECT.has(p.kind) && hasUnsavedChanges?.()) setConfirmAccept(p);
    else void doDecide(p, decision);
  };

  const openHandoff = async (p: ProposalLike) => {
    const next = handoffTarget(p.payload, pageFromPath(location));
    if (!next) {
      toast({ variant: "destructive", title: "Operazione non riuscita", description: "scheda non valida" });
      return;
    }
    if (p.status === "pending") {
      setDecidingId(p.id);
      try {
        await adapter.decide(p.id, "accept");
      } catch (error) {
        fail("Operazione non riuscita", error);
        return;
      } finally {
        setDecidingId(null);
      }
    }
    handoff.open(next.target, next.draft);
  };

  const cost = data ? formatCost(data.costUsd, data.tokensUsed) : null;
  const sheet = layout === "sheet";

  return (
    <div className={cn("min-w-0", sheet ? "flex h-full min-h-0 flex-col" : "space-y-3")}>
      <div className={cn("flex items-start gap-3", sheet && "border-b p-4 pr-12")}>
        <Mark size={18} className="mt-1" />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-base font-medium">{name}</p>
          <p className="truncate text-sm text-ink-muted" title={adapter.subjectLabel}>
            {adapter.subjectLabel}
          </p>
        </div>
        <Led
          state={running ? "work" : "idle"}
          label={running ? "Sta rispondendo" : readOnly ? "Sola lettura" : "Pronto"}
          className="mt-1 shrink-0"
        />
      </div>

      <div className={cn("min-w-0 space-y-3", sheet && "flex min-h-0 flex-1 flex-col p-4")}>
        <ChatToolbar
          conversations={list?.items ?? null}
          selectedId={effectiveId}
          onSelect={setSelectedId}
          disabled={busy !== null}
          running={running}
          canCreate={!adapter.closedReason}
          canDelete={!!adapter.remove && !!data && !adapter.closedReason}
          canRestart={!!adapter.restart}
          onCreate={() =>
            void run("create", "Conversazione non creata", async () => {
              setSelectedId(await adapter.create(null));
            })
          }
          onDelete={() => setConfirmDelete(true)}
          onRestart={() => setConfirmRestart(true)}
        />

        {data && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <div className="min-w-0 flex-1 basis-48">
              <Label htmlFor={modelFieldId} className="sr-only">
                Modello
              </Label>
              <ModelPicker
                id={modelFieldId}
                value={data.aiModelId}
                onChange={(id) => {
                  const setModel = adapter.setModel;
                  if (id !== null && setModel) void run("model", "Modello non cambiato", () => setModel(data.id, id));
                }}
                disabled={!adapter.setModel || readOnly || running || busy !== null}
              />
            </div>
            <span className="font-mono text-xs tabular-nums text-ink-muted">
              {data.tokensUsed.toLocaleString("it-IT")} token{cost ? ` · ${cost}` : ""}
            </span>
          </div>
        )}

        {data?.notice}

        <div
          className={cn(
            "min-w-0 space-y-3 overflow-y-auto rounded-md border p-3",
            sheet ? "min-h-0 flex-1" : "max-h-[32rem]",
          )}
        >
          {conv.error !== undefined ? (
            <p className="text-sm text-destructive">Impossibile caricare la conversazione: {apiErrorMessage(conv.error)}</p>
          ) : list?.error !== undefined ? (
            <p className="text-sm text-destructive">Impossibile caricare le conversazioni: {apiErrorMessage(list.error)}</p>
          ) : conv.isLoading || list?.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !data || data.messages.length === 0 ? (
            <p className="text-sm text-ink-muted">{adapter.emptyHint}</p>
          ) : null}
          {data && (
            <ChatMessages
              data={data}
              character={adapter.character}
              readOnly={readOnly}
              deciding={decidingId !== null}
              renderProposal={adapter.renderProposal}
              onDecide={requestDecide}
              onHandoff={(p) => void openHandoff(p)}
            />
          )}
          {running && (
            <p className="text-sm text-ink-muted" aria-live="polite">
              <Led state="work" label={`${name} sta pensando…`} />
            </p>
          )}
          <div ref={bottomRef} />
        </div>

        {readOnly ? (
          <p className="text-sm text-ink-muted">{readOnlyReason}</p>
        ) : (
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
              placeholder={adapter.character === "alfred" ? "Scrivi ad Alfred…" : "Scrivi a Lucius…"}
              aria-label={`Messaggio per ${name}`}
              disabled={running || busy === "send"}
            />
            <div className="flex items-center justify-between gap-2">
              <span className={cn("font-mono text-xs tabular-nums text-ink-muted", text.length > MAX_CHARS && "text-destructive")}>
                {text.length.toLocaleString("it-IT")} / {MAX_CHARS.toLocaleString("it-IT")}
              </span>
              <Button type="submit" size="sm" disabled={!canSend}>
                <Send />
                {busy === "send" ? "Invio…" : adapter.character === "alfred" ? "Scrivi ad Alfred" : "Scrivi a Lucius"}
              </Button>
            </div>
          </form>
        )}
      </div>

      <ConfirmDialog
        open={confirmAccept !== null}
        onOpenChange={(open) => !open && setConfirmAccept(null)}
        title="Accettare la scheda?"
        description="Hai modifiche non salvate in questa pagina: accettando la scheda andranno perse."
        confirmLabel="Accetta comunque"
        pendingLabel="Accettazione…"
        pending={decidingId !== null}
        onConfirm={() => {
          const p = confirmAccept;
          setConfirmAccept(null);
          if (p) void doDecide(p, "accept");
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Eliminare la conversazione?"
        description={adapter.deleteNote ?? "I messaggi e le schede non decise vanno persi."}
        pending={busy === "delete"}
        onConfirm={() => {
          const remove = adapter.remove;
          if (!data || !remove) return;
          void run("delete", "Eliminazione non riuscita", async () => {
            await remove(data.id);
            setConfirmDelete(false);
            setSelectedId(null);
            toast({ title: "Conversazione eliminata" });
          });
        }}
      />

      <ConfirmDialog
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        title="Ricominciare il filo di Alfred?"
        description="Il filo attuale si archivia e se ne apre uno nuovo; le schede non decise non si potranno più decidere da qui."
        confirmLabel="Ricomincia"
        pendingLabel="Avvio…"
        pending={busy === "restart"}
        onConfirm={() => {
          const restart = adapter.restart;
          if (!restart) return;
          void run("restart", "Filo non ricominciato", async () => {
            await restart();
            setConfirmRestart(false);
            setLock(null);
            toast({ title: "Filo di Alfred ricominciato" });
          });
        }}
      />
    </div>
  );
}
