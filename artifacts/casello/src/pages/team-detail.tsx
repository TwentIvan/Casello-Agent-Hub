import { type MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
import { usePanelSubject } from "@/components/panel/panel-context";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FolderSearch } from "lucide-react";
import {
  ApiError,
  type TeamInstance,
  type TeamInstanceSave,
  getGetTeamInstanceQueryKey,
  getGetDashboardStatsQueryKey,
  getGetTeamInstanceUpdatesQueryKey,
  getGetTeamPlanQueryKey,
  getGetAppQueryKey,
  getListPendingActionsQueryKey,
  getListTeamEventsQueryKey,
  getListTeamTasksQueryKey,
  getListTeamTurnsQueryKey,
  getListUnreadTeamEventsQueryKey,
  getListTeamInstancesQueryKey,
  getListTeamTemplatesQueryKey,
  useActivateTeamInstance,
  useCloseTeamInstance,
  useGetApp,
  useGetTeamInstance,
  useGetTeamPlan,
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
import { LuciusButton } from "@/components/characters/lucius-button";
import { LeadMessageCard } from "@/components/teams/lead-message";
import { PlanApprovalCards } from "@/components/teams/plan-approval-card";
import { PlanCard } from "@/components/teams/plan-card";
import { TEAM_POLL_MS, TeamActivity, type TeamWorkState, useTeamWork } from "@/components/teams/team-activity";
import { TeamBudgetCard } from "@/components/teams/team-budget";
import { TeamAttachments } from "@/components/teams/team-attachments";
import { NodeFolderPicker } from "@/components/teams/node-folder-picker";
import { TeamBulletin } from "@/components/teams/team-bulletin";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";

function toSave(
  name: string,
  refTitle: string,
  roles: RoleDraft[],
  localSkills: LocalSkillDraft[],
  nodeWorkspace: string,
): TeamInstanceSave {
  return {
    nodeWorkspace: nodeWorkspace.trim() === "" ? null : nodeWorkspace.trim(),
    name: name.trim(),
    refTitle: refTitle.trim(),
    roles: withKeys(roles).map(toInstanceRole),
    localSkills: localSkills.map(toLocalSkill),
  };
}

type Confirm = "activate" | "close" | null;

/** Stato della squadra che sopravvive al rimontaggio dell'editor: polling del lavoro e testo non inviato al capo. */
interface TeamSession {
  work: TeamWorkState;
  leadText: string;
  setLeadText: (text: string) => void;
}

/**
 * Polling del lavoro della squadra (fuori dall'editor, che si rimonta a ogni salvataggio). Quando turni e compiti
 * tornano fermi si rileggono una volta PLAN, turni, compiti, bollettino e coda; il polling prosegue ancora per il periodo
 * di grazia, perché il turno del capo che segue un compito finito viene accodato subito dopo.
 */
function useTeamSession(teamId: number): TeamSession {
  const queryClient = useQueryClient();
  const work = useTeamWork(teamId);
  const [leadText, setLeadText] = useState("");
  const wasLive = useRef(work.live);
  useEffect(() => {
    if (wasLive.current && !work.live) {
      void queryClient.invalidateQueries({ queryKey: getListTeamTurnsQueryKey(teamId) });
      void queryClient.invalidateQueries({ queryKey: getListTeamTasksQueryKey(teamId) });
      void queryClient.invalidateQueries({ queryKey: getGetTeamPlanQueryKey(teamId) });
      void queryClient.invalidateQueries({ queryKey: getListTeamEventsQueryKey(teamId) });
      void queryClient.invalidateQueries({ queryKey: getListUnreadTeamEventsQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getListPendingActionsQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
    }
    wasLive.current = work.live;
  }, [work.live, queryClient, teamId]);
  return { work, leadText, setLeadText };
}

/**
 * Lavoro della squadra: piano da approvare, piano, messaggi al capo, attività, bollettino e tetto di spesa. Finché un
 * turno o un compito è in coda o in corso (e per il periodo di grazia dopo) tutte le sezioni si aggiornano ogni 5 secondi.
 */
function TeamWork({ team, dirty, session }: { team: TeamInstance; dirty: boolean; session: TeamSession }) {
  const { work } = session;
  const poll = work.polling ? TEAM_POLL_MS : false;
  const plan = useGetTeamPlan(team.id, { query: { queryKey: getGetTeamPlanQueryKey(team.id) } });
  const taskTitles = useMemo(() => new Map((plan.data?.tasks ?? []).map((t) => [t.id, t.title])), [plan.data]);
  const usedTaskIds = useMemo(() => (work.tasks.data ?? []).map((t) => t.planTaskId), [work.tasks.data]);

  return (
    <>
      <PlanApprovalCards team={team} poll={poll} onDecided={work.kick} />
      <PlanCard team={team} poll={poll} usedTaskIds={usedTaskIds} onSaved={work.kick} />
      <LeadMessageCard team={team} text={session.leadText} onTextChange={session.setLeadText} onSent={work.kick} />
      <TeamActivity team={team} work={work} taskTitles={taskTitles} />
      <TeamBulletin teamId={team.id} poll={poll} />
      <TeamBudgetCard team={team} dirty={dirty} />
    </>
  );
}

/** Squadra caricata: la sessione resta, l'editor si rimonta a ogni salvataggio e riparte dallo stato salvato. */
function TeamDetail({ team }: { team: TeamInstance }) {
  const session = useTeamSession(team.id);
  // il pannello dei personaggi è globale: accettare una scheda cambia `updatedAt` e rimonta l'editor, ma non chiude la conversazione
  const dirtyRef = useRef(false);
  usePanelSubject({
    lucius: { kind: "team", instanceId: team.id, closed: team.status === "closed" },
    hasUnsavedChanges: () => dirtyRef.current,
  });
  return (
    <div className="space-y-6">
      <TeamEditor key={`${team.id}-${team.updatedAt}`} team={team} session={session} dirtyRef={dirtyRef} />
    </div>
  );
}

function TeamEditor({
  team,
  session,
  dirtyRef,
}: {
  team: TeamInstance;
  session: TeamSession;
  dirtyRef: MutableRefObject<boolean>;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(team.name);
  const [refTitle, setRefTitle] = useState(team.ref.title);
  const [nodeWorkspace, setNodeWorkspace] = useState(team.nodeWorkspace ?? "");
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [roles, setRoles] = useState<RoleDraft[]>(() => team.roles.map(draftFromView));
  const [localSkills, setLocalSkills] = useState<LocalSkillDraft[]>(() => team.localSkills.map(localSkillDraft));
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [savingAsTemplate, setSavingAsTemplate] = useState(false);
  const closed = team.status === "closed";
  // Il codice ai ruoli si dà solo se l'App di riferimento ha il repository collegato tramite l'App GitHub; finché l'App
  // non è letta (o la lettura fallisce) la tendina resta attiva: decide comunque il server al salvataggio
  const refApp = useGetApp(team.ref.appId, { query: { queryKey: getGetAppQueryKey(team.ref.appId) } });
  const codeEnabled = !refApp.data || (refApp.data.sourceType === "github" && refApp.data.sourceInstallationId !== null);

  const savedJson = useMemo(
    () =>
      JSON.stringify(
        toSave(team.name, team.ref.title, team.roles.map(draftFromView), team.localSkills.map(localSkillDraft), team.nodeWorkspace ?? ""),
      ),
    [team],
  );
  const current = toSave(name, refTitle, roles, localSkills, nodeWorkspace);
  const dirty = savedJson !== JSON.stringify(current);
  dirtyRef.current = dirty;

  const onUpdated = (saved: TeamInstance) => {
    queryClient.setQueryData(getGetTeamInstanceQueryKey(saved.id), saved);
    void queryClient.invalidateQueries({ queryKey: getListTeamInstancesQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetTeamInstanceUpdatesQueryKey(saved.id) });
    setConfirm(null);
  };

  const save = useSaveTeamInstance({
    mutation: {
      onSuccess: (saved) => {
        onUpdated(saved);
        toast({ title: "Squadra salvata" });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });
  const activate = useActivateTeamInstance({
    mutation: {
      onSuccess: (saved) => {
        onUpdated(saved);
        // Il primo turno del capo è in coda: l'attività riparte e la pagina si aggiorna da sola
        void queryClient.invalidateQueries({ queryKey: getListTeamTurnsQueryKey(saved.id) });
        void queryClient.invalidateQueries({ queryKey: getGetTeamPlanQueryKey(saved.id) });
        session.work.kick();
        toast({ title: "Squadra attivata", description: "Il capo riceve il primo turno e propone il piano." });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Attivazione non riuscita", description: apiErrorMessage(error) }),
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

  const submit = () => save.mutate({ id: team.id, data: current });

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
          <h2 className="break-words text-h2">{team.name}</h2>
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
          <LuciusButton />
          {!closed && (
            <Button onClick={() => submit()} disabled={!dirty || save.isPending}>
              {save.isPending ? "Salvataggio…" : "Salva"}
            </Button>
          )}
          {team.status === "draft" && (
            <Button
              variant="outline"
              onClick={() => setConfirm("activate")}
              disabled={dirty}
              title={dirty ? "Salva le modifiche prima di attivare" : undefined}
            >
              Attiva
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Spazio di lavoro sul nodo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <Label htmlFor="team-node-workspace">Cartella</Label>
          <div className="flex min-w-0 gap-2">
            <Input
              id="team-node-workspace"
              value={nodeWorkspace}
              onChange={(e) => setNodeWorkspace(e.target.value)}
              maxLength={300}
              placeholder="es. SAP/AIMAG/WI_1174"
              className="min-w-0 font-mono text-sm"
              disabled={closed}
            />
            {!closed && (
              <Button type="button" variant="outline" className="shrink-0" onClick={() => setFolderPickerOpen(true)}>
                <FolderSearch className="mr-1.5 h-4 w-4" />
                Sfoglia
              </Button>
            )}
          </div>
          <NodeFolderPicker open={folderPickerOpen} onOpenChange={setFolderPickerOpen} value={nodeWorkspace} onPick={setNodeWorkspace} />
          <p className="text-xs text-muted-foreground">
            Percorso relativo alla cartella radice scelta quando hai installato il nodo (solo lettere, cifre, <span className="font-mono">. _ -</span> e{" "}
            <span className="font-mono">/</span>, senza <span className="font-mono">..</span>). Serve ai compiti dei ruoli «nodo»: se è vuoto
            risultano bloccati. «Sfoglia» mostra le cartelle che il nodo ha sotto la radice. Si salva con «Salva».
          </p>
        </CardContent>
      </Card>

      <TeamAttachments teamId={team.id} readOnly={closed} />

      <TeamWork team={team} dirty={dirty} session={session} />

      {!closed && <TeamUpdatesCard team={team} dirty={dirty} />}

      <section className="space-y-3">
        <h3 className="text-lg font-medium">Ruoli</h3>
        <RolesEditor roles={roles} onChange={setRoles} mode="instance" localSkills={localOptions} readOnly={closed} teamId={team.id} codeEnabled={codeEnabled} />
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-lg font-medium">Skill specializzate</h3>
          <p className="text-sm text-muted-foreground">Proprie di questa squadra, senza versioni: si modificano qui.</p>
        </div>
        <LocalSkillsEditor skills={localSkills} onChange={setLocalSkills} onRemove={removeLocalSkill} readOnly={closed} />
      </section>

      <ConfirmDialog
        open={confirm === "activate"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Attivare la squadra?"
        description="La squadra passa da bozza ad attiva: il capo riceve il primo turno e propone il piano da approvare."
        confirmLabel="Attiva"
        pendingLabel="Attivazione…"
        pending={activate.isPending}
        onConfirm={() => activate.mutate({ id: team.id })}
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
        <TeamDetail key={t.id} team={t} />
      )}
    </div>
  );
}
