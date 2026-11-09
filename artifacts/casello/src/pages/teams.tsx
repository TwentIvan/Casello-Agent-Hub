import { useState } from "react";
import { useLocation } from "wouter";
import { Plus } from "lucide-react";
import {
  type ListTeamInstancesParams,
  type TeamInstanceStatus,
  getListAppsQueryKey,
  getListTeamInstancesQueryKey,
  useListApps,
  useListTeamInstances,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { NewTeamDialog } from "@/components/teams/new-team-dialog";
import { TEAM_STATUS_LABELS, TeamStatusBadge } from "@/components/teams/team-status";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";

export default function TeamsPage() {
  const [, navigate] = useLocation();
  const [status, setStatus] = useState<TeamInstanceStatus | "all">("all");
  const [appId, setAppId] = useState<string>("all");
  const [creating, setCreating] = useState(false);
  const apps = useListApps({ query: { queryKey: getListAppsQueryKey() } });
  const params: ListTeamInstancesParams = {
    ...(status !== "all" && { status }),
    ...(appId !== "all" && { appId: Number(appId) }),
  };
  const list = useListTeamInstances(params, { query: { queryKey: getListTeamInstancesQueryKey(params) } });
  const teams = list.data ?? [];

  return (
    <div className="mx-auto max-w-screen-2xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-h2">Squadre</h2>
          <p className="text-sm text-muted-foreground">
            Squadre al lavoro su un incarico preciso, copiate da un modello e specializzate.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setCreating(true)}>
            <Plus />
            Nuova squadra
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={status} onValueChange={(v) => setStatus(v as TeamInstanceStatus | "all")}>
          <SelectTrigger className="w-44" aria-label="Filtra per stato">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti gli stati</SelectItem>
            {(Object.keys(TEAM_STATUS_LABELS) as TeamInstanceStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {TEAM_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={appId} onValueChange={setAppId}>
          <SelectTrigger className="w-56" aria-label="Filtra per app">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutte le app</SelectItem>
            {(apps.data ?? []).map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Card>
        <CardContent className="p-0">
          {list.isError ? (
            <p className="p-6 text-sm text-destructive">Impossibile caricare le squadre: {apiErrorMessage(list.error)}</p>
          ) : list.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : teams.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">Nessuna squadra trovata.</p>
          ) : (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Nome</TableHead>
                  <TableHead>Lavoro</TableHead>
                  <TableHead className="hidden lg:table-cell">Modello</TableHead>
                  <TableHead className="w-20">Ruoli</TableHead>
                  <TableHead className="w-24">Stato</TableHead>
                  <TableHead className="hidden w-32 pr-4 md:table-cell">Aggiornata</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {teams.map((t) => {
                  const work = `${t.ref.appName} · ${t.ref.type} ${t.ref.id}${t.ref.title ? ` — ${t.ref.title}` : ""}`;
                  return (
                    <TableRow
                      key={t.id}
                      className="cursor-pointer"
                      tabIndex={0}
                      onClick={() => navigate(`/teams/${t.id}`)}
                      onKeyDown={(e) => e.key === "Enter" && navigate(`/teams/${t.id}`)}
                    >
                      <TableCell className="truncate pl-4 font-medium" title={t.name}>
                        {t.name}
                      </TableCell>
                      <TableCell className="truncate" title={work}>
                        {work}
                      </TableCell>
                      <TableCell className="hidden truncate text-muted-foreground lg:table-cell">
                        {t.template ? `${t.template.name} · v${t.template.version}` : "—"}
                      </TableCell>
                      <TableCell className="font-mono tabular-nums">{t.roles.length}</TableCell>
                      <TableCell>
                        <TeamStatusBadge status={t.status} />
                      </TableCell>
                      <TableCell className="hidden pr-4 text-muted-foreground md:table-cell">
                        {formatRelative(t.updatedAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {creating && <NewTeamDialog open onOpenChange={setCreating} />}
    </div>
  );
}
