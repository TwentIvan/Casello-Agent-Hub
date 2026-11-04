import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import {
  type TeamInstance,
  getGetTeamPlanQueryKey,
  useGetTeamPlan,
  useMarkTeamManualActionDone,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";
import { PlanEditorDialog } from "./plan-editor-dialog";
import { PlanStatusBadge, TaskStatusBadge } from "./team-work-status";

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-sm font-medium">{title}</h4>
      {children}
    </div>
  );
}

function TextList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-sm">
      {items.map((item, i) => (
        <li key={i} className="break-words">
          {item}
        </li>
      ))}
    </ul>
  );
}

/** Sezione «Piano»: il PLAN corrente della squadra, con le azioni manuali da segnare e l'editor. */
export function PlanCard({
  team,
  poll,
  usedTaskIds,
  onSaved,
}: {
  team: TeamInstance;
  poll: number | false;
  usedTaskIds: string[];
  /** Dopo il salvataggio del PLAN (che accoda un turno del capo). */
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const closed = team.status === "closed";
  const plan = useGetTeamPlan(team.id, { query: { queryKey: getGetTeamPlanQueryKey(team.id), refetchInterval: poll } });
  const roleName = (key: string) => team.roles.find((r) => r.key === key)?.name ?? key;

  const markDone = useMarkTeamManualActionDone({
    mutation: {
      onSuccess: (saved) => {
        queryClient.setQueryData(getGetTeamPlanQueryKey(team.id), saved);
        toast({ title: "Azione manuale segnata come fatta" });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Azione non aggiornata", description: apiErrorMessage(error) }),
    },
  });

  const p = plan.data;
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Piano</CardTitle>
          {p && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <PlanStatusBadge status={p.status} />
              <span>versione {p.version}</span>
              {p.status !== "approved" && p.approvedVersion !== null && (
                <span>· approvata: versione {p.approvedVersion}</span>
              )}
              <span>· aggiornato {formatRelative(p.updatedAt)}</span>
            </div>
          )}
        </div>
        {p && (
          <Button
            variant="outline"
            size="sm"
            disabled={closed}
            title={closed ? "La squadra è chiusa: il piano non si modifica più" : undefined}
            onClick={() => setEditing(true)}
          >
            Modifica
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {plan.isError && !p ? (
          <p className="text-sm text-destructive">Impossibile caricare il piano: {apiErrorMessage(plan.error)}</p>
        ) : !p ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            {p.status === "draft" && p.tasks.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {team.status === "draft"
                  ? "Nessun piano: quando attivi la squadra il capo lo propone."
                  : "Il capo non ha ancora proposto il piano."}
              </p>
            )}
            <Block title="Obiettivo">
              {p.objective ? (
                <p className="whitespace-pre-wrap break-words text-sm">{p.objective}</p>
              ) : (
                <p className="text-sm text-muted-foreground">Non ancora definito.</p>
              )}
            </Block>
            <Block title="Vincoli">
              <TextList items={p.constraints} empty="Nessun vincolo." />
            </Block>
            <Block title={`Compiti (${p.tasks.length})`}>
              {p.tasks.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nessun compito.</p>
              ) : (
                <ul className="space-y-2">
                  {p.tasks.map((t) => (
                    <li key={t.id} className="rounded-md border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">{t.id}</span>
                        <span className="min-w-0 break-words text-sm font-medium">{t.title}</span>
                        <span className="text-sm text-muted-foreground">· {roleName(t.roleKey)}</span>
                        <span className="ml-auto">
                          <TaskStatusBadge status={t.status} />
                        </span>
                      </div>
                      {t.outcome && <p className="mt-1.5 break-words text-sm">{t.outcome}</p>}
                      {t.instructions && (
                        <details className="mt-1 text-xs">
                          <summary className="cursor-pointer text-muted-foreground">Istruzioni</summary>
                          <p className="mt-1 whitespace-pre-wrap break-words">{t.instructions}</p>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Block>
            <Block title="Azioni manuali">
              {p.manualActions.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nessuna azione da fare a mano.</p>
              ) : (
                <ul className="space-y-2">
                  {p.manualActions.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                      <span className={a.done ? "min-w-0 flex-1 break-words text-muted-foreground line-through" : "min-w-0 flex-1 break-words"}>
                        {a.text}
                      </span>
                      {a.done ? (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Check className="size-3" />
                          Fatta {a.doneAt ? formatRelative(a.doneAt) : ""}
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={closed || markDone.isPending}
                          onClick={() => markDone.mutate({ id: team.id, actionId: a.id })}
                        >
                          Fatto
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Block>
            <Block title="Punti aperti">
              <TextList items={p.openPoints} empty="Nessun punto aperto." />
            </Block>
          </>
        )}
      </CardContent>
      {editing && p && (
        <PlanEditorDialog team={team} plan={p} usedTaskIds={usedTaskIds} onOpenChange={setEditing} onSaved={onSaved} />
      )}
    </Card>
  );
}
