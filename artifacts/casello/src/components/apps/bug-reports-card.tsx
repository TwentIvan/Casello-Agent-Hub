import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  type App,
  type EmbedBugStatus,
  getGetBugSettingsQueryKey,
  getListAppBugsQueryKey,
  useCreateIdentitySecret,
  useDeleteIdentitySecret,
  useGetBugSettings,
  useListAppBugs,
  useUpdateBugSettings,
} from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { BUG_STATUS_LABELS, bugStatusLed } from "@/lib/bug-status";
import { formatRelative } from "@/lib/format";
import { IdentitySecretDialog } from "./identity-secret-dialog";
import { IdentityTestDialog } from "./identity-test-dialog";

const ALL = "all";

/** Segnalazioni dei bug dal plugin: impostazioni, identità degli utenti ed elenco. */
export function BugReportsCard({ app }: { app: App }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = useState<string>(ALL);
  const [secret, setSecret] = useState<string | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [limit, setLimit] = useState("");

  const settings = useGetBugSettings(app.id, { query: { queryKey: getGetBugSettingsQueryKey(app.id) } });
  const listParams = filter === ALL ? undefined : { status: filter as EmbedBugStatus };
  const bugs = useListAppBugs(app.id, listParams, { query: { queryKey: getListAppBugsQueryKey(app.id, listParams) } });
  const data = settings.data;

  useEffect(() => {
    if (data) setLimit(String(data.dailyLimit));
  }, [data?.dailyLimit]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshSettings = () => void queryClient.invalidateQueries({ queryKey: getGetBugSettingsQueryKey(app.id) });
  const onError = (title: string) => (error: unknown) =>
    toast({ variant: "destructive", title, description: apiErrorMessage(error) });

  const update = useUpdateBugSettings({
    mutation: { onSuccess: () => { refreshSettings(); toast({ title: "Impostazioni salvate" }); }, onError: onError("Salvataggio non riuscito") },
  });
  const create = useCreateIdentitySecret({
    mutation: {
      // Il segreto non resta nella MutationCache: gcTime 0 la toglie appena reset() stacca l'osservatore
      gcTime: 0,
      onSuccess: (res) => {
        setSecret(res.secret);
        setRegenOpen(false);
        refreshSettings();
        // Il segreto non resta nella cache delle query: si tiene solo nello stato del dialogo.
        create.reset();
      },
      onError: onError("Generazione non riuscita"),
    },
  });
  const remove = useDeleteIdentitySecret({
    mutation: {
      onSuccess: () => { setRemoveOpen(false); refreshSettings(); toast({ title: "Segreto tolto" }); },
      onError: onError("Rimozione non riuscita"),
    },
  });

  const limitNumber = Number(limit);
  const limitValid = Number.isInteger(limitNumber) && limitNumber >= 1 && limitNumber <= 500;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Segnalazioni bug</CardTitle>
        <CardDescription>
          Gli utenti dell'app segnalano un problema dal pannello Botcave: il Responsabile lo vaglia e tu approvi prima che la squadra lavori.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {settings.isLoading && <p className="text-sm text-ink-muted">Caricamento…</p>}
        {settings.isError && <p className="text-sm text-danger">{apiErrorMessage(settings.error)}</p>}
        {data && (
          <>
            <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
              <div className="flex items-center gap-3">
                <Switch
                  id="bug-enabled"
                  checked={data.enabled}
                  disabled={update.isPending}
                  onCheckedChange={(enabled) => update.mutate({ id: app.id, data: { enabled } })}
                />
                <Label htmlFor="bug-enabled">Accetta segnalazioni</Label>
              </div>
              <div className="flex items-end gap-2">
                <div className="space-y-1">
                  <Label htmlFor="bug-limit">Limite giornaliero</Label>
                  <Input id="bug-limit" type="number" min={1} max={500} className="w-28 font-mono" value={limit} onChange={(e) => setLimit(e.target.value)} />
                </div>
                <Button
                  variant="secondary"
                  disabled={!limitValid || limitNumber === data.dailyLimit || update.isPending}
                  onClick={() => update.mutate({ id: app.id, data: { dailyLimit: limitNumber } })}
                >
                  Salva limite
                </Button>
              </div>
              <p className="text-sm text-ink-muted">
                Oggi: <span className="font-mono">{data.todayCount}</span> su <span className="font-mono">{data.dailyLimit}</span>
              </p>
            </div>

            <div className="space-y-2 border-t border-line pt-4">
              <h3 className="text-label">Identità degli utenti</h3>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Led
                  state={data.identitySecretSet ? "ok" : "idle"}
                  label={data.identitySecretSet ? "Segreto impostato" : "Nessun segreto: le segnalazioni usano la chiave del browser"}
                />
                {data.identitySecretSet && data.identitySecretSetAt && (
                  <span className="text-ink-muted">generato {formatRelative(data.identitySecretSetAt)}</span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {data.identitySecretSet ? (
                  <Button variant="secondary" onClick={() => setRegenOpen(true)}>Rigenera segreto</Button>
                ) : (
                  <Button variant="secondary" disabled={create.isPending} onClick={() => create.mutate({ id: app.id })}>
                    {create.isPending ? "Generazione…" : "Genera segreto"}
                  </Button>
                )}
                {data.identitySecretSet && <Button variant="ghost" onClick={() => setRemoveOpen(true)}>Togli segreto</Button>}
                <Button variant="outline" onClick={() => setTestOpen(true)}>Prova identità</Button>
              </div>
            </div>

            <div className="space-y-1 border-t border-line pt-4 text-sm">
              <h3 className="text-label">Squadra per i bug</h3>
              {data.bugTeam ? (
                <p>
                  <Link href={`/teams/${data.bugTeam.id}`} className="underline underline-offset-2">{data.bugTeam.name}</Link>{" "}
                  <span className="text-ink-muted">({data.bugTeam.status})</span>
                </p>
              ) : (
                <p className="text-ink-muted">Nessuna squadra per i bug: designala nella scheda squadra.</p>
              )}
              {!data.approverAvailable && (
                <p className="text-danger">Nessuno può approvare: designa una squadra per i bug o un modello per il Responsabile.</p>
              )}
            </div>
          </>
        )}

        <div className="space-y-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-label">Segnalazioni</h3>
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger className="w-56" aria-label="Filtra per stato"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Tutti gli stati</SelectItem>
                {(Object.keys(BUG_STATUS_LABELS) as EmbedBugStatus[]).map((s) => (
                  <SelectItem key={s} value={s}>{s} · {BUG_STATUS_LABELS[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {bugs.isError && <p className="text-sm text-danger">{apiErrorMessage(bugs.error)}</p>}
          {bugs.data && bugs.data.length === 0 && <p className="text-sm text-ink-muted">Nessuna segnalazione.</p>}
          <ul className="divide-y divide-line">
            {bugs.data?.map((b) => (
              <li key={b.id}>
                <Link href={`/apps/${app.id}/bugs/${b.number}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm hover:bg-surface-2">
                  <span className="font-mono text-xs text-ink-muted">#{b.number}</span>
                  <span className="min-w-0 flex-1 break-words">{b.title}</span>
                  <Led state={bugStatusLed(b.status)} label={BUG_STATUS_LABELS[b.status]} />
                  <span className="text-xs text-ink-muted">{b.reporterLabel}</span>
                  <span className="text-xs text-ink-muted">{formatRelative(b.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>

      <IdentitySecretDialog secret={secret} onClose={() => setSecret(null)} />
      <IdentityTestDialog appId={app.id} open={testOpen} onOpenChange={setTestOpen} />
      <ConfirmDialog
        open={regenOpen}
        onOpenChange={setRegenOpen}
        title="Rigenerare il segreto?"
        description="Il token in uso nell'app smette di valere: aggiorna il segreto nel server dell'app subito dopo."
        confirmLabel="Rigenera"
        pendingLabel="Generazione…"
        pending={create.isPending}
        onConfirm={() => create.mutate({ id: app.id })}
      />
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title="Togliere il segreto?"
        description="Il token in uso nell'app smette di valere e le segnalazioni tornano a usare la chiave del browser."
        confirmLabel="Togli"
        pendingLabel="Rimozione…"
        pending={remove.isPending}
        onConfirm={() => remove.mutate({ id: app.id })}
      />
    </Card>
  );
}
