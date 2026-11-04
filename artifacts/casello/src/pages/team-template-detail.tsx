import { useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import {
  ApiError,
  type TeamTemplate,
  type TeamTemplateInput,
  getGetTeamTemplateQueryKey,
  getListTeamTemplatesQueryKey,
  useCreateTeamTemplate,
  useDeleteTeamTemplate,
  useGetTeamTemplate,
  useSaveTeamTemplate,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { NewTeamDialog } from "@/components/teams/new-team-dialog";
import { type RoleDraft, draftFromView, newRole, toTemplateRole, withKeys } from "@/components/teams/role-draft";
import { RolesEditor } from "@/components/teams/roles-editor";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

function toInput(name: string, description: string, roles: RoleDraft[]): TeamTemplateInput {
  return { name: name.trim(), description, roles: withKeys(roles).map(toTemplateRole) };
}

/** Editor del modello: nuovo (senza `template`) o versione successiva di uno esistente. */
function TemplateEditor({ template }: { template?: TeamTemplate }) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [roles, setRoles] = useState<RoleDraft[]>(() => (template ? template.roles.map(draftFromView) : [newRole([])]));
  const [deleting, setDeleting] = useState(false);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const readOnly = template?.archived ?? false;

  const savedInput = useMemo(
    () => (template ? JSON.stringify(toInput(template.name, template.description, template.roles.map(draftFromView))) : null),
    [template],
  );
  const dirty = savedInput !== JSON.stringify(toInput(name, description, roles));

  const onSaved = (saved: TeamTemplate, created: boolean) => {
    queryClient.setQueryData(getGetTeamTemplateQueryKey(saved.id), saved);
    void queryClient.invalidateQueries({ queryKey: getListTeamTemplatesQueryKey() });
    toast({ title: created ? "Modello creato" : `Versione ${saved.version} salvata` });
    if (created) navigate(`/team-templates/${saved.id}`);
  };
  const onError = (error: unknown) =>
    toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) });
  const create = useCreateTeamTemplate({ mutation: { onSuccess: (t) => onSaved(t, true), onError } });
  const save = useSaveTeamTemplate({ mutation: { onSuccess: (t) => onSaved(t, false), onError } });
  const pending = create.isPending || save.isPending;

  const remove = useDeleteTeamTemplate({
    mutation: {
      onSuccess: (result) => {
        void queryClient.invalidateQueries({ queryKey: getListTeamTemplatesQueryKey() });
        setDeleting(false);
        if (result.deleted) {
          toast({ title: "Modello eliminato" });
          navigate("/team-templates");
        } else {
          void queryClient.invalidateQueries({ queryKey: getGetTeamTemplateQueryKey(template!.id) });
          toast({ title: "Modello archiviato", description: "Ha delle squadre, che ne ricordano l'origine: resta tra gli archiviati." });
        }
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Eliminazione non riuscita", description: apiErrorMessage(error) }),
    },
  });

  const submit = () => {
    const data = toInput(name, description, roles);
    if (template) save.mutate({ id: template.id, data });
    else create.mutate({ data });
  };

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-2xl font-semibold tracking-tight">{template?.name ?? "Nuovo modello di squadra"}</h2>
          {template && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant="outline">Versione {template.version}</Badge>
              <Badge variant="outline">
                {template.instanceCount === 1 ? "1 squadra" : `${template.instanceCount} squadre`}
              </Badge>
              {template.archived && <Badge variant="secondary">Archiviato</Badge>}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {!readOnly && (
            <Button onClick={submit} disabled={pending || (template !== undefined && !dirty) || name.trim() === ""}>
              {pending ? "Salvataggio…" : template ? "Salva (nuova versione)" : "Crea modello"}
            </Button>
          )}
          {template && !template.archived && (
            <Button variant="outline" onClick={() => setCreatingTeam(true)} disabled={dirty}>
              Nuova squadra da questo modello
            </Button>
          )}
          {template && !template.archived && (
            <Button variant="outline" onClick={() => setDeleting(true)}>
              Elimina
            </Button>
          )}
        </div>
      </div>
      {template && dirty && !readOnly && (
        <p className="text-sm text-muted-foreground">Modifiche non salvate: il salvataggio crea la versione {template.version + 1}.</p>
      )}
      {readOnly && (
        <p className="text-sm text-muted-foreground">
          Modello archiviato: resta in sola lettura perché le sue squadre ne ricordano l'origine.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Modello</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="template-name">Nome</Label>
            <Input id="template-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} disabled={readOnly} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="template-description">Descrizione</Label>
            <Textarea
              id="template-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={2000}
              disabled={readOnly}
            />
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h3 className="text-lg font-semibold">Ruoli</h3>
        <RolesEditor roles={roles} onChange={setRoles} mode="template" readOnly={readOnly} />
      </section>

      {template && (
        <>
          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            title="Eliminare il modello?"
            description={
              template.instanceCount > 0
                ? "Ha delle squadre: invece di eliminarlo lo si archivia, così le squadre ne ricordano l'origine."
                : "Il modello e tutte le sue versioni vengono eliminati."
            }
            confirmLabel={template.instanceCount > 0 ? "Archivia" : "Elimina"}
            pending={remove.isPending}
            onConfirm={() => remove.mutate({ id: template.id })}
          />
          {creatingTeam && (
            <NewTeamDialog open onOpenChange={setCreatingTeam} template={{ id: template.id, name: template.name }} />
          )}
        </>
      )}
    </>
  );
}

export default function TeamTemplateDetailPage() {
  const params = useParams<{ id: string }>();
  const isNew = params.id === "new";
  const id = Number(params.id);
  const template = useGetTeamTemplate(id, {
    query: { queryKey: getGetTeamTemplateQueryKey(id), enabled: !isNew && Number.isInteger(id) },
  });
  const t = template.data;
  const notFound = (!isNew && !Number.isInteger(id)) || (template.error instanceof ApiError && template.error.status === 404);

  return (
    <div className="mx-auto max-w-screen-xl space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/team-templates">
          <ArrowLeft />
          Tutti i modelli
        </Link>
      </Button>
      {isNew ? (
        <TemplateEditor />
      ) : notFound ? (
        <p className="text-sm text-muted-foreground">Modello non trovato.</p>
      ) : template.isError ? (
        <p className="text-sm text-destructive">Impossibile caricare il modello: {apiErrorMessage(template.error)}</p>
      ) : !t ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        // Rimontato a ogni versione o archiviazione: l'editor riparte dallo stato salvato
        <TemplateEditor key={`${t.id}-${t.version}-${t.archived}`} template={t} />
      )}
    </div>
  );
}
