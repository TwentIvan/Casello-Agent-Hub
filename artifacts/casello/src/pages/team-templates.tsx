import { useState } from "react";
import { useLocation } from "wouter";
import { Crown, Plus } from "lucide-react";
import { getListTeamTemplatesQueryKey, useListTeamTemplates } from "@workspace/api-client-react";
import { CharacterButton } from "@/components/characters/character-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";

export default function TeamTemplatesPage() {
  const [, navigate] = useLocation();
  const [archived, setArchived] = useState(false);
  const params = { archived: archived ? ("true" as const) : ("false" as const) };
  const list = useListTeamTemplates(params, { query: { queryKey: getListTeamTemplatesQueryKey(params) } });
  const templates = list.data ?? [];

  return (
    <div className="mx-auto max-w-screen-2xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-h2">Modelli di squadra</h2>
          <p className="text-sm text-muted-foreground">
            Squadre riusabili: ruoli con un capo, compiti, strumenti e skill. Da un modello nascono le squadre dei lavori.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CharacterButton target={{ kind: "character", subjectType: "area_team_templates", subjectId: null, title: "Area Modelli di squadra" }} />
          <Button onClick={() => navigate("/team-templates/new")}>
            <Plus />
            Nuovo modello
          </Button>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
        Mostra gli archiviati
      </label>
      <Card>
        <CardContent className="p-0">
          {list.isError ? (
            <p className="p-6 text-sm text-destructive">Impossibile caricare i modelli: {apiErrorMessage(list.error)}</p>
          ) : list.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : templates.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">
              {archived ? "Nessun modello archiviato." : "Nessun modello di squadra."}
            </p>
          ) : (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Nome</TableHead>
                  <TableHead className="hidden w-56 md:table-cell">Capo</TableHead>
                  <TableHead className="w-20">Ruoli</TableHead>
                  <TableHead className="w-24">Squadre</TableHead>
                  <TableHead className="w-24">Versione</TableHead>
                  <TableHead className="hidden w-32 pr-4 md:table-cell">Aggiornato</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((t) => {
                  const lead = t.roles.find((r) => r.isLead);
                  return (
                    <TableRow
                      key={t.id}
                      className="cursor-pointer"
                      tabIndex={0}
                      onClick={() => navigate(`/team-templates/${t.id}`)}
                      onKeyDown={(e) => e.key === "Enter" && navigate(`/team-templates/${t.id}`)}
                    >
                      <TableCell className="truncate pl-4 font-medium" title={t.name}>
                        {t.name}
                        {t.archived && (
                          <Badge variant="outline" className="ml-2">
                            Archiviato
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="hidden truncate md:table-cell" title={lead?.name}>
                        {lead ? (
                          <span className="inline-flex items-center gap-1">
                            <Crown className="size-3.5 text-muted-foreground" />
                            {lead.name}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="font-mono tabular-nums">{t.roles.length}</TableCell>
                      <TableCell className="font-mono tabular-nums">{t.instanceCount}</TableCell>
                      <TableCell className="font-mono tabular-nums">v{t.version}</TableCell>
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
    </div>
  );
}
