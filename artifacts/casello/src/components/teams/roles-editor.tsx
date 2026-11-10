import type { ReactNode } from "react";
import { Crown, Download, Plus, Trash2, X } from "lucide-react";
import { getDownloadRoleInstructionsUrl, getDownloadRolesExportUrl, type TeamRoleCode, type TeamRoleRunsOn } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ModelPicker } from "@/components/ai/model-picker";
import { TOOL_LEVEL_LABELS } from "@/lib/tool-labels";
import { cn } from "@/lib/utils";
import { CODE_LABELS, RUNS_ON_LABELS, type RoleDraft, codeOptions, newRole } from "./role-draft";
import { SkillKindBadge } from "./skill-kind";
import { SkillPicker } from "./skill-picker";
import { ToolPicker } from "./tool-picker";

export const MAX_ROLES = 20;

/** Skill specializzata della squadra che un ruolo può usare. */
export interface LocalSkillOption {
  code: string;
  name: string;
}

interface RolesEditorProps {
  roles: RoleDraft[];
  onChange: (roles: RoleDraft[]) => void;
  /** `instance`: skill con la versione fissata e skill specializzate della squadra. */
  mode: "template" | "instance";
  localSkills?: LocalSkillOption[];
  readOnly?: boolean;
  /** Squadra (solo `instance`): abilita gli scarichi delle istruzioni dei ruoli. */
  teamId?: number;
  /** Se l'App di riferimento permette di dare il codice ai ruoli (nei modelli sempre sì). */
  codeEnabled?: boolean;
}

export const CODE_DISABLED_HINT = "Collega il repository dell'app tramite l'App GitHub per dare il codice ai ruoli";

/** Il ruolo ha le istruzioni se tra le sue skill specializzate c'è `ruolo-<key>`. */
const hasInstructions = (role: RoleDraft) => role.key !== "" && role.localSkills.includes(`ruolo-${role.key}`);

function Chip({ children, onRemove, label, muted }: { children: ReactNode; onRemove?: () => void; label: string; muted?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-0.5 text-xs",
        muted && "border-dashed text-muted-foreground",
      )}
    >
      <span className="flex min-w-0 flex-wrap items-center gap-1">{children}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Togli ${label}`}
          className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

function RoleCard({
  role,
  mode,
  localSkills,
  readOnly,
  teamId,
  codeEnabled,
  onChange,
  onMakeLead,
  onRemove,
}: {
  role: RoleDraft;
  mode: "template" | "instance";
  localSkills: LocalSkillOption[];
  readOnly: boolean;
  teamId?: number;
  codeEnabled: boolean;
  onChange: (patch: Partial<RoleDraft>) => void;
  onMakeLead: () => void;
  onRemove: () => void;
}) {
  const id = `role-${role.uid}`;
  const availableLocal = localSkills.filter((s) => !role.localSkills.includes(s.code));
  const localName = (code: string) => localSkills.find((s) => s.code === code)?.name;

  return (
    <Card className={cn(role.isLead && "border-primary ring-1 ring-primary/30")}>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor={`${id}-name`} className="sr-only">
              Nome del ruolo
            </Label>
            <Input
              id={`${id}-name`}
              value={role.name}
              onChange={(e) => onChange({ name: e.target.value })}
              maxLength={80}
              disabled={readOnly}
              className="font-medium"
            />
            <p className="truncate font-mono text-xs text-muted-foreground">
              {role.key ? `chiave: ${role.key}` : "la chiave nasce dal nome al salvataggio"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {teamId !== undefined && hasInstructions(role) && (
              <Button asChild variant="outline" size="sm">
                <a href={getDownloadRoleInstructionsUrl(teamId, role.key)} download={`${role.key}.md`}>
                  <Download />
                  Scarica .md
                </a>
              </Button>
            )}
            {role.isLead && (
              <Badge variant="secondary">
                <Crown className="size-3" />
                Capo
              </Badge>
            )}
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={role.isLead}
                onCheckedChange={(checked) => checked && onMakeLead()}
                disabled={readOnly}
                aria-label="Capo della squadra"
              />
              Capo
            </label>
            {!readOnly && (
              <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label={`Togli il ruolo ${role.name}`}>
                <Trash2 />
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${id}-task`}>Identità</Label>
          <Textarea
            id={`${id}-task`}
            value={role.task}
            onChange={(e) => onChange({ task: e.target.value })}
            rows={3}
            maxLength={8000}
            placeholder="Chi è il ruolo e qual è il suo mandato, in poche righe"
            disabled={readOnly}
          />
        </div>

        <div className="grid gap-3 md:grid-cols-[12rem_minmax(0,1fr)]">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-runs`}>Dove gira</Label>
            <Select
              value={role.runsOn}
              onValueChange={(v) => onChange({ runsOn: v as TeamRoleRunsOn })}
              disabled={readOnly}
            >
              <SelectTrigger id={`${id}-runs`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(RUNS_ON_LABELS) as TeamRoleRunsOn[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {RUNS_ON_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {role.runsOn === "cloud" && (
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor={`${id}-model`}>Modello</Label>
              <ModelPicker id={`${id}-model`} value={role.aiModelId} onChange={(v) => onChange({ aiModelId: v })} disabled={readOnly} cloudOnly />
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${id}-code`}>Codice</Label>
          <Select
            value={codeOptions(role.runsOn).includes(role.code) ? role.code : "none"}
            onValueChange={(v) => onChange({ code: v as TeamRoleCode })}
            disabled={readOnly || !codeEnabled}
          >
            <SelectTrigger id={`${id}-code`} className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {codeOptions(role.runsOn).map((k) => (
                <SelectItem key={k} value={k}>
                  {CODE_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!codeEnabled && <p className="text-xs text-muted-foreground">{CODE_DISABLED_HINT}</p>}
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium">Strumenti</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {role.tools.length === 0 && <span className="text-xs text-muted-foreground">Nessuno strumento.</span>}
            {role.tools.map((t) => (
              <Chip
                key={t.id}
                label={t.name}
                muted={!t.available}
                onRemove={readOnly ? undefined : () => onChange({ tools: role.tools.filter((x) => x.id !== t.id) })}
              >
                <span className="text-muted-foreground">{t.appName ?? "app eliminata"} ·</span>
                <span className="break-all font-mono">{t.name}</span>
                {t.level && <span className="text-muted-foreground">· {TOOL_LEVEL_LABELS[t.level]}</span>}
                {!t.available && (
                  <Badge variant="outline" className="text-[10px] font-normal">
                    non disponibile
                  </Badge>
                )}
              </Chip>
            ))}
            {!readOnly && (
              <ToolPicker
                exclude={role.tools.map((t) => t.id)}
                onPick={(tool) => onChange({ tools: [...role.tools, tool] })}
              />
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium">Skill</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {role.skills.length === 0 && <span className="text-xs text-muted-foreground">Nessuna skill del catalogo.</span>}
            {role.skills.map((s) => (
              <Chip
                key={s.code}
                label={s.code}
                onRemove={readOnly ? undefined : () => onChange({ skills: role.skills.filter((x) => x.code !== s.code) })}
              >
                <span className="break-all font-mono" title={s.name}>
                  {s.code}
                </span>
                {mode === "instance" && s.version !== undefined && <span className="text-muted-foreground">v{s.version}</span>}
                <SkillKindBadge kind={s.kind} />
                {s.deprecated && (
                  <Badge variant="outline" className="text-[10px] font-normal">
                    deprecata
                  </Badge>
                )}
              </Chip>
            ))}
            {!readOnly && (
              <SkillPicker
                exclude={role.skills.map((s) => s.code)}
                nodeAllowed={role.runsOn === "node"}
                onPick={(skill) => onChange({ skills: [...role.skills, skill] })}
              />
            )}
          </div>
        </div>

        {mode === "instance" && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Skill specializzate</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {role.localSkills.length === 0 && (
                <span className="text-xs text-muted-foreground">Nessuna skill specializzata.</span>
              )}
              {role.localSkills.map((code) => (
                <Chip
                  key={code}
                  label={code}
                  onRemove={
                    readOnly ? undefined : () => onChange({ localSkills: role.localSkills.filter((c) => c !== code) })
                  }
                >
                  <span className="break-all font-mono" title={localName(code)}>
                    {code}
                  </span>
                  {!localName(code) && (
                    <Badge variant="outline" className="text-[10px] font-normal">
                      non definita
                    </Badge>
                  )}
                </Chip>
              ))}
              {!readOnly && availableLocal.length > 0 && (
                <Select value="" onValueChange={(code) => onChange({ localSkills: [...role.localSkills, code] })}>
                  <SelectTrigger className="h-8 w-56" aria-label="Aggiungi una skill specializzata">
                    <SelectValue placeholder="Aggiungi specializzata" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableLocal.map((s) => (
                      <SelectItem key={s.code} value={s.code}>
                        {s.name} ({s.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Editor dei ruoli di una squadra (modello o istanza): schede impilate, un solo capo. */
export function RolesEditor({ roles, onChange, mode, localSkills = [], readOnly = false, teamId, codeEnabled = true }: RolesEditorProps) {
  const update = (uid: string, patch: Partial<RoleDraft>) =>
    onChange(roles.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  const makeLead = (uid: string) => onChange(roles.map((r) => ({ ...r, isLead: r.uid === uid })));

  return (
    <div className="space-y-3">
      {teamId !== undefined && roles.some(hasInstructions) && (
        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <a href={getDownloadRolesExportUrl(teamId)} download>
              <Download />
              Scarica tutti i ruoli (.zip)
            </a>
          </Button>
        </div>
      )}
      {roles.length === 0 && (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nessun ruolo: una squadra ha da 1 a {MAX_ROLES} ruoli, uno dei quali è il capo.
        </p>
      )}
      {roles.map((role) => (
        <RoleCard
          key={role.uid}
          role={role}
          mode={mode}
          localSkills={localSkills}
          readOnly={readOnly}
          teamId={teamId}
          codeEnabled={codeEnabled}
          onChange={(patch) => update(role.uid, patch)}
          onMakeLead={() => makeLead(role.uid)}
          onRemove={() => onChange(roles.filter((r) => r.uid !== role.uid))}
        />
      ))}
      {!readOnly && (
        <Button type="button" variant="outline" onClick={() => onChange([...roles, newRole(roles)])} disabled={roles.length >= MAX_ROLES}>
          <Plus />
          Aggiungi ruolo
        </Button>
      )}
    </div>
  );
}
