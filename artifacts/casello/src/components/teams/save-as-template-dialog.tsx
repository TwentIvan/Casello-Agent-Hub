import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  type TeamInstance,
  type TeamSaveAsTemplateMode,
  getGetTeamTemplateQueryKey,
  getListSkillsQueryKey,
  getListTeamTemplatesQueryKey,
  useSaveTeamInstanceAsTemplate,
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
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

interface SaveAsTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: TeamInstance;
}

/**
 * «Salva come modello»: un modello nuovo o la versione successiva del modello d'origine. Le skill specializzate
 * scelte entrano nel catalogo con un codice nuovo; le altre vengono tolte dai ruoli.
 */
export function SaveAsTemplateDialog({ open, onOpenChange, team }: SaveAsTemplateDialogProps) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [mode, setMode] = useState<TeamSaveAsTemplateMode>("new");
  const [name, setName] = useState(team.name);
  // codice locale → nuovo codice nel catalogo (presente solo per le skill da promuovere)
  const [promote, setPromote] = useState<Record<string, string>>({});

  const save = useSaveTeamInstanceAsTemplate({
    mutation: {
      onSuccess: (template) => {
        void queryClient.invalidateQueries({ queryKey: getListTeamTemplatesQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetTeamTemplateQueryKey(template.id) });
        void queryClient.invalidateQueries({ queryKey: getListSkillsQueryKey() });
        toast({ title: mode === "new" ? "Modello creato" : `Versione ${template.version} del modello salvata` });
        onOpenChange(false);
        navigate(`/team-templates/${template.id}`);
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });

  const promoted = Object.entries(promote);
  const ready = (mode === "new_version" || name.trim() !== "") && promoted.every(([, code]) => code.trim() !== "");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    save.mutate({
      id: team.id,
      data: {
        mode,
        ...(mode === "new" && { name: name.trim() }),
        ...(promoted.length > 0 && { promote: promoted.map(([localCode, code]) => ({ localCode, code: code.trim() })) }),
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Salva come modello</DialogTitle>
            <DialogDescription>
              I ruoli della squadra diventano un modello; le skill del catalogo perdono la versione fissata.
            </DialogDescription>
          </DialogHeader>
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as TeamSaveAsTemplateMode)} className="space-y-1">
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="new" />
              Nuovo modello
            </label>
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="new_version" disabled={!team.template} />
              {team.template
                ? `Nuova versione di «${team.template.name}»`
                : "Nuova versione del modello d'origine (la squadra non ha un modello)"}
            </label>
          </RadioGroup>
          {mode === "new" && (
            <div className="space-y-1.5">
              <Label htmlFor="save-template-name">Nome del modello</Label>
              <Input id="save-template-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </div>
          )}
          {team.localSkills.length > 0 && (
            <fieldset className="space-y-2 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">Skill specializzate</legend>
              <p className="text-xs text-muted-foreground">
                Quelle scelte entrano nel catalogo con il codice indicato; le altre vengono tolte dai ruoli del modello.
              </p>
              {team.localSkills.map((s) => {
                const on = s.code in promote;
                return (
                  <div key={s.code} className="space-y-1.5">
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={on}
                        onCheckedChange={(v) =>
                          setPromote((prev) => {
                            const next = { ...prev };
                            if (v === true) next[s.code] = s.code;
                            else delete next[s.code];
                            return next;
                          })
                        }
                      />
                      <span className="min-w-0 truncate">
                        {s.name} <span className="font-mono text-xs text-muted-foreground">({s.code})</span>
                      </span>
                    </label>
                    {on && (
                      <Input
                        value={promote[s.code]}
                        onChange={(e) => setPromote((prev) => ({ ...prev, [s.code]: e.target.value }))}
                        aria-label={`Codice nel catalogo per ${s.code}`}
                        placeholder="codice nel catalogo"
                        className="ml-6 w-[calc(100%-1.5rem)] font-mono text-xs"
                      />
                    )}
                  </div>
                );
              })}
            </fieldset>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annulla
            </Button>
            <Button type="submit" disabled={!ready || save.isPending}>
              {save.isPending ? "Salvataggio…" : "Salva modello"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
