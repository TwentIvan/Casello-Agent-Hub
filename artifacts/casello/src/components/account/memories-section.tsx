import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  type MemoryCharacter,
  type MemoryHistoryEntry,
  type MemoryNote,
  getListMemoryHistoryQueryKey,
  getListMemoryNotesQueryKey,
  useCreateMemoryNote,
  useDeleteMemoryHistoryEntry,
  useDeleteMemoryNote,
  useListMemoryHistory,
  useListMemoryNotes,
  useUpdateMemoryNote,
} from "@workspace/api-client-react";
import { AlfredMark, LuciusMark } from "@/components/brand/marks";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { cn } from "@/lib/utils";

const MAX_NOTES = 50;
const MAX_NOTE_CHARS = 300;

const KIND_LABELS: Record<MemoryHistoryEntry["kind"], string> = {
  alfred_session: "Conversazione con Alfred",
  plan_conversation: "Chat del piano",
  team_chat: "Chat di squadra",
};

function formatDate(value: string): string {
  return new Date(value).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
}

/** Memorie di Alfred e Lucius: appunti stabili (modifica, elimina, aggiungi) e storico dei riassunti. */
export function MemoriesSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Memorie</CardTitle>
        <CardDescription>
          Alfred e Lucius ricordano ciò che serve: appunti brevi e i riassunti delle conversazioni. Ognuno vede solo la propria
          memoria. Qui puoi correggerla o toglierla.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="alfred">
          <TabsList>
            <TabsTrigger value="alfred" className="gap-2">
              <AlfredMark size={12} />
              Alfred
            </TabsTrigger>
            <TabsTrigger value="lucius" className="gap-2">
              <LuciusMark size={12} />
              Lucius
            </TabsTrigger>
          </TabsList>
          <TabsContent value="alfred" className="space-y-6">
            <CharacterMemory character="alfred" />
          </TabsContent>
          <TabsContent value="lucius" className="space-y-6">
            <CharacterMemory character="lucius" />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function CharacterMemory({ character }: { character: MemoryCharacter }) {
  return (
    <>
      <Notes character={character} />
      <History character={character} />
    </>
  );
}

function Notes({ character }: { character: MemoryCharacter }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const params = { character };
  const notes = useListMemoryNotes(params, { query: { queryKey: getListMemoryNotesQueryKey(params) } });
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [removing, setRemoving] = useState<MemoryNote | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: getListMemoryNotesQueryKey(params) });
  const fail = (title: string) => (error: unknown) =>
    toast({ variant: "destructive", title, description: apiErrorMessage(error) });

  const create = useCreateMemoryNote({
    mutation: {
      onSuccess: () => {
        setAdding("");
        refresh();
      },
      onError: fail("Appunto non salvato"),
    },
  });
  const update = useUpdateMemoryNote({
    mutation: {
      onSuccess: () => {
        setEditing(null);
        refresh();
      },
      onError: fail("Appunto non salvato"),
    },
  });
  const remove = useDeleteMemoryNote({
    mutation: {
      onSuccess: () => {
        setRemoving(null);
        refresh();
      },
      onError: fail("Appunto non eliminato"),
    },
  });

  const count = notes.data?.length ?? 0;
  const full = count >= MAX_NOTES;
  const addText = adding.trim();

  return (
    <section className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-label">Appunti</h4>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {count} di {MAX_NOTES}
        </span>
      </div>

      {notes.isError ? (
        <p className="text-sm text-destructive">Impossibile caricare gli appunti: {apiErrorMessage(notes.error)}</p>
      ) : !notes.data ? (
        <Skeleton className="h-16 w-full" />
      ) : notes.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nessun appunto.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {notes.data.map((n) => (
            <li key={n.id} className="min-w-0 p-3">
              {editing?.id === n.id ? (
                <div className="space-y-2">
                  <Textarea
                    value={editing.text}
                    onChange={(e) => setEditing({ id: n.id, text: e.target.value })}
                    rows={2}
                    maxLength={MAX_NOTE_CHARS}
                    aria-label="Testo dell'appunto"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {editing.text.length} / {MAX_NOTE_CHARS}
                    </span>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(null)} disabled={update.isPending}>
                        <X />
                        Annulla
                      </Button>
                      <Button
                        size="sm"
                        disabled={editing.text.trim() === "" || update.isPending}
                        onClick={() => update.mutate({ id: n.id, params, data: { content: editing.text.trim() } })}
                      >
                        <Check />
                        Salva appunto
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="whitespace-pre-wrap break-words text-sm">{n.content}</p>
                    {n.ref && <p className="break-words font-mono text-xs text-muted-foreground">{n.ref}</p>}
                    <p className="font-mono text-xs tabular-nums text-muted-foreground">{formatDate(n.updatedAt)}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Modifica l'appunto"
                      onClick={() => setEditing({ id: n.id, text: n.content })}
                    >
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label="Elimina l'appunto" onClick={() => setRemoving(n)}>
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (addText && !full) create.mutate({ data: { character, content: addText } });
        }}
      >
        <Textarea
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          rows={2}
          maxLength={MAX_NOTE_CHARS}
          placeholder={full ? "Memoria piena: elimina un appunto per aggiungerne altri" : "Un fatto o una preferenza da ricordare"}
          aria-label="Nuovo appunto"
          disabled={full}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={cn("font-mono text-xs tabular-nums text-muted-foreground")}>
            {adding.length} / {MAX_NOTE_CHARS}
          </span>
          <Button type="submit" size="sm" variant="outline" disabled={!addText || full || create.isPending}>
            <Plus />
            {create.isPending ? "Salvataggio…" : "Aggiungi appunto"}
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Eliminare l'appunto?"
        description={removing?.content ?? ""}
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate({ id: removing.id, params })}
      />
    </section>
  );
}

function History({ character }: { character: MemoryCharacter }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const q = search.trim();
  const params = q ? { character, q } : { character };
  const history = useListMemoryHistory(params, { query: { queryKey: getListMemoryHistoryQueryKey(params) } });
  const [removing, setRemoving] = useState<MemoryHistoryEntry | null>(null);

  const remove = useDeleteMemoryHistoryEntry({
    mutation: {
      onSuccess: () => {
        setRemoving(null);
        void queryClient.invalidateQueries({ queryKey: getListMemoryHistoryQueryKey({ character }) });
        void queryClient.invalidateQueries({ queryKey: getListMemoryHistoryQueryKey(params) });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Voce non eliminata", description: apiErrorMessage(error) }),
    },
  });

  return (
    <section className="min-w-0 space-y-3">
      <h4 className="text-label">Storico</h4>
      <Input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        maxLength={200}
        placeholder="Cerca nei riassunti"
        aria-label="Cerca nello storico"
        className="max-w-sm"
      />
      {history.isError ? (
        <p className="text-sm text-destructive">Impossibile caricare lo storico: {apiErrorMessage(history.error)}</p>
      ) : !history.data ? (
        <Skeleton className="h-16 w-full" />
      ) : history.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{q ? "Nessun risultato." : "Nessun riassunto: arrivano a conversazione finita."}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {history.data.map((h) => (
            <li key={h.id} className="flex min-w-0 flex-wrap items-start justify-between gap-2 p-3">
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="break-words text-sm font-medium">{h.title}</p>
                <p className="font-mono text-xs tabular-nums text-muted-foreground">
                  {KIND_LABELS[h.kind]} · {formatDate(h.createdAt)}
                </p>
                <p className="whitespace-pre-wrap break-words text-sm text-ink-muted">{h.summary}</p>
              </div>
              <Button variant="ghost" size="icon" aria-label={`Elimina «${h.title}» dallo storico`} onClick={() => setRemoving(h)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Eliminare la voce dello storico?"
        description={removing?.title ?? ""}
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate({ id: removing.id, params: { character } })}
      />
    </section>
  );
}
