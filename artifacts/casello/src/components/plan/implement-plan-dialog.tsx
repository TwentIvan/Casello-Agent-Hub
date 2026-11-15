import { useMemo, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  type AnalysisItem,
  type TeamInstance,
  getGetTeamInstanceQueryKey,
  getGetTeamPlanQueryKey,
  getGetTeamReadinessQueryKey,
  getGetTeamReadinessQueryOptions,
  getListTeamInstancesQueryKey,
  getListTeamTemplatesQueryKey,
  getListTeamTurnsQueryKey,
  useActivateTeamInstance,
  useCreateTeamInstance,
  useGetTeamReadiness,
  useListTeamInstances,
  useListTeamTemplates,
  useSendTeamMessage,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CHAPTER_LABELS, dependencyOrder, itemTitle } from "@/components/analysis/payload";
import { TeamStatusBadge } from "@/components/teams/team-status";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { blockingProblems } from "@/lib/team-readiness";
import {
  IMPLEMENT_CHAPTERS,
  implementableItems,
  implementMessage,
  implementTeams,
  planTeamRef,
} from "@/lib/implement-plan";

const NEW_TEAM = "new";

interface ImplementPlanDialogProps {
  appId: number;
  appName: string;
  items: AnalysisItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * «Implementa»: sceglie una squadra dell'App (o ne crea una da un modello) e le affida il piano. Una squadra in bozza
 * si attiva, poi il capo riceve il messaggio con le voci scelte (nessuna = tutto il piano approvato) e si apre la sua scheda.
 */
export function ImplementPlanDialog({ appId, appName, items, open, onOpenChange }: ImplementPlanDialogProps) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const teams = useListTeamInstances(
    { appId },
    { query: { queryKey: getListTeamInstancesQueryKey({ appId }), enabled: open } },
  );
  const templates = useListTeamTemplates(undefined, { query: { queryKey: getListTeamTemplatesQueryKey(), enabled: open } });
  const candidates = useMemo(() => implementTeams(teams.data ?? [], appId), [teams.data, appId]);

  const [choice, setChoice] = useState<string>("");
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState(`Piano · ${appName}`.slice(0, 120));
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);

  // Squadra preselezionata: la prima attiva o in bozza, altrimenti una nuova
  const effective = choice || (candidates[0] ? String(candidates[0].id) : teams.data ? NEW_TEAM : "");
  const selectedTeam = candidates.find((t) => String(t.id) === effective) ?? null;
  const isNew = effective === NEW_TEAM;

  const draftWithNode = selectedTeam?.status === "draft" && selectedTeam.roles.some((r) => r.runsOn === "node");
  const readiness = useGetTeamReadiness(selectedTeam?.id ?? 0, {
    query: { queryKey: getGetTeamReadinessQueryKey(selectedTeam?.id ?? 0), enabled: open && draftWithNode },
  });
  const blocking = draftWithNode && readiness.data ? blockingProblems(readiness.data) : [];

  const ordered = useMemo(() => {
    const own = implementableItems(items);
    return IMPLEMENT_CHAPTERS.flatMap((chapter) => {
      const list = own.filter((i) => i.chapter === chapter);
      return chapter === "completion" ? dependencyOrder(list) : list;
    });
  }, [items]);
  const chosen = ordered.filter((i) => picked.has(i.id));

  const create = useCreateTeamInstance();
  const activate = useActivateTeamInstance();
  const send = useSendTeamMessage();

  const toggle = (id: number, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** Attiva (se in bozza), manda la richiesta al capo e apre la scheda della squadra. */
  const hand = async (team: TeamInstance) => {
    if (team.status === "draft") {
      await activate.mutateAsync({ id: team.id });
      void queryClient.invalidateQueries({ queryKey: getGetTeamPlanQueryKey(team.id) });
    }
    const text = implementMessage(
      appName,
      chosen.map((i) => ({ id: i.id, title: itemTitle(i), issueNumber: i.issue?.number ?? null })),
    );
    await send.mutateAsync({ id: team.id, data: { text } });
    void queryClient.invalidateQueries({ queryKey: getGetTeamInstanceQueryKey(team.id) });
    void queryClient.invalidateQueries({ queryKey: getListTeamTurnsQueryKey(team.id) });
    void queryClient.invalidateQueries({ queryKey: getListTeamInstancesQueryKey() });
    toast({
      title: team.status === "draft" ? "Squadra attivata" : "Richiesta inviata al capo",
      description: `Il capo di «${team.name}» legge il piano e propone i compiti da approvare.`,
    });
    onOpenChange(false);
    navigate(`/teams/${team.id}`);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    let created: TeamInstance | null = null;
    try {
      if (isNew) {
        created = await create.mutateAsync({
          data: { templateId: Number(templateId), name: name.trim(), ref: planTeamRef(appId, appName) },
        });
        void queryClient.invalidateQueries({ queryKey: getListTeamInstancesQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getListTeamTemplatesQueryKey() });
        // Con ruoli sul nodo si controlla prima che possano lavorare: con dei problemi la squadra resta in bozza,
        // selezionata nel dialogo con l'elenco, e si attiva con «Attiva comunque»
        if (created.roles.some((r) => r.runsOn === "node")) {
          const check = await queryClient.fetchQuery(getGetTeamReadinessQueryOptions(created.id));
          if (blockingProblems(check).length > 0) {
            await queryClient.invalidateQueries({ queryKey: getListTeamInstancesQueryKey({ appId }) });
            setChoice(String(created.id));
            toast({ title: "Squadra creata in bozza", description: "Alcuni ruoli non potranno lavorare: controlla prima di attivarla." });
            return;
          }
        }
        await hand(created);
        return;
      }
      if (selectedTeam) await hand(selectedTeam);
    } catch (error) {
      if (created) {
        // La squadra esiste già: un nuovo tentativo deve usarla, non crearne un'altra
        await queryClient.invalidateQueries({ queryKey: getListTeamInstancesQueryKey({ appId }) });
        setChoice(String(created.id));
      }
      toast({ variant: "destructive", title: "Squadra non avviata", description: apiErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const ready = isNew ? templateId !== "" && name.trim() !== "" : selectedTeam !== null;
  const confirmLabel = busy
    ? "Invio…"
    : isNew
      ? "Crea la squadra e implementa"
      : selectedTeam?.status === "draft"
        ? blocking.length > 0
          ? "Attiva comunque e implementa"
          : "Attiva e implementa"
        : "Manda al capo";

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Implementa il piano</DialogTitle>
            <DialogDescription>
              Una squadra di {appName} lavora sulle voci approvate: il capo le legge, propone il PLAN da approvare e assegna i compiti.
            </DialogDescription>
          </DialogHeader>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Squadra</legend>
            {teams.isError ? (
              <p className="text-sm text-destructive">Impossibile caricare le squadre: {apiErrorMessage(teams.error)}</p>
            ) : !teams.data ? (
              <p className="text-sm text-muted-foreground">Caricamento…</p>
            ) : (
              <RadioGroup value={effective} onValueChange={setChoice} className="gap-1">
                {candidates.map((t) => (
                  <Label
                    key={t.id}
                    className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 font-normal"
                  >
                    <RadioGroupItem value={String(t.id)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{t.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{t.ref.title}</span>
                    </span>
                    <TeamStatusBadge status={t.status} />
                  </Label>
                ))}
                <Label className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 font-normal">
                  <RadioGroupItem value={NEW_TEAM} />
                  <span className="text-sm">Nuova squadra da un modello</span>
                </Label>
              </RadioGroup>
            )}
            {isNew && (
              <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="implement-template">Modello</Label>
                  <Select value={templateId} onValueChange={setTemplateId}>
                    <SelectTrigger id="implement-template">
                      <SelectValue placeholder={templates.isLoading ? "Caricamento…" : "Scegli un modello"} />
                    </SelectTrigger>
                    <SelectContent>
                      {(templates.data ?? []).map((t) => (
                        <SelectItem key={t.id} value={String(t.id)}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {templates.data?.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Nessun modello:{" "}
                      <Link href="/team-templates" className="underline underline-offset-2">
                        creane uno
                      </Link>
                      .
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="implement-name">Nome</Label>
                  <Input id="implement-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
                </div>
              </div>
            )}
            {blocking.length > 0 && (
              <div className="space-y-1 rounded-md border p-3 text-sm">
                <p className="font-medium text-ink">Questi ruoli non potranno lavorare finché non li sistemi:</p>
                {blocking.map((b, i) => (
                  <p key={i} className="break-words text-muted-foreground">
                    {b.roleName}: {b.message}
                  </p>
                ))}
              </div>
            )}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Voci da implementare</legend>
            <p className="text-xs text-muted-foreground">
              {chosen.length === 0
                ? `Nessuna voce scelta: tutto il piano approvato (${ordered.length} voci).`
                : `${chosen.length} voci scelte su ${ordered.length}.`}
            </p>
            {ordered.length > 0 && (
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
                {ordered.map((item) => (
                  <label key={item.id} className="flex cursor-pointer items-start gap-3 rounded px-1 py-1 text-sm">
                    <Checkbox
                      className="mt-0.5"
                      checked={picked.has(item.id)}
                      onCheckedChange={(checked) => toggle(item.id, checked === true)}
                    />
                    <span className="min-w-0 flex-1 break-words">{itemTitle(item)}</span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {CHAPTER_LABELS[item.chapter]}
                      {item.issue ? ` · #${item.issue.number}` : ""}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Annulla
            </Button>
            <Button type="submit" disabled={!ready || busy}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
