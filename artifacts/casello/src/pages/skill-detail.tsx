import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import {
  ApiError,
  getGetSkillQueryKey,
  getListSkillsQueryKey,
  useDeprecateSkill,
  useGetSkill,
} from "@workspace/api-client-react";
import { LuciusButton } from "@/components/characters/lucius-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SkillFormDialog } from "@/components/teams/skill-form-dialog";
import { SkillKindBadge } from "@/components/teams/skill-kind";
import { SkillVersionsCard } from "@/components/teams/skill-versions-card";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

export default function SkillDetailPage() {
  const params = useParams<{ code: string }>();
  const code = params.code;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const skill = useGetSkill(code, { query: { queryKey: getGetSkillQueryKey(code) } });
  const [editing, setEditing] = useState(false);
  const [deprecating, setDeprecating] = useState(false);

  const deprecate = useDeprecateSkill({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetSkillQueryKey(code) });
        void queryClient.invalidateQueries({ queryKey: getListSkillsQueryKey() });
        toast({ title: "Skill deprecata" });
        setDeprecating(false);
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Deprecazione non riuscita", description: apiErrorMessage(error) }),
    },
  });

  const s = skill.data;
  const notFound = skill.error instanceof ApiError && skill.error.status === 404;

  return (
    <div className="mx-auto max-w-screen-2xl space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/skills">
          <ArrowLeft />
          Tutte le skill
        </Link>
      </Button>
      {notFound ? (
        <p className="text-sm text-muted-foreground">Skill non trovata.</p>
      ) : skill.isError ? (
        <p className="text-sm text-destructive">Impossibile caricare la skill: {apiErrorMessage(skill.error)}</p>
      ) : !s ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="break-words text-h2">{s.name}</h2>
              <p className="break-all font-mono text-xs text-muted-foreground">{s.code}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <SkillKindBadge kind={s.kind} />
                <Badge variant="outline">Versione {s.currentVersion}</Badge>
                {s.deprecated && <Badge variant="outline">Deprecata</Badge>}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <LuciusButton />
              <Button onClick={() => setEditing(true)}>Nuova versione</Button>
              {!s.deprecated && (
                <Button variant="outline" onClick={() => setDeprecating(true)}>
                  Depreca
                </Button>
              )}
            </div>
          </div>
          {s.description && <p className="whitespace-pre-wrap break-words text-sm">{s.description}</p>}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{s.kind === "node" ? "Skill sul nodo" : "Istruzioni"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">{s.content}</pre>
              {s.toolHints.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="text-muted-foreground">Strumenti suggeriti:</span>
                  {s.toolHints.map((h) => (
                    <Badge key={h} variant="secondary" className="font-mono">
                      {h}
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <SkillVersionsCard code={s.code} />
          {editing && <SkillFormDialog open onOpenChange={setEditing} skill={s} />}
          <ConfirmDialog
            open={deprecating}
            onOpenChange={setDeprecating}
            title="Deprecare la skill?"
            description="Resta nelle squadre che già la usano, ma non si propone più per nuovi ruoli."
            confirmLabel="Depreca"
            pendingLabel="Deprecazione…"
            pending={deprecate.isPending}
            onConfirm={() => deprecate.mutate({ code: s.code })}
          />
        </>
      )}
    </div>
  );
}
