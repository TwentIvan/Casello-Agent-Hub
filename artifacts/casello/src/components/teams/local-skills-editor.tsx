import { Plus, Trash2 } from "lucide-react";
import type { SkillKind, TeamInstanceLocalSkillsItem, TeamLocalSkill } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SKILL_KIND_LABELS, parseToolHints } from "./skill-kind";

/** Skill specializzata in modifica; il codice si sceglie solo finché non è salvata (i ruoli vi fanno riferimento). */
export interface LocalSkillDraft {
  uid: string;
  code: string;
  name: string;
  kind: SkillKind;
  content: string;
  toolHints: string;
  saved: boolean;
}

let uidCounter = 0;
const nextUid = () => `ls${++uidCounter}`;

export function localSkillDraft(s: TeamInstanceLocalSkillsItem): LocalSkillDraft {
  return { uid: nextUid(), code: s.code, name: s.name, kind: s.kind, content: s.content, toolHints: s.toolHints.join(", "), saved: true };
}

export function toLocalSkill(s: LocalSkillDraft): TeamLocalSkill {
  return {
    code: s.code.trim(),
    name: s.name.trim(),
    kind: s.kind,
    content: s.content,
    toolHints: s.kind === "casello" ? parseToolHints(s.toolHints) : [],
  };
}

interface LocalSkillsEditorProps {
  skills: LocalSkillDraft[];
  onChange: (skills: LocalSkillDraft[]) => void;
  /** Togliere una skill la toglie anche dai ruoli che la usano: lo fa il chiamante. */
  onRemove: (skill: LocalSkillDraft) => void;
  readOnly?: boolean;
}

/** Skill proprie di una sola squadra (senza versioni): codice, nome, tipo e contenuto. */
export function LocalSkillsEditor({ skills, onChange, onRemove, readOnly = false }: LocalSkillsEditorProps) {
  const update = (uid: string, patch: Partial<LocalSkillDraft>) =>
    onChange(skills.map((s) => (s.uid === uid ? { ...s, ...patch } : s)));

  return (
    <div className="space-y-3">
      {skills.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nessuna skill specializzata. Servono per istruzioni proprie di questo lavoro; i ruoli le usano dalla loro scheda.
        </p>
      )}
      {skills.map((s) => {
        const id = `local-${s.uid}`;
        return (
          <Card key={s.uid}>
            <CardContent className="space-y-3 p-4">
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem_auto] md:items-end">
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-code`}>Codice</Label>
                  <Input
                    id={`${id}-code`}
                    value={s.code}
                    onChange={(e) => update(s.uid, { code: e.target.value })}
                    disabled={readOnly || s.saved}
                    placeholder="es. istanza.wi1174-contesto"
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-name`}>Nome</Label>
                  <Input
                    id={`${id}-name`}
                    value={s.name}
                    onChange={(e) => update(s.uid, { name: e.target.value })}
                    maxLength={120}
                    disabled={readOnly}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-kind`}>Tipo</Label>
                  <Select value={s.kind} onValueChange={(v) => update(s.uid, { kind: v as SkillKind })} disabled={readOnly}>
                    <SelectTrigger id={`${id}-kind`}>
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
                {!readOnly && (
                  <Button type="button" variant="ghost" size="icon" onClick={() => onRemove(s)} aria-label={`Togli la skill ${s.code}`}>
                    <Trash2 />
                  </Button>
                )}
              </div>
              {s.kind === "node" ? (
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-content`}>Nome della skill sul nodo</Label>
                  <Input
                    id={`${id}-content`}
                    value={s.content}
                    onChange={(e) => update(s.uid, { content: e.target.value })}
                    disabled={readOnly}
                    className="font-mono text-xs"
                  />
                </div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${id}-content`}>Istruzioni</Label>
                    <Textarea
                      id={`${id}-content`}
                      value={s.content}
                      onChange={(e) => update(s.uid, { content: e.target.value })}
                      rows={5}
                      maxLength={20000}
                      disabled={readOnly}
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${id}-hints`}>Suggerimenti sugli strumenti</Label>
                    <Input
                      id={`${id}-hints`}
                      value={s.toolHints}
                      onChange={(e) => update(s.uid, { toolHints: e.target.value })}
                      placeholder="facoltativi, separati da virgola"
                      disabled={readOnly}
                    />
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        );
      })}
      {!readOnly && (
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            onChange([
              ...skills,
              { uid: nextUid(), code: "", name: "", kind: "casello", content: "", toolHints: "", saved: false },
            ])
          }
        >
          <Plus />
          Aggiungi skill specializzata
        </Button>
      )}
    </div>
  );
}
