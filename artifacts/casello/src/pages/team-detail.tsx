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
  useGetTeamReadiness,
  getGetTeamReadinessQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent } from "@/components/ui/tabs";
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
import { TeamUpdatesCard } from "@/components/teams/team-updates-card";
import { LuciusButton } from "@/components/characters/lucius-button";
import { LEAD_MESSAGE_INPUT_ID, LeadMessageCard } from "@/components/teams/lead-message";
import { PlanApprovalCards } from "@/components/teams/plan-approval-card";
import { PlanCard } from "@/components/teams/plan-card";
import { TEAM_POLL_MS, TeamActivity, type TeamWorkState, useTeamWork } from "@/components/teams/team-activity";
import { TeamBudgetCard } from "@/components/teams/team-budget";
import { TeamAttachments } from "@/components/teams/team-attachments";
import { NodeFolderPicker } from "@/components/teams/node-folder-picker";
import { TeamReadinessCard } from "@/components/teams/team-readiness-card";
import { activateLabel, blockingProblems } from "@/lib/team-readiness";
import { TeamBulletin } from "@/components/teams/team-bulletin";
import { TeamStatusBar } from "@/components/teams/team-status-bar";
import type { TeamTab } from "@/lib/team-status-bar";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";

function toSave(
  name: string,
  refTitle: string,
  roles: RoleDraft[],
  localSkills: LocalSkillDraft[],
  nodeWorkspace: string,
  bugTeam: boolean,
): TeamInstanceSave {
  return {
    bugTeam,
    nodeWorkspace: nodeWorkspace.trim() === "" ? null : nodeWorkspace.trim(),
    name: name.trim(),
    refTitle: refTitle.trim(),
    roles: withKeys(roles).map(toInstanceRole),
    localSkills: localSkills.map(toLocalSkill),
  };
}

type Confirm = "activate" | "close" | null;

/**
 * Stato della squadra che sopravvive al rimontaggio dell'editor: polling del lavoro, testo non inviato al capo, scheda
 * aperta e titoli dei compiti del PLAN (per la barra di stato).
 */
interface TeamSession {
  work: TeamWorkState;
  leadText: string;
  setLeadText: (text: string) => void;
  tab: TeamTab;
  setTab: (tab: TeamTab) => void;
  taskTitles: ReadonlyMap<string, string>;
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
  const [tab, setTab] = useState<TeamTab>("overview");
  const plan = useGetTeamPlan(teamId, { query: { queryKey: getGetTeamPlanQueryKey(teamId) } });
  const taskTitles = useMemo(() => new Map((plan.data?.tasks ?? []).map((t) => [t.id, t.title])), [plan.data]);
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
  return { work, leadText, setLeadText, tab, setTab, taskTitles };
}

/** Panoramica: App e lavoro di riferimento in sola lettura (si modificano in Impostazioni). */
function TeamOverview({ team }: { team: TeamInstance }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Lavoro di riferimento</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
          <dt className="text-muted-foreground">App</dt>
          <dd className="min-w-0 truncate">
            <Link href={`/apps/${team.ref.appId}`} className="font-medium hover:underline">
              {team.ref.appName}
            </Link>
          </dd>
          <dt className="text-muted-foreground">Lavoro</dt>
          <dd className="min-w-0 break-words">{team.ref.title}</dd>
          <dt className="text-muted-foreground">Riferimento</dt>
          <dd className="min-w-0 break-all font-mono text-xs leading-5">
            {team.ref.type} · {team.ref.id}
          </dd>
          {team.bugTeam && (
            <>
              <dt className="text-muted-foreground">Bug</dt>
              <dd className="min-w-0">Squadra per i bug di questa App</dd>
            </>
          )}
        </dl>
      </CardContent>
    </Card>
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
  const [bugTeam, setBugTeam] = useState(team.bugTeam);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [roles, setRoles] = useState<RoleDraft[]>(() => team.roles.map(draftFromView));
  const [localSkills, setLocalSkills] = useState<LocalSkillDraft[]>(() => team.localSkills.map(localSkillDraft));
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [savingAsTemplate, setSavingAsTemplate] = useState(false);
  const closed = team.status === "closed";
  const { work } = session;
  const poll = work.polling ? TEAM_POLL_MS : false;
  const usedTaskIds = useMemo(() => (work.tasks.data ?? []).map((t) => t.planTaskId), [work.tasks.data]);
  // Il codice ai ruoli si dà solo se l'App di riferimento ha il repository collegato tramite l'App GitHub; finché l'App
  // non è letta (o la lettura fallisce) la tendina resta attiva: decide comunque il server al salvataggio
  const refApp = useGetApp(team.ref.appId, { query: { queryKey: getGetAppQueryKey(team.ref.appId) } });
  const codeEnabled = !refApp.data || (refApp.data.sourceType === "github" && refApp.data.sourceInstallationId !== null);

  // «Pronta a lavorare»: con ruoli `node` o con codice (CI sui branch botcave/**) salvati, si rilegge ogni 30 s e dopo ogni salvataggio
  const hasNodeRoles = team.roles.some((r) => r.runsOn === "node" || (!r.isLead && (r.code ?? "none") !== "none"));
  const readiness = useGetTeamReadiness(team.id, {
    query: { queryKey: getGetTeamReadinessQueryKey(team.id), enabled: hasNodeRoles && !closed, refetchInterval: 30_000 },
  });
  const readinessData = hasNodeRoles && !closed ? readiness.data : undefined;
  const blocking = readinessData ? blockingProblems(readinessData) : [];

  const savedJson = useMemo(
    () =>
      JSON.stringify(
        toSave(team.name, team.ref.title, team.roles.map(draftFromView), team.localSkills.map(localSkillDraft), team.nodeWorkspace ?? "", team.bugTeam),
      ),
    [team],
  );
  const current = toSave(name, refTitle, roles, localSkills, nodeWorkspace, bugTeam);
  const dirty = savedJson !== JSON.stringify(current);
  dirtyRef.current = dirty;

  const onUpdated = (saved: TeamInstance) => {
    queryClient.setQueryData(getGetTeamInstanceQueryKey(saved.id), saved);
    void queryClient.invalidateQueries({ queryKey: getListTeamInstancesQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetTeamInstanceUpdatesQueryKey(saved.id) });
    void queryClient.invalidateQueries({ queryKey: getGetTeamReadinessQueryKey(saved.id) });
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

  const writeToLead = () => {
    session.setTab("messages");
    // la scheda Messaggi si monta al cambio: il campo esiste dal frame successivo
    requestAnimationFrame(() => document.getElementById(LEAD_MESSAGE_INPUT_ID)?.focus());
  };

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-h2">{team.name}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
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

      <Tabs value={session.tab} onValueChange={(value) => session.setTab(value as TeamTab)} className="space-y-4">
        <TeamStatusBar
          team={team}
          work={work}
          taskTitles={session.taskTitles}
          dirty={dirty}
          onWriteToLead={writeToLead}
        />

        <TabsContent value="overview" className="mt-0 space-y-6">
          <TeamOverview team={team} />
          {readinessData && <TeamReadinessCard readiness={readinessData} />}
          <PlanApprovalCards team={team} poll={poll} onDecided={work.kick} />
          <TeamBulletin teamId={team.id} poll={poll} />
          <TeamBudgetCard team={team} dirty={dirty} />
        </TabsContent>

        <TabsContent value="plan" className="mt-0 space-y-6">
          <PlanApprovalCards team={team} poll={poll} onDecided={work.kick} />
          <PlanCard team={team} poll={poll} usedTaskIds={usedTaskIds} onSaved={work.kick} />
          <TeamAttachments teamId={team.id} readOnly={closed} />
        </TabsContent>

        <TabsContent value="activity" className="mt-0 space-y-6">
          <TeamActivity team={team} work={work} taskTitles={session.taskTitles} />
        </TabsContent>

        <TabsContent value="messages" className="mt-0 space-y-6">
          <LeadMessageCard team={team} text={session.leadText} onTextChange={session.setLeadText} onSent={work.kick} />
        </TabsContent>

        {/* forceMount: le modifiche non salvate (ruoli, skill, campi) restano anche cambiando scheda */}
        <TabsContent value="settings" forceMount className="mt-0 space-y-6 data-[state=inactive]:hidden">
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
              <div className="flex items-start gap-2">
                <Checkbox
                  id="team-bug-team"
                  checked={bugTeam}
                  onCheckedChange={(v) => setBugTeam(v === true)}
                  disabled={closed}
                  className="mt-0.5"
                />
                <div className="min-w-0">
                  <Label htmlFor="team-bug-team">Squadra per i bug di questa App</Label>
                  <p className="text-xs text-muted-foreground">
                    Le segnalazioni approvate dall'app ({team.ref.appName}) vengono affidate a questa squadra: serve che sia attiva. Una sola squadra
                    per App; se ce n'è già un'altra il salvataggio lo dice. Si salva con «Salva».
                  </p>
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
                risultano bloccati, salvo i ruoli con il codice (lavorano in una copia preparata da Botcave). «Sfoglia» mostra le cartelle che il nodo ha sotto la radice. Si salva con «Salva».
              </p>
            </CardContent>
          </Card>

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
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirm === "activate"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Attivare la squadra?"
        description={
          <>
            La squadra passa da bozza ad attiva: il capo riceve il primo turno e propone il piano da approvare.
            {blocking.length > 0 && (
              <span className="mt-3 block space-y-1">
                <span className="block font-medium text-ink">Questi ruoli non potranno lavorare finché non li sistemi:</span>
                <span className="block space-y-0.5">
                  {blocking.map((b, i) => (
                    <span key={i} className="block break-words">
                      {b.roleName}: {b.message}
                    </span>
                  ))}
                </span>
              </span>
            )}
          </>
        }
        confirmLabel={activateLabel(readinessData)}
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
