import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import {
  type TeamInstance,
  type TeamPlan,
  type TeamPlanInput,
  getGetDashboardStatsQueryKey,
  getGetTeamPlanQueryKey,
  getListPendingActionsQueryKey,
  getListTeamTurnsQueryKey,
  useSaveTeamPlan,
} from "@workspace/api-client-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

const MAX_ITEMS = 30;
const MAX_ITEM_LENGTH = 500;
const MAX_TASKS = 50;

interface TaskDraft {
  id: string;
  title: string;
  roleKey: string;
  instructions: string;
}

/** Un elemento per riga, senza righe vuote. */
function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** Primo `t<n>` libero dopo il massimo tra quelli usati (anche dalle esecuzioni passate). */
function nextTaskId(used: Iterable<string>): string {
  let max = 0;
  for (const id of used) {
    const m = /^t(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `t${max + 1}`;
}

function listError(label: string, items: string[]): string | null {
  if (items.length > MAX_ITEMS) return `${label}: al massimo ${MAX_ITEMS} righe.`;
  if (items.some((i) => i.length > MAX_ITEM_LENGTH)) return `${label}: ogni riga al massimo ${MAX_ITEM_LENGTH} caratteri.`;
  return null;
}

/**
 * Editor del PLAN: obiettivo, vincoli, punti aperti e compiti. Il salvataggio è una correzione dell'utente: diventa
 * subito il piano approvato e il capo ne riceve notizia nel prossimo turno.
 */
export function PlanEditorDialog({
  team,
  plan,
  usedTaskIds,
  onOpenChange,
}: {
  team: TeamInstance;
  plan: TeamPlan;
  /** Id dei compiti già eseguiti in passato: un compito nuovo non li riusa. */
  usedTaskIds: string[];
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [objective, setObjective] = useState(plan.objective);
  const [constraints, setConstraints] = useState(plan.constraints.join("\n"));
  const [openPoints, setOpenPoints] = useState(plan.openPoints.join("\n"));
  const [tasks, setTasks] = useState<TaskDraft[]>(() =>
    plan.tasks.map((t) => ({ id: t.id, title: t.title, roleKey: t.roleKey, instructions: t.instructions })),
  );
  const [confirming, setConfirming] = useState(false);
  const roles = team.roles;
  const original = new Map(plan.tasks.map((t) => [t.id, t]));

  const save = useSaveTeamPlan({
    mutation: {
      onSuccess: (saved) => {
        queryClient.setQueryData(getGetTeamPlanQueryKey(team.id), saved);
        void queryClient.invalidateQueries({ queryKey: getListPendingActionsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getListTeamTurnsQueryKey(team.id) });
        toast({ title: `Piano salvato (versione ${saved.version})`, description: "È il piano approvato della squadra." });
        setConfirming(false);
        onOpenChange(false);
      },
      onError: (error) => {
        setConfirming(false);
        toast({ variant: "destructive", title: "Piano non salvato", description: apiErrorMessage(error) });
      },
    },
  });

  const constraintList = lines(constraints);
  const openPointList = lines(openPoints);
  const error =
    listError("Vincoli", constraintList) ??
    listError("Punti aperti", openPointList) ??
    (tasks.length > MAX_TASKS ? `Al massimo ${MAX_TASKS} compiti.` : null) ??
    (tasks.some((t) => t.title.trim() === "") ? "Ogni compito ha bisogno di un titolo." : null) ??
    (tasks.some((t) => t.roleKey === "") ? "Ogni compito ha bisogno di un ruolo." : null);

  const input = (): TeamPlanInput => ({
    objective: objective.trim(),
    constraints: constraintList,
    openPoints: openPointList,
    tasks: tasks.map((t) => {
      const old = original.get(t.id);
      return {
        id: t.id,
        title: t.title.trim(),
        roleKey: t.roleKey,
        instructions: t.instructions.trim(),
        // Il server conserva stato ed esito dei compiti esistenti; i nuovi partono pianificati
        status: old?.status ?? "planned",
        outcome: old?.outcome ?? null,
      };
    }),
    manualActions: plan.manualActions,
  });

  const update = (id: string, patch: Partial<TaskDraft>) =>
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const addTask = () =>
    setTasks((prev) => [
      ...prev,
      {
        id: nextTaskId([...plan.tasks.map((t) => t.id), ...prev.map((t) => t.id), ...usedTaskIds]),
        title: "",
        roleKey: roles.find((r) => !r.isLead)?.key ?? roles[0]?.key ?? "",
        instructions: "",
      },
    ]);

  return (
    <>
      <Dialog open onOpenChange={(open) => !save.isPending && onOpenChange(open)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Modifica il piano</DialogTitle>
            <DialogDescription>
              Il piano salvato diventa subito quello approvato (versione nuova); le proposte del capo ancora in coda
              vengono superate.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="plan-objective">Obiettivo</Label>
              <Textarea
                id="plan-objective"
                rows={3}
                maxLength={2000}
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="plan-constraints">Vincoli (uno per riga)</Label>
                <Textarea id="plan-constraints" rows={4} value={constraints} onChange={(e) => setConstraints(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="plan-open-points">Punti aperti (uno per riga)</Label>
                <Textarea id="plan-open-points" rows={4} value={openPoints} onChange={(e) => setOpenPoints(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium">Compiti ({tasks.length})</div>
              {tasks.length === 0 && <p className="text-sm text-muted-foreground">Nessun compito.</p>}
              {tasks.map((t) => (
                <div key={t.id} className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center gap-2">
                    <span className="w-8 shrink-0 font-mono text-xs text-muted-foreground">{t.id}</span>
                    <Input
                      aria-label={`Titolo del compito ${t.id}`}
                      placeholder="Titolo"
                      maxLength={200}
                      value={t.title}
                      onChange={(e) => update(t.id, { title: e.target.value })}
                      className="min-w-0 flex-1"
                    />
                    <Select value={t.roleKey} onValueChange={(v) => update(t.id, { roleKey: v })}>
                      <SelectTrigger className="w-44 shrink-0" aria-label={`Ruolo del compito ${t.id}`}>
                        <SelectValue placeholder="Ruolo" />
                      </SelectTrigger>
                      <SelectContent>
                        {roles.map((r) => (
                          <SelectItem key={r.key} value={r.key}>
                            {r.name}
                            {r.isLead ? " (capo)" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Togli il compito ${t.id}`}
                      onClick={() => setTasks((prev) => prev.filter((x) => x.id !== t.id))}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <Textarea
                    aria-label={`Istruzioni del compito ${t.id}`}
                    placeholder="Istruzioni per il ruolo"
                    rows={2}
                    maxLength={4000}
                    value={t.instructions}
                    onChange={(e) => update(t.id, { instructions: e.target.value })}
                  />
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addTask} disabled={tasks.length >= MAX_TASKS || roles.length === 0}>
                <Plus />
                Aggiungi compito
              </Button>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Annulla
            </Button>
            <Button onClick={() => setConfirming(true)} disabled={error !== null || save.isPending}>
              Salva
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => !open && !save.isPending && setConfirming(false)}
        title="Salvare il piano?"
        description="Il piano modificato diventa il piano approvato della squadra: le proposte del capo ancora da approvare vengono rifiutate e il capo riceve la modifica nel prossimo turno. Stato ed esito dei compiti esistenti restano quelli registrati."
        confirmLabel="Salva e approva"
        pendingLabel="Salvataggio…"
        pending={save.isPending}
        onConfirm={() => save.mutate({ id: team.id, data: input() })}
      />
    </>
  );
}
