import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type App,
  ArchitectureRefresh,
  getGetAppArchitectureQueryKey,
  getGetAppQueryKey,
  getListAppArchitectureVersionsQueryKey,
  useGetAppArchitecture,
  useGetAppArchitectureVersion,
  useListAppArchitectureVersions,
  useRefreshAppArchitecture,
  useUpdateApp,
} from "@workspace/api-client-react";
import { Led, type LedState } from "@/components/brand/led";
import { Markdown } from "@/components/plan/markdown";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { architectureLed, lineDiff, REFRESH_LABELS } from "@/lib/architecture";
import { formatRelative, formatUsd } from "@/lib/format";

const LED_LABEL: Record<LedState, string> = {
  ask: "In attesa di una decisione",
  ok: "Sintesi pronta",
  work: "In corso",
  ko: "Errore",
  idle: "Nessuna sintesi",
};

/** Sintesi dell'architettura dell'app: LED, commit, frequenza, «Aggiorna ora», testo e confronto tra versioni. */
export function AppArchitectureCard({ app }: { app: App }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showSummary, setShowSummary] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);

  const arch = useGetAppArchitecture(app.id, {
    query: {
      queryKey: getGetAppArchitectureQueryKey(app.id),
      refetchInterval: (query) => (query.state.data?.status === "running" ? 5000 : false),
    },
  });
  const data = arch.data;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: getGetAppArchitectureQueryKey(app.id) });
    void queryClient.invalidateQueries({ queryKey: getListAppArchitectureVersionsQueryKey(app.id) });
  };

  const refresh = useRefreshAppArchitecture({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Controllo avviato", description: "Se il codice è cambiato la sintesi si aggiorna." });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Aggiornamento non riuscito", description: apiErrorMessage(error) }),
    },
  });
  const updateApp = useUpdateApp({
    mutation: {
      onSuccess: () => {
        invalidate();
        void queryClient.invalidateQueries({ queryKey: getGetAppQueryKey(app.id) });
        toast({ title: "Frequenza salvata" });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });

  const led = data ? architectureLed(data) : "idle";
  const commitUrl = data?.sha && app.sourceRepo ? `https://github.com/${app.sourceRepo}/commit/${data.sha}` : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Architettura</CardTitle>
        <CardDescription>
          Sintesi del codice che i Responsabili leggono per conoscere l'app. Si rigenera quando il commit cambia.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {arch.isLoading && <p className="text-sm text-ink-muted">Caricamento…</p>}
        {arch.isError && <p className="text-sm text-danger">{apiErrorMessage(arch.error)}</p>}
        {data && !data.available && (
          <p className="text-sm text-ink-muted">{data.unavailableReason ?? "Sintesi non disponibile per questa app."}</p>
        )}
        {data?.available && (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <Led state={led} label={LED_LABEL[led]} />
              {commitUrl && data.sha && (
                <a
                  href={commitUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-mono text-xs underline underline-offset-2 break-all"
                >
                  {data.sha.slice(0, 7)}
                </a>
              )}
              {!commitUrl && data.sha && <span className="font-mono text-xs">{data.sha.slice(0, 7)}</span>}
              {data.generatedAt && <span className="text-ink-muted">generata {formatRelative(data.generatedAt)}</span>}
              {data.costUsd != null && <span className="font-mono text-xs">{formatUsd(data.costUsd)}</span>}
              {data.aiModelName && <span className="text-ink-muted break-all">{data.aiModelName}</span>}
            </div>
            {data.lastError && <p className="text-sm text-danger break-words">{data.lastError}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={data.refresh}
                onValueChange={(value) =>
                  updateApp.mutate({ id: app.id, data: { architectureRefresh: value as ArchitectureRefresh } })
                }
                disabled={updateApp.isPending}
              >
                <SelectTrigger className="w-48" aria-label="Frequenza di aggiornamento">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(ArchitectureRefresh).map((value) => (
                    <SelectItem key={value} value={value}>
                      {REFRESH_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="secondary"
                onClick={() => refresh.mutate({ id: app.id })}
                disabled={refresh.isPending || data.status === "running"}
              >
                Aggiorna ora
              </Button>
              <Button variant="ghost" onClick={() => setVersionsOpen(true)}>
                Versioni
              </Button>
              {data.summary && (
                <Button variant="ghost" onClick={() => setShowSummary((v) => !v)}>
                  {showSummary ? "Nascondi sintesi" : "Mostra sintesi"}
                </Button>
              )}
            </div>
            {showSummary && data.summary && <Markdown>{data.summary}</Markdown>}
          </>
        )}
      </CardContent>
      {versionsOpen && <VersionsDialog appId={app.id} onClose={() => setVersionsOpen(false)} />}
    </Card>
  );
}

function VersionsDialog({ appId, onClose }: { appId: number; onClose: () => void }) {
  const list = useListAppArchitectureVersions(appId, { query: { queryKey: getListAppArchitectureVersionsQueryKey(appId) } });
  const versions = list.data ?? [];
  const [fromId, setFromId] = useState<number | null>(null);
  const [toId, setToId] = useState<number | null>(null);
  // Di default si confrontano le due più recenti (l'elenco è dal più recente)
  const to = toId ?? versions[0]?.id ?? null;
  const from = fromId ?? versions[1]?.id ?? null;
  const fromQ = useGetAppArchitectureVersion(appId, from ?? 0, { query: { queryKey: ["architecture-version", appId, from], enabled: from !== null } });
  const toQ = useGetAppArchitectureVersion(appId, to ?? 0, { query: { queryKey: ["architecture-version", appId, to], enabled: to !== null } });
  const diff = useMemo(
    () => (fromQ.data?.summary !== undefined && toQ.data?.summary !== undefined ? lineDiff(fromQ.data.summary, toQ.data.summary) : null),
    [fromQ.data, toQ.data],
  );

  const picker = (label: string, value: number | null, set: (id: number) => void) => (
    <Select value={value !== null ? String(value) : ""} onValueChange={(v) => set(Number(v))}>
      <SelectTrigger aria-label={label} className="w-full sm:w-64">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {versions.map((v) => (
          <SelectItem key={v.id} value={String(v.id)}>
            {v.sha.slice(0, 7)} · {formatRelative(v.createdAt)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Versioni dell'architettura</DialogTitle>
          <DialogDescription>Confronta due versioni della sintesi, riga per riga.</DialogDescription>
        </DialogHeader>
        {list.isLoading && <p className="text-sm text-ink-muted">Caricamento…</p>}
        {list.isError && <p className="text-sm text-danger">{apiErrorMessage(list.error)}</p>}
        {!list.isLoading && versions.length === 0 && <p className="text-sm text-ink-muted">Nessuna versione generata.</p>}
        {versions.length > 0 && (
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              {picker("Da", from, setFromId)}
              {picker("A", to, setToId)}
            </div>
            {versions.length < 2 && <p className="text-sm text-ink-muted">Serve almeno un'altra versione per il confronto.</p>}
            {diff && (
              <div className="rounded-md border border-border bg-surface-1 p-2 font-mono text-xs">
                {diff.map((line, index) => (
                  <div
                    key={index}
                    className={
                      "whitespace-pre-wrap break-words " +
                      (line.kind === "added" ? "text-success" : line.kind === "removed" ? "text-danger" : "text-ink-muted")
                    }
                  >
                    {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
                    {line.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
