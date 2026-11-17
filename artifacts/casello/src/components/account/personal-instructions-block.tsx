import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  getGetCharacterInstructionsQueryKey,
  getListCharacterInstructionVersionsQueryKey,
  useGetCharacterInstructionVersion,
  useGetCharacterInstructions,
  useListCharacterInstructionVersions,
  useRestoreCharacterInstructions,
  useUpdateCharacterInstructions,
} from "@workspace/api-client-react";
import { Markdown } from "@/components/plan/markdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { lineDiff } from "@/lib/architecture";
import { INSTRUCTIONS_MAX_CHARS, instructionsCounter } from "@/lib/instructions-text";

type Character = "alfred" | "lucius";

const SOURCE_LABELS: Record<string, string> = {
  manual: "scritta a mano",
  proposal: "da una proposta",
  restore: "ripristino",
};

const formatDate = (iso: string) =>
  new Date(iso).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });

/** Istruzioni personali di un personaggio: testo, anteprima, versioni e ripristino. */
export function PersonalInstructionsBlock({ character }: { character: Character }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const name = character === "alfred" ? "Alfred" : "Lucius";
  const key = getGetCharacterInstructionsQueryKey(character);
  const current = useGetCharacterInstructions(character, { query: { queryKey: key } });
  // undefined: nessuna modifica, vale il testo salvato
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState(false);
  const [stale, setStale] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);

  const data = current.data;
  const text = draft ?? data?.content ?? "";
  const counter = instructionsCounter(text);
  const dirty = data !== undefined && text.trimEnd() !== data.content.trimEnd();

  const onSaved = (result: { content: string; version: number }) => {
    queryClient.setQueryData(key, result);
    void queryClient.invalidateQueries({ queryKey: getListCharacterInstructionVersionsQueryKey(character) });
    setDraft(undefined);
    setStale(false);
  };
  const onError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 409) {
      setStale(true);
      // Chiude «Versioni»: l'avviso con «Ricarica» sta nel blocco, dietro il dialogo
      setVersionsOpen(false);
    }
    else toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) });
  };

  const save = useUpdateCharacterInstructions({
    mutation: {
      onSuccess: (result) => {
        onSaved(result);
        toast({ title: `Istruzioni di ${name} salvate` });
      },
      onError,
    },
  });
  const restore = useRestoreCharacterInstructions({
    mutation: {
      onSuccess: (result) => {
        onSaved(result);
        setVersionsOpen(false);
        toast({ title: `Versione ripristinata come versione ${result.version}` });
      },
      onError,
    },
  });

  const reload = async () => {
    await queryClient.refetchQueries({ queryKey: key });
    setDraft(undefined);
    setStale(false);
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-label">Istruzioni personali</h3>
        <p className="text-sm text-muted-foreground">
          Si aggiungono alle istruzioni di base: non possono annullarne le regole
        </p>
      </div>
      {current.isError ? (
        <p className="text-sm text-destructive">Impossibile caricare le istruzioni: {apiErrorMessage(current.error)}</p>
      ) : !data ? (
        <Skeleton className="h-32 w-full max-w-2xl" />
      ) : (
        <div className="max-w-2xl space-y-3">
          <Label htmlFor={`${character}-instructions`} className="sr-only">
            Istruzioni personali di {name}
          </Label>
          {preview ? (
            <div className="min-h-32 rounded-md border border-border bg-surface-1 p-3">
              {text.trim() ? <Markdown>{text}</Markdown> : <p className="text-sm text-ink-muted">Nessuna istruzione.</p>}
            </div>
          ) : (
            <Textarea
              id={`${character}-instructions`}
              rows={8}
              value={text}
              disabled={save.isPending}
              onChange={(e) => setDraft(e.target.value)}
            />
          )}
          <p className={"text-sm " + (counter.over ? "text-danger" : "text-ink-muted")}>
            {counter.length} / {INSTRUCTIONS_MAX_CHARS} caratteri
          </p>
          {stale && (
            <div className="flex flex-wrap items-center gap-3 text-sm text-danger" role="alert">
              <span>Le istruzioni sono cambiate: ricarica</span>
              <Button variant="outline" size="sm" onClick={() => void reload()}>
                Ricarica
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={!dirty || counter.over || save.isPending || stale}
              onClick={() => save.mutate({ character, data: { content: text.trimEnd(), baseVersion: data.version } })}
            >
              {save.isPending ? "Salvataggio…" : "Salva"}
            </Button>
            <Button variant="outline" onClick={() => setPreview((p) => !p)}>
              {preview ? "Modifica" : "Anteprima"}
            </Button>
            <Button variant="ghost" onClick={() => setVersionsOpen(true)}>
              Versioni
            </Button>
            <span className="text-sm text-ink-muted">
              {data.version === 0 || !data.updatedAt
                ? "Nessuna versione"
                : `Versione ${data.version} · ${formatDate(data.updatedAt)}`}
            </span>
          </div>
        </div>
      )}
      {versionsOpen && data && (
        <VersionsDialog
          character={character}
          name={name}
          currentVersion={data.version}
          currentContent={data.content}
          restoring={restore.isPending}
          onRestore={(version) => restore.mutate({ character, data: { version, baseVersion: data.version } })}
          onClose={() => setVersionsOpen(false)}
        />
      )}
    </div>
  );
}

function VersionsDialog({
  character,
  name,
  currentVersion,
  currentContent,
  restoring,
  onRestore,
  onClose,
}: {
  character: Character;
  name: string;
  currentVersion: number;
  currentContent: string;
  restoring: boolean;
  onRestore: (version: number) => void;
  onClose: () => void;
}) {
  const list = useListCharacterInstructionVersions(character, {
    query: { queryKey: getListCharacterInstructionVersionsQueryKey(character) },
  });
  const versions = list.data ?? [];
  const [opened, setOpened] = useState<number | null>(null);
  const detail = useGetCharacterInstructionVersion(character, opened ?? 0, {
    query: { queryKey: ["character-instruction-version", character, opened], enabled: opened !== null },
  });
  const diff = useMemo(
    () => (detail.data ? lineDiff(detail.data.content, currentContent) : null),
    [detail.data, currentContent],
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Versioni delle istruzioni di {name}</DialogTitle>
          <DialogDescription>Apri una versione per confrontarla con quella attuale, riga per riga.</DialogDescription>
        </DialogHeader>
        {list.isLoading && <p className="text-sm text-ink-muted">Caricamento…</p>}
        {list.isError && <p className="text-sm text-danger">{apiErrorMessage(list.error)}</p>}
        {!list.isLoading && versions.length === 0 && <p className="text-sm text-ink-muted">Nessuna versione salvata.</p>}
        <ul className="min-w-0 space-y-1">
          {versions.map((v) => (
            <li key={v.version} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono">v{v.version}</span>
              <span className="text-ink-muted">
                {formatDate(v.createdAt)} · {SOURCE_LABELS[v.source] ?? v.source} · {v.length} caratteri
              </span>
              {v.version === currentVersion && <span className="text-ink-muted">(attuale)</span>}
              <Button variant="ghost" size="sm" onClick={() => setOpened(opened === v.version ? null : v.version)}>
                {opened === v.version ? "Chiudi" : "Apri"}
              </Button>
            </li>
          ))}
        </ul>
        {opened !== null && detail.isLoading && <p className="text-sm text-ink-muted">Caricamento…</p>}
        {opened !== null && detail.isError && <p className="text-sm text-danger">{apiErrorMessage(detail.error)}</p>}
        {diff && (
          <div className="min-w-0 space-y-3">
            <div className="min-w-0 rounded-md border border-border bg-surface-1 p-2 font-mono text-xs">
              {diff.length === 0 && <span className="text-ink-muted">Testo vuoto</span>}
              {diff.map((line, index) => (
                <div
                  key={index}
                  className={
                    "whitespace-pre-wrap [overflow-wrap:anywhere] " +
                    (line.kind === "added" ? "text-success" : line.kind === "removed" ? "text-danger" : "text-ink-muted")
                  }
                >
                  {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
                  {line.text}
                </div>
              ))}
            </div>
            <p className="text-xs text-ink-muted">Le righe con «-» sono della versione aperta, quelle con «+» dell'attuale.</p>
            {opened !== currentVersion && (
              <Button disabled={restoring} onClick={() => onRestore(opened!)}>
                {restoring ? "Ripristino…" : `Ripristina la versione ${opened}`}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
