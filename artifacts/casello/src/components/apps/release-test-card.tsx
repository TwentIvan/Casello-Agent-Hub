import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type App,
  type TestRecipe,
  getGetAppQueryKey,
  getGetAppTestRecipeQueryKey,
  getListReleaseTestsQueryKey,
  useGetAppTestRecipe,
  useListReleaseTests,
  useUpdateApp,
  useUpdateAppTestRecipe,
} from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { releaseTestLabel, releaseTestLed } from "@/lib/release-test";

const formatDate = (iso: string) => new Date(iso).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });

function RecipeDialog({ appId, recipe, open, onOpenChange }: { appId: number; recipe: TestRecipe | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setText(recipe ? JSON.stringify(recipe, null, 2) : "");
      setError(null);
    }
  }, [open, recipe]);
  const save = useUpdateAppTestRecipe({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetAppTestRecipeQueryKey(appId) });
        toast({ title: "Ricetta di avvio salvata" });
        onOpenChange(false);
      },
      onError: (e) => setError(apiErrorMessage(e)),
    },
  });
  const submit = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError("Il testo non è un JSON valido.");
      return;
    }
    setError(null);
    save.mutate({ id: appId, data: { recipe: parsed as TestRecipe } });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Ricetta di avvio</DialogTitle>
          <DialogDescription>
            JSON con installazione, build, servizi, database di prova, variabili e indirizzo di partenza. Botcave lo valida al salvataggio; mai credenziali.
          </DialogDescription>
        </DialogHeader>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={18} className="font-mono text-xs" aria-label="Ricetta di avvio in JSON" />
        {error && <p className="text-sm text-danger">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Annulla
          </Button>
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending ? "Salvataggio…" : "Salva la ricetta"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Carta «Collaudo» della scheda App: correzione automatica, ricetta di avvio e ultimi collaudi. */
export function ReleaseTestCard({ app }: { app: App }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const recipe = useGetAppTestRecipe(app.id, { query: { queryKey: getGetAppTestRecipeQueryKey(app.id) } });
  const tests = useListReleaseTests({ appId: app.id }, { query: { queryKey: getListReleaseTestsQueryKey({ appId: app.id }) } });
  const updateApp = useUpdateApp({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetAppQueryKey(app.id) });
        toast({ title: "Impostazione salvata" });
      },
      onError: (e) => toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(e) }),
    },
  });
  const view = recipe.data;
  const latest = (tests.data ?? []).slice(0, 5);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Collaudo</CardTitle>
        <CardDescription>Prima di «Porta in produzione» un agente prova il lavoro avviando l'App con la ricetta qui sotto.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center gap-3 text-sm">
          <Switch
            checked={app.testAutoFix}
            onCheckedChange={(checked) => updateApp.mutate({ id: app.id, data: { testAutoFix: checked } })}
            disabled={updateApp.isPending}
            aria-label="Correggi da solo i problemi del collaudo"
          />
          Correggi da solo i problemi del collaudo
        </label>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs text-ink-muted">
              Ricetta di avvio
              {view && view.version > 0 && ` · versione ${view.version}${view.source ? ` (${view.source === "agent" ? "dell'agente" : "dell'utente"})` : ""}`}
            </p>
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Modifica
            </Button>
          </div>
          {recipe.isLoading && <p className="text-sm text-ink-muted">Caricamento…</p>}
          {recipe.isError && <p className="text-sm text-danger">{apiErrorMessage(recipe.error)}</p>}
          {view && !view.recipe && <p className="text-sm text-ink-muted">Nessuna ricetta: il collaudo la ricava dal codice o si salta.</p>}
          {view?.recipe && (
            <pre className="max-h-64 overflow-auto rounded-md bg-surface-1 p-3 font-mono text-xs">{JSON.stringify(view.recipe, null, 2)}</pre>
          )}
        </div>
        <div className="space-y-1">
          <p className="text-xs text-ink-muted">Ultimi collaudi</p>
          {tests.isError && <p className="text-sm text-danger">{apiErrorMessage(tests.error)}</p>}
          {tests.data && latest.length === 0 && <p className="text-sm text-ink-muted">Nessun collaudo ancora.</p>}
          <ul className="space-y-1">
            {latest.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-3 text-sm">
                <Led state={releaseTestLed(t)} label={releaseTestLabel(t)} />
                <span className="font-mono text-xs text-ink-muted">
                  lavoro {t.workId} · {t.sha.slice(0, 7)} · {formatDate(t.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
      <RecipeDialog appId={app.id} recipe={view?.recipe ?? null} open={editing} onOpenChange={setEditing} />
    </Card>
  );
}
