import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  type FleetPolicy,
  getGetDashboardStatsQueryKey,
  getGetFleetQueryKey,
  useGetFleet,
  usePauseFleet,
  useResumeFleet,
  useUpdateFleetPolicy,
} from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { AgentActivityLed } from "@/components/agents/agent-activity-led";
import { useAgentActivity, useLivePollInterval } from "@/components/live/live-updates";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatDuration, formatRelative, formatUsd } from "@/lib/format";
import {
  FLEET_HEALTH_LABELS,
  FLEET_HEALTH_LED,
  FLEET_LIMITS,
  type FleetFilter,
  filterFleet,
  finishedRunsText,
  fleetIssuesText,
  fleetLimitsError,
  formatSuccessRate,
} from "@/lib/fleet";

const REFRESH_MS = 15_000;
const ALL_APPS = "all";

const FILTER_LABELS: Record<FleetFilter, string> = {
  all: "Tutti",
  attention: "Da guardare",
  failing: "Falliscono",
  degraded: "Rallentati",
  healthy: "Sani",
  off: "Spenti",
};

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-label text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="font-mono text-2xl tabular-nums">{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/** Politica comune: pausa centrale e limiti di concorrenza delle run. */
function PolicyCard({ policy }: { policy: FleetPolicy }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [total, setTotal] = useState(String(policy.maxRunningRuns));
  const [perAgent, setPerAgent] = useState(String(policy.maxRunningPerAgent));
  const [pauseOpen, setPauseOpen] = useState(false);
  const [reason, setReason] = useState("");

  useEffect(() => {
    setTotal(String(policy.maxRunningRuns));
    setPerAgent(String(policy.maxRunningPerAgent));
  }, [policy.maxRunningRuns, policy.maxRunningPerAgent]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getGetFleetQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
  };
  const onError = (error: unknown) =>
    toast({ variant: "destructive", title: "Operazione non riuscita", description: apiErrorMessage(error) });
  const save = useUpdateFleetPolicy({
    mutation: {
      onSuccess: () => {
        refresh();
        toast({ title: "Limiti salvati" });
      },
      onError,
    },
  });
  const pause = usePauseFleet({
    mutation: {
      onSuccess: () => {
        refresh();
        setPauseOpen(false);
        setReason("");
      },
      onError,
    },
  });
  const resume = useResumeFleet({ mutation: { onSuccess: refresh, onError } });

  const totalN = Number(total);
  const perAgentN = Number(perAgent);
  const limitsError = total === "" || perAgent === "" ? "Indica entrambi i limiti" : fleetLimitsError(totalN, perAgentN);
  const changed = totalN !== policy.maxRunningRuns || perAgentN !== policy.maxRunningPerAgent;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Coordinamento</CardTitle>
        <CardDescription>Regole comuni a tutte le run degli agenti: valgono per ogni App e per ogni utente.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <Led state={policy.paused ? "ko" : "ok"} label={policy.paused ? "Flotta in pausa" : "Flotta in funzione"} />
            {policy.paused ? (
              <p className="text-sm text-muted-foreground">
                {policy.pausedByName ? `Messa in pausa da ${policy.pausedByName}` : "Messa in pausa"}
                {policy.pausedAt ? ` ${formatRelative(policy.pausedAt)}` : ""}
                {policy.pauseReason ? `: ${policy.pauseReason}` : ""}. Le run nuove restano in coda e gli inneschi non scattano.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Le run partono appena c'è posto nei limiti.</p>
            )}
          </div>
          {policy.paused ? (
            <Button onClick={() => resume.mutate()} disabled={resume.isPending}>
              Riprendi la flotta
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => setPauseOpen(true)}>
              Metti in pausa la flotta
            </Button>
          )}
        </div>

        <form
          className="flex flex-wrap items-end gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (limitsError) return;
            save.mutate({ data: { maxRunningRuns: totalN, maxRunningPerAgent: perAgentN } });
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="fleet-total">Run in corso in tutto ({FLEET_LIMITS.maxRunningRuns.min}–{FLEET_LIMITS.maxRunningRuns.max})</Label>
            <Input
              id="fleet-total"
              type="number"
              min={FLEET_LIMITS.maxRunningRuns.min}
              max={FLEET_LIMITS.maxRunningRuns.max}
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              className="w-28 font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="fleet-per-agent">Per agente ({FLEET_LIMITS.maxRunningPerAgent.min}–{FLEET_LIMITS.maxRunningPerAgent.max})</Label>
            <Input
              id="fleet-per-agent"
              type="number"
              min={FLEET_LIMITS.maxRunningPerAgent.min}
              max={FLEET_LIMITS.maxRunningPerAgent.max}
              value={perAgent}
              onChange={(e) => setPerAgent(e.target.value)}
              className="w-28 font-mono"
            />
          </div>
          <Button type="submit" variant="secondary" disabled={!changed || limitsError !== null || save.isPending}>
            Salva i limiti
          </Button>
          {changed && limitsError && <p className="w-full text-sm text-danger">{limitsError}</p>}
        </form>
      </CardContent>

      <Dialog open={pauseOpen} onOpenChange={setPauseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Metti in pausa la flotta</DialogTitle>
            <DialogDescription>
              Nessuna run nuova parte finché non riprendi: le run restano in coda, sorveglianza e run programmate non scattano, i
              webhook accodano. Le run già in corso arrivano in fondo. Vale per tutti gli utenti.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="fleet-reason">Motivo (facoltativo, visibile a tutti)</Label>
            <Textarea
              id="fleet-reason"
              value={reason}
              maxLength={FLEET_LIMITS.pauseReason}
              rows={2}
              onChange={(e) => setReason(e.target.value.replace(/[\r\n]+/g, " "))}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPauseOpen(false)}>
              Annulla
            </Button>
            <Button onClick={() => pause.mutate({ data: { reason: reason.trim() || null } })} disabled={pause.isPending}>
              Metti in pausa
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function FleetPage() {
  const interval = useLivePollInterval(REFRESH_MS);
  const fleet = useGetFleet({ query: { queryKey: getGetFleetQueryKey(), refetchInterval: interval } });
  const activity = useAgentActivity();
  const [filter, setFilter] = useState<FleetFilter>("all");
  const [appFilter, setAppFilter] = useState<string>(ALL_APPS);

  const data = fleet.data;
  const apps = useMemo(() => {
    const byId = new Map<number, string>();
    for (const a of data?.agents ?? []) byId.set(a.appId, a.appName);
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1], "it"));
  }, [data]);
  const visible = useMemo(
    () => filterFleet(data?.agents ?? [], filter, appFilter === ALL_APPS ? null : Number(appFilter)),
    [data, filter, appFilter],
  );
  const s = data?.summary;

  return (
    <div className="mx-auto max-w-screen-2xl space-y-6">
      <div>
        <h2 className="text-h2">Flotta</h2>
        <p className="text-sm text-muted-foreground">
          Salute e attività di tutti gli agenti nelle ultime 24 ore, con le regole di coordinamento comuni.
        </p>
      </div>

      {fleet.isError ? (
        <p className="text-sm text-destructive">Impossibile caricare la flotta: {apiErrorMessage(fleet.error)}</p>
      ) : !data || !s ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <>
          <PolicyCard policy={data.policy} />

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label="Agenti" value={s.agents} hint={`${s.working} in lavoro · ${s.waitingUser} aspettano te`} />
            <Stat label="Falliscono" value={s.failing} hint={`${s.degraded} rallentati`} />
            <Stat label="Sani" value={s.healthy} hint={`${s.off} spenti`} />
            <Stat label="Run in corso" value={s.runningRuns} hint={`${s.pendingRuns} in coda`} />
            <Stat
              label="Ultime 24 ore"
              value={`${s.succeeded24h + s.failed24h} run`}
              hint={`${s.failed24h} fallite · ${formatUsd(s.cost24hUsd)}`}
            />
          </div>

          <div className="flex flex-wrap gap-3">
            <Select value={filter} onValueChange={(v) => setFilter(v as FleetFilter)}>
              <SelectTrigger className="w-44" aria-label="Filtra per salute">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(FILTER_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={appFilter} onValueChange={setAppFilter}>
              <SelectTrigger className="w-48" aria-label="Filtra per app">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_APPS}>Tutte le app</SelectItem>
                {apps.map(([id, name]) => (
                  <SelectItem key={id} value={String(id)}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Card>
            <CardContent className="p-0">
              {visible.length === 0 ? (
                <p className="px-4 py-12 text-center text-sm text-muted-foreground">
                  {data.agents.length === 0 ? "Nessun agente ancora." : "Nessun agente corrisponde ai filtri."}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Agente</TableHead>
                      <TableHead>Salute</TableHead>
                      <TableHead>Attività</TableHead>
                      <TableHead className="text-right">In corso · coda</TableHead>
                      <TableHead className="hidden md:table-cell">Ultime 24 ore</TableHead>
                      <TableHead className="text-right">Successo</TableHead>
                      <TableHead className="hidden text-right lg:table-cell">Durata media</TableHead>
                      <TableHead className="hidden text-right lg:table-cell">Costo 24 h</TableHead>
                      <TableHead className="hidden pr-4 text-right xl:table-cell">Ultima run</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((a) => {
                      const issues = fleetIssuesText(a.issues);
                      return (
                        <TableRow key={a.agentId} className="relative align-top">
                          <TableCell className="pl-4">
                            {/* Il link copre tutta la riga (after:inset-0) */}
                            <Link href={`/agents/${a.agentId}`} className="font-medium after:absolute after:inset-0 hover:underline">
                              {a.name}
                            </Link>
                            <p className="text-xs text-muted-foreground">{a.appName}</p>
                          </TableCell>
                          <TableCell className="max-w-xs">
                            <Led state={FLEET_HEALTH_LED[a.health]} label={FLEET_HEALTH_LABELS[a.health]} />
                            {issues && <p className="text-xs text-muted-foreground">{issues}</p>}
                            {a.lastError && (
                              <p className="truncate text-xs text-muted-foreground" title={a.lastError}>
                                Ultimo errore: {a.lastError}
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            <AgentActivityLed activity={activity.byAgent.get(a.agentId)} />
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">
                            {a.runningRuns} · {a.pendingRuns}
                          </TableCell>
                          <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">
                            {finishedRunsText(a)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">{formatSuccessRate(a.successRate)}</TableCell>
                          <TableCell className="hidden whitespace-nowrap text-right font-mono tabular-nums lg:table-cell">
                            {formatDuration(a.avgDurationMs)}
                          </TableCell>
                          <TableCell className="hidden whitespace-nowrap text-right font-mono tabular-nums lg:table-cell">
                            {a.cost24hUsd != null ? formatUsd(a.cost24hUsd) : a.unpriced24h > 0 ? "costo parziale" : "—"}
                          </TableCell>
                          <TableCell className="hidden whitespace-nowrap pr-4 text-right text-muted-foreground xl:table-cell">
                            {a.lastRunAt ? formatRelative(a.lastRunAt) : "mai"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
