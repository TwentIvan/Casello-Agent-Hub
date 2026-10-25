import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import {
  type Agent,
  type AgentSkill,
  getListAgentSkillsQueryKey,
  useDeleteAgentSkill,
  useListAgentSkills,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

/** Skill dell'agente (approvate dalle analisi dell'architetto): sola lettura, con eliminazione confermata. */
export function AgentSkillsSection({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const skills = useListAgentSkills(agent.id, { query: { queryKey: getListAgentSkillsQueryKey(agent.id) } });
  // toDelete resta valorizzato a dialog chiuso, così titolo e toast non perdono il nome durante l'animazione.
  const [toDelete, setToDelete] = useState<AgentSkill | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const deleteSkill = useDeleteAgentSkill({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListAgentSkillsQueryKey(agent.id) });
        toast({ title: "Skill eliminata", description: toDelete?.name });
        setDeleteOpen(false);
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Eliminazione non riuscita", description: apiErrorMessage(error) }),
    },
  });

  const sorted = [...(skills.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, "it"));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Skill</CardTitle>
        <CardDescription>Procedure ricorrenti dell'agente, approvate dalle analisi dell'architetto.</CardDescription>
      </CardHeader>
      <CardContent>
        {skills.isError ? (
          <p className="text-sm text-destructive">Impossibile caricare le skill: {apiErrorMessage(skills.error)}</p>
        ) : skills.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nessuna skill. Le skill si aggiungono approvandole nella revisione di un'analisi dell'app.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {sorted.map((skill) => (
              <li key={skill.id} className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium break-all">{skill.name}</span>
                    {skill.status === "draft" && (
                      <Badge variant="secondary" className="text-[11px] font-normal">
                        Bozza
                      </Badge>
                    )}
                  </div>
                  {skill.description && (
                    <p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">{skill.description}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-xs text-muted-foreground">Tool:</span>
                    {skill.toolNames.length === 0 ? (
                      <span className="text-xs text-muted-foreground">nessuno</span>
                    ) : (
                      skill.toolNames.map((name) => (
                        <Badge key={name} variant="outline" className="font-mono text-[11px] font-normal">
                          {name}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-destructive"
                  aria-label={`Elimina la skill ${skill.name}`}
                  onClick={() => {
                    setToDelete(skill);
                    setDeleteOpen(true);
                  }}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Eliminare la skill «${toDelete?.name ?? ""}»?`}
        description="L'agente non potrà più usarla. L'operazione non si può annullare: per riaverla serve una nuova analisi."
        pending={deleteSkill.isPending}
        onConfirm={() => toDelete && deleteSkill.mutate({ id: agent.id, skillId: toDelete.id })}
      />
    </Card>
  );
}
