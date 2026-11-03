import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type CatalogSkill,
  type CatalogSkillUpdate,
  type SkillKind,
  getGetSkillQueryKey,
  getListSkillVersionsQueryKey,
  getListSkillsQueryKey,
  useCreateSkill,
  useUpdateSkill,
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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { SKILL_KIND_LABELS, parseToolHints } from "./skill-kind";

interface SkillFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Senza `skill` si crea una skill nuova; con `skill` si crea una nuova versione. */
  skill?: CatalogSkill;
  onCreated?: (skill: CatalogSkill) => void;
}

function KindFields({
  kind,
  content,
  hints,
  onContent,
  onHints,
}: {
  kind: SkillKind;
  content: string;
  hints: string;
  onContent: (v: string) => void;
  onHints: (v: string) => void;
}) {
  return kind === "node" ? (
    <div className="space-y-1.5">
      <Label htmlFor="skill-content">Nome della skill sul nodo</Label>
      <Input id="skill-content" value={content} onChange={(e) => onContent(e.target.value)} className="font-mono" />
      <p className="text-xs text-muted-foreground">Il nome con cui la skill è installata sul nodo locale.</p>
    </div>
  ) : (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="skill-content">Istruzioni</Label>
        <Textarea
          id="skill-content"
          value={content}
          onChange={(e) => onContent(e.target.value)}
          rows={12}
          maxLength={20000}
          className="font-mono text-xs"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="skill-hints">Suggerimenti sugli strumenti</Label>
        <Input id="skill-hints" value={hints} onChange={(e) => onHints(e.target.value)} placeholder="es. leggi_file, cerca" />
        <p className="text-xs text-muted-foreground">Facoltativi, separati da virgola.</p>
      </div>
    </>
  );
}

/** Crea una skill nuova (versione 1) oppure, con `skill`, modifica nome/descrizione e crea una nuova versione. */
export function SkillFormDialog({ open, onOpenChange, skill, onCreated }: SkillFormDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const editing = skill !== undefined;
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<SkillKind>(skill?.kind ?? "casello");
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [content, setContent] = useState(skill?.content ?? "");
  const [hints, setHints] = useState(skill?.toolHints.join(", ") ?? "");

  const refresh = (c: string) => {
    void queryClient.invalidateQueries({ queryKey: getListSkillsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetSkillQueryKey(c) });
    void queryClient.invalidateQueries({ queryKey: getListSkillVersionsQueryKey(c) });
  };

  const create = useCreateSkill({
    mutation: {
      onSuccess: (created) => {
        refresh(created.code);
        toast({ title: "Skill creata" });
        onOpenChange(false);
        onCreated?.(created);
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Creazione non riuscita", description: apiErrorMessage(error) }),
    },
  });
  const update = useUpdateSkill({
    mutation: {
      onSuccess: (updated) => {
        refresh(updated.code);
        toast({ title: "Skill aggiornata", description: `Versione corrente: ${updated.currentVersion}.` });
        onOpenChange(false);
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });

  const effectiveKind = skill?.kind ?? kind;
  const toolHints = effectiveKind === "casello" ? parseToolHints(hints) : [];
  const pending = create.isPending || update.isPending;

  const submit = () => {
    if (!skill) {
      create.mutate({
        data: { code: code.trim(), name: name.trim(), description: description.trim(), kind, content, toolHints },
      });
      return;
    }
    // Si inviano solo i campi cambiati: contenuto e suggerimenti generano la nuova versione.
    const data: CatalogSkillUpdate = {};
    if (name.trim() !== skill.name) data.name = name.trim();
    if (description.trim() !== skill.description) data.description = description.trim();
    if (content !== skill.content) data.content = content;
    if (toolHints.join("\n") !== skill.toolHints.join("\n")) data.toolHints = toolHints;
    if (Object.keys(data).length === 0) {
      toast({ title: "Nessuna modifica da salvare" });
      return;
    }
    update.mutate({ code: skill.code, data });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Nuova versione" : "Nuova skill"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Cambiare contenuto o suggerimenti crea una nuova versione; nome e descrizione si aggiornano senza versione."
              : "La skill nasce alla versione 1. Il codice non si può cambiare dopo."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {!editing && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="skill-code">Codice</Label>
                <Input
                  id="skill-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="es. revisione-codice"
                  className="font-mono"
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">Minuscole, cifre, punto, trattino e trattino basso.</p>
              </div>
              <div className="space-y-1.5">
                <Label>Tipo</Label>
                <Select value={kind} onValueChange={(v) => setKind(v as SkillKind)}>
                  <SelectTrigger aria-label="Tipo">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(SKILL_KIND_LABELS) as SkillKind[]).map((k) => (
                      <SelectItem key={k} value={k}>
                        {SKILL_KIND_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="skill-name">Nome</Label>
            <Input id="skill-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="skill-description">Descrizione</Label>
            <Textarea
              id="skill-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={2000}
            />
          </div>
          <KindFields kind={effectiveKind} content={content} hints={hints} onContent={setContent} onHints={setHints} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annulla
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Salvataggio…" : editing ? "Salva" : "Crea skill"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
