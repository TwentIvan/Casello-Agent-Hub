import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import {
  ApiError,
  type TeamInstance,
  type TeamInstanceSave,
  type TeamInstanceSaveStatus,
  getGetTeamInstanceQueryKey,
  getGetTeamInstanceUpdatesQueryKey,
  getListTeamInstancesQueryKey,
  getListTeamTemplatesQueryKey,
  useCloseTeamInstance,
  useGetTeamInstance,
  useSaveTeamInstance,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  type LocalSkillDraft,
  LocalSkillsEditor,
  localSkillDraft,
  toLocalSkill,
} from "@/components/teams/local-skills-editor";
import { type RoleDraft, draftFromView, toInstanceRole, withKeys } from "@/components/teams/role-draft";
import { RolesEditor } from "@/components/teams/roles-editor";
import { SaveAsTemplateDialog } from "@/components/teams/save-as-template-dialog";
import { TeamStatusBadge } from "@/components/teams/team-status";
import { TeamUpdatesCard } from "@/components/teams/team-updates-card";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";

function toSave(name: string, refTitle: string, roles: RoleDraft[], localSkills: LocalSkillDraft[]): TeamInstanceSave {
  return {
    name: name.trim(),
    refTitle: refTitle.trim(),
    roles: withKeys(roles).map(toInstanceRole),
    localSkills: localSkills.map(toLocalSkill),
  };
}

type Confirm = "activate" | "close" | null;

function TeamEditor({ team }: { team: TeamInstance }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(team.name);
  const [refTitle, setRefTitle] = useState(team.ref.title);
  const [roles, setRoles] = useState<RoleDraft[]>(() => team.roles.map(draftFromView));
  const [localSkills, setLocalSkills] = useState<LocalSkillDraft[]>(() => team.localSkills.map(localSkillDraft));
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [savingAsTemplate, setSavingAsTemplate] = useState(false);
  const closed = team.status === "closed";

  const savedJson = useMemo(
    () =>
      JSON.stringify(
        toSave(team.name, team.ref.title, team.roles.map(draftFromView), team.localSkills.map(localSkillDraft)),
      ),
    [team],
  );
  const current = toSave(name, refTitle, roles, localSkills);
  const dirty = savedJson !== JSON.stringify(current);

  const onUpdated = (saved: TeamInstance) => {
    queryClient.setQueryData(getGetTeamInstanceQueryKey(saved.id), saved);
    void queryClient.invalidateQueries({ queryKey: getListTeamInstancesQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetTeamInstanceUpdatesQueryKey(saved.id) });
    setConfirm(null);
  };

  const save = useSaveTeamInstance({
    mutation: {
      onSuccess: (saved, vars) => {
        onUpdated(saved);
        const status = vars.data.status;
        toast({
          title: status === "active" ? "Squadra attivata" : status === "draft" ? "Squadra riportata in bozza" : "Squadra salvata",
        });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });
  const close = useCloseTeamInstance({
    mutation: {
      onSuccess: (saved) => {
        onUpdated(saved);
        void queryClient.invalidateQueries({ queryKey: getListTeamTemplatesQueryKey() });
        toast({ title: "Squadra chiusa" });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Chiusura non riuscita", description: apiErrorMessage(error) }),
    },
  });

  const submit = (status?: TeamInstanceSaveStatus) =>
    save.mutate({ id: team.id, data: { ...current, ...(status && { status }) } });

  const removeLocalSkill = (skill: LocalSkillDraft) => {
    setLocalSkills((prev) => prev.filter((s) => s.uid !== skill.uid));
    if (skill.code) setRoles((prev) => prev.map((r) => ({ ...r, localSkills: r.localSkills.filter((c) => c !== skill.code) })));
  };
  const localOptions = localSkills
    .filter((s) => s.code.trim() !== "")
    .map((s) => ({ code: s.code.trim(), name: s.name || s.code }));

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-2xl font-semibold tracking-tight">{team.name}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <TeamStatusBadge status={team.status} />
            {team.template ? (
              <span>
                Dal modello{" "}
                <Link href={`/team-templates/${team.template.id}`} className="font-medium text-foreground hover:underline">
                  {team.template.name}
                </Link>{" "}
                · v{team.template.version}
              </span>
            ) : (
              <span>Creata da zero</span>
            )}
            <span>· aggiornata {formatRelative(team.updatedAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!closed && (
            <Button onClick={() => submit()} disabled={!dirty || save.isPending}>
              {save.isPending ? "Salvataggio…" : "Salva"}
            </Button>
          )}
          {team.status === "draft" && (
            <Button variant="outline" onClick={() => setConfirm("activate")}>
              Attiva
            </Button>
          )}
          {team.status === "active" && (
            <Button variant="outline" onClick={() => submit("draft")} disabled={save.isPending}>
              Riporta in bozza
            </Button>
          )}
          <Button variant="outline" onClick={() => setSavingAsTemplate(true)} disabled={dirty}>
            Salva come modello
          </Button>
          {!closed && (
            <Button variant="outline" onClick={() => setConfirm("close")}>
              Chiudi
            </Button>
          )}
        </div>
      </div>
      {dirty && <p className="text-sm text-muted-foreground">Modifiche non salvate.</p>}
      {closed && (
        <p className="text-sm text-muted-foreground">
          Squadra chiusa {team.closedAt ? formatRelative(team.closedAt) : ""}: resta in sola lettura e non riceve aggiornamenti.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lavoro di riferimento</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
            <dt className="text-muted-foreground">App</dt>
            <dd className="min-w-0 truncate">
              <Link href={`/apps/${team.ref.appId}`} className="font-medium hover:underline">
                {team.ref.appName}
              </Link>
            </dd>
            <dt className="text-muted-foreground">Lavoro</dt>
            <dd className="min-w-0 break-all font-mono text-xs leading-5">
              {team.ref.type} · {team.ref.id}
            </dd>
          </dl>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="team-name">Nome della squadra</Label>
              <Input id="team-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} disabled={closed} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="team-ref-title">Titolo del lavoro</Label>
              <Input
                id="team-ref-title"
                value={refTitle}
                onChange={(e) => setRefTitle(e.target.value)}
                maxLength={300}
                disabled={closed}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {!closed && <TeamUpdatesCard team={team} dirty={dirty} />}

      <section className="space-y-3">
        <h3 className="text-lg font-semibold">Ruoli</h3>
        <RolesEditor roles={roles} onChange={setRoles} mode="instance" localSkills={localOptions} readOnly={closed} />
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-lg font-semibold">Skill specializzate</h3>
          <p className="text-sm text-muted-foreground">Proprie di questa squadra, senza versioni: si modificano qui.</p>
        </div>
        <LocalSkillsEditor skills={localSkills} onChange={setLocalSkills} onRemove={removeLocalSkill} readOnly={closed} />
      </section>

      <ConfirmDialog
        open={confirm === "activate"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Attivare la squadra?"
        description={
          dirty ? "Le modifiche non salvate vengono salvate insieme all'attivazione." : "La squadra passa da bozza ad attiva."
        }
        confirmLabel="Attiva"
        pendingLabel="Attivazione…"
        pending={save.isPending}
        onConfirm={() => submit("active")}
      />
      <ConfirmDialog
        open={confirm === "close"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Chiudere la squadra?"
        description={
          dirty
            ? "Una squadra chiusa non si riapre e non si modifica più: le modifiche non salvate vanno perse."
            : "Una squadra chiusa non si riapre e non si modifica più."
        }
        confirmLabel="Chiudi"
        pendingLabel="Chiusura…"
        pending={close.isPending}
        onConfirm={() => close.mutate({ id: team.id })}
      />
      {savingAsTemplate && <SaveAsTemplateDialog open onOpenChange={setSavingAsTemplate} team={team} />}
    </>
  );
}

export default function TeamDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const valid = Number.isInteger(id);
  const team = useGetTeamInstance(id, { query: { queryKey: getGetTeamInstanceQueryKey(id), enabled: valid } });
  const t = team.data;
  const notFound = !valid || (team.error instanceof ApiError && team.error.status === 404);

  return (
    <div className="mx-auto max-w-screen-xl space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/teams">
          <ArrowLeft />
          Tutte le squadre
        </Link>
      </Button>
      {notFound ? (
        <p className="text-sm text-muted-foreground">Squadra non trovata.</p>
      ) : team.isError ? (
        <p className="text-sm text-destructive">Impossibile caricare la squadra: {apiErrorMessage(team.error)}</p>
      ) : !t ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        // Rimontato a ogni salvataggio: l'editor riparte dallo stato salvato
        <TeamEditor key={`${t.id}-${t.updatedAt}`} team={t} />
      )}
    </div>
  );
}
