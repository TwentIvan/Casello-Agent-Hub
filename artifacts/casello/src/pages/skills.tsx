import { CharacterButton } from "@/components/characters/character-button";
import { useState } from "react";
import { useLocation } from "wouter";
import { Plus } from "lucide-react";
import { type SkillKind, getListSkillsQueryKey, useListSkills } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SKILL_KIND_LABELS, SkillKindBadge } from "@/components/teams/skill-kind";
import { SkillFormDialog } from "@/components/teams/skill-form-dialog";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";

export default function SkillsPage() {
  const [, navigate] = useLocation();
  const [kind, setKind] = useState<SkillKind | "all">("all");
  const [q, setQ] = useState("");
  const [showDeprecated, setShowDeprecated] = useState(false);
  const [creating, setCreating] = useState(false);
  const params = {
    ...(kind !== "all" && { kind }),
    ...(q.trim() && { q: q.trim().slice(0, 100) }),
    ...(!showDeprecated && { deprecated: "false" as const }),
  };
  const list = useListSkills(params, { query: { queryKey: getListSkillsQueryKey(params) } });
  const skills = list.data ?? [];

  return (
    <div className="mx-auto max-w-screen-2xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-h2">Skill</h2>
          <p className="text-sm text-muted-foreground">
            Il catalogo delle skill versionate che i ruoli delle squadre possono usare.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CharacterButton target={{ kind: "character", subjectType: "area_skills", subjectId: null, title: "Area Skill" }} />
          <Button onClick={() => setCreating(true)}>
            <Plus />
            Nuova skill
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Cerca per codice o nome"
          aria-label="Cerca"
          className="w-64"
          maxLength={100}
        />
        <Select value={kind} onValueChange={(v) => setKind(v as SkillKind | "all")}>
          <SelectTrigger className="w-44" aria-label="Filtra per tipo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti i tipi</SelectItem>
            {(Object.keys(SKILL_KIND_LABELS) as SkillKind[]).map((k) => (
              <SelectItem key={k} value={k}>
                {SKILL_KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showDeprecated} onChange={(e) => setShowDeprecated(e.target.checked)} />
          Mostra le deprecate
        </label>
      </div>
      <Card>
        <CardContent className="p-0">
          {list.isError ? (
            <p className="p-6 text-sm text-destructive">Impossibile caricare le skill: {apiErrorMessage(list.error)}</p>
          ) : list.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : skills.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">Nessuna skill trovata.</p>
          ) : (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-56 pl-4">Codice</TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead className="w-32">Tipo</TableHead>
                  <TableHead className="w-24">Versione</TableHead>
                  <TableHead className="hidden w-32 pr-4 md:table-cell">Aggiornata</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skills.map((s) => (
                  <TableRow
                    key={s.code}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => navigate(`/skills/${encodeURIComponent(s.code)}`)}
                    onKeyDown={(e) => e.key === "Enter" && navigate(`/skills/${encodeURIComponent(s.code)}`)}
                  >
                    <TableCell className="truncate pl-4 font-mono text-xs" title={s.code}>
                      {s.code}
                    </TableCell>
                    <TableCell className="truncate" title={s.name}>
                      {s.name}
                      {s.deprecated && (
                        <Badge variant="outline" className="ml-2">
                          Deprecata
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <SkillKindBadge kind={s.kind} />
                    </TableCell>
                    <TableCell className="font-mono tabular-nums">v{s.currentVersion}</TableCell>
                    <TableCell className="hidden pr-4 text-muted-foreground md:table-cell">
                      {formatRelative(s.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {creating && (
        <SkillFormDialog
          open
          onOpenChange={setCreating}
          onCreated={(s) => navigate(`/skills/${encodeURIComponent(s.code)}`)}
        />
      )}
    </div>
  );
}
