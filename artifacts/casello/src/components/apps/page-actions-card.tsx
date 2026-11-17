import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { type App, type PageAction, getGetAppQueryKey, useUpdateAppPageActions } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { MAX_ACTIONS_PER_APP, MAX_ACTIONS_PER_PAGE, groupActions, moveAction } from "@/lib/page-actions";

/** Azioni proposte dal plugin per tipo di pagina dell'App ospite. */
export function PageActionsCard({ app }: { app: App }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [actions, setActions] = useState<PageAction[]>(app.pageActions);
  // Tipi di pagina aggiunti a mano e ancora senza azioni
  const [emptyPages, setEmptyPages] = useState<string[]>([]);
  const [newPage, setNewPage] = useState("");

  useEffect(() => setActions(app.pageActions), [app.pageActions]);

  const save = useUpdateAppPageActions({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetAppQueryKey(app.id) });
        setEmptyPages([]);
        toast({ title: "Azioni del plugin salvate" });
      },
      onError: (error) => toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });

  const groups = groupActions(actions);
  const pages = [...groups.map((g) => g.page), ...emptyPages.filter((p) => !groups.some((g) => g.page === p))];
  const suggestions = app.embedPagesSeen.filter((p) => !pages.includes(p));

  const patch = (page: string, index: number, change: Partial<PageAction>) => {
    let seen = -1;
    setActions((list) => list.map((a) => (a.page === page && ++seen === index ? { ...a, ...change } : a)));
  };
  const remove = (page: string, index: number) => {
    let seen = -1;
    setActions((list) => list.filter((a) => !(a.page === page && ++seen === index)));
  };
  const addAction = (page: string) => setActions((list) => [...list, { page, label: "", request: "" }]);
  const addPage = (page: string) => {
    const name = page.trim();
    if (!name || pages.includes(name)) return;
    setEmptyPages((list) => [...list, name]);
    setNewPage("");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-h2">Azioni del plugin</CardTitle>
        <CardDescription>
          Le azioni che il plugin propone per tipo di pagina: l'etichetta compare come pulsante, la richiesta parte verso il Responsabile.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {pages.length === 0 && <p className="text-sm text-ink-muted">Nessuna azione: aggiungi un tipo di pagina.</p>}
        {pages.map((page) => {
          const list = groups.find((g) => g.page === page)?.actions ?? [];
          return (
            <div key={page} className="space-y-3 rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-mono text-sm">{page}</h3>
                <span className="font-mono text-xs text-ink-muted">{list.length}/{MAX_ACTIONS_PER_PAGE}</span>
              </div>
              {list.map((action, index) => (
                <div key={index} className="space-y-2 rounded-md bg-surface-1 p-3">
                  <Input
                    aria-label="Etichetta"
                    placeholder="Etichetta"
                    maxLength={40}
                    value={action.label}
                    onChange={(e) => patch(page, index, { label: e.target.value })}
                  />
                  <Textarea
                    aria-label="Richiesta"
                    placeholder="Richiesta"
                    maxLength={1000}
                    rows={3}
                    value={action.request}
                    onChange={(e) => patch(page, index, { request: e.target.value })}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost" size="sm" disabled={index === 0} onClick={() => setActions((l) => moveAction(l, page, index, -1))}>Su</Button>
                    <Button variant="ghost" size="sm" disabled={index === list.length - 1} onClick={() => setActions((l) => moveAction(l, page, index, 1))}>Giù</Button>
                    <Button variant="ghost" size="sm" onClick={() => remove(page, index)}>Togli</Button>
                  </div>
                </div>
              ))}
              <Button variant="secondary" size="sm" disabled={list.length >= MAX_ACTIONS_PER_PAGE || actions.length >= MAX_ACTIONS_PER_APP} onClick={() => addAction(page)}>
                Aggiungi azione
              </Button>
            </div>
          );
        })}

        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label="Tipo di pagina"
              className="max-w-xs font-mono"
              placeholder="Tipo di pagina"
              maxLength={40}
              value={newPage}
              onChange={(e) => setNewPage(e.target.value)}
            />
            <Button variant="secondary" disabled={!newPage.trim()} onClick={() => addPage(newPage)}>Aggiungi tipo di pagina</Button>
          </div>
          {suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-label text-ink-muted">Viste dal plugin</span>
              {suggestions.map((p) => (
                <Button key={p} variant="outline" size="sm" className="font-mono" onClick={() => addPage(p)}>{p}</Button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button disabled={save.isPending} onClick={() => save.mutate({ id: app.id, data: { actions } })}>Salva</Button>
          <span className="font-mono text-xs text-ink-muted">{actions.length}/{MAX_ACTIONS_PER_APP}</span>
        </div>
      </CardContent>
    </Card>
  );
}
