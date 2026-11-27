import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  type TeamInstanceRole,
  getListAppsQueryKey,
  getListTeamInstancesQueryKey,
  getListTeamTemplatesQueryKey,
  useCreateTeamInstance,
  useListApps,
  useListTeamTemplates,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDefaultAiModelId } from "@/components/ai/ai-queries";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

const FROM_SCRATCH = "none";
/** Tipo del lavoro di riferimento delle squadre create a mano (quelle di «Implementa» e del ciclo hanno il loro). */
const TEAM_REF_TYPE = "squadra";

interface NewTeamDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Modello di partenza già scelto (scheda del modello); senza si sceglie qui, anche «da zero». */
  template?: { id: number; name: string };
}

/** Crea una squadra per un lavoro concreto: nome e lavoro di riferimento (app e titolo facoltativo). */
export function NewTeamDialog({ open, onOpenChange, template }: NewTeamDialogProps) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const apps = useListApps({ query: { queryKey: getListAppsQueryKey(), enabled: open } });
  const templates = useListTeamTemplates(undefined, {
    query: { queryKey: getListTeamTemplatesQueryKey(), enabled: open && !template },
  });
  const defaultModelId = useDefaultAiModelId({ cloudOnly: true });
  const [templateChoice, setTemplateChoice] = useState<string>("");
  const [name, setName] = useState("");
  const [appId, setAppId] = useState("");
  const [refTitle, setRefTitle] = useState("");

  const create = useCreateTeamInstance({
    mutation: {
      onSuccess: (team) => {
        void queryClient.invalidateQueries({ queryKey: getListTeamInstancesQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getListTeamTemplatesQueryKey() });
        toast({ title: "Squadra creata" });
        onOpenChange(false);
        navigate(`/teams/${team.id}`);
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Creazione non riuscita", description: apiErrorMessage(error) }),
    },
  });

  const templateId = template?.id ?? (templateChoice && templateChoice !== FROM_SCRATCH ? Number(templateChoice) : undefined);
  const ready =
    name.trim() !== "" && appId !== "" && (template || templateChoice !== "");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    // Da zero si parte da un solo ruolo, il capo, da completare nella scheda della squadra
    const lead: TeamInstanceRole = {
      key: "capo",
      name: "Capo",
      task: "",
      isLead: true,
      runsOn: "cloud",
      aiModelId: defaultModelId,
      tools: [],
      skills: [],
      localSkills: [],
    };
    create.mutate({
      data: {
        ...(templateId !== undefined ? { templateId } : { roles: [lead] }),
        name: name.trim(),
        // Il lavoro di riferimento è l'App: tipo e id sono solo un'etichetta, presa dal nome della squadra
        ref: {
          appId: Number(appId),
          type: TEAM_REF_TYPE,
          id: name.trim().slice(0, 100),
          title: refTitle.trim() || name.trim(),
        },
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{template ? "Nuova squadra da questo modello" : "Nuova squadra"}</DialogTitle>
            <DialogDescription>
              {template
                ? `I ruoli di «${template.name}» vengono copiati con le skill fissate alla versione attuale.`
                : "Parti da un modello o da zero; la squadra nasce in bozza."}
            </DialogDescription>
          </DialogHeader>
          {!template && (
            <div className="space-y-1.5">
              <Label htmlFor="team-template">Modello</Label>
              <Select value={templateChoice} onValueChange={setTemplateChoice}>
                <SelectTrigger id="team-template">
                  <SelectValue placeholder={templates.isLoading ? "Caricamento…" : "Scegli un modello"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={FROM_SCRATCH}>Nessun modello (da zero, con il solo capo)</SelectItem>
                  {(templates.data ?? []).map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="team-name">Nome</Label>
            <Input id="team-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="es. WI 1174" />
          </div>
          <fieldset className="space-y-3 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">Lavoro di riferimento</legend>
            <div className="space-y-1.5">
              <Label htmlFor="team-app">App</Label>
              {apps.isError ? (
                <p className="text-sm text-destructive">Impossibile caricare le app: {apiErrorMessage(apps.error)}</p>
              ) : (
                <Select value={appId} onValueChange={setAppId}>
                  <SelectTrigger id="team-app">
                    <SelectValue placeholder={apps.isLoading ? "Caricamento…" : "Scegli un'app"} />
                  </SelectTrigger>
                  <SelectContent>
                    {(apps.data ?? []).map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="team-ref-title">Titolo (facoltativo)</Label>
              <Input id="team-ref-title" value={refTitle} onChange={(e) => setRefTitle(e.target.value)} maxLength={300} />
            </div>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annulla
            </Button>
            <Button type="submit" disabled={!ready || create.isPending}>
              {create.isPending ? "Creazione…" : "Crea squadra"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
