import { useQueryClient } from "@tanstack/react-query";
import {
  type App,
  getGetAppBootstrapForAppQueryKey,
  getGetAppBootstrapQueryKey,
  useCheckAppBootstrapHealth,
  useGetAppBootstrapForApp,
  useSetAppBootstrapChecklistItem,
} from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { checklistLed } from "@/lib/app-bootstrap";
import { formatRelative } from "@/lib/format";

/** «Primo deploy» di un'App nata da zero: checklist con LED, copia dei dettagli e controllo dell'indirizzo. Senza richiesta da zero non compare. */
export function FirstDeployCard({ app }: { app: App }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const query = useGetAppBootstrapForApp(app.id, {
    query: {
      queryKey: getGetAppBootstrapForAppQueryKey(app.id),
      retry: false,
      refetchInterval: (q) => (q.state.data?.status === "running" ? 10_000 : false),
    },
  });
  const boot = query.data;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getGetAppBootstrapForAppQueryKey(app.id) });
    if (boot) void queryClient.invalidateQueries({ queryKey: getGetAppBootstrapQueryKey(boot.id) });
  };
  const onError = (error: unknown) =>
    toast({ variant: "destructive", title: "Operazione non riuscita", description: apiErrorMessage(error) });
  const setItem = useSetAppBootstrapChecklistItem({ mutation: { onSuccess: refresh, onError } });
  const check = useCheckAppBootstrapHealth({
    mutation: {
      onSuccess: (saved) => {
        refresh();
        toast({ title: saved.healthOkAt ? "L'app risponde" : "L'app non risponde ancora" });
      },
      onError,
    },
  });

  if (!boot) return null;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copiato" });
    } catch {
      toast({ variant: "destructive", title: "Copia non riuscita" });
    }
  };

  const allDone = boot.checklist.length > 0 && boot.checklist.every((i) => i.done);
  if (allDone) {
    const last = boot.checklist.map((i) => i.doneAt).filter((d): d is string => !!d).sort().at(-1);
    return (
      <Card>
        <CardHeader>
          <CardTitle>Primo deploy</CardTitle>
          <CardDescription>
            <Led state="ok" label={`Primo deploy completato${last ? ` il ${new Date(last).toLocaleDateString("it-IT")}` : ""}`} />
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Primo deploy</CardTitle>
        <CardDescription>
          Le operazioni che restano a te dopo la creazione di <span className="font-mono">{boot.domain}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {boot.checklist.map((item) => (
          <div key={item.key} className="space-y-1.5 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Led state={checklistLed(item, boot)} label={item.label} />
              <div className="flex items-center gap-2">
                {item.key === "health" && (
                  <Button size="sm" variant="outline" disabled={check.isPending} onClick={() => check.mutate({ id: boot.id })}>
                    {check.isPending ? "Controllo…" : "Controlla ora"}
                  </Button>
                )}
                {!item.auto && (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={item.done}
                      disabled={setItem.isPending}
                      onCheckedChange={(v) => setItem.mutate({ id: boot.id, item: item.key, data: { done: v === true } })}
                    />
                    Fatto
                  </label>
                )}
              </div>
            </div>
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 break-words text-sm text-ink-muted">{item.detail}</p>
              <Button size="sm" variant="ghost" onClick={() => void copy(item.detail)}>
                Copia
              </Button>
            </div>
            {item.key === "health" && boot.healthCheckedAt && (
              <p className="text-xs text-ink-muted">Ultimo controllo {formatRelative(boot.healthCheckedAt)}</p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
